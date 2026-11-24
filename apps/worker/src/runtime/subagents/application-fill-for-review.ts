import type { Pool } from "pg"
import { unlinkSync } from "node:fs"
import { withCloakContext } from "../../cloak/pool.js"
import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview, failApplicationFillBeforeBrowser, persistApplicationFillWait, type ApplicationFillCompletionStaleGate } from "../../db/application-task-completion.js"
import { generateResumePdf } from "../../db/resume-pdf.js"
import { findFormPattern } from "../../db/form-patterns.js"
import { tailorResumeKeywords } from "../../db/tailor-resume.js"
import { detectBrowserWait, type HarnessResult } from "../../harness/agent-harness.js"
import { inspectFormReviewNeeds, type FormReviewNeeds } from "../../harness/form-review.js"
import { fillCustomQuestions } from "../../flows/helpers.js"
import { executeBrowserFill, type FlowType } from "../../flows/index.js"
import type { ReviewedFillExecutionPhase } from "../../flows/browser-fill-executor.js"
import { evaluateUnattendedApplyControl } from "../../queue/unattended-apply-control.js"
import { checkRateLimit } from "../../rate-limit.js"
import type { ObjectiveReviewedApplicationFillReadback, ReviewedApplicationFillReadback } from "../../db/reviewed-application-fill-completion.js"
import { claimApplicationFillBrowserStart, reviewedApplicationFillSelector, type BrowserStartClaim } from "../reviewed-application-fill-binding.js"
import { buildApplicationFillInput, isAllowedDestination, urlPattern, type ApplicationFillContext } from "../application-fill-preparation.js"
import { readObjectiveReviewedApplicationFillSourceFromPool } from "../objective-reviewed-application-fill-read.js"
import { objectiveReviewedMaterialWasFilled, reviewedMaterialWasFilled } from "./application-fill-reviewed-readback.js"
import type { SubagentExecutionResult, SubagentLease } from "./types.js"
type WaitDetail = "captcha_required" | "authentication_required" | "mfa_required" | "unknown_sensitive_field" | "required_field" | "stale_review" | "review_required" | "fill_outcome_uncertain" | "unattended_apply_unavailable" | "cancelled"; type WaitCheckpoint = "fill_outcome_uncertain" | "form_answer_required"
export type ApplicationFillAcquisitionPhase = "before_control_read" | "before_pattern_read" | "context_requested" | "page_acquired" | "navigation_returned" | "navigation_response_success" | "navigation_response_unavailable" | "destination_allowed" | "destination_rejected" | "wait_detection_returned" | "outer_wait_clear" | "outer_wait_detected" | "executor_started" | ReviewedFillExecutionPhase | "fill_returned" | "callback_settled" | "context_returned"
export type ApplicationFillStageObservation =
  | Readonly<{ stage: "entry_validation" | "wait_persistence" | "completion"; outcome: "accepted" | "rejected" | "waiting" | "completed" | "stale" | "conflict" | "failed" | "cancelled" | "unavailable"; leaseLost: boolean; signalAborted: boolean; staleGate?: ApplicationFillCompletionStaleGate }>
  | Readonly<{ stage: "browser_acquisition"; phase: ApplicationFillAcquisitionPhase }>
