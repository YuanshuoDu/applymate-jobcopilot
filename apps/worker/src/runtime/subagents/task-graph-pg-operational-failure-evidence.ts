import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import { parseTaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus } from "./task-graph-command-port.js"
import { parseTaskGraphOperationalFailurePlanNodes, taskGraphOperationalFailedBranchFingerprint,
  type TaskGraphOperationalFailedBranchRelation, type TaskGraphOperationalFailureReason } from "./task-graph-pg-operational-failed-branch-relation.js"
import { proveTaskGraphOperationalExternalDependencies } from "./task-graph-pg-operational-failure-dependencies.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { dateValue } from "./pg-store-persistence.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { normalizeRootPlanCriteria } from "./root-plan-criteria.js"
import { steeringReconciliationSequence, validSteeringReconciliationToolCall, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type EventProof = TaskGraphOperationalFailedBranchRelation["failedSource"]
const RESUME_FAILURE_REASONS = new Set<TaskGraphOperationalFailureReason>(["child_resume_unavailable", "child_resume_evidence_unavailable"])
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }
function invalidPersistedPlanCall(): never { throw new Error("steering_reconciliation_operational_failure_event_invalid") }
export function isTaskGraphOperationalNoResultEnvelope(value: unknown): boolean {
  const row = object(value)
  const keys = row && Object.keys(row).sort().join(",")
  return keys === "taskGraphVerificationReport" || keys === "taskGraphVerificationReport,workerResult" && row?.workerResult === null
}

export type TaskGraphOperationalFailurePlanCallInput = Readonly<{
  sequence: bigint
  nodes: NonNullable<ReturnType<typeof parseTaskGraphOperationalFailurePlanNodes>>
  criteria?: readonly string[]
}>

/** Reads and verifies the persisted agent.plan call that authorized an operational-failure replacement. */
export async function readTaskGraphOperationalFailurePlanCallInput(
  client: Client,
  scope: SteeringReconciliationScope,
  relation: TaskGraphOperationalFailedBranchRelation,
): Promise<TaskGraphOperationalFailurePlanCallInput> {
  const call = relation.agentPlanCall
  const result = await client.query<Row>(`SELECT event."sequence"::text AS "sequence", event."type", event."actor",
      event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId"
      AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started'
      AND event."taskId" = $3 AND event."correlationId" = $4 AND item."taskId" = $3 AND item."stepId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, call.callId, call.stepId])
  const row = result.rows[0]
  const sequence = steeringReconciliationSequence(row?.sequence)
  const content = object(row?.content), input = object(content?.input)
  const nodes = input && typeof input.expectedRevision === "number" ? parseTaskGraphOperationalFailurePlanNodes(input.nodes) : null
  const criteria = normalizeRootPlanCriteria(input?.rootSuccessCriteria)
  const mode = nodes && parseTaskGraphOperationalFailureReplacement(input?.replaceOperationalFailure, nodes)
  const event = row && { type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  const item = row && { id: row.id, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.content }
  if (result.rows.length !== 1 || !sequence || sequence <= 0n || !row || row.stepId !== call.stepId
    || row.itemType !== "tool_call" || content?.toolName !== "agent.plan" || !nodes || criteria === null || !mode?.ok
    || !event || !item || !validSteeringReconciliationToolCall(event, item, scope, call.stepId, "revise", relation.observedRevision,
      undefined, undefined, call.replaceOperationalFailure)
    || !same(mode.value, call.replaceOperationalFailure) || input?.expectedRevision !== relation.observedRevision
    || sequence <= BigInt(relation.failedSource.event.sequence) || sequence <= BigInt(relation.observedGraphEvent.sequence)
    || sequence >= BigInt(relation.cancellations[0]?.event.sequence ?? relation.planEvent.sequence)) invalidPersistedPlanCall()
  const fingerprint = taskGraphOperationalFailedBranchFingerprint({ rootTaskId: scope.rootTaskId,
    expectedRevision: relation.observedRevision, replaceOperationalFailure: call.replaceOperationalFailure, nodes,
    ...(criteria === undefined ? {} : { rootSuccessCriteria: criteria }) })
  if (fingerprint !== relation.requestFingerprint) invalidPersistedPlanCall()
  return { sequence, nodes, ...(criteria === undefined ? {} : { criteria }) }
}

function exactResult(value: unknown): Readonly<{ report: Row }> | null {
  const row = object(value)
  return row && isTaskGraphOperationalNoResultEnvelope(row)
    ? { report: object(row.taskGraphVerificationReport) ?? {} } : null
}
function reasonFor(node: StoredTaskGraphNode, taskType: unknown, role: unknown, reason: unknown): reason is TaskGraphOperationalFailureReason {
  const identityMatches = node.templateId === "scout" && role === "scout" && taskType === "job_discovery"
    || node.templateId === "analyst" && role === "analyst" && taskType === "job_analysis"
  return identityMatches && node.verificationDisposition === "typed" && node.verification?.role === node.templateId
    && (node.templateId === "scout" || node.templateId === "analyst")
    && (RESUME_FAILURE_REASONS.has(reason as TaskGraphOperationalFailureReason) || reason === TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)
}

async function readLifecycleReceipt(client: Client, scope: GraphIdentityScope, key: string): Promise<Row | null> {
  const rows = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence"::text AS "sequence",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic",
      outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
    LEFT JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."idempotencyKey" = $2`, [scope.sessionId, key, scope.userId])
  return rows.rows.length === 1 ? rows.rows[0]! : null
}

