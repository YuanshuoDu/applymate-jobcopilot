import type pg from "pg"
import type { TenantScope, RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { parseSnapshotContent } from "./context/context-snapshot-canonical.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnResumeState } from "./turns/turn-engine-types.js"
import { consumeDurableWaitOutcomes } from "./subagents/durable-wait-consumer.js"

export type CanonicalTurnState = {
  readonly scope: TenantScope
  readonly goal: string
  readonly modelProfileSnapshot: RepositoryJsonValue
  readonly toolPolicySnapshot: unknown
  readonly budgetSnapshot: unknown
  readonly rootTaskId?: string
  readonly rootInputId?: string
  readonly snapshot: StepContextSnapshot
  readonly resume?: TurnResumeState
}

type Row = Record<string, unknown>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
}

function text(input: unknown): string {
  const value = object(input).goal ?? object(input).content
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("turn_goal_missing")
  return value.trim()
}

function snapshotFromContent(value: unknown, scope: TenantScope, sessionId: string): StepContextSnapshot {
  const content = parseSnapshotContent(value)
  if (content.ownerId !== scope.userId || content.sessionId !== sessionId) throw new Error("context_snapshot_scope_mismatch")
  return {
    system: content.context.system,
    profile: content.context.profile,
    goal: content.context.goal,
    steerHistory: content.context.steerHistory,
    businessRefs: content.references.map(({ source: _source, verified: _verified, ...reference }) => reference),
    toolObservations: content.context.toolObservations,
  }
}

function eventPayload(value: unknown): Record<string, unknown> {
  const payload = object(value)
  return object(payload.payload ?? payload)
}

