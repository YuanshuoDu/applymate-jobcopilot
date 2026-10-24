import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import { parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, canonicalTaskGraphJson,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphFailedBranchEventIdentity, TaskGraphFailedBranchIdentity } from "./task-graph-pg-failed-branch-relation.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

export type TaskGraphFailedBranchEvidence = Readonly<{
  failedSource: Readonly<{ source: TaskGraphFailedBranchIdentity; attemptCount: number; resultDigest: string; reportDigest: string; event: TaskGraphFailedBranchEventIdentity }>
  verifiedExternalDependencies: readonly Readonly<{ dependency: TaskGraphFailedBranchIdentity; attemptCount: number; resultDigest: string; reportDigest: string; completedEvent: TaskGraphFailedBranchEventIdentity }>[]
}>

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }
function identity(node: StoredTaskGraphNode): TaskGraphFailedBranchIdentity { return { nodeKey: node.key, taskId: node.taskId } }
function typed(node: StoredTaskGraphNode): boolean {
  return (node.templateId === "scout" || node.templateId === "analyst") && node.verificationDisposition === "typed"
    && node.verification?.role === node.templateId && node.verification.criteria.length > 0
    && node.repairOf === undefined && node.nativeDelegation === undefined
}

function closureFor(snapshot: TaskGraphSnapshot, candidates: readonly StoredTaskGraphNode[]): { root: StoredTaskGraphNode; closure: StoredTaskGraphNode[] } | null {
  if (candidates.length < 2 || new Set(candidates.map(node => node.key)).size !== candidates.length) return null
  const byKey = new Map(snapshot.nodes.map(node => [node.key, node] as const)), keys = new Set(candidates.map(node => node.key))
  if (candidates.some(node => !same(byKey.get(node.key), node))) return null
  const roots = candidates.filter(node => !node.dependsOn.some(key => keys.has(key)))
  if (roots.length !== 1) return null
  const closureKeys = new Set([roots[0]!.key])
  for (let changed = true; changed;) {
    changed = false
    for (const node of snapshot.nodes) if (!closureKeys.has(node.key) && node.dependsOn.some(key => closureKeys.has(key))) {
      closureKeys.add(node.key); changed = true
    }
  }
  const closure = snapshot.nodes.filter(node => closureKeys.has(node.key))
  return closure.length === candidates.length && closure.every((node, index) => node.key === candidates[index]?.key)
    ? { root: roots[0]!, closure } : null
}

function externalAncestors(snapshot: TaskGraphSnapshot, closure: readonly StoredTaskGraphNode[]): StoredTaskGraphNode[] | null {
  const byKey = new Map(snapshot.nodes.map(node => [node.key, node] as const)), closureKeys = new Set(closure.map(node => node.key)), seen = new Set<string>()
  const pending = closure.flatMap(node => [...node.dependsOn])
  while (pending.length) {
    const key = pending.pop()!, node = byKey.get(key)
    if (!node) return null
    if (closureKeys.has(key) || seen.has(key)) continue
    seen.add(key); pending.push(...node.dependsOn)
  }
  return snapshot.nodes.filter(node => seen.has(node.key))
}

function sameDependencyHistory(historical: TaskGraphSnapshot, current: TaskGraphSnapshot, node: StoredTaskGraphNode): boolean {
  const historicalByKey = new Map(historical.nodes.map(value => [value.key, value] as const))
  const currentByKey = new Map(current.nodes.map(value => [value.key, value] as const)), pending = [node.key], seen = new Set<string>()
  while (pending.length) {
    const key = pending.pop()!
    if (seen.has(key)) continue
    seen.add(key)
    const expected = currentByKey.get(key), actual = historicalByKey.get(key)
    if (!expected || !actual || !same(actual, expected)) return false
    pending.push(...expected.dependsOn)
  }
  return true
}

