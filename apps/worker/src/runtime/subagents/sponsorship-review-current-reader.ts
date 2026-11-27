import type pg from "pg"
import { readSponsorshipTaskObservationsWithClient, type SponsorshipObservationTask } from "./sponsorship-observation-binder-core.js"
import { buildSponsorshipReviewPacket } from "./sponsorship-review-packet.js"
import { readSponsorshipReviewObservation } from "./sponsorship-review-readback.js"
import { nativeVerificationControlContentMatches, readNativeVerificationControlTasks } from "./native-verification-pg-request.js"
import { digestNativeVerificationValue } from "./native-verification-contract.js"
import { toSponsorshipObservationModelFrame, type SponsorshipObservationModelFrame } from "./sponsorship-observation-contract.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
export type CurrentSponsorshipReviewEntry = Readonly<{
  jobId: string
  observation: SponsorshipObservationModelFrame
  reviewerTaskId: string
  reviewerAttempt: number
  reviewBindingDigest: string
}>
export type SponsorshipCurrentReviewReadDiagnosticStage =
  | "controls_unavailable" | "control_missing" | "reviewer_status_invalid" | "reviewer_attempt_binding_mismatch"
  | "reviewer_country_mismatch" | "reviewer_record_bound"
  | "scout_missing" | "job_missing" | "source_mismatch" | "packet_mismatch" | "proof_invalid" | "review_readback_bound"

function reportDiagnosticStage(
  report: ((stage: SponsorshipCurrentReviewReadDiagnosticStage) => void) | undefined,
  stage: SponsorshipCurrentReviewReadDiagnosticStage,
): void {
  if (process.env.NODE_ENV !== "test" || typeof report !== "function") return
  try { report(stage) } catch { /* Diagnostics must never change the read result. */ }
}

function row(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}

/** Rebuilds the source packet and private Reviewer proof under the current Root transaction. */
export async function readCurrentSponsorshipReviewWithClient(client: Queryable, input: Readonly<{
  scope: TaskGraphReadScope; reviewerTaskId: string; rootAttemptCount: number; targetCountryCode: string
}>, reportStage?: (stage: SponsorshipCurrentReviewReadDiagnosticStage) => void): Promise<CurrentSponsorshipReviewEntry | undefined> {
  const diagnose = (stage: SponsorshipCurrentReviewReadDiagnosticStage) => reportDiagnosticStage(reportStage, stage)
  let controls
  try { controls = await readNativeVerificationControlTasks(client, input.scope) }
  catch (error) { diagnose("controls_unavailable"); throw error }
  const selected = controls.filter(task => task.taskId === input.reviewerTaskId && task.control.target.kind === "sponsorship_source")
  if (selected.length !== 1) { diagnose("control_missing"); return undefined }
  const reviewer = selected[0]!, target = reviewer.control.target
  if (target.kind !== "sponsorship_source" || reviewer.status !== "completed" || reviewer.failureReason !== null
    || reviewer.interruptRequestedAt !== null || reviewer.attemptCount < 1 || reviewer.qualityGateResultOversize === true) {
    diagnose("reviewer_status_invalid"); return undefined
  }
  if (target.rootAttemptCount !== input.rootAttemptCount) { diagnose("reviewer_attempt_binding_mismatch"); return undefined }
  if (target.targetCountryCode !== input.targetCountryCode) { diagnose("reviewer_country_mismatch"); return undefined }
  diagnose("reviewer_record_bound")
  const sourceTaskResult = await client.query(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."role", task."taskType", task."status", task."attemptCount", task."context", task."result"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $4
      AND task."role" = 'scout' AND task."taskType" = 'job_discovery' AND task."status" = 'completed' AND task."attemptCount" = $5
      AND session."userId" = $6 AND turn."userId" = $6 AND turn."rootTaskId" = $4 FOR SHARE OF task`,
  [target.scoutTaskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, target.scoutAttempt, input.scope.userId])
  const scout = row(sourceTaskResult.rows[0]) as unknown as SponsorshipObservationTask | undefined
  if (sourceTaskResult.rows.length !== 1 || !scout) { diagnose("scout_missing"); return undefined }
  const jobLock = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2 FOR SHARE`, [target.jobId, input.scope.userId])
  if (jobLock.rows.length !== 1) { diagnose("job_missing"); return undefined }
  const bound = await readSponsorshipTaskObservationsWithClient(client, scout, { jobIds: [target.jobId] })
  const source = bound?.length === 1 && bound[0]?.jobId === target.jobId && bound[0].observation.status === "inconclusive"
    ? bound[0].source : undefined
  if (!source || source.scoutResultDigest !== target.scoutResultDigest || source.sourceReceiptDigest !== target.sourceReceiptDigest
    || source.materialDigest !== target.materialDigest) { diagnose("source_mismatch"); return undefined }
  const packet = buildSponsorshipReviewPacket({ userId: input.scope.userId, sessionId: input.scope.sessionId,
    turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId, rootAttemptCount: input.rootAttemptCount,
    scoutTaskId: scout.id, scoutAttempt: scout.attemptCount, scoutResultDigest: source.scoutResultDigest,
    jobId: target.jobId, sourceReceiptDigest: source.sourceReceiptDigest, materialDigest: source.materialDigest,
    targetCountryCode: input.targetCountryCode, job: source.job })
  if (!packet || !nativeVerificationControlContentMatches(reviewer.packet, packet.content)) { diagnose("packet_mismatch"); return undefined }
  const observation = readSponsorshipReviewObservation({ taskId: reviewer.taskId, status: reviewer.status,
    attemptCount: reviewer.attemptCount, failureReason: reviewer.failureReason,
    interruptRequestedAt: reviewer.interruptRequestedAt, result: reviewer.result,
    qualityGateResult: reviewer.qualityGateResult, qualityGateResultOversize: reviewer.qualityGateResultOversize,
    control: reviewer.control, packet: reviewer.packet, source: packet })
  if (!observation) { diagnose("proof_invalid"); return undefined }
  const modelFrame = toSponsorshipObservationModelFrame(observation)
  const reviewBindingDigest = `sha256:${digestNativeVerificationValue({
    owner: { userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId },
    rootAttemptCount: input.rootAttemptCount, targetCountryCode: input.targetCountryCode,
    target, sourceBindingDigest: target.sourceBindingDigest, jobId: target.jobId,
    reviewerTaskId: reviewer.taskId, reviewerAttempt: reviewer.attemptCount,
    controlOperationId: reviewer.control.controlOperationId, evidencePacketDigest: reviewer.control.evidencePacketDigest,
    reviewerResultDigest: digestNativeVerificationValue(reviewer.result), privateReportDigest: digestNativeVerificationValue(reviewer.qualityGateResult),
    observation: modelFrame,
  })}`
  diagnose("review_readback_bound")
  return { jobId: target.jobId, observation: modelFrame, reviewerTaskId: reviewer.taskId,
    reviewerAttempt: reviewer.attemptCount, reviewBindingDigest }
}