type StageObserver = (event: ApplicationFillStageObservation) => void; type FillContext = ApplicationFillContext
const LOAD_CONTEXT_SQL = [
  'SELECT app."id" AS "applicationTaskId", app."jobId", turn."input" AS "turnInput", app."userId" AS "applicationUserId", app."sessionId" AS "applicationSessionId", app."fillTurnId", app."fillTurnSessionId", app."fillTurnUserId", app."status" AS "taskStatus", app."checkpoint", app."resumeId", app."coverLetterId", app."confirmedAnswers", job."userId" AS "jobUserId", job.url AS "jobUrl", job.role AS "jobTitle", job.company AS "jobCompany", job.keywords AS "jobKeywords", job.description AS "jobDescription", job."coverLetter" AS "jobCoverLetter", usr."accountStatus", usr.name AS "userName", usr.email AS "userEmail", usr.phone AS "userPhone", usr.location AS "userLocation", usr.linkedin AS "userLinkedin", usr."personaFields",',
  'resume.content AS "resumeContent", cover.content AS "coverLetterContent", session."userId" AS "sessionUserId", session.status AS "sessionStatus", turn."userId" AS "turnUserId", turn."sessionId" AS "turnSessionId", turn.status AS "turnStatus"',
  'FROM application_tasks app JOIN "Job" job ON job.id = app."jobId" AND job."userId" = app."userId" JOIN "User" usr ON usr.id = app."userId" LEFT JOIN "Resume" resume ON resume.id = app."resumeId" AND resume."userId" = app."userId" LEFT JOIN "CoverLetter" cover ON cover.id = app."coverLetterId" AND cover."userId" = app."userId" AND cover."jobId" = app."jobId"',
  'JOIN agent_sessions session ON session.id = app."sessionId" AND session."userId" = app."userId"',
  'JOIN agent_turns turn ON turn.id = app."fillTurnId" AND turn."sessionId" = app."sessionId" AND turn."userId" = app."userId" WHERE app."userId" = $1 AND app."sessionId" = $2 AND app."fillTurnId" = $3 AND app."fillTurnSessionId" = $2 AND app."fillTurnUserId" = $1',
].join(" ")
/** Server-owned fill adapter. Client/model context is never used to resolve task identity. */
export async function executeApplicationFillForReview(input: { pool: Pool; lease: SubagentLease; stageObserver?: StageObserver }): Promise<SubagentExecutionResult> {
  const { pool, lease } = input, invalidLease = validateLease(lease)
  if (input.stageObserver) observeStage(input.stageObserver, { stage: "entry_validation", outcome: invalidLease ? "rejected" : "accepted", leaseLost: invalidLease === "lease_lost", signalAborted: Boolean(lease.signal?.aborted) })
  if (invalidLease) return failed(invalidLease)
  if (typeof lease.turnId !== "string" || !lease.turnId.trim()) return failed("fill_lease_invalid")
  if (lease.interruptRequestedAt || lease.signal.aborted) return acknowledgeCancellation(pool, lease)
  let context: FillContext | null
  try {
    context = await loadFillContext(pool, lease)
  } catch { return preBrowserFailure(pool, lease, "fill_context_unavailable") }
  if (!context || !matchesLeaseScope(context, lease)) return failed("fill_scope_mismatch")
  const reviewedSelector = reviewedApplicationFillSelector(context.turnInput)
  if (reviewedSelector.kind === "invalid") return failed("fill_reviewed_source_invalid")
  let objectiveEvidence: Awaited<ReturnType<typeof readObjectiveReviewedApplicationFillSourceFromPool>> = undefined
  const observeAcquisitionPhase = (phase: ApplicationFillAcquisitionPhase) => {
    if (reviewedSelector.kind === "selected" || reviewedSelector.kind === "objective") observeStage(input.stageObserver, { stage: "browser_acquisition", phase })
  }
  if (needsCompletionReplay(context)) {
    const completion = input.stageObserver ? await completeForReview(pool, lease, input.stageObserver) : await completeApplicationFillForReview(pool, { lease })
    return completion.status === "completed" ? { status: "completed", result: { status: "filled_for_user_review" } } : lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed(completion.status === "stale" ? "lease_lost" : "fill_completion_conflict")
  }
  if (context.accountStatus !== "active") return failed("account_inactive")
  if (context.taskStatus === "waiting_for_user" && ["form_answer_required", "fill_outcome_uncertain"].includes(context.checkpoint ?? "") && context.sessionStatus === "waiting_for_user" && context.turnStatus === "waiting_for_user") return { status: "waiting_for_user", failureReason: context.checkpoint === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : "review_required" }
  if (context.taskStatus !== "filling") return failed("application_task_inactive")
  if (context.checkpoint === "browser_active") return wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain", undefined, input.stageObserver)
  if (context.checkpoint !== "taskgraph_fill_queued") return failed("fill_checkpoint_invalid")
  if (!["running", "waiting_for_user"].includes(context.sessionStatus) || !["in_progress", "waiting_for_user", "waiting_for_dependency"].includes(context.turnStatus)) return failed("fill_turn_inactive")
  if (reviewedSelector.kind === "objective") {
    objectiveEvidence = await readObjectiveReviewedApplicationFillSourceFromPool(pool, { userId: lease.userId,
      sessionId: lease.sessionId, fillTurnId: lease.turnId, applicationTaskId: context.applicationTaskId,
      jobId: context.jobId, turnInput: context.turnInput, phase: "prepare" })
    if (!objectiveEvidence || objectiveEvidence.source.materialProofHash !== reviewedSelector.source.materialProofHash
      || objectiveEvidence.source.approvalId !== reviewedSelector.source.approvalId
      || objectiveEvidence.source.reviewTurnId !== reviewedSelector.source.reviewTurnId) {
      return preBrowserFailure(pool, lease, "objective_application_fill_unavailable")
    }
  }
  let task: ReturnType<typeof buildApplicationFillInput>
  try {
    task = buildApplicationFillInput(objectiveEvidence ? { ...context, resumeContent: objectiveEvidence.resumeContent } : context,
      reviewedSelector.kind !== "absent")
  } catch { return preBrowserFailure(pool, lease, "fill_material_unavailable") }
  let control: Awaited<ReturnType<typeof evaluateUnattendedApplyControl>>
  try {
    const rate = await checkRateLimit(lease.userId, new URL(task.applyUrl).hostname)
    if (!rate.allowed) return preBrowserFailure(pool, lease, "fill_rate_limited")
  } catch { return preBrowserFailure(pool, lease, "fill_preflight_unavailable") }
  let resumePath: string
  try { resumePath = await generateResumePdf(lease.userId,
    objectiveEvidence ? task.resumeContent : tailorResumeKeywords(task.resumeContent, task.jobKeywords)) }
  catch { return preBrowserFailure(pool, lease, "fill_material_unavailable") }
  let start: BrowserStartClaim
  try { start = await claimApplicationFillBrowserStart({ pool, lease, expectedSelector: reviewedSelector,
    ...(objectiveEvidence ? { expectedObjectiveResumeWitness: objectiveEvidence.resumeWitness } : {}),
    applicationTaskId: context.applicationTaskId, jobId: context.jobId }) }
  catch { discardResume(resumePath); return lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed("fill_prestart_unavailable") }
  if (start.status === "already_started") { discardResume(resumePath); return wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain", undefined, input.stageObserver) }
  if (start.status !== "claimed") { discardResume(resumePath); return start.status === "stale" || lease.signal.aborted || lease.interruptRequestedAt ? acknowledgeCancellation(pool, lease) : failed("fill_start_conflict") }
  if (start.reviewedMaterial) task.persona.coverLetter = start.reviewedMaterial.content
  try {
    observeAcquisitionPhase("before_control_read")
    control = await evaluateUnattendedApplyControl(pool, task.applyUrl, lease.userId)
    if (!control.allowed) return wait(pool, lease, "form_answer_required", "unattended_apply_unavailable", undefined, input.stageObserver)
    observeAcquisitionPhase("before_pattern_read")
    const pattern = await findFormPattern(lease.userId, new URL(task.applyUrl).hostname, urlPattern(task.applyUrl)).catch(() => null)
    observeAcquisitionPhase("context_requested")
    const outcome = await withCloakContext(lease.userId, async page => {
      observeAcquisitionPhase("page_acquired")
      const closeOnAbort = () => { void page.close().catch(() => undefined) }
      lease.signal.addEventListener("abort", closeOnAbort, { once: true })
      try {
        if (lease.signal.aborted) { closeOnAbort(); return cancelledOutcome() }
        if (start.reviewedMaterial) page.setDefaultTimeout(30_000)
        const navigationResponse = await page.goto(task.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        observeAcquisitionPhase("navigation_returned")
        observeAcquisitionPhase(navigationResponse?.ok() ? "navigation_response_success" : "navigation_response_unavailable")
        if (lease.signal.aborted) return cancelledOutcome()
        const destinationAllowed = isAllowedDestination(page.url(), control.flow, task.applyUrl)
        observeAcquisitionPhase(destinationAllowed ? "destination_allowed" : "destination_rejected")
        if (!destinationAllowed) {
          return { kind: "wait" as const, detail: "fill_outcome_uncertain" as const }
        }
        const browserWait = await detectBrowserWait(page)
        observeAcquisitionPhase("wait_detection_returned")
        observeAcquisitionPhase(browserWait ? "outer_wait_detected" : "outer_wait_clear")
        if (browserWait) return { kind: "wait" as const, detail: waitDetail(browserWait.reason) }
        if (lease.signal.aborted) return cancelledOutcome()
        observeAcquisitionPhase("executor_started")
        const result = await executeBrowserFill({
          jobId: "server-bound-application",
          applyUrl: task.applyUrl,
          atsType: control.flow,
          persona: task.persona,
          jobTitle: task.jobTitle,
          jobCompany: task.jobCompany,
          jobKeywords: task.jobKeywords,
          jobDescription: task.jobDescription,
          resumePath,
          submit: false,
        }, { page, pattern, aiAvailable: true, harnessConfig: { userId: lease.userId, signal: lease.signal }, ...(start.reviewedMaterial && control.flow === "greenhouse" ? { reviewedCoverLetter: { content: start.reviewedMaterial.content } } : {}), ...(reviewedSelector.kind !== "absent" && reviewedSelector.kind !== "invalid" && input.stageObserver ? { reviewedPhaseObserver: observeAcquisitionPhase } : {}) })
        observeAcquisitionPhase("fill_returned")
        if (lease.signal.aborted || result.classification === "cancelled") return cancelledOutcome()
        if (result.waitReason) return { kind: "wait" as const, detail: waitDetail(result.waitReason) }
        if (result.reviewReady) {
          await fillCustomQuestions(page, task.persona, [], task.confirmedAnswers)
          const reviewedFillReadback = start.objectiveEvidence && start.reviewedMaterial
            ? await objectiveReviewedMaterialWasFilled(page, result, start.reviewedMaterial, start.objectiveEvidence.source, lease, context.applicationTaskId)
            : start.reviewedMaterial ? await reviewedMaterialWasFilled(page, result, start.reviewedMaterial, lease, context.applicationTaskId) : undefined
          if (start.reviewedMaterial && !reviewedFillReadback) return { kind: "wait" as const, detail: "review_required" as const }
          const needs = safeNeeds(await inspectFormReviewNeeds(page))
          if (needs.missing.length || needs.sensitive.length) {
            return { kind: "needs" as const, needs, detail: needs.sensitive.length ? "unknown_sensitive_field" as const : "required_field" as const }
          }
          return { kind: "ready" as const, result, ...(reviewedFillReadback ? { reviewedFillReadback } : {}) }
        }
        return { kind: "wait" as const, detail: waitDetailFromResult(result) }
      } finally { lease.signal.removeEventListener("abort", closeOnAbort); observeAcquisitionPhase("callback_settled") }
    })
    observeAcquisitionPhase("context_returned")
    if (outcome.kind === "wait" && outcome.detail === "cancelled") return acknowledgeCancellation(pool, lease)
    if (outcome.kind === "wait") return wait(pool, lease, outcome.detail === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : "form_answer_required", outcome.detail, undefined, input.stageObserver)
    if (outcome.kind === "needs") return wait(pool, lease, "form_answer_required", outcome.detail, outcome.needs, input.stageObserver)
    if (outcome.kind !== "ready") return failed("fill_outcome_uncertain")
    const completed = input.stageObserver ? await completeForReview(pool, lease, input.stageObserver, outcome.reviewedFillReadback)
      : await completeApplicationFillForReview(pool, { lease, ...(outcome.reviewedFillReadback ? { reviewedFillReadback: outcome.reviewedFillReadback } : {}) })
    return completed.status === "waiting" ? { status: "waiting_for_user", failureReason: "stale_review" }
      : completed.status === "completed" ? { status: "completed", result: { status: "filled_for_user_review" } }
      : lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed(completed.status === "stale" ? "lease_lost" : "fill_completion_conflict")
  } catch {
    return lease.signal.aborted ? acknowledgeCancellation(pool, lease) : wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain", undefined, input.stageObserver)
  } finally {
    discardResume(resumePath)
  }
}
function validateLease(lease: SubagentLease): string | null {
  if (lease.role !== "application_filler" || lease.taskType !== "application_fill_for_review") return "fill_role_invalid"
  if (lease.status !== "running" || !lease.userId || !lease.sessionId || !lease.turnId || !lease.id || !lease.ownerId || lease.leaseOwner !== lease.ownerId || !Number.isInteger(lease.attemptCount) || lease.attemptCount < 1) return "fill_lease_invalid"
  if (!(lease.leaseExpiresAt instanceof Date) || lease.leaseExpiresAt.getTime() <= Date.now()) return "lease_lost"
  return null
}
async function acknowledgeCancellation(pool: Pool, lease: SubagentLease): Promise<SubagentExecutionResult> {
  try {
    const result = await acknowledgeApplicationFillCancellation(pool, { lease })
    return result.status === "cancelled" ? failed("fill_cancelled") : failed(result.status === "stale" ? "lease_lost" : "fill_cancellation_conflict")
  } catch { return failed("fill_cancellation_unavailable") }
}
function matchesLeaseScope(row: FillContext, lease: SubagentLease): boolean { return [row.applicationUserId, row.fillTurnUserId, row.jobUserId, row.sessionUserId, row.turnUserId].every(id => id === lease.userId) && [row.applicationSessionId, row.fillTurnSessionId, row.turnSessionId].every(id => id === lease.sessionId) && row.fillTurnId === lease.turnId }
function failed(reason: string, retryable = false): SubagentExecutionResult { return { status: "failed", failureReason: reason, ...(retryable ? { retryDisposition: "retryable" as const } : {}) } }
async function preBrowserFailure(pool: Pool, lease: SubagentLease, reason: string): Promise<SubagentExecutionResult> {
  if (lease.signal.aborted || lease.interruptRequestedAt) return acknowledgeCancellation(pool, lease)
  if (lease.attemptCount < lease.maxAttempts) return failed(reason, true)
  try {
    const result = await failApplicationFillBeforeBrowser(pool, { lease })
    return result.status === "failed" ? failed(reason) : failed(result.status === "stale" ? "lease_lost" : "fill_prestart_failure_conflict")
  } catch { return failed("fill_prestart_failure_unavailable") }
}
function cancelledOutcome() { return { kind: "wait" as const, detail: "cancelled" as const } }; function needsCompletionReplay(row: FillContext): boolean { return row.turnStatus === "waiting_for_approval" && ((row.taskStatus === "waiting_for_authorization" && row.checkpoint === "form_filled" && row.sessionStatus === "waiting_for_user") || (row.taskStatus === "filling" && row.checkpoint === "submission_authorized" && ["running", "waiting_for_user"].includes(row.sessionStatus)) || (row.taskStatus === "waiting_for_authorization" && row.checkpoint === "queue_retry" && ["running", "waiting_for_user"].includes(row.sessionStatus))) }
function discardResume(path: string): void { try { unlinkSync(path) } catch { /* temporary file may already be gone */ } }; function observeStage(observer: StageObserver | undefined, event: ApplicationFillStageObservation): void { if (observer) try { observer(event) } catch {} }
async function completeForReview(pool: Pool, lease: SubagentLease, observer?: StageObserver,
  reviewedFillReadback?: ReviewedApplicationFillReadback | ObjectiveReviewedApplicationFillReadback) {
  try {
    let staleGate: ApplicationFillCompletionStaleGate | undefined
    const result = await completeApplicationFillForReview(pool, { lease, ...(reviewedFillReadback ? { reviewedFillReadback } : {}), ...(observer ? { onStaleGate: (gate: ApplicationFillCompletionStaleGate) => { staleGate = gate } } : {}) })
    if (observer) observeStage(observer, { stage: "completion", outcome: result.status, leaseLost: result.status === "stale" && !lease.signal.aborted, signalAborted: lease.signal.aborted, ...(result.status === "stale" && staleGate ? { staleGate } : {}) }); return result
  } catch (error) { if (observer) observeStage(observer, { stage: "completion", outcome: "unavailable", leaseLost: false, signalAborted: lease.signal.aborted }); throw error }
}
async function wait(pool: Pool, lease: SubagentLease, checkpoint: WaitCheckpoint, detail: WaitDetail, needs?: FormReviewNeeds, observer?: StageObserver): Promise<SubagentExecutionResult> {
  if (lease.signal.aborted || lease.interruptRequestedAt) return acknowledgeCancellation(pool, lease)
  try {
    const result = await persistApplicationFillWait(pool, { lease, checkpoint, detail, ...(needs ? { needs } : {}) })
    if (observer) observeStage(observer, { stage: "wait_persistence", outcome: result.status === "waiting" ? "waiting" : result.status, leaseLost: result.status === "stale" && !lease.signal.aborted, signalAborted: lease.signal.aborted })
    return result.status === "waiting" ? { status: "waiting_for_user", failureReason: detail } : failed(lease.signal.aborted ? "fill_cancelled" : result.status === "stale" ? "lease_lost" : "fill_wait_conflict")
  } catch { if (observer) observeStage(observer, { stage: "wait_persistence", outcome: "unavailable", leaseLost: false, signalAborted: lease.signal.aborted }); return failed("fill_wait_persistence_unavailable") }
}
function waitDetail(reason: NonNullable<Awaited<ReturnType<typeof detectBrowserWait>>>["reason"]): WaitDetail { return reason === "captcha" ? "captcha_required" : reason === "login_required" ? "authentication_required" : reason === "mfa_required" ? "mfa_required" : reason === "stale_review" ? "stale_review" : "unknown_sensitive_field" }; function waitDetailFromResult(result: HarnessResult): WaitDetail { return result.classification === "cancelled" ? "cancelled" : result.classification === "browser_crash" ? "fill_outcome_uncertain" : result.classification === "untrusted_input" ? "unknown_sensitive_field" : "review_required" }
function safeNeeds(needs: FormReviewNeeds): FormReviewNeeds { const safe = (fields: FormReviewNeeds["missing"]) => fields.map(({ key, label }) => ({ key, label: label.slice(0, 200) })); return { missing: safe(needs.missing), sensitive: safe(needs.sensitive) } }

async function loadFillContext(pool: Pool, lease: SubagentLease): Promise<FillContext | null> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const rows = await client.query<FillContext>(LOAD_CONTEXT_SQL, [lease.userId, lease.sessionId, lease.turnId])
    await client.query("COMMIT")
    return rows.rows.length === 1 ? rows.rows[0] : null
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
