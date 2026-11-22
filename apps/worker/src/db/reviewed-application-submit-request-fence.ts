import type { PoolClient } from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { parseReviewedApplicationFillSource, type ReviewedApplicationFillSourceSelection } from "@jobcopilot/shared"

import { withExactAttemptFence } from "../queue/application-submit-fence.js"
import type { ApplicationSubmissionStartScope } from "./application-task-state.js"
import { hasReviewedSubmissionArtifact, readReviewedApplicationSubmitMaterial } from "./reviewed-application-submit-material.js"
import { acquireSourceMaterialFence } from "./source-material-fence.js"

type Phase = "marker" | "boundary"
type FencePhase = Phase | "stop_poll"
type ProofResult<T> = { readonly kind: "current"; readonly value: T; readonly sourceTurnId: string | null } | { readonly kind: "superseded" } | { readonly kind: "invalid" }
type ApprovalRow = {
  userId: string; sessionId: string; turnId: string | null; taskId: string | null; jobId: string | null; toolCallId: string | null
  type: string; status: string; payload: unknown; resourceHash: string | null; materialHash: string | null; answersHash: string | null
  scopeHash: string | null; expiresAt: Date | string | null; decidedAt: Date | string | null; consumedAt: Date | string | null
}
type AttemptRow = { userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string; state: string }
type EventRow = { data: unknown }
type StopPollApprovalRow = ApprovalRow & { id: string; nonceHash: string | null; revision: number }
type RotationEventRow = { actor: string; taskId: string | null; correlationId: string | null; idempotencyKey: string | null; payload: unknown }

/** Rechecks a reviewed request under the shared source fence and exact attempt locks. */
export const withReviewedApplicationSubmitRequestFence = <T>(client: PoolClient, scope: ApplicationSubmissionStartScope,
  phase: Phase, expectedSourceTurnId: string | null | undefined, work: (sourceTurnId?: string) => Promise<T>): Promise<ProofResult<T>> =>
  withReviewedApplicationSubmitFenceInternal(client, scope, phase, expectedSourceTurnId, work)

async function withReviewedApplicationSubmitFenceInternal<T>(
  client: PoolClient,
  scope: ApplicationSubmissionStartScope,
  phase: FencePhase,
  expectedSourceTurnId: string | null | undefined,
  work: (sourceTurnId?: string) => Promise<T>,
): Promise<ProofResult<T>> {
  const hinted = await readSource(client, scope)
  await acquireSourceMaterialFence(client, [scope.userId])
  const fenced = await withExactAttemptFence(client, scope, async () => {
    const current = await readSource(client, scope)
    if (!sameSource(hinted, current) || !matchesExpectedSource(current, expectedSourceTurnId) || current.kind === "invalid") {
      return { valid: false as const }
    }
    if (current.kind === "absent" && await hasReviewedSubmissionArtifact(client, scope)) return { valid: false as const }
    const requestIsCurrent = current.kind !== "selected" || (phase === "stop_poll"
      ? await reviewedStopPollIsCurrent(client, scope, current.sourceTurnId)
      : await reviewedRequestIsCurrent(client, scope, phase, current.sourceTurnId))
    if (!requestIsCurrent) return { valid: false as const }
    return { valid: true as const, value: await work(current.kind === "selected" ? current.sourceTurnId : undefined) }
  })
  if (fenced.kind === "superseded") return phase === "boundary"
    && (hinted.kind !== "absent" || expectedSourceTurnId !== undefined && expectedSourceTurnId !== null) ? { kind: "invalid" } : fenced
  return fenced.value.valid ? { kind: "current", value: fenced.value.value,
    sourceTurnId: hinted.kind === "selected" ? hinted.sourceTurnId : null } : { kind: "invalid" }
}

/** Read-only pre-browser proof; request admission still uses the consumed/reserved marker fence. */
export const withReviewedApplicationSubmitStopPollFence = <T>(client: PoolClient, scope: ApplicationSubmissionStartScope,
  work: (sourceTurnId?: string) => Promise<T>): Promise<ProofResult<T>> =>
  withReviewedApplicationSubmitFenceInternal(client, scope, "stop_poll", undefined, work)

