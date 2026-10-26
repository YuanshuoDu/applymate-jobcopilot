import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { isTaskGraphOperationalNoResultEnvelope } from "./task-graph-pg-operational-failure-evidence.js"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphVerificationReport } from "./task-graph-command-port.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type HistoricalFailureTask = Readonly<{
  id: unknown; status: unknown; attemptCount: unknown; role: unknown; taskType: unknown; failureReason: unknown; result: unknown
}>
type Input = Readonly<{ scope: GraphIdentityScope; task: HistoricalFailureTask; archivedReport: unknown }>
export type ConsumedTaskGraphFailureReport = Readonly<{ criterionIds: readonly string[]; report: TaskGraphVerificationReport }>

const RESUME_REASONS = new Set(["child_resume_unavailable", "child_resume_evidence_unavailable"])
const EVENT_LIMIT = 2
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed), descriptors = Object.getOwnPropertyDescriptors(parsed)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(parsed).every(key => typeof key === "string"
      && descriptors[key]?.enumerable && "value" in descriptors[key]!) ? parsed as Row : null
  } catch { return null }
}
function exact(value: Row | null, keys: readonly string[]): value is Row {
  return value !== null && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key))
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function sequence(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  try { return BigInt(value) <= MAX_SEQUENCE ? value : null } catch { return null }
}
function failureReport(value: unknown, criterionIds: readonly string[]): TaskGraphVerificationReport | null {
  const report = parseTaskGraphVerificationReport(value, criterionIds)
  return report?.status === "unverified" && report.reasonCode === "result_invalid"
    && report.evidenceDigest === null && report.resultDigest === null
    && report.criteria.every(item => item.status === "unverified" && item.reasonCode === "result_invalid")
    && taskGraphVerificationReportMatchesStatus(report, "failed") ? report : null
}

function receiptMatches(row: Row, scope: GraphIdentityScope, taskId: string, attemptCount: number, reason: string,
  role: "scout" | "analyst", archivedReport: unknown, authoritativeReport: unknown): ConsumedTaskGraphFailureReport | null {
  const payload = object(row.payload), item = object(payload?.item), event = parseTaskGraphEvent(object(payload?.event))
  if (!exact(payload, ["kind", "event", "revision", "item"]) || payload?.kind !== "lifecycle" || !item || !event
    || event.type !== "task.failed" || event.failureReason !== reason || !Number.isSafeInteger(event.expectedRevision)
    || payload.revision !== event.expectedRevision + 1 || !exact(item, ["schemaVersion", "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"])
    || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.rootTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.parentTaskId
    || item.type !== "task_graph" || item.revision !== payload.revision || item.phase !== null
    || !(item.status === "streaming" || item.status === "running")
    || !(item.stepId === null || typeof item.stepId === "string")) return null

  let snapshot
  try { snapshot = parseTaskGraphSnapshot(item.content) } catch { return null }
  const node = snapshot.nodes.find(candidate => candidate.taskId === taskId)
  if (!node || node.templateId !== role || node.verificationDisposition !== "typed"
    || !node.verification || node.verification.role !== role) return null
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, attemptCount, "task.failed")
  const eventSequence = sequence(row.sequence)
  if (!eventSequence || typeof row.id !== "string" || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== taskId || row.type !== "item.delta"
    || row.actor !== "system" || row.correlationId !== scope.turnId || row.causationId !== null
    || row.idempotencyKey !== key || event.nodeKey !== node.key || event.idempotencyKey !== key
    || item.revision !== event.expectedRevision + 1 || !same(snapshot.nodes.find(candidate => candidate.key === event.nodeKey), node)
    || row.sessionUserId !== scope.userId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId) return null

  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence: eventSequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !same(row.outboxPayload, expectedOutbox)) return null

  const criterionIds = node.verification.criteria.map(criterion => criterion.id)
  const report = failureReport(authoritativeReport, criterionIds), archived = failureReport(archivedReport, criterionIds)
  return report && archived && same(report, archived) ? { criterionIds, report } : null
}

/** Revalidates only the typed report in an already-consumed wait using its immutable failure receipt. */
export async function readConsumedTaskGraphFailureReport(client: Client, input: Input): Promise<ConsumedTaskGraphFailureReport | null> {
  const { scope, task } = input
  const taskId = task.id, attemptCount = task.attemptCount, role = task.role
  const result = object(task.result), authoritativeReport = result?.taskGraphVerificationReport
  const rolePair = role === "scout" && task.taskType === "job_discovery"
    || role === "analyst" && task.taskType === "job_analysis"
  if (!scope.userId || !scope.sessionId || !scope.turnId || !scope.rootTaskId || scope.parentTaskId !== scope.rootTaskId
    || typeof taskId !== "string" || taskId.trim() !== taskId || !taskId
    || task.status !== "failed" || typeof attemptCount !== "number" || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || !rolePair
    || role !== "scout" && role !== "analyst"
    || typeof task.failureReason !== "string" || !RESUME_REASONS.has(task.failureReason)
    || !isTaskGraphOperationalNoResultEnvelope(task.result) || !authoritativeReport) return null

  const rows = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."sequence"::text AS "sequence",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId",
      outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $4
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      AND turn."userId" = $4 AND turn."rootTaskId" = $5
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND event."itemId" = $6 AND event."type" = 'item.delta' AND event."actor" = 'system'
      AND event."correlationId" = $2 AND event."causationId" IS NULL
      AND event."payload"->>'kind' = 'lifecycle' AND event."payload"->'event'->>'type' = 'task.failed'
    ORDER BY event."sequence" DESC LIMIT ${EVENT_LIMIT}`, [scope.sessionId, scope.turnId, taskId, scope.userId,
    scope.rootTaskId, taskGraphItemId(scope.rootTaskId)])
  if (rows.rows.length !== 1) return null
  const row = rows.rows[0]!
  const resultEnvelope = object(task.result)!
  return receiptMatches(row, scope, taskId, attemptCount, task.failureReason, role, input.archivedReport,
    resultEnvelope.taskGraphVerificationReport)
}
