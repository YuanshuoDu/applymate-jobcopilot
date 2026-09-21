import { Buffer } from "node:buffer"
import type pg from "pg"
import type { TenantScope, RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { parseSnapshotContent } from "./context/context-snapshot-canonical.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"; import type { TurnResumeState } from "./turns/turn-engine-types.js"
import { consumeDurableWaitOutcomes } from "./subagents/durable-wait-consumer.js"
import { isBoundedPlanJson, parsePlanRevisionEvent, parsePlanRevisionReceipt, planRevisionObservation, restorePlanRevisions } from "./planning/plan-revision-receipt.js"
import { filterPlanRevisionEvents, goalRevisionObservation, restoreGoalRevisions } from "./planning/goal-revision-receipt.js"
import { parsePlanCommandReceipt, planCommandObservation } from "./planning/plan-command-receipt.js"
import { hydrateGoalContract } from "./planning/goal-contract-hydration.js"
import type { GoalContract } from "./planning/goal-plan-contract.js"
import { parseContextCompactionObservation } from "./context/context-snapshot-compaction-seam.js"
import { currentPlanId, PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, restorePlanCompletionFeedback, sanitizePlanCompletionFeedbackObservations } from "./planning/plan-completion-feedback.js"
import { restoreCanonicalSteeringMarkers, type SteeringMarkerState } from "./canonical-steering-markers.js"
import { priorConversation } from "./canonical-steering-markers.js"
import { STEERING_MARKER_EVENT_TYPE } from "./context/steering-marker.js"
import { scopeCanonicalWaitProjections } from "./canonical-wait-scope.js"
import type { PersistedTaskGraphEvent } from "./planning/plan-task-graph-adapter.js"
export type CanonicalTurnState = {
  readonly scope: TenantScope
  readonly goal: string
  readonly goalContract?: GoalContract
  readonly modelProfileSnapshot: RepositoryJsonValue
  readonly toolPolicySnapshot: unknown
  readonly budgetSnapshot: unknown
  readonly rootTaskId?: string
  readonly rootInputId?: string
  readonly snapshot: StepContextSnapshot
  readonly planRevision?: number | null
  readonly planProposalHashes?: readonly string[]
  readonly taskGraphEvents?: readonly PersistedTaskGraphEvent[]
  readonly steeringMarkers?: SteeringMarkerState
  readonly resume?: TurnResumeState
}
type Row = Record<string, unknown>; function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
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
function strictObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) ? value as Record<string, unknown> : null
}
function taskGraphEvent(value: unknown): PersistedTaskGraphEvent["event"] {
  const candidate = strictObject(value)
  if (!candidate || Object.keys(candidate).length !== 3 || !["type", "nodeId", "eventId"].every(key => Object.hasOwn(candidate, key))) throw new Error("task_graph_event_invalid")
  if (!(typeof candidate.type === "string" && ["start", "complete", "fail", "wait", "cancel"].includes(candidate.type))) throw new Error("task_graph_event_invalid")
  if (typeof candidate.nodeId !== "string" || !candidate.nodeId || candidate.nodeId.length > 256 || typeof candidate.eventId !== "string" || !candidate.eventId || candidate.eventId.length > 512) throw new Error("task_graph_event_invalid")
  return { type: candidate.type as PersistedTaskGraphEvent["event"]["type"], nodeId: candidate.nodeId, eventId: candidate.eventId }
}
function taskGraphEvents(events: readonly Row[], lease: TurnLease, rootTaskId: unknown): readonly PersistedTaskGraphEvent[] {
  const graphRows = events.filter(event => event.type === "plan.task_graph")
  if (graphRows.length === 0) return []
  if (typeof rootTaskId !== "string" || !rootTaskId) throw new Error("task_graph_scope_invalid")
  let previousSequence: bigint | null = null
  return graphRows.map(row => {
    if (row.userId !== lease.userId || row.sessionId !== lease.sessionId || row.turnId !== lease.turnId || row.taskId !== rootTaskId) throw new Error("task_graph_scope_invalid")
    const payload = eventPayload(row.payload)
    const encoded = JSON.stringify(payload)
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 8 * 1024) throw new Error("task_graph_payload_too_large")
    const envelope = strictObject(payload)
    if (!envelope || Object.keys(envelope).some(key => !["runKey", "event", "state"].includes(key)) || typeof envelope.runKey !== "string" || !envelope.runKey || envelope.runKey.length > 256 || !envelope.runKey.startsWith(`${rootTaskId}:`)) throw new Error("task_graph_payload_invalid")
    const event = taskGraphEvent(envelope.event)
    if (Object.hasOwn(envelope, "state") && !strictObject(envelope.state)) throw new Error("task_graph_state_invalid")
    let sequence: bigint
    try { sequence = BigInt(String(row.sequence)) } catch { throw new Error("task_graph_sequence_invalid") }
    if (previousSequence !== null && sequence <= previousSequence) throw new Error("task_graph_sequence_invalid")
    previousSequence = sequence
    return { runKey: envelope.runKey, event, ...(Object.hasOwn(envelope, "state") ? { state: json(envelope.state) } : {}) }
  })
}
function authoritativeOutputs(events: readonly Row[]): Map<string, unknown> {
  const outputs = new Map<string, unknown>()
  for (const event of events) {
    if (event.type !== "tool_call.completed" && event.type !== "tool_call.failed") continue
    const payload = eventPayload(event.payload)
    if (typeof payload.toolCallId !== "string") continue
    if (Object.prototype.hasOwnProperty.call(payload, "output")) outputs.set(payload.toolCallId, payload.output)
  }
  return outputs
}
function observations(items: readonly Row[], events: readonly Row[], currentGoalRevision: number): StepContextSnapshot["toolObservations"] {
  const calls = new Map<string, Row>(), results = new Set<string>()
  const outputs = authoritativeOutputs(events)
  for (const item of items) {
    const content = object(item.content)
    if (typeof content.toolCallId !== "string") continue
    if ((item.type === "tool_call" || item.type === "tool_result") && item.status !== undefined && item.status !== null && item.status !== "completed" && item.status !== "failed") throw new Error("tool_result_replay_uncertain")
    if (item.type === "tool_call") calls.set(content.toolCallId, content)
    if (item.type === "tool_result") results.add(content.toolCallId)
  }
  if ([...calls.keys()].some(callId => !results.has(callId))) throw new Error("tool_result_replay_uncertain")
  return items.filter(item => item.type === "tool_result").flatMap(item => {
    const content = object(item.content)
    if (typeof content.toolCallId !== "string") return []
    const call = calls.get(content.toolCallId)
    if (!call || typeof call.toolName !== "string") return []
    const output = Object.prototype.hasOwnProperty.call(content, "output") && content.output !== null
      ? content.output
      : outputs.get(content.toolCallId) ?? content.output ?? null
    if (call.toolName === "agent.plan.propose" && object(output).status === "accepted" && object(output).goalRevision !== currentGoalRevision) return []
    return [{ id: `tool-result:${content.toolCallId}`, content: json({
      toolCallId: content.toolCallId, toolName: call.toolName, input: call.input ?? {}, status: call.status ?? (content.errorCode ? "failed" : "completed"),
      output, errorCode: content.errorCode ?? null,
    }) }]
  })
}
function planObservations(events: readonly Row[], currentPlanIds?: ReadonlySet<string>): StepContextSnapshot["toolObservations"] {
  return events.filter(event => event.type === "plan.observation").flatMap(event => {
    const payload = eventPayload(event.payload), id = payload.observationId, content = payload.content, planCallId = payload.planCallId
    if (currentPlanIds && (typeof planCallId !== "string" || !currentPlanIds.has(planCallId))) return []
    if (typeof id !== "string" || id.trim() !== id || id.length === 0 || id.length > 256 || !isBoundedPlanJson(content)) return []
    const encoded = JSON.stringify(content); return encoded === undefined || Buffer.byteLength(encoded, "utf8") > 8 * 1024 ? [] : [{ id, content: json(content) }]
  })
}
function planRevisionObservations(events: readonly Row[], goalRevision: number): StepContextSnapshot["toolObservations"] {
  let current: number | null = null
  return events.flatMap(event => {
    const payload = eventPayload(event.payload)
    const candidate = event.type === "plan.revision"
      ? parsePlanRevisionEvent(payload)
      : event.type === "tool_call.completed" && payload.toolName === "agent.plan.propose" && typeof payload.toolCallId === "string"
        ? parsePlanRevisionReceipt(payload.output, payload.toolCallId)
        : null
    if (!candidate || candidate.goalRevision !== goalRevision || candidate.planRevision !== (current === null ? 1 : current + 1) || candidate.basedOnPlanRevision !== (current === null ? null : current)) return []
    current = candidate.planRevision
    const projection = planRevisionObservation(candidate)
    return [{ id: projection.id, content: json(projection.content) }]
  })
}
function acceptedPlanRevisions(observations: StepContextSnapshot["toolObservations"]): ReadonlyMap<string, number> {
  const revisions = new Map<string, number>()
  for (const observation of observations) {
    const content = object(observation.content)
    if (typeof content.planCallId === "string" && typeof content.planRevision === "number") revisions.set(content.planCallId, content.planRevision)
  }
  return revisions
}
function expectedPlanRevision(payload: Record<string, unknown>, revisions: ReadonlyMap<string, number>): number | undefined {
  return typeof payload.planCallId === "string" ? revisions.get(payload.planCallId) : undefined
}
function planReceiptInScope(planCallId: unknown, currentPlanIds: ReadonlySet<string> | undefined, acceptedRevisions: ReadonlyMap<string, number>): boolean {
  if (currentPlanIds) return typeof planCallId === "string" && currentPlanIds.has(planCallId)
  if (acceptedRevisions.size > 0) return typeof planCallId === "string" && acceptedRevisions.has(planCallId)
  return true
}
function planCommandObservations(events: readonly Row[], currentPlanIds?: ReadonlySet<string>, revisions: ReadonlyMap<string, number> = new Map()): StepContextSnapshot["toolObservations"] {
  return events.filter(event => event.type === "plan.command").flatMap(event => {
    const payload = eventPayload(event.payload)
    const receipt = parsePlanCommandReceipt(payload, undefined, expectedPlanRevision(payload, revisions))
    return receipt && planReceiptInScope(receipt.planCallId, currentPlanIds, revisions) ? [planCommandObservation(receipt)] : []
  })
}
function planActionCount(events: readonly Row[], currentPlanIds?: ReadonlySet<string>, revisions: ReadonlyMap<string, number> = new Map()): number {
  const counted = new Set<string>()
  for (const event of events) {
    if (event.type !== "plan.command" && event.type !== "plan.observation") continue
    const payload = eventPayload(event.payload)
    const receipt = event.type === "plan.command"
      ? parsePlanCommandReceipt(payload, undefined, expectedPlanRevision(payload, revisions))
      : null
    const planCallId = event.type === "plan.command" ? receipt?.planCallId : payload.planCallId
    if (!planReceiptInScope(planCallId, currentPlanIds, revisions)) continue
    const observationId = event.type === "plan.command" ? receipt?.observationId : payload.observationId
    const content = event.type === "plan.command" ? receipt?.content : payload.content
    const contentObject = object(content)
    if (typeof observationId !== "string" || observationId.trim() !== observationId || observationId.length === 0 || observationId.length > 256 || !isBoundedPlanJson(content) || counted.has(observationId) || contentObject.kind !== "plan_command" || !["tool_call", "delegate", "join"].includes(String(contentObject.commandKind))) continue
    counted.add(observationId)
  }
  return counted.size
}
function contextCompactionObservations(events: readonly Row[]): StepContextSnapshot["toolObservations"] {
  return events.filter(event => event.type === "context.compaction").flatMap(event => {
    const observation = parseContextCompactionObservation(eventPayload(event.payload))
    return observation ? [{ id: observation.id, content: json(observation.content) }] : []
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
      `SELECT "id", "type", "status", "content" FROM "agent_items" WHERE "turnId" = $1 AND "sessionId" = $2
       AND ("taskId" IS NULL OR "taskId" = $3) AND "type" IN ('tool_call', 'tool_result') ORDER BY "createdAt" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId],
    )
    const eventsResult = await client.query<Row>(
      `SELECT event."id", event."type", event."actor", event_session."userId" AS "userId", event."sessionId", event."turnId", event."taskId", event."sequence", event."payload" FROM "agent_events" AS event JOIN "agent_sessions" AS event_session ON event_session."id" = event."sessionId" AND event_session."userId" = $4 JOIN "agent_turns" AS event_turn ON event_turn."id" = event."turnId" AND event_turn."sessionId" = event."sessionId" AND event_turn."userId" = $4 WHERE event."turnId" = $1 AND event."sessionId" = $2 AND (event."taskId" IS NULL OR event."taskId" = $3) AND event."type" IN ('tool_call.completed', 'tool_call.failed', 'plan.observation', 'plan.command', 'plan.revision', 'goal.revision', 'context.compaction', 'plan.task_graph', '${PLAN_COMPLETION_FEEDBACK_EVENT_TYPE}', '${STEERING_MARKER_EVENT_TYPE}') ORDER BY event."sequence" ASC`, [lease.turnId, lease.sessionId, turn.rootTaskId, lease.userId],
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
    const hydratedGoal = hydrateGoalContract(turn.input)
    const steeringMarkers = restoreCanonicalSteeringMarkers(eventsResult.rows, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: typeof turn.rootTaskId === "string" ? turn.rootTaskId : null })
    const goalState = restoreGoalRevisions(hydratedGoal.goalContract, eventsResult.rows.map(event => ({ type: event.type, payload: eventPayload(event.payload) })))
    const revisionState = restorePlanRevisions(filterPlanRevisionEvents(eventsResult.rows.map(event => ({ type: event.type, payload: event.payload })), goalState.goalContract.revision).map(event => ({ type: event.type, payload: eventPayload(event.payload) })))
    const revision = revisionState.latest
    const restoredTaskGraphEvents = taskGraphEvents(eventsResult.rows, lease, turn.rootTaskId)
    const currentRevisionObservations = planRevisionObservations(eventsResult.rows, goalState.goalContract.revision)
    const acceptedRevisions = acceptedPlanRevisions(currentRevisionObservations)
    const currentPlanIds = goalState.goalContract.revision > 1 ? new Set(currentRevisionObservations.flatMap(item => { const content = object(item.content); return typeof content.planCallId === "string" ? [content.planCallId] : [] })) : undefined
    const restoredBase = [...observations(itemsResult.rows, eventsResult.rows, goalState.goalContract.revision), ...planObservations(eventsResult.rows, currentPlanIds), ...currentRevisionObservations, ...planCommandObservations(eventsResult.rows, currentPlanIds, acceptedRevisions), ...contextCompactionObservations(eventsResult.rows), ...(goalState.receipt ? [goalRevisionObservation(goalState.receipt)] : []), ...(revision ? [planRevisionObservation(revision)] : [])]
    const scopedSnapshot = scopeCanonicalWaitProjections(sanitizePlanCompletionFeedbackObservations(snapshot.toolObservations, lease.turnId), eventsResult.rows).filter(item => { const content = object(item.content); const output = object(content.output); return (content.kind !== "plan_revision" || content.goalRevision === goalState.goalContract.revision) && (content.toolName !== "agent.plan.propose" || output.status !== "accepted" || output.goalRevision === goalState.goalContract.revision) && (!currentPlanIds || (content.kind !== "plan_command" && content.kind !== "plan_control")) })
    const currentPlan = currentPlanId([...scopedSnapshot, ...restoredBase])
    snapshot = { ...snapshot, toolObservations: sanitizePlanCompletionFeedbackObservations(scopedSnapshot, lease.turnId, currentPlan) }
    const restoredFeedback = restorePlanCompletionFeedback(eventsResult.rows.map(event => ({ type: event.type, payload: eventPayload(event.payload) })), lease.turnId, currentPlan)
    const restored = [...restoredBase, ...restoredFeedback]
    const seen = new Set(snapshot.toolObservations.map(item => item.id))
    const restoredIds = new Set<string>()
    const restoredNew = restored.filter(item => {
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
    const seenHistory = new Set(snapshot.steerHistory.map(item => item.id))
    snapshot = {
      ...snapshot,
      goal: { id: `turn-goal:${lease.turnId}`, content: goalState.goalContract.objective },
      steerHistory: [...snapshot.steerHistory, ...history.filter(item => !seenHistory.has(item.id)).map(({ sequence: _sequence, ...item }) => item)],
      toolObservations: [...snapshot.toolObservations, ...restoredNew, ...scopeCanonicalWaitProjections(consumedWaits, eventsResult.rows).filter(item => !seenWithRestored.has(item.id))],
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
      planActionCount: planActionCount(eventsResult.rows, currentPlanIds, acceptedRevisions),
      inputThroughSequence: BigInt(String(last?.inputThroughSequence ?? 0)),
      consumedInputIds: Array.isArray(last?.consumedInputIds) ? last.consumedInputIds.filter((id): id is string => typeof id === "string") : [],
      usage,
    } satisfies TurnResumeState : undefined
     const result = { scope, goal: goalState.goalContract.objective, goalContract: goalState.goalContract, modelProfileSnapshot: json(turn.modelProfileSnapshot), toolPolicySnapshot: turn.toolPolicySnapshot ?? {}, budgetSnapshot: turn.budgetSnapshot ?? {}, planRevision: revision?.planRevision ?? null, planProposalHashes: revisionState.hashes, ...(restoredTaskGraphEvents.length > 0 ? { taskGraphEvents: restoredTaskGraphEvents } : {}), steeringMarkers, ...(typeof turn.rootTaskId === "string" ? { rootTaskId: turn.rootTaskId } : {}), ...(rootInput.rows[0] ? { rootInputId: rootInput.rows[0].id } : {}), snapshot, ...(resume ? { resume } : {}) }
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
