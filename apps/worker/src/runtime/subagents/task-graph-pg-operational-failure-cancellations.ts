import type pg from "pg"
import type { TaskGraphOperationalFailedBranchRelation, TaskGraphOperationalIdentity } from "./task-graph-pg-operational-failed-branch-relation.js"
import type { TaskGraphBranchSourceRow } from "./task-graph-pg-branch-repair.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventIdentity = TaskGraphOperationalFailedBranchRelation["priorCancellations"][number]["event"]
type PriorCancellation = TaskGraphOperationalFailedBranchRelation["priorCancellations"][number]
const PREREQUISITE_FAILURE = "A prerequisite task did not complete."

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function sequence(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) }
function timestamp(value: unknown): boolean { return value instanceof Date ? Number.isFinite(value.getTime()) : typeof value === "string" && Number.isFinite(Date.parse(value)) }
function pristineCancelled(row: TaskGraphBranchSourceRow): boolean {
  return row.status === "cancelled" && row.attemptCount === 0 && row.failureReason === PREREQUISITE_FAILURE
    && row.leaseOwner === null && row.leaseExpiresAt === null && row.nextAttemptAt === null && row.startedAt === null
    && row.completedAt !== null && row.closedAt === null && row.interruptRequestedAt === null && row.result === null
    && row.confidence === null && row.qualityGateResult === null && row.contextSnapshotId === null
    && Array.isArray(row.outputArtifactIds) && row.outputArtifactIds.length === 0 && row.hasCanonicalDispatch === false
}
function eventEnvelope(row: Row, scope: GraphIdentityScope, node: StoredTaskGraphNode, snapshot: TaskGraphSnapshot,
  failureSequence: bigint, observedSequence: bigint): EventIdentity | null {
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, 0, "task.cancelled"), seq = String(row.sequence)
  const payload = object(row.payload), event = parseTaskGraphEvent(object(payload?.event)), item = object(payload?.item)
  if (!id(row.id) || !sequence(seq) || BigInt(seq) <= failureSequence || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId || row.itemId !== taskGraphItemId(scope.rootTaskId)
    || row.taskId !== node.taskId || row.type !== "item.delta" || row.actor !== "system" || row.correlationId !== scope.turnId
    || row.causationId !== null || row.idempotencyKey !== key || payload?.kind !== "lifecycle"
    || Object.keys(payload).sort().join(",") !== "event,item,kind,revision" || event?.type !== "task.cancelled"
    || event.nodeKey !== node.key || event.idempotencyKey !== key || !Number.isSafeInteger(event.expectedRevision)
    || Number(event.expectedRevision) < 0 || payload.revision !== Number(event.expectedRevision) + 1
    || !item || Object.keys(item).sort().join(",") !== "completedAt,content,createdAt,id,phase,revision,schemaVersion,sessionId,startedAt,status,stepId,taskId,turnId,type,updatedAt"
    || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.rootTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.rootTaskId || item.type !== "task_graph"
    || (item.status !== "running" && item.status !== "streaming") || (item.phase !== null && typeof item.phase !== "string")
    || (item.stepId !== null && !id(item.stepId))
    || item.revision !== payload.revision || !timestamp(item.startedAt) || !timestamp(item.createdAt) || !timestamp(item.updatedAt)
    || (item.completedAt !== null && !timestamp(item.completedAt))) return null
  try { if (!same(parseTaskGraphSnapshot(item.content), snapshot)) return null } catch { return null }
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence: seq, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !same(row.outboxPayload, expectedOutbox)) return null
  if (BigInt(seq) > observedSequence) return null
  return { id: row.id, sequence: seq, idempotencyKey: key }
}
function strings(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return Array.isArray(parsed) && parsed.every(item => id(item) && item.length <= 256) ? parsed as string[] : null
}
function exactKeys(value: Row | null, keys: readonly string[]): boolean {
  return value !== null && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function terminal(value: unknown): boolean { return ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(value)) }