function lifecycle(row: Row, scope: GraphIdentityScope, expected: { node: StoredTaskGraphNode; attempt: number; type: string; snapshot: TaskGraphSnapshot; exactGraph?: boolean }):
  Readonly<{ event: TaskGraphFailedBranchEventIdentity; graph: TaskGraphSnapshot; value: Record<string, unknown> }> | null {
  const key = taskGraphLifecycleKey(scope.rootTaskId, expected.node.key, expected.attempt, expected.type)
  const sequence = String(row.sequence), payload = object(row.payload), event = parseTaskGraphEvent(payload?.event), item = object(payload?.item)
  if (row.idempotencyKey !== key || row.type !== "item.delta" || row.actor !== "system" || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.itemId !== taskGraphItemId(scope.parentTaskId) || row.taskId !== expected.node.taskId
    || row.correlationId !== scope.turnId || row.causationId !== null || payload?.kind !== "lifecycle"
    || !event || event.type !== expected.type || event.nodeKey !== expected.node.key || event.idempotencyKey !== key
    || !Number.isSafeInteger(event.expectedRevision) || payload.revision !== event.expectedRevision + 1
    || !item || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.parentTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.parentTaskId
    || item.type !== "task_graph" || item.revision !== payload.revision || typeof row.id !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(sequence) || !Number.isSafeInteger(item.revision)) return null
  let graph: TaskGraphSnapshot
  try { graph = parseTaskGraphSnapshot(item.content) } catch { return null }
  const node = graph.nodes.find(candidate => candidate.key === expected.node.key)
  if (!node || !same(node, expected.node) || !same(graph.rootSuccessCriteria ?? null, expected.snapshot.rootSuccessCriteria ?? null)
    || expected.exactGraph && !same(graph, expected.snapshot)) return null
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !same(row.outboxPayload, expectedOutbox)) return null
  return { event: { id: row.id, sequence, idempotencyKey: key }, graph, value: event }
}

