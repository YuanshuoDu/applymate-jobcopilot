import type pg from "pg"
import { normalizeAgentLocationAllowlist, redactSensitiveText } from "@jobcopilot/shared"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { isOrdinaryRegisteredScout } from "../subagents/task-graph-pending-scout-scope.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, canonicalTaskGraphJson, parseTaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import { parsePersistedTaskGraphReceipt } from "../subagents/task-graph-pg-event-validation.js"
import { parseSteeringReconciliationReceipt, STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_SCHEMA_VERSION, type SteeringReconciliationState } from "../subagents/steering-reconciliation-contract.js"
import { parseTaskGraphSupersededScoutRetirementReceipt, TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE,
  taskGraphScoutRetirementIdempotencyKeyFromIdentity, type TaskGraphSupersededScoutRetirementReceipt } from "../subagents/task-graph-scout-retirement-contract.js"
import { readTaskGraphConfirmedLocationSteerAtSequence } from "../subagents/task-graph-confirmed-location-steer.js"
import type { GraphIdentityScope, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphRetiredScoutProof } from "../subagents/task-graph-final-summary-binding.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Scope = GraphIdentityScope
type EventRow = Row & Readonly<{ id: string; sequence: unknown; payload: unknown }>; type BoundEvent = EventRow & Readonly<{ sequence: bigint; payload: Row; idempotencyKey: string }>
type StepRow = Row & Readonly<{ id: string; ordinal: number; attempt: number; status: string }>
const MAX_SEQUENCE = (1n << 63n) - 1n, empty = () => new Map<string, TaskGraphRetiredScoutProof>()
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null } catch { return null }
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function sequence(value: unknown): bigint | null {
  try { const n = typeof value === "bigint" ? value : typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) ? BigInt(value) : -1n
    return n > 0n && n <= MAX_SEQUENCE ? n : null } catch { return null }
}
function timestamp(value: unknown): string | null { const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : null }
function scopeValid(scope: Scope): boolean { return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId].every(id)
  && scope.parentTaskId === scope.rootTaskId }

