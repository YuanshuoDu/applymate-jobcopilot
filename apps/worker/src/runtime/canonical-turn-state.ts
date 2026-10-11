import type pg from "pg"
import type { TenantScope, RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { restoreCanonicalTurnSnapshot } from "./context/canonical-turn-snapshot-state.js"
import type { SelectedJobMemoryRecord } from "./context/selected-job-memory.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnResumeState } from "./turns/turn-engine-types.js"
import type { PersistedToolCallRecovery } from "./turns/turn-engine-types.js"
import { restoreToolCallState } from "./turns/persisted-tool-call-state.js"
import { consumeDurableWaitOutcomes } from "./subagents/durable-wait-consumer.js"
import { restoreCanonicalSteeringMarkers, priorConversation, type SteeringMarkerState } from "./canonical-steering-markers.js"
import { STEERING_MARKER_EVENT_TYPE } from "./context/steering-marker.js"
import { COGNITIVE_AGENDA_EVENT_TYPE, parseCognitiveAgendaReceipt, type CognitiveAgendaReceipt } from "./turns/cognitive-agenda-receipt.js"
import { recoverAnsweredQuestionHistory } from "./question-answer-recovery.js"

export type CanonicalTurnState = {
  readonly scope: TenantScope
  readonly goal: string
  readonly modelProfileSnapshot: RepositoryJsonValue
  readonly toolPolicySnapshot: unknown
  readonly budgetSnapshot: unknown
  readonly rootTaskId?: string
  readonly rootInputId?: string
  /** Exact server-owned interactive-discovery intent restored from the Turn envelope. */
  readonly intent?: CanonicalTurnIntent
  /** Loaded Turns always provide this; optional for existing injected stateLoader fixtures. */
  readonly contextSnapshotPinned?: boolean
  readonly snapshot: StepContextSnapshot
  /** Bounded server-owned TaskGraph projection; only an exact selected-job Turn may expose it to the model. */
  readonly selectedJobMemories?: readonly SelectedJobMemoryRecord[]
  readonly steeringMarkers?: SteeringMarkerState
  readonly pendingToolCalls?: readonly PersistedToolCallRecovery[]
  /** Latest validated agenda receipt; audit state only, never model context. */
  readonly cognitiveAgendaReceipt?: CognitiveAgendaReceipt
  readonly resume?: TurnResumeState
}

export type CanonicalTurnIntent = Readonly<{ kind: "interactive_discovery_shortlist"; version: 1 }>
export const INTERACTIVE_DISCOVERY_INTENT: CanonicalTurnIntent = Object.freeze({ kind: "interactive_discovery_shortlist", version: 1 })

type Row = Record<string, unknown>
function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}
function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
}

function eventPayload(value: unknown): Row { const payload = object(value); return object(payload.payload ?? payload) }
function turnGoal(value: unknown): string {
  const root = object(value)
  const input = object(root.input)
  const source = Object.keys(input).length > 0 ? input : root
  const goal = source.goal ?? source.content
  if (typeof goal !== "string" || !goal.trim()) throw new Error("turn_goal_missing")
  return goal.trim()
}

function turnIntent(value: unknown): CanonicalTurnIntent | undefined {
  const root = object(value)
  const input = object(root.input)
  const source = Object.keys(input).length > 0 ? input : root
  const intent = object(source.intent)
  if (Object.keys(intent).sort().join(",") !== "kind,version"
    || intent.kind !== INTERACTIVE_DISCOVERY_INTENT.kind
    || intent.version !== INTERACTIVE_DISCOVERY_INTENT.version) return undefined
  return INTERACTIVE_DISCOVERY_INTENT
}

