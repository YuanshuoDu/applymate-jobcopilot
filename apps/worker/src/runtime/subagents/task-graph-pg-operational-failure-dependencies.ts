import type pg from "pg"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import type { TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventProof = TaskGraphOperationalFailedBranchRelation["verifiedExternalDependencies"][number]
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }

export function taskGraphOperationalExternalAncestors(snapshot: TaskGraphSnapshot,
  sourceNodes: readonly StoredTaskGraphNode[]): StoredTaskGraphNode[] | null {
  const byKey = new Map(snapshot.nodes.map(node => [node.key, node] as const)), sourceKeys = new Set(sourceNodes.map(node => node.key))
  const seen = new Set<string>(), pending = sourceNodes.flatMap(node => [...node.dependsOn])
  while (pending.length) {
    const key = pending.pop()!, node = byKey.get(key)
    if (!node) return null
    if (sourceKeys.has(key) || seen.has(key)) continue
    seen.add(key); pending.push(...node.dependsOn)
  }
  return snapshot.nodes.filter(node => seen.has(node.key)).sort((left, right) => left.key.localeCompare(right.key))
}

function readLifecycle(row: Row, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode, attemptCount: number):
  Readonly<{ id: string; sequence: string; idempotencyKey: string; graph: TaskGraphSnapshot }> | null {
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, attemptCount, "task.completed")
  const sequence = String(row.sequence), payload = object(row.payload), event = parseTaskGraphEvent(object(payload?.event)), item = object(payload?.item)
  if (row.idempotencyKey !== key || row.type !== "item.delta" || row.actor !== "system" || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.itemId !== taskGraphItemId(scope.parentTaskId) || row.taskId !== node.taskId
    || row.correlationId !== scope.turnId || row.causationId !== null || payload?.kind !== "lifecycle"
    || event?.type !== "task.completed" || event.nodeKey !== node.key || event.idempotencyKey !== key
    || !Number.isSafeInteger(event.expectedRevision) || payload.revision !== event.expectedRevision + 1
    || item?.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.parentTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.parentTaskId
    || item.type !== "task_graph" || item.revision !== payload.revision || !Number.isSafeInteger(item.revision)
    || typeof row.id !== "string" || !/^[1-9][0-9]{0,18}$/.test(sequence)) return null
  let graph: TaskGraphSnapshot
  try { graph = parseTaskGraphSnapshot(item.content) } catch { return null }
  if (!same(graph.nodes.find(candidate => candidate.key === node.key), node)
    || !same(graph.rootSuccessCriteria ?? null, snapshot.rootSuccessCriteria ?? null)) return null
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !same(row.outboxPayload, expectedOutbox)) return null
  return { id: row.id, sequence, idempotencyKey: key, graph }
}

function sameDependencyHistory(historical: TaskGraphSnapshot, current: TaskGraphSnapshot, node: StoredTaskGraphNode): boolean {
  const oldByKey = new Map(historical.nodes.map(value => [value.key, value] as const)), currentByKey = new Map(current.nodes.map(value => [value.key, value] as const))
  const pending = [node.key], seen = new Set<string>()
  while (pending.length) {
    const key = pending.pop()!
    if (seen.has(key)) continue
    seen.add(key)
    const old = oldByKey.get(key), next = currentByKey.get(key)
    if (!old || !next || !same(old, next)) return false
    pending.push(...next.dependsOn)
  }
  return true
}

export async function proveTaskGraphOperationalExternalDependencies(client: Client, input: Readonly<{
  scope: GraphIdentityScope
  snapshot: TaskGraphSnapshot
  sourceNodes: readonly StoredTaskGraphNode[]
  failedEventSequence: string
}>): Promise<readonly EventProof[] | null> {
  if (!/^[1-9][0-9]{0,18}$/.test(input.failedEventSequence)) return null
  const nodes = taskGraphOperationalExternalAncestors(input.snapshot, input.sourceNodes)
  if (!nodes) return null
  if (!nodes.length) return []
  const ids = nodes.map(node => node.taskId), taskResult = await client.query<Row>(`SELECT task."id", task."status", task."role", task."taskType", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
      task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."failureReason", task."result"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6 ORDER BY task."id" FOR UPDATE OF task`,
  [ids, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
  if (taskResult.rows.length !== ids.length) return null
  const tasks = new Map(taskResult.rows.map(row => [String(row.id), row]))
  const keys = nodes.map(node => taskGraphLifecycleKey(input.scope.rootTaskId, node.key, Number(tasks.get(node.taskId)?.attemptCount), "task.completed"))
  if (keys.some(key => key.endsWith(":NaN:task.completed")) || new Set(keys).size !== keys.length) return null
  const eventResult = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence"::text AS "sequence",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic",
      outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
    LEFT JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."idempotencyKey" = ANY($2::text[]) ORDER BY event."sequence"`,
  [input.scope.sessionId, keys, input.scope.userId])
  if (eventResult.rows.length !== keys.length) return null
  const events = new Map(eventResult.rows.map(row => [String(row.idempotencyKey), row]))
  if (events.size !== keys.length) return null
  const proofs: EventProof[] = []
  for (const node of nodes) {
    const task = tasks.get(node.taskId)!, attemptCount = Number(task.attemptCount), result = object(task.result)
    const rawReport = result && object(result.taskGraphVerificationReport)
    const report = rawReport && node.verification ? parseTaskGraphVerificationReport(rawReport, node.verification.criteria.map(item => item.id)) : undefined
    const lifecycle = readLifecycle(events.get(taskGraphLifecycleKey(input.scope.rootTaskId, node.key, attemptCount, "task.completed")) ?? {},
      input.scope, input.snapshot, node, attemptCount)
    const fixedTaskType = node.templateId === "scout" ? "job_discovery" : "job_analysis"
    if (node.repairOf || node.nativeDelegation || (node.templateId !== "scout" && node.templateId !== "analyst")
      || node.verificationDisposition !== "typed" || node.verification?.role !== node.templateId || task.status !== "completed"
      || task.role !== node.templateId || task.taskType !== fixedTaskType || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || task.failureReason !== null
      || task.leaseOwner !== null || task.leaseExpiresAt !== null || task.nextAttemptAt !== null || task.completedAt === null
      || task.closedAt !== null || task.interruptRequestedAt !== null || result?.status !== "completed" || !report
      || report.status !== "passed" || !taskGraphVerificationReportMatchesStatus(report, "completed") || !lifecycle
      || BigInt(lifecycle.sequence) >= BigInt(input.failedEventSequence) || !sameDependencyHistory(lifecycle.graph, input.snapshot, node)) return null
    proofs.push({ dependency: { nodeKey: node.key, taskId: node.taskId }, attemptCount,
      resultDigest: taskGraphResultDigest(task.result), reportDigest: taskGraphResultDigest(rawReport),
      completedEvent: { id: lifecycle.id, sequence: lifecycle.sequence, idempotencyKey: lifecycle.idempotencyKey } })
  }
  return proofs
}
