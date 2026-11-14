import { createHash } from "node:crypto"
import type pg from "pg"
import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"

type Row = Record<string, unknown>
type Scope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
type GateWaitState = "waiting_for_dependency" | "waiting_for_approval"
const MAX_GATE_JOBS = 50
const GATE_REVIEW_MARKER = "agent-harness.v2.scheduled-gate-review-marker.v1"
const ITEM_CONTENT_KEYS = ["waitKind", "approvalId", "toolCallId", "action", "title", "body", "impact",
  "scopeHash", "receiptRevision", "expiresAt", "decision"] as const

export type ScheduledPrepareGateWaitWitness = Readonly<{
  gateTaskId: string; gateAttemptCount: number; leaseOwnerId: string; requestAttemptCount: number
  preparedJobIds: readonly string[]
}>

/** Revalidates a live Gate lease and only the exact suspended Gate wait or its active approval witness. */
export async function scheduledPrepareGateRootWitnessMatches(client: Pick<pg.PoolClient, "query">, input: Readonly<{
  scope: Scope; rootStatus: "running" | "waiting"; rootAttemptCount: number; turnStatus: string
  turnLeaseOwnerId: unknown; turnLeaseExpiresAt: unknown; waitId: string | null
  witness: ScheduledPrepareGateWaitWitness; now?: Date
}>): Promise<boolean> {
  const { scope, witness } = input, now = input.now ?? new Date()
  if (![scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, witness.gateTaskId, witness.leaseOwnerId].every(validId)
    || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1
    || !Number.isSafeInteger(witness.gateAttemptCount) || witness.gateAttemptCount < 1
    || !Number.isSafeInteger(witness.requestAttemptCount) || witness.requestAttemptCount < 0
    || witness.requestAttemptCount >= Number.MAX_SAFE_INTEGER || !Number.isFinite(now.getTime())
    || witness.preparedJobIds.length > MAX_GATE_JOBS || witness.preparedJobIds.some(id => !validId(id))
    || new Set(witness.preparedJobIds).size !== witness.preparedJobIds.length) return false
  const gateRows = await client.query<Row>(`SELECT task."id", task."role", task."taskType", task."status", task."attemptCount",
      task."maxAttempts", task."failureReason", task."leaseOwner", task."interruptRequestedAt",
      task."leaseExpiresAt" > clock_timestamp() AS "leaseValid",
      (task."absoluteDeadlineAt" IS NULL OR task."absoluteDeadlineAt" > clock_timestamp()) AS "deadlineValid"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $9
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      AND turn."userId" = $9 AND turn."rootTaskId" = $4
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND task."role" = $5 AND task."taskType" = $6
      AND task."status" = 'running' AND task."attemptCount" = $7 AND task."leaseOwner" = $8
      AND task."leaseExpiresAt" > clock_timestamp() AND task."failureReason" IS NULL AND task."interruptRequestedAt" IS NULL
      AND (task."absoluteDeadlineAt" IS NULL OR task."absoluteDeadlineAt" > clock_timestamp())`,
  [witness.gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE,
    witness.gateAttemptCount, witness.leaseOwnerId, scope.userId])
  const gate = asRecord(gateRows.rows[0])
  if (gateRows.rows.length !== 1 || !gate || gate.id !== witness.gateTaskId || gate.role !== SCHEDULED_GATE_ROLE
    || gate.taskType !== SCHEDULED_GATE_TASK_TYPE || gate.status !== "running" || Number(gate.attemptCount) !== witness.gateAttemptCount
    || !Number.isSafeInteger(gate.maxAttempts) || Number(gate.maxAttempts) < witness.gateAttemptCount
    || gate.failureReason !== null || gate.leaseOwner !== witness.leaseOwnerId || gate.leaseValid !== true
    || gate.deadlineValid !== true || gate.interruptRequestedAt != null) return false
  if (input.turnStatus === "waiting_for_approval") {
    if (input.turnLeaseOwnerId !== null || input.turnLeaseExpiresAt !== null
      || (await scheduledPrepareGateApprovalWitnessIds(client, scope, witness, now)).length === 0) return false
  } else if (!["in_progress", "waiting_for_dependency"].includes(input.turnStatus)) return false
  if (input.rootStatus === "running") return true
  if (input.rootStatus !== "waiting" || input.turnStatus !== "waiting_for_dependency" && input.turnStatus !== "waiting_for_approval"
    || input.turnLeaseOwnerId !== null || input.turnLeaseExpiresAt !== null || !validId(input.waitId)) return false
  return await scheduledPrepareGateWaitMatches(client, scope, input.rootAttemptCount, input.waitId, input.turnStatus, witness)
}

