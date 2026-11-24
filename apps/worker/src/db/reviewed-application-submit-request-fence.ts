import type { PoolClient } from "pg"
import { parseReviewedApplicationFillSource, type ReviewedApplicationFillSourceSelection } from "@jobcopilot/shared"

import { withExactAttemptFence } from "../queue/application-submit-fence.js"
import type { ApplicationSubmissionStartScope } from "./application-task-state.js"
import { hasReviewedSubmissionArtifact, readReviewedApplicationSubmitMaterial } from "./reviewed-application-submit-material.js"
import { acquireSourceMaterialFence } from "./source-material-fence.js"

type Phase = "marker" | "boundary"
type ProofResult<T> = { readonly kind: "current"; readonly value: T; readonly sourceTurnId: string | null } | { readonly kind: "superseded" } | { readonly kind: "invalid" }
type ApprovalRow = {
  userId: string; sessionId: string; turnId: string | null; taskId: string | null; jobId: string | null; toolCallId: string | null
  type: string; status: string; payload: unknown; resourceHash: string | null; materialHash: string | null; answersHash: string | null
  scopeHash: string | null; expiresAt: Date | string | null; decidedAt: Date | string | null; consumedAt: Date | string | null
}
type AttemptRow = { userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string; state: string }
type EventRow = { data: unknown }

/** Rechecks a reviewed request under the shared source fence and exact attempt locks. */
export async function withReviewedApplicationSubmitRequestFence<T>(
  client: PoolClient,
  scope: ApplicationSubmissionStartScope,
  phase: Phase,
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
    if (current.kind === "selected" && !(await reviewedRequestIsCurrent(client, scope, phase, current.sourceTurnId))) {
      return { valid: false as const }
    }
    return { valid: true as const, value: await work(current.kind === "selected" ? current.sourceTurnId : undefined) }
  })
  if (fenced.kind === "superseded") return phase === "boundary"
    && (hinted.kind !== "absent" || expectedSourceTurnId !== undefined && expectedSourceTurnId !== null) ? { kind: "invalid" } : fenced
  return fenced.value.valid ? { kind: "current", value: fenced.value.value,
    sourceTurnId: hinted.kind === "selected" ? hinted.sourceTurnId : null } : { kind: "invalid" }
}

export async function readSubmissionTurnState(client: PoolClient, scope: ApplicationSubmissionStartScope): Promise<{
  readonly sessionStatus: string | undefined
  readonly turnStatus: string | undefined
  readonly interrupted: boolean | undefined
}> {
  const session = await client.query<{ status: string }>(
    `SELECT "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [scope.sessionId, scope.userId],
  )
  const turn = await client.query<{ status: string }>(
    `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
    [scope.turnId, scope.sessionId, scope.userId],
  )
  const interrupted = await client.query<{ stopped: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.interrupted') AS "stopped"`,
    [scope.sessionId, scope.turnId],
  )
  return { sessionStatus: session.rows[0]?.status, turnStatus: turn.rows[0]?.status, interrupted: interrupted.rows[0]?.stopped }
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