export async function readSubmissionTurnState(client: PoolClient, scope: ApplicationSubmissionStartScope): Promise<{
  readonly sessionStatus: string | undefined
  readonly turnStatus: string | undefined
  readonly interrupted: boolean | undefined
}> {
  const session = await client.query<{ status: string }>(`SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [scope.sessionId, scope.userId])
  const turn = await client.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])
  const interrupted = await client.query<{ stopped: boolean }>(`SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
    AND "type" = 'turn.interrupted') AS "stopped"`, [scope.sessionId, scope.turnId])
  return { sessionStatus: session.rows[0]?.status, turnStatus: turn.rows[0]?.status, interrupted: interrupted.rows[0]?.stopped }
}

export async function readSubmissionTurnStopState(client: PoolClient, scope: ApplicationSubmissionStartScope): Promise<{
  readonly sessionStatus: string | undefined
  readonly turnStatus: string | undefined
  readonly leaseOwnerId: string | null | undefined
  readonly leaseStartedAt: Date | null | undefined
  readonly leaseExpiresAt: Date | null | undefined
  readonly leaseVersion: number | undefined
  readonly interruptionEvidence: boolean | undefined
}> {
  const session = await client.query<{ status: string }>(`SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [scope.sessionId, scope.userId])
  const turn = await client.query<{
    status: string; leaseOwnerId: string | null; leaseStartedAt: Date | null; leaseExpiresAt: Date | null; leaseVersion: number
  }>(`SELECT "status", "leaseOwnerId", "leaseStartedAt", "leaseExpiresAt", "leaseVersion" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [scope.turnId, scope.sessionId, scope.userId])
  const interruptions = await client.query<{ stopped: boolean }>(`SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
    AND "type" IN ('turn.interrupt.requested', 'turn.interrupted', 'turn.failed')) AS "stopped"`, [scope.sessionId, scope.turnId])
  const row = turn.rows[0]
  return { sessionStatus: session.rows[0]?.status, turnStatus: row?.status, leaseOwnerId: row?.leaseOwnerId,
    leaseStartedAt: row?.leaseStartedAt, leaseExpiresAt: row?.leaseExpiresAt, leaseVersion: row?.leaseVersion,
    interruptionEvidence: interruptions.rows[0]?.stopped }
}

async function readSource(client: PoolClient, scope: ApplicationSubmissionStartScope): Promise<ReviewedApplicationFillSourceSelection> {
  const result = await client.query<{ input: unknown }>(
    `SELECT "input" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 LIMIT 2`,
    [scope.fillTurnId, scope.sessionId, scope.userId],
  )
  return result.rows.length === 1 ? parseReviewedApplicationFillSource(result.rows[0]?.input) : { kind: "invalid" }
}

function sameSource(left: ReviewedApplicationFillSourceSelection, right: ReviewedApplicationFillSourceSelection): boolean {
  return left.kind === right.kind && (left.kind !== "selected" || right.kind === "selected" && left.sourceTurnId === right.sourceTurnId)
}
function matchesExpectedSource(current: ReviewedApplicationFillSourceSelection, expected: string | null | undefined): boolean {
  return expected === undefined || expected === null && current.kind === "absent"
    || typeof expected === "string" && current.kind === "selected" && current.sourceTurnId === expected
}

async function reviewedRequestIsCurrent(
  client: PoolClient,
  scope: ApplicationSubmissionStartScope,
  phase: Phase,
  sourceTurnId: string,
): Promise<boolean> {
  if (scope.turnId !== scope.fillTurnId) return false
  const expectedCheckpoint = phase === "marker" ? "browser_active" : "submission_request_started"
  const tasks = await client.query<{ status: string; checkpoint: string; workerTaskId: string | null }>(`SELECT "status","checkpoint","workerTaskId" FROM "application_tasks"
    WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 LIMIT 2`,
  [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId])
  const attempts = await client.query<AttemptRow>(`SELECT "userId","jobId","receiptId","constraintHash","artifactHash","state"
    FROM "submission_attempt" WHERE "receiptId"=$1 LIMIT 2 FOR UPDATE`, [scope.approvalId])
  const approvals = await client.query<ApprovalRow>(`SELECT "userId","sessionId","turnId","taskId","jobId","toolCallId","type","status","payload",
    "resourceHash","materialHash","answersHash","scopeHash","expiresAt","decidedAt","consumedAt"
    FROM "agent_approvals" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 LIMIT 2 FOR UPDATE`,
  [scope.approvalId, scope.userId, scope.sessionId])
  const starts = await client.query<EventRow>(`SELECT "data" FROM "application_task_events" WHERE "taskId"=$1 AND "type"='submission_execution_started'
    AND "actor"='worker' AND "data"->>'approvalId'=$2 LIMIT 2`, [scope.applicationTaskId, scope.approvalId])
  const task = tasks.rows[0], attempt = attempts.rows[0], approval = approvals.rows[0]
  if (tasks.rows.length !== 1 || !task || task.status !== "filling" || task.checkpoint !== expectedCheckpoint
    || task.workerTaskId !== scope.workerTaskId) return false
  if (attempts.rows.length !== 1 || !attempt || attempt.userId !== scope.userId || attempt.jobId !== scope.jobId
    || attempt.receiptId !== scope.approvalId || attempt.constraintHash !== scope.constraintHash || attempt.state !== "reserved") return false
  if (approvals.rows.length !== 1 || !approval || !validConsumedApproval(approval, scope)
    || attempt.artifactHash !== approval.resourceHash) return false
  if (phase === "marker" ? starts.rows.length !== 0 : starts.rows.length !== 1 || !matchesStartEvent(starts.rows[0]?.data, scope)) return false
  const proof = await readReviewedApplicationSubmitMaterial({
    client, identity: scope, sourceTurnId,
    approval: { resourceHash: approval.resourceHash!, materialHash: approval.materialHash!, answersHash: approval.answersHash! },
    currentSource: true,
  })
  return proof?.artifactHash === approval.resourceHash
}

async function reviewedStopPollIsCurrent(client: PoolClient, scope: ApplicationSubmissionStartScope, sourceTurnId: string): Promise<boolean> {
  if (scope.turnId !== scope.fillTurnId) return false
  const attempts = await client.query<{ state: string }>(`SELECT "state" FROM "submission_attempt" WHERE "receiptId"=$1 LIMIT 2 FOR UPDATE`, [scope.approvalId])
  if (attempts.rows.length === 1 && attempts.rows[0]?.state === "reserved") return reviewedRequestIsCurrent(client, scope, "marker", sourceTurnId)
  if (attempts.rows.length !== 0) return false
  const tasks = await client.query<{ status: string; checkpoint: string; workerTaskId: string | null; resumeId: string | null; coverLetterId: string | null }>(
    `SELECT "status","checkpoint","workerTaskId","resumeId","coverLetterId" FROM "application_tasks"
      WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 LIMIT 2 FOR UPDATE`,
    [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId])
  if (tasks.rows.length !== 1 || tasks.rows[0]?.status !== "filling" || tasks.rows[0]?.checkpoint !== "browser_active"
    || tasks.rows[0]?.workerTaskId !== scope.workerTaskId) return false
  const [reservations, starts, stages] = await Promise.all([
    client.query(`SELECT "id" FROM "agent_action_reservations" WHERE "approvalId"=$1 LIMIT 2 FOR UPDATE`, [scope.approvalId]),
    client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1 AND "type"='submission_execution_started'
      AND "actor"='worker' AND "data"->>'approvalId'=$2 LIMIT 2`, [scope.applicationTaskId, scope.approvalId]),
    client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1 AND "type"='submission_stop_protocol'
      AND "data"->>'approvalId'=$2 LIMIT 2`, [scope.applicationTaskId, scope.approvalId]),
  ])
  if (reservations.rows.length || starts.rows.length || stages.rows.length) return false
  const approvals = await client.query<StopPollApprovalRow>(`SELECT "id","userId","sessionId","turnId","taskId","jobId","toolCallId","type","status",
      "payload","resourceHash","materialHash","answersHash","scopeHash","nonceHash","revision","expiresAt","decidedAt","consumedAt"
    FROM "agent_approvals" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 LIMIT 2 FOR UPDATE`, [scope.approvalId, scope.userId, scope.sessionId])
  const approval = approvals.rows[0]
  if (approvals.rows.length !== 1 || !approval || !await validApprovedStopPollReceipt(approval, scope, tasks.rows[0]!)) return false
  const requests = await client.query<{ payload: unknown; sequence: string }>(
    `SELECT request."payload",request."sequence" FROM "agent_events" AS request WHERE request."sessionId"=$1 AND request."turnId"=$2
      AND request."type"='approval.requested' AND request."actor"='orchestrator' AND request."taskId"=$5 AND request."correlationId"=$3
      AND request."idempotencyKey"=$4 AND NOT EXISTS (SELECT 1 FROM "agent_events" AS revision WHERE revision."sessionId"=$1 AND revision."type"='goal.revision'
        AND revision."sequence">request."sequence") LIMIT 2`,
    [scope.sessionId, scope.fillTurnId, scope.approvalId, `approval:${scope.approvalId}:requested`, scope.applicationTaskId])
  if (requests.rows.length !== 1) return false
  const requestPayload = record(requests.rows[0]?.payload), originalScopeHash = requestPayload?.scopeHash
  if (!requestPayload || Object.keys(requestPayload).sort().join(",") !== "action,approvalId,revision,scopeHash"
    || requestPayload.action !== "submit_application" || requestPayload.approvalId !== scope.approvalId
    || !digest(originalScopeHash) || requestPayload.revision !== approval.revision) return false
  const rotations = await client.query<RotationEventRow>(
    `SELECT "actor","taskId","correlationId","idempotencyKey","payload" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2
      AND "type"='approval.receipt_rotated' AND "sequence">$4 AND ("correlationId"=$3 OR "payload"->>'approvalId'=$3) ORDER BY "sequence" DESC LIMIT 1`,
    [scope.sessionId, scope.fillTurnId, scope.approvalId, requests.rows[0]!.sequence])
  const rotation = rotations.rows[0], rotationPayload = record(rotation?.payload)
  // Web may redact payload approvalId; the exact event routing fields remain authoritative.
  if (rotation ? rotation.actor !== "system" || rotation.taskId !== scope.applicationTaskId || rotation.correlationId !== scope.approvalId
    || rotation.idempotencyKey !== `approval:${scope.approvalId}:receipt-rotated:${approval.scopeHash}` || !rotationPayload
    || Object.keys(rotationPayload).sort().join(",") !== "approvalId,revision,scopeHash"
    || (rotationPayload.approvalId !== scope.approvalId && rotationPayload.approvalId !== "[REDACTED]")
    || rotationPayload.scopeHash !== approval.scopeHash || rotationPayload.revision !== approval.revision
    : originalScopeHash !== approval.scopeHash) return false
  const proof = await readReviewedApplicationSubmitMaterial({ client, identity: scope, sourceTurnId,
    approval: { resourceHash: approval.resourceHash!, materialHash: approval.materialHash!, answersHash: approval.answersHash! }, currentSource: true })
  return proof?.artifactHash === approval.resourceHash
}

async function validApprovedStopPollReceipt(row: StopPollApprovalRow, scope: ApplicationSubmissionStartScope,
  task: { resumeId: string | null; coverLetterId: string | null }): Promise<boolean> {
  const payload = record(row.payload), keys = payload ? Object.keys(payload).sort().join(",") : ""
  const expiry = date(row.expiresAt), decided = date(row.decidedAt)
  if (row.id !== `application-fill:${scope.applicationTaskId}:${scope.fillTurnId}` || row.userId !== scope.userId
    || row.sessionId !== scope.sessionId || row.turnId !== scope.fillTurnId || row.taskId !== scope.applicationTaskId || row.jobId !== scope.jobId
    || row.toolCallId !== `application-submit:${scope.applicationTaskId}` || row.type !== "submit_application" || row.status !== "approved"
    || row.scopeHash !== scope.constraintHash || !digest(row.resourceHash) || !digest(row.materialHash) || !digest(row.answersHash)
    || !digest(row.nonceHash) || !Number.isSafeInteger(row.revision) || row.revision < 0 || !expiry || expiry <= new Date()
    || !decided || decided > expiry || row.consumedAt !== null || keys !== "applicationTaskId,coverLetterId,jobId,resumeId"
    || payload?.applicationTaskId !== scope.applicationTaskId || payload.jobId !== scope.jobId
    || payload.resumeId !== task.resumeId || payload.coverLetterId !== task.coverLetterId) return false
  return await hashApprovalScope({ userId: row.userId, sessionId: row.sessionId, turnId: row.turnId!, jobId: row.jobId!,
    toolCallId: row.toolCallId!, action: "submit_application", resourceHash: row.resourceHash!, materialHash: row.materialHash!,
    answersHash: row.answersHash!, revision: row.revision, nonceHash: row.nonceHash, expiresAt: expiry.toISOString() }) === row.scopeHash
}

function validConsumedApproval(row: ApprovalRow, scope: ApplicationSubmissionStartScope): boolean {
  const payload = record(row.payload), keys = payload ? Object.keys(payload).sort().join(",") : ""
  const expiry = date(row.expiresAt), decided = date(row.decidedAt), consumed = date(row.consumedAt)
  return row.userId === scope.userId && row.sessionId === scope.sessionId && row.turnId === scope.fillTurnId
    && row.taskId === scope.applicationTaskId && row.jobId === scope.jobId && row.toolCallId === `application-submit:${scope.applicationTaskId}`
    && row.type === "submit_application" && row.status === "consumed" && row.scopeHash === scope.constraintHash
    && digest(row.resourceHash) && digest(row.materialHash) && digest(row.answersHash)
    && payload?.applicationTaskId === scope.applicationTaskId && payload.jobId === scope.jobId
    && keys === "applicationTaskId,coverLetterId,jobId,resumeId"
    && expiry !== null && decided !== null && consumed !== null && decided <= consumed && consumed <= expiry
}

function matchesStartEvent(value: unknown, scope: ApplicationSubmissionStartScope): boolean {
  const event = record(value)
  return Boolean(event && Object.keys(event).sort().join(",") === "applicationTaskId,approvalId,constraintHash,executionId,fillTurnId,jobId,sessionId,userId,workerTaskId"
    && event.approvalId === scope.approvalId && event.applicationTaskId === scope.applicationTaskId && event.constraintHash === scope.constraintHash
    && event.executionId === scope.executionId && event.fillTurnId === scope.fillTurnId && event.jobId === scope.jobId
    && event.sessionId === scope.sessionId && event.userId === scope.userId && event.workerTaskId === scope.workerTaskId)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function date(value: Date | string | null): Date | null {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