function authoritativeOutputs(events: readonly Row[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>()
  for (const event of events) {
    if (event.type !== "tool_call.completed" && event.type !== "tool_call.failed") continue
    const payload = eventPayload(event.payload)
    if (typeof payload.toolCallId !== "string") continue
    // Lifecycle events are the durable execution receipt. UI projections may
    // intentionally retain only outputAvailable on the corresponding item.
    if (Object.prototype.hasOwnProperty.call(payload, "output")) outputs.set(payload.toolCallId, payload.output)
  }
  return outputs
}

function observations(items: readonly Row[], events: readonly Row[]): StepContextSnapshot["toolObservations"] {
  const calls = new Map<string, Row>()
  const outputs = authoritativeOutputs(events)
  for (const item of items) {
    const content = object(item.content)
    if (item.type === "tool_call" && typeof content.toolCallId === "string") calls.set(content.toolCallId, content)
  }
  return items.filter(item => item.type === "tool_result").flatMap(item => {
    const content = object(item.content)
    if (typeof content.toolCallId !== "string") return []
    const call = calls.get(content.toolCallId)
    if (!call || typeof call.toolName !== "string") return []
    const output = Object.prototype.hasOwnProperty.call(content, "output") && content.output !== null
      ? content.output
      : outputs.get(content.toolCallId) ?? content.output ?? null
    return [{ id: `tool-result:${content.toolCallId}`, content: json({
      toolCallId: content.toolCallId, toolName: call.toolName, input: call.input ?? {}, status: call.status ?? (content.errorCode ? "failed" : "completed"),
      output, errorCode: content.errorCode ?? null,
    }) }]
  })
}

function textContent(value: unknown): string | null {
  const row = object(value)
  if (typeof row.content === "string" && row.content.trim()) return row.content.trim()
  if (typeof row.text === "string" && row.text.trim()) return row.text.trim()
  if (typeof row.body === "string" && row.body.trim()) return row.body.trim()
  if (typeof row.goal === "string" && row.goal.trim()) return row.goal.trim()
  const partsSource = Array.isArray(value) ? value : row.parts
  if (Array.isArray(partsSource)) {
    const parts = partsSource.flatMap((part) => {
      const item = object(part)
      return item.type === "text" && typeof item.text === "string" ? [item.text] : []
    })
    if (parts.length > 0) return parts.join("\n").trim()
  }
  return null
}

type PriorHistoryEntry = { readonly id: string; readonly content: unknown; readonly sequence: bigint | null }

function priorConversation(rows: readonly Row[], currentTurnId: string, throughSequence: bigint | null): PriorHistoryEntry[] {
  return rows.flatMap((row) => {
    const id = typeof row.id === "string" ? row.id : null
    const turnId = typeof row.turnId === "string" ? row.turnId : row.targetTurnId
    const text = textContent(row.content)
    let sequence: bigint | null = null
    try {
      if (row.historySequence !== undefined && row.historySequence !== null) sequence = BigInt(String(row.historySequence))
      else if (row.acceptedSequence !== undefined && row.acceptedSequence !== null) sequence = BigInt(String(row.acceptedSequence))
    } catch { return [] }
    if (throughSequence !== null && sequence !== null && sequence <= throughSequence) return []
    const role = row.historyRole === "assistant" ? "assistant" : "user"
    return id && turnId !== currentTurnId && text ? [{ id: `history:${role}:${id}`, content: { role, text }, sequence }] : []
  })
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
      `SELECT "ordinal", "attempt", "inputThroughSequence", "consumedInputIds", "inputTokens", "outputTokens", "estimatedCostUsd"
       FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2 AND ("taskId" IS NULL OR "taskId" = $3)
       ORDER BY "ordinal" ASC, "attempt" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const itemsResult = await client.query<Row>(
      `SELECT "id", "type", "content" FROM "agent_items" WHERE "turnId" = $1 AND "sessionId" = $2
       AND ("taskId" IS NULL OR "taskId" = $3) AND "type" IN ('tool_call', 'tool_result') ORDER BY "createdAt" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const eventsResult = await client.query<Row>(
      `SELECT "type", "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2
       AND ("taskId" IS NULL OR "taskId" = $3) AND "type" IN ('tool_call.completed', 'tool_call.failed') ORDER BY "sequence" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const priorInputs = await client.query<Row>(
      `SELECT "id", "targetTurnId", "content", "acceptedSequence", 'user' AS "historyRole", "acceptedSequence" AS "historySequence" FROM "agent_inputs"
       WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" IS NOT NULL AND "targetTurnId" <> $3
       ORDER BY "acceptedSequence" ASC`, [lease.sessionId, lease.userId, lease.turnId],
    )
    const priorItems = await client.query<Row>(
      `SELECT item."id", item."turnId", item."content", 'assistant' AS "historyRole",
              COALESCE(MAX(event."sequence"), 0) AS "historySequence"
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
    let snapshotThroughSequence: bigint | null = null
    if (turn.contextSnapshotId) {
      const contextResult = await client.query<Row>(`SELECT snapshot."content", snapshot."throughSequence" FROM "agent_context_snapshots" AS snapshot
        JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
        WHERE snapshot."id" = $1 AND snapshot."sessionId" = $2 AND session."userId" = $3`, [turn.contextSnapshotId, lease.sessionId, lease.userId])
      if (!contextResult.rows[0]) throw new Error("context_snapshot_missing")
      snapshot = snapshotFromContent(contextResult.rows[0].content, scope, lease.sessionId)
      snapshotThroughSequence = BigInt(String(contextResult.rows[0].throughSequence ?? object(contextResult.rows[0].content).throughSequence ?? 0))
    } else {
      const contextResult = await client.query<Row>(`SELECT snapshot."content", snapshot."throughSequence" FROM "agent_context_snapshots" AS snapshot
        JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
        WHERE snapshot."sessionId" = $1 AND session."userId" = $2
        ORDER BY snapshot."throughSequence" DESC, snapshot."version" DESC LIMIT 1`, [lease.sessionId, lease.userId])
      if (contextResult.rows[0]) {
        snapshot = snapshotFromContent(contextResult.rows[0].content, scope, lease.sessionId)
        snapshotThroughSequence = BigInt(String(contextResult.rows[0].throughSequence ?? object(contextResult.rows[0].content).throughSequence ?? 0))
      }
    }
    const restored = observations(itemsResult.rows, eventsResult.rows)
    const seen = new Set(snapshot.toolObservations.map(item => item.id))
    const restoredNew = restored.filter(item => !seen.has(item.id))
    const seenWithRestored = new Set([...seen, ...restoredNew.map(item => item.id)])
    const history = [...priorConversation(priorInputs.rows, lease.turnId, snapshotThroughSequence), ...priorConversation(priorItems.rows, lease.turnId, snapshotThroughSequence)]
      .sort((left, right) => {
        if (left.sequence === null && right.sequence === null) return left.id.localeCompare(right.id)
        if (left.sequence === null) return 1
        if (right.sequence === null) return -1
        return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.id.localeCompare(right.id)
      })
    const seenHistory = new Set(snapshot.steerHistory.map(item => item.id))
    snapshot = {
      ...snapshot,
      goal: { id: `turn-goal:${lease.turnId}`, content: text(turn.input) },
      steerHistory: [...snapshot.steerHistory, ...history.filter(item => !seenHistory.has(item.id)).map(({ sequence: _sequence, ...item }) => item)],
      toolObservations: [...snapshot.toolObservations, ...restoredNew, ...consumedWaits.filter(item => !seenWithRestored.has(item.id))],
    }
    const steps = stepsResult.rows
    const last = steps[steps.length - 1]
    const ordinalResult = await client.query<Row>(
      `SELECT MAX("ordinal") AS "maxOrdinal" FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2`, [lease.turnId, lease.sessionId],
    )
    const maxOrdinal = ordinalResult.rows[0]?.maxOrdinal === null || ordinalResult.rows[0]?.maxOrdinal === undefined
      ? null : Number(ordinalResult.rows[0].maxOrdinal)
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
    const result = { scope, goal: text(turn.input), modelProfileSnapshot: json(turn.modelProfileSnapshot), toolPolicySnapshot: turn.toolPolicySnapshot ?? {}, budgetSnapshot: turn.budgetSnapshot ?? {}, ...(typeof turn.rootTaskId === "string" ? { rootTaskId: turn.rootTaskId } : {}), ...(rootInput.rows[0] ? { rootInputId: rootInput.rows[0].id } : {}), snapshot, ...(resume ? { resume } : {}) }
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