async function scheduledPrepareGateWaitMatches(client: Pick<pg.PoolClient, "query">, scope: Scope, rootAttemptCount: number,
  waitId: string, turnStatus: GateWaitState, witness: ScheduledPrepareGateWaitWitness): Promise<boolean> {
  const rows = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", wait."stepId",
      wait."idempotencyKey", wait."targetTaskIds", wait."mode", wait."status", wait."matchedTaskIds", wait."result",
      wait."suspendedAt", wait."resolvedAt", wait."consumedAt", parent."status" AS "parentStatus",
      parent."attemptCount" AS "parentAttemptCount", parent."result" AS "parentResult", parent."failureReason" AS "parentFailureReason",
      turn."status" AS "turnStatus", turn."leaseOwnerId" AS "turnLeaseOwnerId", turn."leaseExpiresAt" AS "turnLeaseExpiresAt",
      step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt", step."status" AS "stepStatus",
      (SELECT COUNT(*) FROM "agent_wait_conditions" AS candidate WHERE candidate."userId" = $2
        AND candidate."sessionId" = $3 AND candidate."turnId" = $5 AND candidate."parentTaskId" = $4
        AND candidate."status" IN ('waiting', 'ready', 'timed_out') AND candidate."consumedAt" IS NULL
        AND candidate."result"->'request'->'scheduledGate'->>'gateTaskId' = $6) AS "activeGateWaitCount"
    FROM "agent_wait_conditions" AS wait
    JOIN "agent_sessions" AS session ON session."id" = wait."sessionId" AND session."userId" = wait."userId"
    JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
      AND turn."userId" = wait."userId" AND turn."rootTaskId" = $4 AND turn."status" = $7
      AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL
    JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."id" = $4
      AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId" AND parent."rootTaskId" = $4
      AND parent."parentTaskId" IS NULL AND parent."taskType" = 'root' AND parent."status" = 'waiting'
      AND parent."attemptCount" = $8 AND parent."failureReason" IS NULL
    JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
    WHERE wait."id" = $1 AND wait."userId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $5
      AND wait."parentTaskId" = $4 AND step."attempt" = 1 AND (step."taskId" = $4 OR step."taskId" IS NULL)
      AND step."status" = 'waiting_for_tool'`,
  [waitId, scope.userId, scope.sessionId, scope.rootTaskId, scope.turnId, witness.gateTaskId, turnStatus, rootAttemptCount])
  if (rows.rows.length !== 1) return false
  const row = asRecord(rows.rows[0]), targets = stringArray(row?.targetTaskIds), matched = stringArray(row?.matchedTaskIds)
  const result = asRecord(row?.result), request = asRecord(result?.request), marker = asRecord(request?.scheduledGate)
  const parentResult = asRecord(row?.parentResult)
  return !!row && !!parentResult && exact(parentResult, ["status", "stepCount", "toolCallCount", "finalItemId", "waitId"])
    && parentResult.status === "waiting_for_dependency" && parentResult.waitId === waitId
    && Number.isSafeInteger(parentResult.stepCount) && Number(parentResult.stepCount) >= 0
    && Number.isSafeInteger(parentResult.toolCallCount) && Number(parentResult.toolCallCount) >= 0
    && (parentResult.finalItemId === null || validId(parentResult.finalItemId))
    && row.id === waitId && row.userId === scope.userId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.parentTaskId === scope.rootTaskId && row.parentStatus === "waiting" && Number(row.parentAttemptCount) === rootAttemptCount
    && row.parentFailureReason === null && row.turnStatus === turnStatus && row.turnLeaseOwnerId === null
    && row.turnLeaseExpiresAt === null && (row.stepTaskId === null || row.stepTaskId === scope.rootTaskId)
    && validId(row.stepId) && row.stepAttempt === 1 && row.stepStatus === "waiting_for_tool"
    && row.status === "waiting" && row.mode === "any" && timestamp(row.suspendedAt) && row.resolvedAt === null && row.consumedAt === null
    && sameOne(targets, witness.gateTaskId) && matched?.length === 0 && Number(row.activeGateWaitCount) === 1
    && exact(result, ["request"]) && exact(request, ["targetTaskIds", "mode", "timeoutMs", "scheduledGate"])
    && sameOne(stringArray(request.targetTaskIds), witness.gateTaskId) && request.mode === "any" && request.timeoutMs === 86_400_000
    && exact(marker, ["gateTaskId", "requestAttemptCount"]) && marker.gateTaskId === witness.gateTaskId
    && marker.requestAttemptCount === witness.requestAttemptCount
    && row.idempotencyKey === gateWaitKey(witness.gateTaskId, String(row.stepId), witness.requestAttemptCount)
}

/** Returns only approval IDs whose private receipt, started item, and requested event all agree. */
export async function scheduledPrepareGateApprovalWitnessIds(client: Pick<pg.PoolClient, "query">, scope: Scope,
  witness: ScheduledPrepareGateWaitWitness, now = new Date()): Promise<string[]> {
  if (!witness.preparedJobIds.length) return []
  const approvals = await client.query<Row>(`SELECT approval."id", approval."userId", approval."sessionId", approval."turnId",
      approval."taskId", approval."jobId", approval."toolCallId", approval."type", approval."status", approval."title",
      approval."body", approval."impact", approval."payload", approval."scopeHash", approval."revision", approval."expiresAt",
      approval."decidedAt", approval."consumedAt", application."id" AS "applicationTaskId",
      application."userId" AS "applicationUserId", application."sessionId" AS "applicationSessionId",
      application."jobId" AS "applicationJobId"
    FROM "agent_approvals" AS approval
    JOIN "application_tasks" AS application ON application."id" = approval."taskId"
      AND application."userId" = approval."userId" AND application."sessionId" = approval."sessionId"
      AND application."jobId" = approval."jobId"
    WHERE approval."userId" = $1 AND approval."sessionId" = $2 AND approval."turnId" = $3
      AND approval."jobId" = ANY($4::text[]) AND approval."type" = 'review_application' AND approval."status" = 'pending'
      AND approval."decidedAt" IS NULL AND approval."consumedAt" IS NULL AND approval."expiresAt" > $5
      AND approval."payload"->'scheduledGateReview'->>'gateTaskId' = $6 ORDER BY approval."id" ASC LIMIT $7`,
  [scope.userId, scope.sessionId, scope.turnId, witness.preparedJobIds, now, witness.gateTaskId, MAX_GATE_JOBS + 1])
  if (approvals.rows.length > MAX_GATE_JOBS) return []
  const ids = approvals.rows.flatMap(row => validId(row.id) ? [row.id] : [])
  if (!ids.length) return []
  const itemIds = ids.map(id => `agent-wait:approval:${id}`)
  const [items, events] = await Promise.all([
    client.query<Row>(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt"
      FROM "agent_items" WHERE "id" = ANY($1::text[]) AND "sessionId" = $2 AND "turnId" = $3`, [itemIds, scope.sessionId, scope.turnId]),
    client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "idempotencyKey", "payload"
      FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'approval.requested'
        AND "correlationId" = ANY($3::text[])`, [scope.sessionId, scope.turnId, ids]),
  ])
  return approvals.rows.flatMap(approval => {
    const approvalId = validId(approval.id) ? approval.id : null
    if (!approvalId) return []
    const matchingItems = items.rows.filter(item => item.id === `agent-wait:approval:${approvalId}`)
    const matchingEvents = events.rows.filter(event => event.correlationId === approvalId)
    return matchingItems.length === 1 && matchingEvents.length === 1
      && validApprovalWitness(approval, matchingItems[0]!, matchingEvents[0]!, scope, witness, now) ? [approvalId] : []
  }).sort()
}

function validApprovalWitness(approval: Row, item: Row, event: Row, scope: Scope,
  witness: ScheduledPrepareGateWaitWitness, now: Date): boolean {
  const approvalId = approval.id, taskId = approval.taskId, jobId = approval.jobId, toolCallId = approval.toolCallId
  const expiresAt = asDate(approval.expiresAt), payload = asRecord(approval.payload), marker = asRecord(payload?.scheduledGateReview)
  const impact = asRecord(approval.impact), content = asRecord(item.content), eventPayload = asRecord(event.payload)
  return validId(approvalId) && approval.userId === scope.userId && approval.sessionId === scope.sessionId && approval.turnId === scope.turnId
    && approval.type === "review_application" && approval.status === "pending" && approval.decidedAt === null && approval.consumedAt === null
    && !!expiresAt && expiresAt > now && validId(taskId) && validId(jobId) && witness.preparedJobIds.includes(jobId)
    && approval.applicationTaskId === taskId && approval.applicationUserId === scope.userId
    && approval.applicationSessionId === scope.sessionId && approval.applicationJobId === jobId
    && validId(toolCallId) && typeof approval.scopeHash === "string" && approval.scopeHash.length > 0
    && Number.isSafeInteger(approval.revision) && Number(approval.revision) >= 0
    && !!payload && exact(marker, ["schemaVersion", "gateTaskId"]) && marker.schemaVersion === GATE_REVIEW_MARKER
    && marker.gateTaskId === witness.gateTaskId && payload.jobId === jobId && payload.applicationTaskId === taskId
    && Object.keys(payload).every(key => ["jobId", "applicationTaskId", "artifactBindings", "scheduledGateReview"].includes(key))
    && !!impact && exact(impact, ["externalSubmission", "jobId"]) && impact.externalSubmission === false && impact.jobId === jobId
    && !!content && exact(content, [...ITEM_CONTENT_KEYS]) && item.id === `agent-wait:approval:${approvalId}`
    && item.sessionId === scope.sessionId && item.turnId === scope.turnId && item.stepId === null && item.taskId === null
    && item.type === "approval_request" && item.status === "started" && item.revision === 0
    && !!asDate(item.startedAt) && item.completedAt === null && content.waitKind === "approval" && content.approvalId === approvalId
    && content.toolCallId === toolCallId && content.action === "review_application" && content.title === approval.title
    && content.body === approval.body && sameImpact(content.impact, impact) && content.scopeHash === approval.scopeHash
    && content.receiptRevision === approval.revision && content.expiresAt === expiresAt.toISOString() && content.decision === null
    && event.sessionId === scope.sessionId && event.turnId === scope.turnId && event.itemId === null && event.taskId === taskId
    && event.type === "approval.requested" && event.actor === "orchestrator" && event.correlationId === approvalId
    && event.idempotencyKey === `approval:${approvalId}:requested` && !!eventPayload
    && exact(eventPayload, ["approvalId", "action", "scopeHash", "revision"])
    && eventPayload.approvalId === approvalId && eventPayload.action === "review_application"
    && eventPayload.scopeHash === approval.scopeHash && eventPayload.revision === approval.revision
}

function gateWaitKey(taskId: string, stepId: string, attempt: number): string {
  return `scheduled-gate-wait:${createHash("sha256").update(JSON.stringify([taskId, stepId, attempt]), "utf8").digest("hex")}`
}
function parse(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function asRecord(value: unknown): Row | null {
  const parsed = parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(value: Row | null, keys: readonly string[]): value is Row {
  const actual = value && Reflect.ownKeys(value)
  return !!actual && actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function stringArray(value: unknown): string[] | null {
  const parsed = parse(value)
  return Array.isArray(parsed) && parsed.every(validId) && new Set(parsed).size === parsed.length ? parsed : null
}
function sameOne(values: string[] | null, value: string): boolean { return values?.length === 1 && values[0] === value }
function sameImpact(value: unknown, impact: Row): boolean {
  const actual = asRecord(value)
  return !!actual && exact(actual, ["externalSubmission", "jobId"])
    && actual.externalSubmission === impact.externalSubmission && actual.jobId === impact.jobId
}
function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value)
  return null
}
function timestamp(value: unknown): boolean { return asDate(value) !== null }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