/** Returns only internally proven terminal retirements; invalid receipts remain subject to the old gate. */
export async function readTaskGraphRetiredScouts(client: Client, scope: Scope, loaded: LoadedGraph,
  reconciliation: SteeringReconciliationState): Promise<ReadonlyMap<string, TaskGraphRetiredScoutProof>> {
  try {
    if (!client || !scopeValid(scope) || loaded.discoveryTurnEligibility !== "ordinary" || !loaded.item || !loaded.snapshot
      || !loaded.state || loaded.item.revision !== loaded.state.revision || !loaded.sourceInputCheckpointByNodeKey
      || reconciliation.unresolvedInputs.length > 0) return empty()
    const eligible = loaded.snapshot.nodes.filter(node => {
      const task = loaded.tasks.get(node.taskId)
      return task?.status === "interrupted" && isOrdinaryRegisteredScout(node, { ...task, failureReason: null })
    })
    if (!eligible.length) return empty()
    const rows = await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."itemId", event."taskId",
        event."correlationId", event."causationId", event."idempotencyKey", event."payload",
        EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" event JOIN "agent_sessions" session ON session."id" = event."sessionId"
      JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."type" = $4
        AND turn."rootTaskId" = $5 AND turn."userId" = $6 AND session."userId" = $6
      ORDER BY event."sequence" ASC LIMIT $7`,
    [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE,
      scope.rootTaskId, scope.userId, TASK_GRAPH_LIMITS.maxPersistedNodes + 1])
    if (rows.rows.length > TASK_GRAPH_LIMITS.maxPersistedNodes) return empty()
    const counts = new Map<string, number>()
    for (const row of rows.rows) if (id(row.taskId)) counts.set(row.taskId, (counts.get(row.taskId) ?? 0) + 1)
    const proofs = empty()
    for (const raw of rows.rows) {
      const receipt = parseTaskGraphSupersededScoutRetirementReceipt(raw.payload, {
        sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      })
      if (!receipt || counts.get(receipt.taskId) !== 1 || !eligible.some(node => node.key === receipt.nodeKey && node.taskId === receipt.taskId)) continue
      const proof = await validateRetirement(client, scope, loaded, reconciliation, raw as EventRow, receipt)
      if (proof && !proofs.has(proof.nodeKey)) proofs.set(proof.nodeKey, proof)
    }
    return proofs
  } catch { return empty() }
}

async function validateRetirement(client: Client, scope: Scope, loaded: LoadedGraph, state: SteeringReconciliationState,
  event: EventRow, receipt: TaskGraphSupersededScoutRetirementReceipt): Promise<TaskGraphRetiredScoutProof | null> {
  const nodes = loaded.snapshot!.nodes, current = nodes.find(node => node.key === receipt.nodeKey), replacement = nodes.find(node => node.key === receipt.replacementNodeKey)
  const task = current && loaded.tasks.get(current.taskId), replacementTask = replacement && loaded.tasks.get(replacement.taskId)
  const revision = loaded.item!.revision
  const eventSeq = sequence(event.sequence), accepted = BigInt(receipt.acceptedSteerSequence)
  if (!eventSeq || !id(event.id) || event.type !== TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE || event.actor !== "system"
    || event.itemId !== taskGraphItemId(scope.rootTaskId) || event.taskId !== receipt.taskId || event.correlationId !== scope.turnId
    || !id(event.causationId)
    || !/^task_graph\.scout_retirement:sha256:[0-9a-f]{64}$/u.test(String(event.idempotencyKey)) || event.hasOutbox !== false
    || receipt.graphRevision > revision || receipt.acceptedPlanRevision > receipt.graphRevision || state.lastReconciledInputThroughSequence === undefined
    || state.lastReconciledInputThroughSequence < accepted || !current || !replacement || !task
    || !isOrdinaryRegisteredScout(current, { ...task, failureReason: null })
    || state.currentRevision !== revision || task.status !== "interrupted" || task.attemptCount !== receipt.attempt || current.dependsOn.length !== 0
    || nodes.some(node => node.key !== current.key && (node.dependsOn.includes(current.key) || node.repairOf?.nodeKey === current.key))
    || checkpoint(loaded, current.key) === null || checkpoint(loaded, current.key)! >= accepted
    || replacement.taskId !== receipt.replacementTaskId || !replacementTask || !isOrdinaryRegisteredScout(replacement, replacementTask)
    || checkpoint(loaded, replacement.key) === null || checkpoint(loaded, replacement.key)!.toString() !== receipt.replacementSourceSequence
    || checkpoint(loaded, replacement.key)! < accepted) return null
  const actionStep = event.causationId
  const steerScope = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId }
  const [plan, reconciliation, taskRow, ack, steps, acceptedSteer, action] = await Promise.all([
    readEvent(client, scope, receipt.planEventId, receipt.planEventSequence),
    readEvent(client, scope, receipt.reconciliationEventId, receipt.reconciliationEventSequence),
    readTask(client, scope, receipt), readAck(client, scope, loaded, receipt),
    readSteps(client, scope, actionStep, receipt.reconciliationStepId),
    readTaskGraphConfirmedLocationSteerAtSequence(client, steerScope, BigInt(receipt.reconciliationThroughSequence), accepted),
    readAction(client, scope, actionStep, receipt, String(event.idempotencyKey)),
  ])
  if (!plan || !reconciliation || !taskRow || !ack || !steps || acceptedSteer.kind !== "confirmed" || !action) return null
  const planPayload = plan.payload, planReceipt = object(planPayload.receipt), planItem = object(planPayload.item)
  const reconciliationReceipt = parseSteeringReconciliationReceipt(reconciliation.payload)
  const plannedLocations = nodeLocations(receipt, plan)
  if (plan.sequence >= reconciliation.sequence || reconciliation.sequence >= eventSeq || eventSeq >= ack.sequence
    || steps.action.ordinal <= steps.reconciliation.ordinal || timestamp(taskRow.interruptRequestedAt) !== receipt.interruptRequestedAt
    || !planReceipt || planReceipt.status !== "accepted" || planPayload.revision !== receipt.acceptedPlanRevision
    || planReceipt.revision !== receipt.acceptedPlanRevision || planItem?.stepId !== receipt.reconciliationStepId
    || plan.type !== (receipt.acceptedPlanRevision === 1 ? "item.started" : "item.delta") || plan.actor !== "orchestrator"
    || plan.itemId !== taskGraphItemId(scope.rootTaskId) || plan.taskId !== scope.rootTaskId || plan.correlationId !== scope.turnId
    || plan.causationId !== receipt.reconciliationStepId || plan.idempotencyKey !== receipt.planIdempotencyKey || plan.hasOutbox !== true
    || plan.idempotencyKey !== taskGraphProposalKey(scope.rootTaskId, receipt.acceptedPlanRevision - 1)
    || reconciliation.type !== STEERING_RECONCILIATION_EVENT_TYPE || reconciliation.actor !== "orchestrator"
    || reconciliation.itemId !== null || reconciliation.taskId !== scope.rootTaskId || reconciliation.correlationId !== scope.turnId
    || reconciliation.causationId !== receipt.reconciliationStepId || reconciliation.idempotencyKey !== receipt.reconciliationIdempotencyKey
    || reconciliation.hasOutbox !== false || !reconciliationReceipt || reconciliationReceipt.schemaVersion !== STEERING_RECONCILIATION_SCHEMA_VERSION
    || reconciliationReceipt.sessionId !== scope.sessionId || reconciliationReceipt.turnId !== scope.turnId
    || reconciliationReceipt.rootTaskId !== scope.rootTaskId || reconciliationReceipt.decision !== "revise"
    || reconciliationReceipt.observedRevision + 1 !== receipt.acceptedPlanRevision
    || reconciliationReceipt.resultingRevision !== receipt.acceptedPlanRevision || reconciliationReceipt.stepId !== receipt.reconciliationStepId
    || reconciliationReceipt.inputCheckpoint.throughSequence !== receipt.reconciliationThroughSequence
    || reconciliationReceipt.steerInputIds.length !== 1 || reconciliationReceipt.steerInputIds[0] !== acceptedSteer.acceptedInputId
    || plannedLocations === null || canonicalTaskGraphJson(plannedLocations) !== canonicalTaskGraphJson(acceptedSteer.locations)) return null
  try { parsePersistedTaskGraphReceipt(plan.type, planPayload, loaded.item!, loaded.snapshot!, scope, {
    type: plan.type, itemId: plan.itemId, taskId: plan.taskId, idempotencyKey: plan.idempotencyKey,
  }) } catch { return null }
  const source = parseTaskGraphSnapshot(planItem.content)
  const prior = source.nodes.find(node => node.key === receipt.nodeKey), planned = source.nodes.find(node => node.key === receipt.replacementNodeKey)
  if (!prior || !planned || canonicalTaskGraphJson(prior) !== canonicalTaskGraphJson(current)
    || canonicalTaskGraphJson(planned) !== canonicalTaskGraphJson(replacement)) return null
  const created = object(plan.payload.receipt)?.nodes
  if (!Array.isArray(created) || created.filter(value => object(value)?.key === receipt.replacementNodeKey
    && object(value)?.taskId === receipt.replacementTaskId).length !== 1) return null
  return { nodeKey: receipt.nodeKey, taskId: receipt.taskId, attempt: receipt.attempt,
    interruptRequestedAt: receipt.interruptRequestedAt, receiptEventId: event.id, lifecycleEventId: ack.id }
}
function checkpoint(loaded: LoadedGraph, key: string): bigint | null { return loaded.sourceInputCheckpointByNodeKey?.get(key)?.inputThroughSequence ?? null }
async function readEvent(client: Client, scope: Scope, eventId: string, eventSequence: string): Promise<BoundEvent | null> {
  const result = await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."itemId", event."taskId",
      event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" event JOIN "agent_sessions" session ON session."id" = event."sessionId"
    JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."id" = $1 AND event."sequence" = $2::bigint AND event."sessionId" = $3 AND event."turnId" = $4
      AND turn."rootTaskId" = $5 AND turn."userId" = $6 AND session."userId" = $6 LIMIT 2`,
  [eventId, eventSequence, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, seq = sequence(row.sequence), payload = object(row.payload)
  return seq && id(row.id) && payload ? { ...row, id: row.id, sequence: seq, payload, idempotencyKey: String(row.idempotencyKey) } : null
}
function nodeLocations(receipt: TaskGraphSupersededScoutRetirementReceipt, plan: BoundEvent): readonly string[] | null {
  const content = object(plan.payload.item)?.content
  let snapshot: ReturnType<typeof parseTaskGraphSnapshot>
  try { snapshot = parseTaskGraphSnapshot(content) } catch { return null }
  const node = snapshot.nodes.find(item => item.key === receipt.replacementNodeKey && item.taskId === receipt.replacementTaskId)
  const checks = node?.verification?.criteria.filter(item => item.id === "candidate-location") ?? []
  const check = checks.length === 1 ? checks[0]?.check : undefined
  if (check?.kind !== "candidate_location_in" || !Array.isArray(check.locations)) return null
  const normalized = normalizeAgentLocationAllowlist(check.locations)
  return normalized && canonicalTaskGraphJson(normalized) === canonicalTaskGraphJson(check.locations) ? normalized : null
}
function matchingText(value: unknown, expected: string): boolean { return value === expected || value === redactSensitiveText(expected) }
async function readAction(client: Client, scope: Scope, stepId: string, receipt: TaskGraphSupersededScoutRetirementReceipt,
  idempotencyKey: string): Promise<boolean> {
  const calls = await client.query<Row>(`SELECT item."id", item."status", item."content" FROM "agent_items" item
    JOIN "agent_steps" step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
    JOIN "agent_turns" turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    JOIN "agent_sessions" session ON session."id" = step."sessionId" AND session."userId" = turn."userId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."stepId" = $3 AND item."taskId" = $4
      AND item."type" = 'tool_call' AND item."content"->>'toolName' = 'agent.retire_superseded_scout'
      AND step."taskId" = $4 AND turn."rootTaskId" = $4 AND turn."userId" = $5 AND session."userId" = $5 LIMIT 32`,
  [scope.sessionId, scope.turnId, stepId, scope.rootTaskId, scope.userId])
  const matches: string[] = []
  for (const raw of calls.rows) {
    const content = object(raw.content), input = object(content?.input)
    const keys = content ? Object.keys(content).sort().join(",") : ""
    const preResult = raw.status === "started" && keys === "input,toolCallId,toolName,toolVersion"
    const completed = raw.status === "completed" && keys === "errorCode,input,status,toolCallId,toolName,toolVersion"
      && content?.status === "completed" && content.errorCode === null
    if (!id(raw.id) || !content || content.toolVersion !== "1" || !(preResult || completed)
      || content.toolName !== "agent.retire_superseded_scout" || !id(content.toolCallId) || !input
      || Object.keys(input).sort().join(",") !== "expectedRevision,taskId"
      || input.expectedRevision !== receipt.graphRevision || !matchingText(input.taskId, receipt.taskId)) continue
    const key = taskGraphScoutRetirementIdempotencyKeyFromIdentity({ scope: { userId: scope.userId, sessionId: scope.sessionId,
      turnId: scope.turnId, rootTaskId: scope.rootTaskId, stepId }, expectedRevision: receipt.graphRevision,
      taskId: receipt.taskId, callId: content.toolCallId })
    if (key === idempotencyKey) matches.push(content.toolCallId)
  }
  if (matches.length !== 1) return false
  return true
}

async function readTask(client: Client, scope: Scope, receipt: TaskGraphSupersededScoutRetirementReceipt): Promise<Row | null> {
  const result = await client.query<Row>(`SELECT task."id", task."status", task."role", task."taskType", task."attemptCount",
      task."interruptRequestedAt", task."leaseOwner", task."leaseExpiresAt",
      EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"
        AND child."rootTaskId" = task."rootTaskId" AND child."parentTaskId" = task."id") AS "hasChild"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND turn."rootTaskId" = $4 AND turn."userId" = $5 AND session."userId" = $5 LIMIT 2`,
  [receipt.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.status === "interrupted" && row.role === "scout" && row.taskType === "job_discovery"
    && Number(row.attemptCount) === receipt.attempt && row.leaseOwner === null && row.leaseExpiresAt === null
    && row.hasChild === false && timestamp(row.interruptRequestedAt) === receipt.interruptRequestedAt ? row : null
}

async function readAck(client: Client, scope: Scope, loaded: LoadedGraph, receipt: TaskGraphSupersededScoutRetirementReceipt): Promise<EventRow & { sequence: bigint } | null> {
  const key = taskGraphLifecycleKey(scope.rootTaskId, receipt.nodeKey, receipt.attempt, "task.interrupted")
  const result = await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."itemId", event."taskId",
      event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" event JOIN "agent_sessions" session ON session."id" = event."sessionId"
    JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
      AND event."idempotencyKey" = $5 AND event."type" = 'item.delta' AND turn."rootTaskId" = $6
      AND turn."userId" = $7 AND session."userId" = $7 LIMIT 2`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), receipt.taskId, key, scope.rootTaskId, scope.userId])
  const row = result.rows[0] as EventRow | undefined, payload = object(row?.payload), item = object(payload?.item), revision = Number(item?.revision)
  if (result.rows.length !== 1 || !row || !id(row.id) || row.actor !== "system" || row.correlationId !== scope.turnId
    || row.causationId !== null || row.hasOutbox !== true || !payload || payload.kind !== "lifecycle" || !item
    || payload.revision !== revision || !Number.isSafeInteger(revision) || item.id !== taskGraphItemId(scope.rootTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.rootTaskId
    || item.type !== "task_graph" || revision > loaded.item!.revision) return null
  const event = parsePersistedTaskGraphReceipt(row.type, payload, loaded.item!, loaded.snapshot!, scope, {
    type: row.type, itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey,
  })
  const seq = sequence(row.sequence)
  return event?.type === "task.interrupted" && event.nodeKey === receipt.nodeKey && event.idempotencyKey === key && seq
    ? { ...row, sequence: seq } : null
}

async function readSteps(client: Client, scope: Scope, actionStepId: string, reconciliationStepId: string): Promise<{ action: StepRow; reconciliation: StepRow } | null> {
  const result = await client.query<StepRow>(`SELECT step."id", step."ordinal", step."attempt", step."status", step."taskId",
      turn."rootTaskId" AS "turnRootTaskId", turn."userId" AS "turnUserId", session."userId" AS "sessionUserId"
    FROM "agent_steps" step JOIN "agent_turns" turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    JOIN "agent_sessions" session ON session."id" = step."sessionId" AND session."userId" = turn."userId"
    WHERE step."id" = ANY($1::text[]) AND step."sessionId" = $2 AND step."turnId" = $3
      AND step."taskId" = $4 AND turn."rootTaskId" = $4 AND turn."userId" = $5 AND session."userId" = $5 LIMIT 3`,
  [[actionStepId, reconciliationStepId], scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (result.rows.length !== 2) return null
  const action = result.rows.find(row => row.id === actionStepId), reconciliation = result.rows.find(row => row.id === reconciliationStepId)
  return action && reconciliation && Number.isSafeInteger(action.ordinal) && Number.isSafeInteger(reconciliation.ordinal)
    && Number(action.attempt) === 1 && Number(reconciliation.attempt) === 1
    && STEP_STATUSES.has(action.status) && STEP_STATUSES.has(reconciliation.status)
    ? { action, reconciliation } : null
}
