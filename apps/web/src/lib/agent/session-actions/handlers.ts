import { db } from "@/lib/db"
import { err, ok } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"
import { updateAgentSession } from "@/lib/agent/session/repository"
import { loadUserAiConfig } from "@/lib/model-router"
import { isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements"
import { tailorResumeForAgent } from "@/lib/agent/resume-tailoring"
import { applicationFillTaskGraphEnabled, queueApplicationFill } from "@/lib/auto-apply"
import { assertActiveAccount, assertJobPreflight, assertUnattendedApplyEnabled, validateAutoApplyUrl } from "@/lib/auto-apply-guards"
import { clientReceipt, consumeLegacyReceipt, issueLegacyReceipt, resolveLegacyApproval, validateLegacyReceipt } from "@/lib/agent/approval/legacy-receipt"
import { validatePendingApprovalReceipt } from "@/lib/agent/approval/store"
import { ensureV2Turn } from "@/lib/agent/session/v2-turn"
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy"
import { resumeLegacyApprovalTurnInTransaction } from "@/lib/agent/approval/legacy-approval-fence"
import { AgentCommandError } from "../control-plane/commands/errors"
import { confirmSubmissionNotReceived } from "../control-plane/commands/application-submission-recovery-command"
import {
  applicationPayload, canonicalApprovalResponse, legacyApprovalErrorResponse, resumeTailoringPayload,
  safeEventFields, serializeEvent, type ApprovalAction, type ConfirmSubmissionNotReceivedAction, type CreateAutomationAction, type RetryApplicationFillAction,
  type ScopedApproval,
} from "./support"

function receiptScope(approval: ScopedApproval, nonce: string, userId: string, sessionId: string, resource?: unknown) {
  if (!approval.turnId || !approval.toolCallId || !approval.jobId || !approval.expiresAt) {
    throw new Error("Approval is missing its immutable receipt scope")
  }
  return {
    approvalId: approval.id, userId, sessionId, turnId: approval.turnId, toolCallId: approval.toolCallId,
    jobId: approval.jobId, action: approval.type as never, nonce,
    resource: resource ?? { jobId: approval.jobId }, material: approval.payload, answers: null,
    revision: approval.revision, expiresAt: approval.expiresAt,
  }
}

export async function consumeReceiptForApproval(approval: ScopedApproval, nonce: string, userId: string, sessionId: string, resource?: unknown) {
  await consumeLegacyReceipt(db, receiptScope(approval, nonce, userId, sessionId, resource))
}

export async function validateReceiptForApproval(approval: ScopedApproval, nonce: string, userId: string, sessionId: string, resource?: unknown) {
  if (approval.type === "submit_application") {
    if (!approval.turnId || !approval.toolCallId || !approval.jobId || !approval.resourceHash || !approval.materialHash || !approval.answersHash || !approval.expiresAt) {
      throw new Error("Approval is missing its immutable receipt scope")
    }
    await validatePendingApprovalReceipt(db, approval.id, {
      userId, sessionId, turnId: approval.turnId, toolCallId: approval.toolCallId, jobId: approval.jobId,
      action: "submit_application", resourceHash: approval.resourceHash, materialHash: approval.materialHash,
      answersHash: approval.answersHash, revision: approval.revision, expiresAt: approval.expiresAt, nonce,
    })
    return
  }
  await validateLegacyReceipt(db, receiptScope(approval, nonce, userId, sessionId, resource))
}

export async function handleCreateAutomationAction(sessionId: string, userId: string, action: CreateAutomationAction) {
  if (!action.approvalId || !action.receiptNonce) return err("Saving an automation requires a scoped approval receipt", 428)
  const approval = await db.agentApproval.findFirst({
    where: { id: action.approvalId, sessionId, userId, status: "pending", type: "automation_mutation" },
    select: { id: true, type: true, payload: true, turnId: true, toolCallId: true, jobId: true, revision: true, expiresAt: true, resourceHash: true, materialHash: true, answersHash: true },
  })
  if (!approval) return err("Automation approval is no longer pending", 409)
  try {
    requireLegacyPolicy({
      userId, sessionId, turnId: approval.turnId ?? `automation:${sessionId}`,
      stepId: `automation:${action.approvalId}`, toolCallId: approval.toolCallId ?? `automation:${sessionId}`,
      toolName: "automation.mutate", domain: "automation", risk: "internal_write", capabilities: ["read", "write"],
      input: { requiresReceipt: true, receiptValidated: true, unknownSensitiveFacts: false },
    })
    const resolution = await resolveLegacyApproval(db, { approval, userId, sessionId, decision: "approved" }, {
      beforeResolve: () => validateReceiptForApproval(approval, action.receiptNonce!, userId, sessionId, { automationName: action.draft.name }),
    })
    if (resolution?.disposition === "canonical_wait") return canonicalApprovalResponse(resolution)
    if (approval.turnId) await resumeLegacyApprovalTurnInTransaction(db, { sessionId, userId, turnId: approval.turnId })
    await consumeReceiptForApproval(approval, action.receiptNonce, userId, sessionId, { automationName: action.draft.name })
  } catch (error) {
    return legacyApprovalErrorResponse(error, "Automation approval could not be consumed")
  }
  const existing = await db.agentAutomation.findFirst({ where: { userId, name: action.draft.name }, select: { id: true } })
  const data = {
    userId, enabled: true, createdBy: "agent", ...action.draft,
    nextRunAt: nextRunAtFromCron(action.draft.cron, new Date(), action.draft.timezone),
  }
  const automation = existing
    ? await db.agentAutomation.update({ where: { id: existing.id }, data })
    : await db.agentAutomation.create({ data })
  const eventType = existing ? "automation_updated" : "automation_created"
  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId, taskId: null, type: eventType, speaker: "Orchestrator",
      title: existing ? "Automation updated" : "Automation created", durationMs: null,
      ...safeEventFields(eventType, `${existing ? "Updated" : "Created"} automation: ${action.draft.name}`, {
        automationId: automation.id, draft: action.draft, mode: existing ? "updated_existing" : "created_new",
      }),
    },
  })
  return ok({ event: serializeEvent(event as Parameters<typeof serializeEvent>[0]), automation })
}

