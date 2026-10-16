import type { Pool, PoolClient } from "pg"
import { unlinkSync } from "node:fs"
import { withCloakContext } from "../../cloak/pool.js"
import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview, failApplicationFillBeforeBrowser, persistApplicationFillWait } from "../../db/application-task-completion.js"
import { generateResumePdf, type ResumeContent } from "../../db/resume-pdf.js"
import { findFormPattern } from "../../db/form-patterns.js"
import { tailorResumeKeywords } from "../../db/tailor-resume.js"
import { detectBrowserWait, type HarnessResult } from "../../harness/agent-harness.js"
import { inspectFormReviewNeeds, type FormReviewNeeds } from "../../harness/form-review.js"
import { fillCustomQuestions } from "../../flows/helpers.js"
import { executeBrowserFill, type FlowType } from "../../flows/index.js"
import { evaluateUnattendedApplyControl } from "../../queue/unattended-apply-control.js"
import { checkRateLimit } from "../../rate-limit.js"
import type { SubagentExecutionResult, SubagentLease } from "./types.js"

type WaitDetail = "captcha_required" | "authentication_required" | "mfa_required" | "unknown_sensitive_field" | "required_field" | "stale_review" | "review_required" | "fill_outcome_uncertain" | "unattended_apply_unavailable" | "cancelled"
type WaitCheckpoint = "fill_outcome_uncertain" | "form_answer_required"
type FillContext = { applicationUserId: string; applicationSessionId: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; taskStatus: string; checkpoint: string | null; resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown; jobUserId: string; jobUrl: string | null; jobTitle: string; jobCompany: string; jobKeywords: string | null; jobDescription: string | null; jobCoverLetter: string | null; accountStatus: string; userName: string | null; userEmail: string; userPhone: string | null; userLocation: string | null; userLinkedin: string | null; personaFields: unknown; resumeContent: unknown; coverLetterContent: string | null; sessionUserId: string; sessionStatus: string; turnUserId: string; turnSessionId: string; turnStatus: string }
const LOAD_CONTEXT_SQL = [
  'SELECT app."userId" AS "applicationUserId", app."sessionId" AS "applicationSessionId", app."fillTurnId", app."fillTurnSessionId", app."fillTurnUserId", app."status" AS "taskStatus", app."checkpoint", app."resumeId", app."coverLetterId", app."confirmedAnswers", job."userId" AS "jobUserId", job.url AS "jobUrl", job.role AS "jobTitle", job.company AS "jobCompany", job.keywords AS "jobKeywords", job.description AS "jobDescription", job."coverLetter" AS "jobCoverLetter", usr."accountStatus", usr.name AS "userName", usr.email AS "userEmail", usr.phone AS "userPhone", usr.location AS "userLocation", usr.linkedin AS "userLinkedin", usr."personaFields",',
  'resume.content AS "resumeContent", cover.content AS "coverLetterContent", session."userId" AS "sessionUserId", session.status AS "sessionStatus", turn."userId" AS "turnUserId", turn."sessionId" AS "turnSessionId", turn.status AS "turnStatus"',
  'FROM application_tasks app JOIN "Job" job ON job.id = app."jobId" AND job."userId" = app."userId" JOIN "User" usr ON usr.id = app."userId" LEFT JOIN "Resume" resume ON resume.id = app."resumeId" AND resume."userId" = app."userId" LEFT JOIN "CoverLetter" cover ON cover.id = app."coverLetterId" AND cover."userId" = app."userId" AND cover."jobId" = app."jobId"',
  'JOIN agent_sessions session ON session.id = app."sessionId" AND session."userId" = app."userId"',
  'JOIN agent_turns turn ON turn.id = app."fillTurnId" AND turn."sessionId" = app."sessionId" AND turn."userId" = app."userId" WHERE app."userId" = $1 AND app."sessionId" = $2 AND app."fillTurnId" = $3 AND app."fillTurnSessionId" = $2 AND app."fillTurnUserId" = $1',
].join(" ")