function readFailureEvent(row: Row, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode, attemptCount: number,
  reason: TaskGraphOperationalFailureReason, sourceNodes: readonly StoredTaskGraphNode[]): Readonly<{
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

function readStartedEvent(row: Row, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, node: StoredTaskGraphNode, attemptCount: number): Readonly<{
  sequence: string
}> | null {
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, attemptCount, "task.started")
  const sequence = String(row.sequence), payload = object(row.payload), event = parseTaskGraphEvent(object(payload?.event)), item = object(payload?.item)
  if (row.idempotencyKey !== key || row.type !== "item.delta" || row.actor !== "system" || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
    || row.itemId !== taskGraphItemId(scope.parentTaskId) || row.taskId !== node.taskId || row.correlationId !== scope.turnId
    || row.causationId !== null || payload?.kind !== "lifecycle" || event?.type !== "task.started" || event.nodeKey !== node.key
    || event.idempotencyKey !== key || !Number.isSafeInteger(event.expectedRevision) || payload.revision !== event.expectedRevision + 1
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
  return { sequence }
}

async function proveExpiredDeadline(client: Client, scope: GraphIdentityScope, node: StoredTaskGraphNode, attemptCount: number,
  role: unknown, taskType: unknown, reason: string): Promise<boolean> {
  const result = await client.query<Row>(`SELECT task."absoluteDeadlineAt", task."completedAt", clock_timestamp() AS "checkedAt"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      AND session."userId" = $9 JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      AND turn."userId" = $9 AND turn."rootTaskId" = task."rootTaskId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND task."attemptCount" = $5 AND task."role" = $6 AND task."taskType" = $7
      AND task."failureReason" = $8 AND task."status" = 'failed'`,
  [node.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, attemptCount, role, taskType, reason, scope.userId])
  if (result.rows.length !== 1) return false
  const deadline = dateValue(result.rows[0]?.absoluteDeadlineAt), completed = dateValue(result.rows[0]?.completedAt)
  const checked = dateValue(result.rows[0]?.checkedAt)
  return Boolean(deadline && completed && checked && Number.isFinite(deadline.getTime())
    && Number.isFinite(completed.getTime()) && Number.isFinite(checked.getTime())
    && deadline.getTime() <= checked.getTime() && completed.getTime() >= deadline.getTime())
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
  const failureRow = await readLifecycleReceipt(client, input.scope, key)
  if (!failureRow) return null
  const failureEvent = readFailureEvent(failureRow, input.scope, input.snapshot, input.failedNode, attemptCount, reason, input.sourceNodes)
  if (!failureEvent) return null
  if (reason === TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON) {
    const startKey = taskGraphLifecycleKey(input.scope.rootTaskId, input.failedNode.key, attemptCount, "task.started")
    const startRow = await readLifecycleReceipt(client, input.scope, startKey)
    const startEvent = startRow && readStartedEvent(startRow, input.scope, input.snapshot, input.failedNode, attemptCount)
    if (!startEvent || BigInt(startEvent.sequence) >= BigInt(failureEvent.sequence)) return null
    if (!await proveExpiredDeadline(client, input.scope, input.failedNode, attemptCount, row.role, row.taskType, reason)) return null
  }
  const external = await proveTaskGraphOperationalExternalDependencies(client, { scope: input.scope, snapshot: failureEvent.graph,
    sourceNodes: input.sourceNodes, failedEventSequence: failureEvent.sequence })
  if (!external) return null
  return { failedSource: { source: { nodeKey: input.failedNode.key, taskId: input.failedNode.taskId }, attemptCount,
    failureReason: reason, resultDigest: taskGraphResultDigest(row.result), event: { id: failureEvent.id,
      sequence: failureEvent.sequence, idempotencyKey: failureEvent.idempotencyKey } }, verifiedExternalDependencies: external,
    failureGraph: failureEvent.graph, failureRevision: failureEvent.expectedRevision }
}