export async function handleRetryApplicationFillAction(sessionId: string, userId: string, action: RetryApplicationFillAction) {
  if (!applicationFillTaskGraphEnabled()) return err("Explicit TaskGraph fill retry is unavailable while the feature is disabled", 409)
  const task = await db.applicationTask.findFirst({ where: { id: action.applicationTaskId, userId, sessionId }, select: { id: true, jobId: true } })
  if (!task) return err("Application task not found", 404)
  const job = await db.job.findFirst({ where: { id: task.jobId, userId }, select: { url: true } })
  if (!job) return err("Job not found", 404)
  try {
    const queued = await queueApplicationFill({
      userId, jobId: task.jobId, applyUrl: job.url, applicationTaskId: task.id,
      sessionId, retry: true, retryId: action.requestId,
    })
    return ok({ ...queued, retried: true })
  } catch (error) {
    return err(error instanceof Error ? error.message : "Could not retry the fill-for-review pass", 409)
  }
}

export async function handleConfirmSubmissionNotReceivedAction(sessionId: string, userId: string, action: ConfirmSubmissionNotReceivedAction) {
  if (!applicationFillTaskGraphEnabled()) return err("Submission recovery is unavailable while TaskGraph fill is disabled", 409)
  const task = await db.applicationTask.findFirst({ where: { id: action.applicationTaskId, userId, sessionId }, select: { id: true, jobId: true } })
  if (!task) return err("Application task not found", 404)
  const job = await db.job.findFirst({ where: { id: task.jobId, userId }, select: { url: true } })
  if (!job) return err("Job not found", 404)
  try {
    await assertActiveAccount(userId)
    await assertUnattendedApplyEnabled(userId)
    validateAutoApplyUrl(job.url)
    await assertJobPreflight({ userId, jobId: task.jobId })
    const result = await confirmSubmissionNotReceived(db, { ...action, sessionId, userId })
    return ok({ ...result, recovered: true })
  } catch (error) {
    const status = error instanceof AgentCommandError ? error.status : 409
    return err(error instanceof Error ? error.message : "The uncertain submission could not be recovered", status)
  }
}