/** Proves the immutable failed Scout and verified outside ancestors; the caller validates live descendant eligibility. */
export async function proveTaskGraphFailedBranchEvidence(client: Client, input: Readonly<{
  scope: GraphIdentityScope
  snapshot: TaskGraphSnapshot
  sourceNodes: readonly StoredTaskGraphNode[]
}>): Promise<TaskGraphFailedBranchEvidence | null> {
  const { scope, snapshot, sourceNodes } = input, derived = closureFor(snapshot, sourceNodes)
  if (!derived || derived.root.templateId !== "scout" || !typed(derived.root) || sourceNodes.some(node => !typed(node))) return null
  const outside = externalAncestors(snapshot, sourceNodes)
  if (!outside) return null
  const ids = [...new Set([derived.root, ...outside].map(node => node.taskId))].sort()
  const taskResult = await client.query<Row>(`SELECT task."id", task."status", task."role", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
      task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."failureReason", task."result",
      task."confidence", task."qualityGateResult", task."contextSnapshotId", task."outputArtifactIds"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6
    ORDER BY task."id" FOR UPDATE OF task`, [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (taskResult.rows.length !== ids.length) return null
  const tasks = new Map(taskResult.rows.map(row => [String(row.id), row]))
  const failedRow = tasks.get(derived.root.taskId)
  if (!failedRow || failedRow.status !== "failed" || failedRow.role !== "scout" || Number(failedRow.attemptCount) < 1
    || failedRow.failureReason !== "task_graph_verification_unverified" || failedRow.leaseOwner !== null || failedRow.leaseExpiresAt !== null
    || failedRow.nextAttemptAt !== null || failedRow.startedAt === null || failedRow.completedAt === null || failedRow.closedAt !== null
    || failedRow.interruptRequestedAt !== null || failedRow.result === null) return null
  const failedResult = object(failedRow.result), failedReportRaw = failedResult && object(failedResult.taskGraphVerificationReport)
  const failedReport = failedReportRaw && derived.root.verification
    ? parseTaskGraphVerificationReport(failedReportRaw, derived.root.verification.criteria.map(item => item.id)) : undefined
  if (!failedResult || failedResult.status !== "failed" || Object.hasOwn(failedResult, "taskGraphRepairReceipt")
    || Object.hasOwn(failedResult, "native") || Object.hasOwn(failedResult, "nativeResult") || !failedReport
    || failedReport.status !== "unverified" || failedReport.reasonCode !== "result_invalid" || failedReport.evidenceDigest !== null
    || failedReport.resultDigest !== null || !taskGraphVerificationReportMatchesStatus(failedReport, "failed")) return null

  const expectedKeys = [taskGraphLifecycleKey(scope.rootTaskId, derived.root.key, Number(failedRow.attemptCount), "task.failed"),
    ...outside.map(node => taskGraphLifecycleKey(scope.rootTaskId, node.key, Number(tasks.get(node.taskId)?.attemptCount), "task.completed"))]
  if (expectedKeys.some(key => key.endsWith(":NaN:task.completed")) || new Set(expectedKeys).size !== expectedKeys.length) return null
  const eventResult = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence"::text AS "sequence",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic",
      outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
    LEFT JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."idempotencyKey" = ANY($2::text[]) ORDER BY event."sequence"`,
  [scope.sessionId, expectedKeys, scope.userId])
  if (eventResult.rows.length !== expectedKeys.length) return null
  const events = new Map(eventResult.rows.map(row => [String(row.idempotencyKey), row]))
  if (events.size !== expectedKeys.length) return null
  const failureRow = events.get(expectedKeys[0]!)!, failedEvent = lifecycle(failureRow, scope, { node: derived.root, attempt: Number(failedRow.attemptCount), type: "task.failed", snapshot })
  if (!failedEvent || failedEvent.value.failureReason !== failedRow.failureReason) return null
  const failedSnapshot = failedEvent.graph, failedClosure = closureFor(failedSnapshot, sourceNodes), failedOutside = externalAncestors(failedSnapshot, sourceNodes)
  if (!failedClosure || !failedOutside || failedOutside.length !== outside.length
    || failedOutside.some((node, index) => node.key !== outside[index]?.key || node.taskId !== outside[index]?.taskId
      || !same(node, outside[index]))) return null

  const externalProofs: TaskGraphFailedBranchEvidence["verifiedExternalDependencies"][number][] = []
  for (const node of outside) {
    if (node.repairOf) return null
    const task = tasks.get(node.taskId)!, result = object(task.result), reportRaw = result && object(result.taskGraphVerificationReport)
    const report = reportRaw && node.verification ? parseTaskGraphVerificationReport(reportRaw, node.verification.criteria.map(item => item.id)) : undefined
    const attemptCount = Number(task.attemptCount), key = taskGraphLifecycleKey(scope.rootTaskId, node.key, attemptCount, "task.completed")
    const completed = lifecycle(events.get(key) ?? {}, scope, { node, attempt: attemptCount, type: "task.completed", snapshot: failedSnapshot })
    if (!typed(node) || task.status !== "completed" || task.role !== node.templateId || !Number.isSafeInteger(attemptCount) || attemptCount < 1
      || task.failureReason !== null || task.leaseOwner !== null || task.leaseExpiresAt !== null || task.nextAttemptAt !== null
      || task.completedAt === null || task.closedAt !== null || task.interruptRequestedAt !== null || result?.status !== "completed"
      || !report || report.status !== "passed" || !taskGraphVerificationReportMatchesStatus(report, "completed") || !completed
      || !sameDependencyHistory(completed.graph, failedSnapshot, node)
      || BigInt(completed.event.sequence) >= BigInt(failedEvent.event.sequence)) return null
    if (Object.hasOwn(result, "taskGraphRepairReceipt")) return null
    externalProofs.push({ dependency: identity(node), attemptCount, resultDigest: taskGraphResultDigest(task.result),
      reportDigest: taskGraphResultDigest(reportRaw), completedEvent: completed.event })
  }
  return { failedSource: { source: identity(derived.root), attemptCount: Number(failedRow.attemptCount),
    resultDigest: taskGraphResultDigest(failedRow.result), reportDigest: taskGraphResultDigest(failedReportRaw), event: failedEvent.event },
  verifiedExternalDependencies: externalProofs.sort((left, right) => left.dependency.nodeKey.localeCompare(right.dependency.nodeKey)) }
}