function cognitiveAgendaReceipt(events: readonly Row[], lease: TurnLease, rootTaskId: unknown): CognitiveAgendaReceipt | undefined {
  const rows = events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE)
  if (rows.length === 0) return undefined
  if (typeof rootTaskId !== "string" || !rootTaskId) throw new Error("cognitive_agenda_scope_invalid")
  let previousSequence: bigint | null = null
  let latest: CognitiveAgendaReceipt | undefined
  for (const event of rows) {
    if (event.userId !== lease.userId || event.sessionId !== lease.sessionId || event.turnId !== lease.turnId || (event.taskId !== null && event.taskId !== rootTaskId)) throw new Error("cognitive_agenda_scope_invalid")
    let sequence: bigint
    try { sequence = BigInt(String(event.sequence)) } catch { throw new Error("cognitive_agenda_sequence_invalid") }
    if (previousSequence !== null && sequence <= previousSequence) throw new Error("cognitive_agenda_sequence_invalid")
    previousSequence = sequence
    const payload = eventPayload(event.payload)
    const stepId = typeof payload.stepId === "string" ? payload.stepId : ""
    const parsed = parseCognitiveAgendaReceipt(payload, { sessionId: lease.sessionId, turnId: lease.turnId, taskId: rootTaskId, stepId })
    if (!parsed) throw new Error("cognitive_agenda_receipt_invalid")
    latest = parsed
  }
  return latest
}

function validateAgendaResumeFence(receipt: CognitiveAgendaReceipt | undefined, steps: readonly Row[]): void {
  const fence = receipt?.resumeFence
  if (!fence) return
  const last = steps[steps.length - 1]
  if (!last || last.id !== receipt.stepId || String(last.inputThroughSequence ?? "") !== fence.inputThroughSequence || !Array.isArray(last.consumedInputIds) || JSON.stringify(last.consumedInputIds) !== JSON.stringify(fence.consumedInputIds)) throw new Error("cognitive_agenda_resume_fence_invalid")
}

export type CanonicalTurnStateLoadOptions = { readonly consumeWaitOutcomes?: boolean }