export async function handleApprovedResumeTailoring(sessionId: string, userId: string, action: ApprovalAction, approval: ScopedApproval) {
  const payload = resumeTailoringPayload(approval.payload)
  if (!payload) return err("Resume tailoring approval is missing its job or resume.", 400)
  try {
    const artifact = await tailorResumeForAgent({ userId, resumeId: payload.resumeId, jobId: payload.jobId, aiConfig: await loadUserAiConfig(userId, "agent") })
    const tailoredEvent = await db.agentTranscriptEvent.create({
      data: {
        sessionId, taskId: null, type: "resume_tailored", speaker: "Writer", title: "Tailored resume ready", durationMs: null,
        ...safeEventFields("resume_tailored", `${artifact.name} is ready for Reviewer and your final confirmation.`, { resume: { ...artifact } }),
      },
    })
    const turn = await ensureV2Turn(db, { sessionId, userId, goal: `Confirm tailored resume for ${artifact.company} · ${artifact.role}`, source: "user" })
    const currentTurn = await db.agentTurn.findFirst({ where: { id: turn.turnId, sessionId, userId }, select: { revision: true } })
    const finalApproval = await issueLegacyReceipt(db, {
      userId, sessionId, turnId: turn.turnId, toolCallId: `resume-confirm:${artifact.id}`, jobId: artifact.jobId,
      action: "confirm_tailored_resume", title: "Confirm tailored resume",
      body: `Reviewer: confirm ${artifact.name} as the final resume for ${artifact.company} · ${artifact.role} before handing it to Executor.`,
      impact: { resume: artifact.name, company: artifact.company, role: artifact.role },
      payload: { resumeId: artifact.id, jobId: artifact.jobId }, resource: { jobId: artifact.jobId },
      material: { resumeId: artifact.id, jobId: artifact.jobId }, revision: currentTurn?.revision ?? 0,
    })
    const reviewEvent = await db.agentTranscriptEvent.create({
      data: {
        sessionId, taskId: null, type: "approval_request", speaker: "Reviewer", title: "Final resume review", durationMs: null,
        ...safeEventFields("approval_request", finalApproval.approval.body, { approval: clientReceipt(finalApproval, { resume: artifact.name, company: artifact.company, role: artifact.role }) }),
      },
    })
    await updateAgentSession(db, { sessionId, status: "waiting_for_user", completedAt: null })
    return ok({ events: [serializeEvent(tailoredEvent), serializeEvent(reviewEvent)] })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not tailor the resume."
    const event = await db.agentTranscriptEvent.create({
      data: { sessionId, taskId: null, type: "error", speaker: "Writer", title: "Tailoring failed", durationMs: null, ...safeEventFields("error", message, { approvalId: action.approvalId }) },
    })
    return ok({ event: serializeEvent(event) })
  }
}

export async function handleConfirmedTailoredResume(sessionId: string, userId: string, approval: ScopedApproval) {
  const payload = resumeTailoringPayload(approval.payload)
  if (!payload) return err("Final resume approval is missing its job or resume.", 400)
  const resume = await db.resume.findFirst({ where: { id: payload.resumeId, userId, targetJobId: payload.jobId }, select: { id: true, name: true } })
  const job = await db.job.findFirst({ where: { id: payload.jobId, userId }, select: { id: true, company: true, role: true, url: true, status: true } })
  if (!resume || !job) return err("The tailored resume or job is no longer available.", 404)
  if (job.status === "applied") return err("This job has already been submitted.", 409)
  await db.job.update({ where: { id: job.id }, data: {
    finalResumeId: resume.id, status: "saved", workflowState: "ready_to_apply",
    analysisNote: job.url
      ? "[Application ready] Open the employer form, use the ApplyMate extension to fill it, then review and submit it yourself."
      : "[Application ready] Missing application URL.",
  } })
  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId, taskId: null, type: "resume_finalized", speaker: "Reviewer", title: "Application pack ready", durationMs: null,
      ...safeEventFields("resume_finalized", job.url
        ? `${resume.name} is confirmed for ${job.company} · ${job.role}. Open the employer form, let the extension fill the fields, review everything, then submit it yourself.`
        : `${resume.name} is confirmed and linked to ${job.company} · ${job.role}, but this job has no application URL.`,
      { resume: { id: resume.id, name: resume.name }, job }),
    },
  })
  await updateAgentSession(db, { sessionId, status: "completed", completedAt: new Date() })
  return ok({ event: serializeEvent(event) })
}

export async function handleReviewApplicationApproval(sessionId: string, userId: string, action: ApprovalAction, approval: ScopedApproval): Promise<Response | null> {
  if (approval.type !== "review_application") return null
  const payload = applicationPayload(approval.payload)
  if (!payload) return err("Application review is missing its task.", 400)
  if (action.decision !== "approved") {
    const cancelled = await db.applicationTask.updateMany({
      where: { id: payload.applicationTaskId, userId, jobId: payload.jobId, OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }] },
      data: { status: "cancelled", checkpoint: "review_declined", completedAt: new Date() },
    })
    if (cancelled.count === 1) {
      await db.applicationTaskEvent.create({ data: { taskId: payload.applicationTaskId, type: "review_declined", actor: "user", body: safeEventFields("review_declined", action.body, {}).body } })
    }
    return null
  }
  const job = await db.job.findFirst({ where: { id: payload.jobId, userId }, select: { company: true, role: true, url: true } })
  if (!job) return err("Job not found", 404)
  try {
    const queued = await queueApplicationFill({ userId, jobId: payload.jobId, applyUrl: job.url, applicationTaskId: payload.applicationTaskId, sessionId })
    const event = await db.agentTranscriptEvent.create({
      data: { sessionId, taskId: null, type: "application_queued", speaker: "Executor", title: "Form fill queued", durationMs: null, ...safeEventFields("application_queued", "The worker will fill this form without submitting it. Refresh this session when it is ready for final review.", { ...queued, jobId: payload.jobId, operation: "fill" }) },
    })
    await updateAgentSession(db, { sessionId, status: "running", completedAt: null })
    return ok({ event: serializeEvent(event) })
  } catch (error) {
    return err(error instanceof Error ? error.message : "Could not queue the form-fill review pass.", 409)
  }
}