function time(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
function validConsumedRootWait(wait: Row, scope: GraphIdentityScope, targetRows: ReadonlyMap<string, Row>): boolean {
  const targets = strings(wait.targetTaskIds), matched = strings(wait.matchedTaskIds), result = object(wait.result)
  const request = object(result?.request), outcome = object(result?.outcome), taskValues = Array.isArray(outcome?.tasks) ? outcome.tasks : null
  const created = time(wait.createdAt), resolved = time(wait.resolvedAt), consumed = time(wait.consumedAt)
  if (!result || !request || !outcome || !taskValues) return false
  if (wait.parentTaskId !== scope.rootTaskId || wait.userId !== scope.userId || wait.sessionUserId !== scope.userId
    || wait.sessionId !== scope.sessionId || wait.turnId !== scope.turnId
    || !id(wait.id) || !id(wait.stepId) || !id(wait.idempotencyKey)
    || wait.parentId !== scope.rootTaskId || wait.parentSessionId !== scope.sessionId || wait.parentTurnId !== scope.turnId
    || wait.parentRootTaskId !== null && wait.parentRootTaskId !== undefined && wait.parentRootTaskId !== scope.rootTaskId
    || wait.parentParentTaskId !== null || wait.parentRole !== "orchestrator" || wait.parentTaskType !== "root"
    || wait.turnUserId !== scope.userId || wait.turnRootTaskId !== null && wait.turnRootTaskId !== undefined && wait.turnRootTaskId !== scope.rootTaskId
    || wait.stepTaskId !== scope.rootTaskId && wait.stepTaskId !== null || Number(wait.stepAttempt) !== 1
    || wait.mode !== "all" || wait.status !== "ready" || created === null || resolved === null || consumed === null
    || !timestamp(wait.suspendedAt) || resolved < created || consumed < resolved
    || !targets || !matched || targets.length === 0 || targets.length > 8 || new Set(targets).size !== targets.length
    || !sameIds(targets, [...targets].sort()) || !sameIds(matched, targets) || !exactKeys(result, ["request", "outcome"])
    || !exactKeys(request, ["mode", "targetTaskIds", "timeoutMs"]) || request.mode !== "all"
    || !Number.isSafeInteger(request.timeoutMs) || Number(request.timeoutMs) < 1 || Number(request.timeoutMs) > 86_400_000
    || !sameIds(strings(request.targetTaskIds) ?? [], targets)
    || !exactKeys(outcome, ["waitId", "status", "matchedTaskIds", "targetTaskIds", "tasks"])
    || outcome.waitId !== wait.id || outcome.status !== "ready" || !sameIds(strings(outcome.targetTaskIds) ?? [], targets)
    || !sameIds(strings(outcome.matchedTaskIds) ?? [], targets) || taskValues.length !== targets.length) return false
  const tasks = new Map<string, Row>()
  for (const value of taskValues) {
    const task = object(value)
    const keys = task && Object.hasOwn(task, "verificationReport")
      ? ["taskId", "status", "role", "result", "failureReason", "verificationReport"]
      : task && Object.hasOwn(task, "repairReceipt")
        ? ["taskId", "status", "role", "result", "failureReason", "repairReceipt"]
        : ["taskId", "status", "role", "result", "failureReason"]
    if (!task || !exactKeys(task, keys) || !id(task.taskId) || tasks.has(task.taskId) || !terminal(task.status)
      || typeof task.role !== "string" || !task.role.trim() || task.role.length > 256) return false
    tasks.set(task.taskId, task)
  }
  if (targets.some(taskId => !tasks.has(taskId) || !targetRows.has(taskId))) return false
  for (const taskId of targets) {
    const task = tasks.get(taskId)!, row = targetRows.get(taskId)!
    if (task.status !== row.status || task.role !== row.role || String(row.rootTaskId ?? row.id) !== scope.rootTaskId
      || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.userId !== scope.userId) return false
    if (row.status === "cancelled" && (!exactKeys(task, ["taskId", "status", "role", "result", "failureReason"])
      || task.result !== null || task.failureReason !== null)) return false
  }
  return true
}
async function rootWaitReferencesAreValid(client: Client, scope: GraphIdentityScope, descendantIds: readonly string[]): Promise<boolean> {
  if (descendantIds.length === 0) return true
  const rows = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId", wait."idempotencyKey",
      wait."targetTaskIds", wait."mode", wait."status", wait."matchedTaskIds", wait."result", wait."createdAt", wait."resolvedAt", wait."suspendedAt", wait."consumedAt",
      session."userId" AS "sessionUserId",
      parent."id" AS "parentId", parent."sessionId" AS "parentSessionId", parent."turnId" AS "parentTurnId",
      parent."rootTaskId" AS "parentRootTaskId", parent."parentTaskId" AS "parentParentTaskId", parent."role" AS "parentRole", parent."taskType" AS "parentTaskType",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt"
    FROM "agent_wait_conditions" wait LEFT JOIN "agent_sessions" session ON session."id" = wait."sessionId"
    LEFT JOIN "agent_turns" turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
    LEFT JOIN "sub_agent_tasks" parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId"
    LEFT JOIN "agent_steps" step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    WHERE wait."parentTaskId" = ANY($1::text[]) OR wait."targetTaskIds" ?| $1::text[] OR wait."matchedTaskIds" ?| $1::text[]`,
  [descendantIds])
  if (rows.rows.length === 0) return true
  const targetIds = [...new Set(rows.rows.flatMap(wait => strings(wait.targetTaskIds) ?? []))]
  const targets = targetIds.length ? await client.query<Row>(`SELECT task."id", task."rootTaskId", task."sessionId", task."turnId", task."status", task."role", session."userId" AS "userId"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5`,
  [targetIds, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId]) : { rows: [] }
  const targetRows = new Map(targets.rows.map(row => [String(row.id), row]))
  return rows.rows.every(wait => validConsumedRootWait(wait, scope, targetRows))
}

const OTHER_EVIDENCE = `EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_steps" row WHERE row."sessionId" = task."sessionId" AND row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_items" row WHERE row."sessionId" = task."sessionId" AND row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_tree_budget_reservations" row WHERE row."taskId" = task."id" OR row."rootTaskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_native_semantic_rejections" row WHERE row."rootTaskId" = task."id" OR row."controlTaskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_mailbox_messages" row WHERE row."fromTaskId" = task."id" OR row."toTaskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_mailbox_hydration_checkpoints" row WHERE row."rootTaskId" = task."id" OR row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_tool_result_references" row WHERE row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_transcript_events" row WHERE row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_approvals" row WHERE row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_artifact_version" row WHERE row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_artifact_review" row WHERE row."taskId" = task."id")
  OR EXISTS (SELECT 1 FROM "application_tasks" row WHERE row."workerTaskId" = task."id")
  OR EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE (outbox."payload"->>'taskId' = task."id" OR outbox."payload"->'payload'->>'taskId' = task."id")
    AND NOT (outbox."topic" = 'agent.session.event' AND outbox."aggregateId" = task."sessionId"
      AND outbox."idempotencyKey" = 'agent-event:' || event."id"))`

/** Returns only automatic, pristine dependency cancellations from the exact failed graph attempt. */
export async function proveTaskGraphOperationalFailureCancellations(client: Client, input: Readonly<{
  scope: GraphIdentityScope
  failureGraph: TaskGraphSnapshot
  failureSequence: string
  observedSequence: string
  sourceNodes: readonly StoredTaskGraphNode[]
  failedNode: StoredTaskGraphNode
}>): Promise<readonly PriorCancellation[] | null> {
  if (!sequence(input.failureSequence) || !sequence(input.observedSequence)
    || BigInt(input.observedSequence) < BigInt(input.failureSequence)) return null
  const failureSequence = BigInt(input.failureSequence), observedSequence = BigInt(input.observedSequence), output: PriorCancellation[] = []
  const descendants = input.sourceNodes.filter(node => node.taskId !== input.failedNode.taskId)
  if (!input.sourceNodes.some(node => node.taskId === input.failedNode.taskId
    && same(node, input.failureGraph.nodes.find(candidate => candidate.taskId === node.taskId)))
    || descendants.some(node => !same(node, input.failureGraph.nodes.find(candidate => candidate.taskId === node.taskId)))) return null
  const taskRows = await client.query<Row>(`SELECT task."id", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
      task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."failureReason",
      task."result", task."confidence", task."qualityGateResult", task."contextSnapshotId", task."outputArtifactIds",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
        AND dispatch."payload"->>'taskId' = task."id" AND dispatch."payload"->>'sessionId' = task."sessionId"
        AND dispatch."payload"->>'rootTaskId' = task."rootTaskId") AS "hasCanonicalDispatch"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5 ORDER BY task."id"`,
  [descendants.map(node => node.taskId), input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  if (taskRows.rows.length !== descendants.length) return null
  const taskById = new Map(taskRows.rows.map(row => [String(row.id), row]))
  if (!await rootWaitReferencesAreValid(client, input.scope, descendants.map(node => node.taskId))) return null
  for (const node of descendants) {
    const task = taskById.get(node.taskId)!
    if (task.failureReason !== PREREQUISITE_FAILURE) continue
    if (!pristineCancelled(task as TaskGraphBranchSourceRow)) return null
    const key = taskGraphLifecycleKey(input.scope.rootTaskId, node.key, 0, "task.cancelled")
    const rows = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId",
        event."sequence"::text AS "sequence", event."type", event."actor", event."correlationId", event."causationId",
        event."idempotencyKey", event."payload", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
        outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId",
        outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload",
        (${OTHER_EVIDENCE}) AS "hasOtherEvidence",
        (SELECT COUNT(*)::int FROM "agent_events" other WHERE other."sessionId" = task."sessionId" AND other."taskId" = task."id") AS "eventCount"
      FROM "sub_agent_tasks" task JOIN "agent_events" event ON event."sessionId" = task."sessionId" AND event."taskId" = task."id"
      JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      LEFT JOIN "agent_outbox" outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $4 AND task."status" = 'cancelled' AND task."attemptCount" = 0
        AND event."idempotencyKey" = $5 AND turn."userId" = $6 AND turn."rootTaskId" = $4`,
    [node.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, key, input.scope.userId])
    if (rows.rows.length !== 1 || rows.rows[0]?.eventCount !== 1 || rows.rows[0]?.hasOtherEvidence !== false) return null
    const event = eventEnvelope(rows.rows[0]!, input.scope, node, input.failureGraph, failureSequence, observedSequence)
    if (!event) return null
    output.push({ source: { nodeKey: node.key, taskId: node.taskId } satisfies TaskGraphOperationalIdentity, event })
  }
  output.sort((left, right) => BigInt(left.event.sequence) < BigInt(right.event.sequence) ? -1 : 1)
  return output
}