export async function loadCanonicalTurnState(pool: Pick<pg.Pool, "connect">, lease: TurnLease, now = new Date(), options: CanonicalTurnStateLoadOptions = {}): Promise<CanonicalTurnState> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const scope = { userId: lease.userId } satisfies TenantScope
    const turnResult = await client.query<Row>(
      `SELECT "id", "sessionId", "userId", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt",
              "input", "rootTaskId", "contextSnapshotId", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot"
       FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
         AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > $6 AND "status" = 'in_progress'
       FOR UPDATE`,
      [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now],
    )
    const turn = turnResult.rows[0]
    if (!turn) throw new Error("turn_not_owned")
    const consumedWaits = options.consumeWaitOutcomes ? await consumeDurableWaitOutcomes({ client, lease, turn, now }) : []
    const stepsResult = await client.query<Row>(
      `SELECT "id", "taskId", "ordinal", "attempt", "inputThroughSequence", "consumedInputIds", "inputTokens", "outputTokens", "estimatedCostUsd"
       FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2 AND ("taskId" IS NULL OR "taskId" = $3)
       ORDER BY "ordinal" ASC, "attempt" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const itemsResult = await client.query<Row>(
      `SELECT "id", "stepId", "taskId", "type", "status", "revision", "content" FROM "agent_items" WHERE "turnId" = $1 AND "sessionId" = $2
       AND ("taskId" IS NULL OR "taskId" = $3) AND "type" IN ('tool_call', 'tool_result') ORDER BY "createdAt" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const eventsResult = await client.query<Row>(
      `SELECT event."id", event."type", event."actor", event_session."userId" AS "userId", event."sessionId", event."turnId", event."taskId", event."sequence", event."payload"
       FROM "agent_events" AS event
       JOIN "agent_sessions" AS event_session ON event_session."id" = event."sessionId" AND event_session."userId" = $4
       JOIN "agent_turns" AS event_turn ON event_turn."id" = event."turnId" AND event_turn."sessionId" = event."sessionId" AND event_turn."userId" = $4
       WHERE event."turnId" = $1 AND event."sessionId" = $2 AND (event."taskId" IS NULL OR event."taskId" = $3)
         AND event."type" IN ('tool_call.completed', 'tool_call.failed', '${STEERING_MARKER_EVENT_TYPE}', '${COGNITIVE_AGENDA_EVENT_TYPE}')
       ORDER BY event."sequence" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId, lease.userId],
    )
    const priorInputs = await client.query<Row>(
      `SELECT "id", "targetTurnId", "content", "acceptedSequence", 'user' AS "historyRole", "acceptedSequence" AS "historySequence" FROM "agent_inputs"
       WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" IS NOT NULL AND "targetTurnId" <> $3
         AND NOT ("delivery" = 'follow_up' AND "status" IN ('accepted', 'queued')
           AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL)
       ORDER BY "acceptedSequence" ASC`, [lease.sessionId, lease.userId, lease.turnId],
    )
    const priorItems = await client.query<Row>(
      `SELECT item."id", item."turnId", item."content", 'assistant' AS "historyRole", COALESCE(MAX(event."sequence"), 0) AS "historySequence"
       FROM "agent_items" AS item LEFT JOIN "agent_events" AS event ON event."itemId" = item."id"
       LEFT JOIN "sub_agent_tasks" AS item_task ON item_task."id" = item."taskId"
       WHERE item."sessionId" = $1 AND item."turnId" <> $2 AND item."type" = 'agent_message' AND item."status" = 'completed'
         AND (item."taskId" IS NULL OR item_task."rootTaskId" = item_task."id")
       GROUP BY item."id", item."turnId", item."content" ORDER BY "historySequence" ASC, item."id" ASC`, [lease.sessionId, lease.turnId],
    )
    const rootInput = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_inputs" WHERE "targetTurnId" = $1 AND "sessionId" = $2 AND "userId" = $3 ORDER BY "acceptedSequence" ASC LIMIT 1`,
      [lease.turnId, lease.sessionId, lease.userId],
    )
    let snapshot: StepContextSnapshot = { system: [{ id: "canonical-runtime", content: "Use only scoped, policy-approved tools and continue until the stated goal is verifiably complete." }], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
    let selectedJobMemories: readonly SelectedJobMemoryRecord[] | undefined
    let snapshotThroughSequence: bigint | null = null
    if (turn.contextSnapshotId) {
      const contextResult = await client.query<Row>(`SELECT snapshot."content", snapshot."throughSequence" FROM "agent_context_snapshots" AS snapshot
        JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
        WHERE snapshot."id" = $1 AND snapshot."sessionId" = $2 AND session."userId" = $3`, [turn.contextSnapshotId, lease.sessionId, lease.userId])
      if (!contextResult.rows[0]) throw new Error("context_snapshot_missing")
      const restored = restoreCanonicalTurnSnapshot(contextResult.rows[0].content, contextResult.rows[0].throughSequence, scope, lease.sessionId)
      snapshot = restored.snapshot; selectedJobMemories = restored.selectedJobMemories
      snapshotThroughSequence = BigInt(String(contextResult.rows[0].throughSequence))
    } else {
      const contextResult = await client.query<Row>(`SELECT snapshot."content", snapshot."throughSequence" FROM "agent_context_snapshots" AS snapshot
        JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
        WHERE snapshot."sessionId" = $1 AND session."userId" = $2
        ORDER BY snapshot."throughSequence" DESC, snapshot."version" DESC LIMIT 1`, [lease.sessionId, lease.userId])
      if (contextResult.rows[0]) {
        const restored = restoreCanonicalTurnSnapshot(contextResult.rows[0].content, contextResult.rows[0].throughSequence, scope, lease.sessionId)
        snapshot = restored.snapshot; selectedJobMemories = restored.selectedJobMemories
        snapshotThroughSequence = BigInt(String(contextResult.rows[0].throughSequence))
      }
    }
    const goal = turnGoal(turn.input)
    const rootTaskId = typeof turn.rootTaskId === "string" ? turn.rootTaskId : null
    const steeringMarkers = restoreCanonicalSteeringMarkers(eventsResult.rows, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId })
    const restoredAgenda = cognitiveAgendaReceipt(eventsResult.rows, lease, turn.rootTaskId)
    const restored = restoreToolCallState(itemsResult.rows, eventsResult.rows)
    const seen = new Set(snapshot.toolObservations.map(item => item.id))
    const restoredToolObservations = restored.observations.map(item => ({ id: item.id, content: json(item.content) }))
    const restoredIds = new Set<string>()
    const restoredNew = restoredToolObservations.filter(item => {
      if (seen.has(item.id) || restoredIds.has(item.id)) return false
      restoredIds.add(item.id)
      return true
    })
    const seenWithRestored = new Set([...seen, ...restoredNew.map(item => item.id)])
    const history = [...priorConversation(priorInputs.rows, lease.turnId, snapshotThroughSequence), ...priorConversation(priorItems.rows, lease.turnId, snapshotThroughSequence)]
      .sort((left, right) => {
        if (left.sequence === null && right.sequence === null) return left.id.localeCompare(right.id)
        if (left.sequence === null) return 1
        if (right.sequence === null) return -1
        return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.id.localeCompare(right.id)
      })
    const questionHistory = await recoverAnsweredQuestionHistory(client, { lease, rootTaskId, steps: stepsResult.rows, toolItems: itemsResult.rows, existingHistory: snapshot.steerHistory })
    const seenHistory = new Set(snapshot.steerHistory.map(item => item.id))
    snapshot = {
      ...snapshot,
      goal: { id: `turn-goal:${lease.turnId}`, content: goal },
      steerHistory: [...snapshot.steerHistory, ...history.filter(item => !seenHistory.has(item.id)).map(({ sequence: _sequence, ...item }) => item), ...questionHistory],
      toolObservations: [...snapshot.toolObservations, ...restoredNew, ...consumedWaits.filter(item => !seenWithRestored.has(item.id))],
    }
    const steps = stepsResult.rows
    const last = steps[steps.length - 1]
    const ordinalResult = await client.query<Row>(
      `SELECT MAX("ordinal") AS "maxOrdinal" FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2`, [lease.turnId, lease.sessionId],
    )
    const maxOrdinal = ordinalResult.rows[0]?.maxOrdinal === null || ordinalResult.rows[0]?.maxOrdinal === undefined ? null : Number(ordinalResult.rows[0].maxOrdinal)
    const usage = steps.reduce<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number }>((total, step) => {
      total.inputTokens += Number(step.inputTokens ?? 0)
      total.outputTokens += Number(step.outputTokens ?? 0)
      total.estimatedCostUsd += Number(step.estimatedCostUsd ?? 0)
      return total
    }, { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
    const resume = last || maxOrdinal !== null ? {
      nextOrdinal: (maxOrdinal ?? Number(last.ordinal)) + 1,
      stepCount: steps.length,
      toolCallCount: itemsResult.rows.filter(item => item.type === "tool_call").length,
      inputThroughSequence: BigInt(String(last?.inputThroughSequence ?? 0)),
      consumedInputIds: Array.isArray(last?.consumedInputIds) ? last.consumedInputIds.filter((id): id is string => typeof id === "string") : [],
      usage,
    } satisfies TurnResumeState : undefined
    validateAgendaResumeFence(restoredAgenda, steps)
    const intent = turnIntent(turn.input)
    const result = {
      scope, goal, modelProfileSnapshot: json(turn.modelProfileSnapshot), toolPolicySnapshot: turn.toolPolicySnapshot ?? {}, budgetSnapshot: turn.budgetSnapshot ?? {},
      ...(intent ? { intent } : {}),
      contextSnapshotPinned: turn.contextSnapshotId !== null && turn.contextSnapshotId !== undefined,
      steeringMarkers, ...(restoredAgenda ? { cognitiveAgendaReceipt: restoredAgenda } : {}), ...(restored.pending.length ? { pendingToolCalls: restored.pending } : {}), ...(rootTaskId ? { rootTaskId } : {}),
      ...(rootInput.rows[0] ? { rootInputId: rootInput.rows[0].id } : {}), snapshot, ...(resume ? { resume } : {}),
      ...(selectedJobMemories ? { selectedJobMemories } : {}),
    }
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
