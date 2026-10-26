import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import type { TaskGraphOperationalFailedBranchRelation, TaskGraphOperationalResumeFailureReason } from "./task-graph-pg-operational-failed-branch-relation.js"
import { proveTaskGraphOperationalExternalDependencies } from "./task-graph-pg-operational-failure-dependencies.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventProof = TaskGraphOperationalFailedBranchRelation["failedSource"]
const FAILURE_REASONS = new Set<TaskGraphOperationalResumeFailureReason>(["child_resume_unavailable", "child_resume_evidence_unavailable"])
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }
export function isTaskGraphOperationalNoResultEnvelope(value: unknown): boolean {
  const row = object(value)
  const keys = row && Object.keys(row).sort().join(",")
  return keys === "taskGraphVerificationReport" || keys === "taskGraphVerificationReport,workerResult" && row?.workerResult === null
}
function exactResult(value: unknown): Readonly<{ report: Row }> | null {
  const row = object(value)
  return row && isTaskGraphOperationalNoResultEnvelope(row)
    ? { report: object(row.taskGraphVerificationReport) ?? {} } : null
}
function reasonFor(node: StoredTaskGraphNode, taskType: unknown, role: unknown, reason: unknown): reason is TaskGraphOperationalResumeFailureReason {
  const identityMatches = node.templateId === "scout" && role === "scout" && taskType === "job_discovery"
    || node.templateId === "analyst" && role === "analyst" && taskType === "job_analysis"
  return identityMatches && node.verificationDisposition === "typed" && node.verification?.role === node.templateId
    && (node.templateId === "scout" || node.templateId === "analyst") && FAILURE_REASONS.has(reason as TaskGraphOperationalResumeFailureReason)
}

function readFailureEvent(row: Row, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode, attemptCount: number,
  reason: TaskGraphOperationalResumeFailureReason, sourceNodes: readonly StoredTaskGraphNode[]): Readonly<{
    id: string; sequence: string; idempotencyKey: string; graph: TaskGraphSnapshot; expectedRevision: number
  }> | null {
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, attemptCount, "task.failed")
  const sequence = String(row.sequence), payload = object(row.payload), event = parseTaskGraphEvent(object(payload?.event)), item = object(payload?.item)
  if (row.idempotencyKey !== key || row.type !== "item.delta" || row.actor !== "system" || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.itemId !== taskGraphItemId(scope.parentTaskId) || row.taskId !== node.taskId || row.correlationId !== scope.turnId
    || row.causationId !== null || payload?.kind !== "lifecycle" || event?.type !== "task.failed" || event.nodeKey !== node.key
    || event.idempotencyKey !== key || event.failureReason !== reason || !Number.isSafeInteger(event.expectedRevision)
    || payload.revision !== event.expectedRevision + 1 || item?.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION
    || item.id !== taskGraphItemId(scope.parentTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
    || item.taskId !== scope.parentTaskId || item.type !== "task_graph" || item.revision !== payload.revision
    || !Number.isSafeInteger(item.revision) || typeof row.id !== "string" || !/^[1-9][0-9]{0,18}$/.test(sequence)) return null
  let graph: TaskGraphSnapshot
  try { graph = parseTaskGraphSnapshot(item.content) } catch { return null }
  if (!same(graph.nodes.find(candidate => candidate.key === node.key), node)
    || !same(graph.rootSuccessCriteria ?? null, snapshot.rootSuccessCriteria ?? null)
    || sourceNodes.some(source => !same(graph.nodes.find(candidate => candidate.key === source.key), source))) return null
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !same(row.outboxPayload, expectedOutbox)) return null
  return { id: row.id, sequence, idempotencyKey: key, graph, expectedRevision: Number(event.expectedRevision) }
}

export type TaskGraphOperationalFailureEvidence = Readonly<{
  failedSource: EventProof
  verifiedExternalDependencies: TaskGraphOperationalFailedBranchRelation["verifiedExternalDependencies"]
  failureGraph: TaskGraphSnapshot
  failureRevision: number
}>

export async function proveTaskGraphOperationalFailureEvidence(client: Client, input: Readonly<{
  scope: GraphIdentityScope
  snapshot: TaskGraphSnapshot
  sourceNodes: readonly StoredTaskGraphNode[]
  failedNode: StoredTaskGraphNode
  failedRow: Row
}>): Promise<TaskGraphOperationalFailureEvidence | null> {
  const row = input.failedRow, attemptCount = Number(row.attemptCount), reason = row.failureReason
  if (!input.sourceNodes.some(node => node.key === input.failedNode.key && node.taskId === input.failedNode.taskId)
    || !reasonFor(input.failedNode, row.taskType, row.role, reason) || row.id !== input.failedNode.taskId || row.status !== "failed"
    || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || row.leaseOwner !== null || row.leaseExpiresAt !== null
    || row.nextAttemptAt !== null || row.startedAt === null || row.completedAt === null || row.closedAt !== null
    || row.interruptRequestedAt !== null || row.confidence !== null || row.qualityGateResult !== null
    || row.contextSnapshotId !== null || !Array.isArray(row.outputArtifactIds) || row.outputArtifactIds.length !== 0) return null
  const result = exactResult(row.result), criteria = input.failedNode.verification?.criteria.map(item => item.id)
  const report = criteria && result ? parseTaskGraphVerificationReport(result.report, criteria) : undefined
  if (!result || !report || report.status !== "unverified" || report.reasonCode !== "result_invalid"
    || report.evidenceDigest !== null || report.resultDigest !== null || !taskGraphVerificationReportMatchesStatus(report, "failed")
    || report.criteria.some(item => item.status !== "unverified" || item.reasonCode !== "result_invalid")) return null
  const key = taskGraphLifecycleKey(input.scope.rootTaskId, input.failedNode.key, attemptCount, "task.failed")
  const eventRows = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence"::text AS "sequence",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic",
      outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
    LEFT JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."idempotencyKey" = $2`, [input.scope.sessionId, key, input.scope.userId])
  if (eventRows.rows.length !== 1) return null
  const failureEvent = readFailureEvent(eventRows.rows[0]!, input.scope, input.snapshot, input.failedNode, attemptCount, reason, input.sourceNodes)
  if (!failureEvent) return null
  const external = await proveTaskGraphOperationalExternalDependencies(client, { scope: input.scope, snapshot: failureEvent.graph,
    sourceNodes: input.sourceNodes, failedEventSequence: failureEvent.sequence })
  if (!external) return null
  return { failedSource: { source: { nodeKey: input.failedNode.key, taskId: input.failedNode.taskId }, attemptCount,
    failureReason: reason, resultDigest: taskGraphResultDigest(row.result), event: { id: failureEvent.id,
      sequence: failureEvent.sequence, idempotencyKey: failureEvent.idempotencyKey } }, verifiedExternalDependencies: external,
    failureGraph: failureEvent.graph, failureRevision: failureEvent.expectedRevision }
}