/** Server-owned fill adapter. Client/model context is never used to resolve task identity. */
export async function executeApplicationFillForReview(input: { pool: Pool; lease: SubagentLease }): Promise<SubagentExecutionResult> {
  const { pool, lease } = input
  const invalidLease = validateLease(lease)
  if (invalidLease) return failed(invalidLease)
  if (lease.interruptRequestedAt || lease.signal.aborted) return acknowledgeCancellation(pool, lease)
  let context: FillContext | null
  try {
    context = await loadFillContext(pool, lease)
  } catch { return preBrowserFailure(pool, lease, "fill_context_unavailable") }
  if (!context || !matchesLeaseScope(context, lease)) return failed("fill_scope_mismatch")
  if (needsCompletionReplay(context)) {
    const completion = await completeApplicationFillForReview(pool, { lease })
    return completion.status === "completed" ? { status: "completed", result: { status: "filled_for_user_review" } } : lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed(completion.status === "stale" ? "lease_lost" : "fill_completion_conflict")
  }
  if (context.accountStatus !== "active") return failed("account_inactive")
  if (context.taskStatus === "waiting_for_user" && ["form_answer_required", "fill_outcome_uncertain"].includes(context.checkpoint ?? "") && context.sessionStatus === "waiting_for_user" && context.turnStatus === "waiting_for_user") return { status: "waiting_for_user", failureReason: context.checkpoint === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : "review_required" }
  if (context.taskStatus !== "filling") return failed("application_task_inactive")
  if (context.checkpoint === "browser_active") return wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain")
  if (context.checkpoint !== "taskgraph_fill_queued") return failed("fill_checkpoint_invalid")
  if (!["running", "waiting_for_user"].includes(context.sessionStatus) || !["in_progress", "waiting_for_user", "waiting_for_dependency"].includes(context.turnStatus)) return failed("fill_turn_inactive")
  let task: ReturnType<typeof buildFillInput>
  try {
    task = buildFillInput(context)
  } catch { return preBrowserFailure(pool, lease, "fill_material_unavailable") }
  let control: Awaited<ReturnType<typeof evaluateUnattendedApplyControl>>
  try {
    const rate = await checkRateLimit(lease.userId, new URL(task.applyUrl).hostname)
    if (!rate.allowed) return preBrowserFailure(pool, lease, "fill_rate_limited")
  } catch { return preBrowserFailure(pool, lease, "fill_preflight_unavailable") }
  let resumePath: string
  try { resumePath = await generateResumePdf(lease.userId, tailorResumeKeywords(task.resumeContent, task.jobKeywords)) }
  catch { return preBrowserFailure(pool, lease, "fill_material_unavailable") }
  let start: "claimed" | "already_started" | "stale" | "conflict"
  try { start = await claimBrowserStart(pool, lease) } catch { discardResume(resumePath); return lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed("fill_prestart_unavailable") }
  if (start === "already_started") { discardResume(resumePath); return wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain") }
  if (start !== "claimed") { discardResume(resumePath); return start === "stale" || lease.signal.aborted || lease.interruptRequestedAt ? acknowledgeCancellation(pool, lease) : failed("fill_start_conflict") }
  try {
    control = await evaluateUnattendedApplyControl(pool, task.applyUrl, lease.userId)
    if (!control.allowed) return wait(pool, lease, "form_answer_required", "unattended_apply_unavailable")
    const pattern = await findFormPattern(lease.userId, new URL(task.applyUrl).hostname, urlPattern(task.applyUrl)).catch(() => null)
    const outcome = await withCloakContext(lease.userId, async page => {
      const closeOnAbort = () => { void page.close().catch(() => undefined) }
      lease.signal.addEventListener("abort", closeOnAbort, { once: true })
      try {
        if (lease.signal.aborted) { closeOnAbort(); return cancelledOutcome() }
        await page.goto(task.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        if (lease.signal.aborted) return cancelledOutcome()
        if (!isAllowedDestination(page.url(), control.flow, task.applyUrl)) {
          return { kind: "wait" as const, detail: "fill_outcome_uncertain" as const }
        }
        const browserWait = await detectBrowserWait(page)
        if (browserWait) return { kind: "wait" as const, detail: waitDetail(browserWait.reason) }
        if (lease.signal.aborted) return cancelledOutcome()
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
        }, { page, pattern, aiAvailable: true, harnessConfig: { userId: lease.userId, signal: lease.signal } })
        if (lease.signal.aborted || result.classification === "cancelled") return cancelledOutcome()
        if (result.waitReason) return { kind: "wait" as const, detail: waitDetail(result.waitReason) }
        if (result.reviewReady) {
          await fillCustomQuestions(page, task.persona, [], task.confirmedAnswers)
          const needs = safeNeeds(await inspectFormReviewNeeds(page))
          if (needs.missing.length || needs.sensitive.length) {
            return { kind: "needs" as const, needs, detail: needs.sensitive.length ? "unknown_sensitive_field" as const : "required_field" as const }
          }
          return { kind: "ready" as const, result }
        }
        return { kind: "wait" as const, detail: waitDetailFromResult(result) }
      } finally { lease.signal.removeEventListener("abort", closeOnAbort) }
    })
    if (outcome.kind === "wait" && outcome.detail === "cancelled") return acknowledgeCancellation(pool, lease)
    if (outcome.kind === "wait") return wait(pool, lease, outcome.detail === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : "form_answer_required", outcome.detail)
    if (outcome.kind === "needs") return wait(pool, lease, "form_answer_required", outcome.detail, outcome.needs)
    if (outcome.kind !== "ready") return failed("fill_outcome_uncertain")
    const completed = await completeApplicationFillForReview(pool, { lease })
    return completed.status === "completed" ? { status: "completed", result: { status: "filled_for_user_review" } }
      : lease.signal.aborted ? acknowledgeCancellation(pool, lease) : failed(completed.status === "stale" ? "lease_lost" : "fill_completion_conflict")
  } catch {
    return lease.signal.aborted ? acknowledgeCancellation(pool, lease) : wait(pool, lease, "fill_outcome_uncertain", "fill_outcome_uncertain")
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
function cancelledOutcome() { return { kind: "wait" as const, detail: "cancelled" as const } }
function needsCompletionReplay(row: FillContext): boolean { return row.turnStatus === "waiting_for_approval" && ((row.taskStatus === "waiting_for_authorization" && row.checkpoint === "form_filled" && row.sessionStatus === "waiting_for_user") || (row.taskStatus === "filling" && row.checkpoint === "submission_authorized" && ["running", "waiting_for_user"].includes(row.sessionStatus)) || (row.taskStatus === "waiting_for_authorization" && row.checkpoint === "queue_retry" && ["running", "waiting_for_user"].includes(row.sessionStatus))) }
function discardResume(path: string): void { try { unlinkSync(path) } catch { /* temporary file may already be gone */ } }
async function wait(pool: Pool, lease: SubagentLease, checkpoint: WaitCheckpoint, detail: WaitDetail, needs?: FormReviewNeeds): Promise<SubagentExecutionResult> {
  if (lease.signal.aborted || lease.interruptRequestedAt) return acknowledgeCancellation(pool, lease)
  try {
    const result = await persistApplicationFillWait(pool, { lease, checkpoint, detail, ...(needs ? { needs } : {}) })
    return result.status === "waiting" ? { status: "waiting_for_user", failureReason: detail } : failed(lease.signal.aborted ? "fill_cancelled" : result.status === "stale" ? "lease_lost" : "fill_wait_conflict")
  } catch { return failed("fill_wait_persistence_unavailable") }
}
function buildFillInput(row: FillContext) {
  if (!row.resumeId || !row.resumeContent) throw new Error("resume_unavailable")
  if (row.coverLetterId && row.coverLetterContent === null) throw new Error("cover_letter_unavailable")
  const resumeContent = parseResumeContent(row.resumeContent)
  const persona: Record<string, string> = {
    fullName: row.userName ?? "", email: row.userEmail, phone: row.userPhone ?? "",
    location: row.userLocation ?? "", linkedinUrl: row.userLinkedin ?? "",
  }
  if (Array.isArray(row.personaFields)) for (const item of row.personaFields) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const value = item as Record<string, unknown>
      if (typeof value.key === "string" && value.key.trim() && typeof value.value === "string") persona[value.key] = value.value
    }
  }
  if (row.coverLetterContent || row.jobCoverLetter) persona.coverLetter = row.coverLetterContent ?? row.jobCoverLetter ?? ""
  return {
    applyUrl: safeApplyUrl(row.jobUrl),
    jobTitle: (row.jobTitle || "Application").slice(0, 256),
    jobCompany: (row.jobCompany || "Company").slice(0, 256),
    jobKeywords: (row.jobKeywords ?? "").slice(0, 8000),
    jobDescription: (row.jobDescription ?? "").slice(0, 20_000),
    persona,
    resumeContent,
    confirmedAnswers: parseAnswers(row.confirmedAnswers),
  }
}
function parseResumeContent(value: unknown): ResumeContent { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resume_invalid"); return value as ResumeContent }
function parseAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim())))
}
function safeApplyUrl(value: string | null): string {
  if (!value || value.length > 2048) throw new Error("apply_url_invalid")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("apply_url_invalid")
  return url.toString()
}
function urlPattern(value: string): string { const segments = new URL(value).pathname.replace(/^\/+/, "").split("/"); return `${segments.slice(0, 2).join("/")}/` }
function isAllowedDestination(raw: string, flow: FlowType, approved: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (flow === "greenhouse") return host === "boards.greenhouse.io" || host.endsWith(".greenhouse.io")
    if (flow === "lever") return ["jobs.lever.co", "jobs.eu.lever.co", "app.lever.co"].includes(host)
    if (flow === "workday") return host.endsWith(".myworkdayjobs.com")
    if (flow === "smartrecruiters") return ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(host)
    if (flow === "personio") return host.endsWith(".jobs.personio.com")
    return url.origin === new URL(approved).origin
  } catch { return false }
}
function waitDetail(reason: NonNullable<Awaited<ReturnType<typeof detectBrowserWait>>>["reason"]): WaitDetail { return reason === "captcha" ? "captcha_required" : reason === "login_required" ? "authentication_required" : reason === "mfa_required" ? "mfa_required" : reason === "stale_review" ? "stale_review" : "unknown_sensitive_field" }
function waitDetailFromResult(result: HarnessResult): WaitDetail { return result.classification === "cancelled" ? "cancelled" : result.classification === "browser_crash" ? "fill_outcome_uncertain" : result.classification === "untrusted_input" ? "unknown_sensitive_field" : "review_required" }
function safeNeeds(needs: FormReviewNeeds): FormReviewNeeds { const safe = (fields: FormReviewNeeds["missing"]) => fields.map(({ key, label }) => ({ key, label: label.slice(0, 200) })); return { missing: safe(needs.missing), sensitive: safe(needs.sensitive) } }
async function claimBrowserStart(pool: Pool, lease: SubagentLease): Promise<"claimed" | "already_started" | "stale" | "conflict"> {
  const client = await pool.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const session = await client.query<{ status: string }>('SELECT status FROM agent_sessions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [lease.sessionId, lease.userId])
    if (!session.rows[0] || !["running", "waiting_for_user"].includes(session.rows[0].status)) return await txResult(client, "ROLLBACK", "stale")
    const turn = await client.query<{ status: string }>('SELECT status FROM agent_turns WHERE id=$1 AND "sessionId"=$2 AND "userId"=$3 FOR UPDATE', [lease.turnId, lease.sessionId, lease.userId])
    if (!turn.rows[0] || !["in_progress", "waiting_for_user", "waiting_for_dependency"].includes(turn.rows[0].status)) return await txResult(client, "ROLLBACK", "stale")
    const task = await client.query<{ id: string }>(
      'SELECT sub."id" FROM sub_agent_tasks sub JOIN agent_sessions s ON s."id"=sub."sessionId" AND s."userId"=$4 JOIN agent_turns t ON t."id"=sub."turnId" AND t."sessionId"=sub."sessionId" AND t."userId"=$4 WHERE sub."id"=$1 AND sub."sessionId"=$2 AND sub."turnId"=$3 AND sub."role"=$5 AND sub."taskType"=$6 AND sub.status=\'running\' AND sub."leaseOwner"=$7 AND sub."attemptCount"=$8 AND date_trunc(\'milliseconds\',sub."leaseExpiresAt")=date_trunc(\'milliseconds\',$9::timestamptz) AND sub."leaseExpiresAt">clock_timestamp() AND sub."interruptRequestedAt" IS NULL FOR UPDATE OF sub',
      [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.role, lease.taskType, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
    if (task.rowCount !== 1) return await txResult(client, "ROLLBACK", "stale")
    const app = await client.query<{ status: string; checkpoint: string | null }>('SELECT "status","checkpoint" FROM application_tasks WHERE "userId"=$1 AND "sessionId"=$2 AND "fillTurnId"=$3 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$1 FOR UPDATE', [lease.userId, lease.sessionId, lease.turnId])
    if (!app.rows[0] || app.rows[0].status !== "filling") return await txResult(client, "ROLLBACK", "conflict")
    if (app.rows[0].checkpoint === "browser_active") return await txResult(client, "COMMIT", "already_started")
    if (app.rows[0].checkpoint !== "taskgraph_fill_queued") return await txResult(client, "ROLLBACK", "conflict")
    const updated = await client.query('UPDATE application_tasks SET "checkpoint"=\'browser_active\',"updatedAt"=NOW() WHERE "userId"=$1 AND "sessionId"=$2 AND "fillTurnId"=$3 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$1 AND "status"=\'filling\' AND "checkpoint"=\'taskgraph_fill_queued\' RETURNING "fillTurnId"', [lease.userId, lease.sessionId, lease.turnId])
    if (updated.rowCount !== 1) return await txResult(client, "ROLLBACK", "conflict")
    return await txResult(client, "COMMIT", "claimed")
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
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
async function txResult<T extends "claimed" | "already_started" | "stale" | "conflict">(client: PoolClient, command: "COMMIT" | "ROLLBACK", result: T): Promise<T> {
  await client.query(command)
  return result
}
