import type pg from "pg"
import type { TaskGraphOperationalFailedBranchRelation, TaskGraphOperationalIdentity } from "./task-graph-pg-operational-failed-branch-relation.js"
import type { TaskGraphBranchSourceRow } from "./task-graph-pg-branch-repair.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { proveTaskGraphOperationalRootWaitReferences } from "./task-graph-pg-operational-failure-root-waits.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventIdentity = TaskGraphOperationalFailedBranchRelation["priorCancellations"][number]["event"]
type PriorCancellation = TaskGraphOperationalFailedBranchRelation["priorCancellations"][number]
type CancellationInput = Readonly<{ scope: GraphIdentityScope; failureGraph: TaskGraphSnapshot; failureSequence: string; observedSequence: string;
  sourceNodes: readonly StoredTaskGraphNode[]; failedNode: StoredTaskGraphNode }>
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

/** Reads automatic, pristine dependency cancellations from the exact failed graph attempt, without wait authority. */
export async function readTaskGraphOperationalPriorCancellations(client: Client, input: CancellationInput): Promise<readonly PriorCancellation[] | null> {
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

/** Preserves the strict wait proof used by fresh scheduling and legacy callers. */
export async function proveTaskGraphOperationalFailureCancellations(client: Client, input: CancellationInput): Promise<readonly PriorCancellation[] | null> {
  const prior = await readTaskGraphOperationalPriorCancellations(client, input)
  if (!prior) return null
  const descendants = input.sourceNodes.filter(node => node.taskId !== input.failedNode.taskId)
  return await proveTaskGraphOperationalRootWaitReferences(client, { scope: input.scope, taskIds: descendants.map(node => node.taskId) }) ? prior : null
}

/** Revalidates the full closure after history has proven its exact operation-cancellation receipts. */
export async function proveTaskGraphOperationalHistoryCancellations(client: Client, input: CancellationInput & Readonly<{
  operationCancellations: TaskGraphOperationalFailedBranchRelation["cancellations"]
}>): Promise<readonly PriorCancellation[] | null> {
  const prior = await readTaskGraphOperationalPriorCancellations(client, input)
  if (!prior) return null
  const descendants = input.sourceNodes.filter(node => node.taskId !== input.failedNode.taskId)
  const byTask = new Map(descendants.map(node => [node.taskId, node] as const)), ids = new Set<string>()
  if (input.operationCancellations.some(value => {
    const source = byTask.get(value.source.taskId)
    if (!source || source.key !== value.source.nodeKey || ids.has(source.taskId)) return true
    ids.add(source.taskId); return false
  }) || prior.some(value => ids.has(value.source.taskId))) return null
  return await proveTaskGraphOperationalRootWaitReferences(client, { scope: input.scope,
    taskIds: descendants.map(node => node.taskId), operationCancellations: input.operationCancellations }) ? prior : null
}

/** Checks operation cancellation effects except waits, which history proves separately after these receipts. */
export async function operationalCancellationsHaveNoOtherEvidence(client: Client, scope: GraphIdentityScope,
  sources: readonly TaskGraphOperationalIdentity[], cancellations: TaskGraphOperationalFailedBranchRelation["cancellations"]): Promise<boolean> {
  if (!sources.length) return true
  const ids = sources.map(source => source.taskId), eventKeys = cancellations.map(item => item.event.idempotencyKey)
  const result = await client.query<Row>(`SELECT task."id",
      (EXISTS (SELECT 1 FROM "agent_steps" step WHERE step."sessionId" = task."sessionId" AND step."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_items" item WHERE item."sessionId" = task."sessionId" AND item."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_events" event WHERE event."sessionId" = task."sessionId" AND event."taskId" = task."id"
        AND event."idempotencyKey" <> ALL($5::text[]))
      OR EXISTS (SELECT 1 FROM "agent_tree_budget_reservations" reservation WHERE reservation."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_native_semantic_rejections" row WHERE row."rootTaskId" = task."id" OR row."controlTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_tool_result_references" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_transcript_events" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_approvals" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_version" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_review" row WHERE row."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "application_tasks" row WHERE row."workerTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE (outbox."payload"->>'taskId' = task."id" OR outbox."payload"->'payload'->>'taskId' = task."id")
        AND outbox."idempotencyKey" <> ALL($6::text[]))) AS "hasEvidence",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id") AS "hasDispatch"
    FROM "sub_agent_tasks" task WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 ORDER BY task."id"`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, eventKeys, cancellations.map(item => `agent-event:${item.event.id}`)])
  return result.rows.length === ids.length && result.rows.every(row => row.hasEvidence === false && row.hasDispatch === false)
}
