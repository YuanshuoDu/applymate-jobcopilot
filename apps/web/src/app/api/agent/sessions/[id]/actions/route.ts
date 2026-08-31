import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { redactAgentEvent } from "@jobcopilot/shared"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"
import { updateAgentSession } from "@/lib/agent/session/repository"
import { loadUserAiConfig } from "@/lib/model-router"
import { isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements"
import { tailorResumeForAgent } from "@/lib/agent/resume-tailoring"
import { queueApplicationFill, queueAutonomousApplication } from "@/lib/auto-apply"
import { clientReceipt, consumeLegacyReceipt, issueLegacyReceipt, resolveLegacyApproval, validateLegacyReceipt, type ScopedApprovalRecord } from "@/lib/agent/approval/legacy-receipt"
import { ensureV2Turn } from "@/lib/agent/session/v2-turn"
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy"

interface RouteCtx {
  params: Promise<{ id: string }>
}

type ApprovalDecision = "approved" | "rejected" | "cancelled" | "review"

type ApprovalAction = {
  type: "approval_response"
  approvalId: string | null
  decision: ApprovalDecision
  body: string
  receiptNonce: string | null
}

type CreateAutomationAction = {
  type: "create_automation"
  draft: AutomationDraft
  approvalId: string | null
  receiptNonce: string | null
}

type SessionAction = ApprovalAction | CreateAutomationAction

type ScopedApproval = ScopedApprovalRecord & {
  resourceHash: string | null
  materialHash: string | null
  answersHash: string | null
}

type AutomationDraft = {
  name: string
  triggerType: string
  cron: string | null
  timezone: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

function readBody(body: unknown): SessionAction | null {
  if (!body || typeof body !== "object") return null
  const row = body as {
    type?: unknown
    approvalId?: unknown
    decision?: unknown
    body?: unknown
    receiptNonce?: unknown
    draft?: unknown
  }
  if (row.type === "create_automation") {
    const draft = readAutomationDraft(row.draft)
    return draft ? {
      type: "create_automation", draft,
      approvalId: typeof row.approvalId === "string" && row.approvalId ? row.approvalId : null,
      receiptNonce: typeof row.receiptNonce === "string" && row.receiptNonce ? row.receiptNonce : null,
    } : null
  }
  if (row.type !== "approval_response") return null
  const rawDecision = typeof row.decision === "string" ? row.decision : "review"
  const decision = isApprovalDecision(rawDecision) ? rawDecision : "review"
  return {
    type: row.type,
    approvalId: typeof row.approvalId === "string" && row.approvalId ? row.approvalId : null,
    decision,
    body: typeof row.body === "string" && row.body.trim()
      ? row.body.trim()
      : approvalBody(decision),
    receiptNonce: typeof row.receiptNonce === "string" && row.receiptNonce.trim() ? row.receiptNonce.trim() : null,
  }
}

function readAutomationDraft(value: unknown): AutomationDraft | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const name = text(row.name)
  if (!name) return null
  return {
    name,
    triggerType: text(row.triggerType) || "manual",
    cron: text(row.cron) || null,
    timezone: text(row.timezone) || "Europe/Berlin",
    targetRoles: stringList(row.targetRoles),
    targetLocations: stringList(row.targetLocations),
    minScore: numberInRange(row.minScore, 85, 0, 100),
    dailyCap: numberInRange(row.dailyCap, 8, 1, 50),
    requireApproval: bool(row.requireApproval, true),
    autoApply: bool(row.autoApply, false),
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => text(item))
    .filter(Boolean)
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "approved" || value === "rejected" || value === "cancelled" || value === "review"
}

function approvalTitle(decision: ApprovalDecision) {
  if (decision === "approved") return "Approved"
  if (decision === "rejected") return "Rejected"
  if (decision === "cancelled") return "Cancelled"
  return "Review requested"
}

function approvalBody(decision: ApprovalDecision) {
  if (decision === "approved") return "Approved the requested action."
  if (decision === "rejected") return "Rejected the requested action."
  if (decision === "cancelled") return "Cancelled the requested action."
  return "Asked to review the requested action."
}

function serializeEvent(event: {
  id: string
  sessionId: string
  taskId: string | null
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown
  durationMs: number | null
  createdAt: Date
}) {
  return {
    ...event,
    createdAt: event.createdAt.toISOString(),
  }
}

function automationWriteData(userId: string, draft: AutomationDraft) {
  return {
    userId,
    enabled: true,
    createdBy: "agent",
    ...draft,
    nextRunAt: nextRunAtFromCron(draft.cron, new Date(), draft.timezone),
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const session = await db.agentSession.findFirst({
    where: { id, userId: auth.userId },
    select: { id: true },
  })
  if (!session) return err("Session not found", 404)

  const body = await req.json().catch(() => null)
  const action = readBody(body)
  if (!action) return err("Unsupported action type", 400)

  if (action.type === "create_automation") {
    if (!action.approvalId || !action.receiptNonce) return err("Saving an automation requires a scoped approval receipt", 428)
    const automationApproval = await db.agentApproval.findFirst({
      where: { id: action.approvalId, sessionId: id, userId: auth.userId, status: "pending", type: "automation_mutation" },
      select: {
        id: true, type: true, payload: true, turnId: true, toolCallId: true, jobId: true,
        revision: true, expiresAt: true, resourceHash: true, materialHash: true, answersHash: true,
      },
    })
    if (!automationApproval) return err("Automation approval is no longer pending", 409)
    try {
      requireLegacyPolicy({
        userId: auth.userId, sessionId: id, turnId: automationApproval.turnId ?? `automation:${id}`,
        stepId: `automation:${action.approvalId}`, toolCallId: automationApproval.toolCallId ?? `automation:${id}`,
        toolName: "automation.mutate", domain: "automation", risk: "internal_write", capabilities: ["read", "write"],
        input: { requiresReceipt: true, receiptValidated: true, unknownSensitiveFacts: false },
      })
      await validateReceiptForApproval(db, automationApproval, action.receiptNonce, auth.userId, id, { automationName: action.draft.name })
      await resolveLegacyApproval(db, { approval: automationApproval, userId: auth.userId, sessionId: id, decision: "approved" })
      if (automationApproval.turnId) await db.agentTurn.update({ where: { id: automationApproval.turnId }, data: { status: "in_progress" } })
      await consumeReceiptForApproval(db, automationApproval, action.receiptNonce, auth.userId, id, { automationName: action.draft.name })
    } catch (error) {
      return err(error instanceof Error ? error.message : "Automation approval could not be consumed", 409)
    }
    const existing = await db.agentAutomation.findFirst({
      where: { userId: auth.userId, name: action.draft.name },
      select: { id: true },
    })
    const data = automationWriteData(auth.userId, action.draft)
    const automation = existing
      ? await db.agentAutomation.update({ where: { id: existing.id }, data })
      : await db.agentAutomation.create({ data })
    const eventType = existing ? "automation_updated" : "automation_created"

    const event = await db.agentTranscriptEvent.create({
      data: {
        sessionId: id,
        taskId: null,
        type: eventType,
        speaker: "Orchestrator",
        title: existing ? "Automation updated" : "Automation created",
        durationMs: null,
        ...safeEventFields(eventType, `${existing ? "Updated" : "Created"} automation: ${action.draft.name}`, { automationId: automation.id, draft: action.draft, mode: existing ? "updated_existing" : "created_new" }),
        },
    })

    return ok({
      event: serializeEvent(event as Parameters<typeof serializeEvent>[0]),
      automation,
    })
  }

  let approval: ScopedApproval | null = null
  if (action.approvalId) {
    approval = await db.agentApproval.findFirst({
      where: { id: action.approvalId, sessionId: id, userId: auth.userId, status: 'pending' },
      select: {
        id: true, type: true, payload: true, turnId: true, toolCallId: true, jobId: true,
        revision: true, expiresAt: true, resourceHash: true, materialHash: true, answersHash: true,
      },
    })
    if (!approval) return err("Approval is no longer pending", 409)
    const policy = approvalPolicyInput(approval)
    try {
      requireLegacyPolicy({
        userId: auth.userId,
        sessionId: id,
        turnId: approval.turnId ?? `legacy-approval:${action.approvalId}`,
        stepId: `approval:${action.approvalId}`,
        toolCallId: approval.toolCallId ?? `approval:${action.approvalId}`,
        toolName: policy.toolName,
        domain: policy.domain,
        risk: policy.risk,
        capabilities: policy.capabilities,
        input: {
          requiresReceipt: action.decision === "approved",
          receiptValidated: Boolean(action.receiptNonce),
          unknownSensitiveFacts: false,
        },
      })
    } catch (error) {
      return policyErrorResponse(error)
    }
    if (action.decision === "approved" && !action.receiptNonce) return err("A scoped receipt is required to approve this action", 428)
    if (action.decision === "approved" && approval.type === "tailor_resume") {
      if (!(await isFeatureAllowed(auth.userId, "tailored_resume"))) return err("This feature is not included in your current plan", 403)
      const aiAccess = await resolveAiAccess(auth.userId)
      if (aiAccess === "disabled") return err("This feature is not included in your current plan", 403)
      if (aiAccess === "exhausted") return err("Monthly AI credits exhausted", 429)
    }
    try {
      if (action.decision === "approved") await validateReceiptForApproval(db, approval, action.receiptNonce!, auth.userId, id)
      await resolveLegacyApproval(db, {
        approval,
        userId: auth.userId,
        sessionId: id,
        decision: action.decision === "approved" ? "approved" : "rejected",
      })
      if (approval.turnId) {
        await db.agentTurn.update({ where: { id: approval.turnId }, data: { status: "in_progress" } })
      }
      if (action.decision === "approved" && approval.type !== "submit_application") {
        await consumeReceiptForApproval(db, approval, action.receiptNonce!, auth.userId, id)
      }
    } catch (error) {
      return err(error instanceof Error ? error.message : "Approval could not be resolved", 409)
    }
  }

  if (action.decision === 'approved' && approval?.type === 'tailor_resume') {
    const payload = resumeTailoringPayload(approval.payload)
    if (!payload) return err('Resume tailoring approval is missing its job or resume.', 400)
    try {
      const artifact = await tailorResumeForAgent({
        userId: auth.userId,
        resumeId: payload.resumeId,
        jobId: payload.jobId,
        aiConfig: await loadUserAiConfig(auth.userId, 'agent'),
      })
      const tailoredEvent = await db.agentTranscriptEvent.create({
        data: {
          sessionId: id, taskId: null, type: 'resume_tailored', speaker: 'Writer',
          title: 'Tailored resume ready',
          durationMs: null,
          ...safeEventFields('resume_tailored', `${artifact.name} is ready for Reviewer and your final confirmation.`, { resume: { ...artifact } }),
        },
      })
      const turn = await ensureV2Turn(db, {
        sessionId: id,
        userId: auth.userId,
        goal: `Confirm tailored resume for ${artifact.company} · ${artifact.role}`,
        source: "user",
      })
      const currentTurn = await db.agentTurn.findFirst({ where: { id: turn.turnId, sessionId: id, userId: auth.userId }, select: { revision: true } })
      const finalApproval = await issueLegacyReceipt(db, {
        userId: auth.userId,
        sessionId: id,
        turnId: turn.turnId,
        toolCallId: `resume-confirm:${artifact.id}`,
        jobId: artifact.jobId,
        action: "confirm_tailored_resume",
        title: "Confirm tailored resume",
        body: `Reviewer: confirm ${artifact.name} as the final resume for ${artifact.company} · ${artifact.role} before handing it to Executor.`,
        impact: { resume: artifact.name, company: artifact.company, role: artifact.role },
        payload: { resumeId: artifact.id, jobId: artifact.jobId },
        resource: { jobId: artifact.jobId },
        material: { resumeId: artifact.id, jobId: artifact.jobId },
        revision: currentTurn?.revision ?? 0,
      })
      const reviewEvent = await db.agentTranscriptEvent.create({
        data: {
          sessionId: id, taskId: null, type: 'approval_request', speaker: 'Reviewer',
          title: 'Final resume review', durationMs: null,
          ...safeEventFields('approval_request', finalApproval.approval.body, { approval: clientReceipt(finalApproval, { resume: artifact.name, company: artifact.company, role: artifact.role }) }),
        },
      })
      await updateAgentSession(db, { sessionId: id, status: 'waiting_for_user', completedAt: null })
      return ok({ events: [serializeEvent(tailoredEvent), serializeEvent(reviewEvent)] })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not tailor the resume.'
      const event = await db.agentTranscriptEvent.create({
        data: { sessionId: id, taskId: null, type: 'error', speaker: 'Writer', title: 'Tailoring failed', durationMs: null, ...safeEventFields('error', message, { approvalId: action.approvalId }) },
      })
      return ok({ event: serializeEvent(event) })
    }
  }

  if (action.decision === 'approved' && approval?.type === 'confirm_tailored_resume') {
    const payload = resumeTailoringPayload(approval.payload)
    if (!payload) return err('Final resume approval is missing its job or resume.', 400)
    const resume = await db.resume.findFirst({ where: { id: payload.resumeId, userId: auth.userId, targetJobId: payload.jobId }, select: { id: true, name: true } })
    const job = await db.job.findFirst({ where: { id: payload.jobId, userId: auth.userId }, select: { id: true, company: true, role: true, url: true, status: true } })
    if (!resume || !job) return err('The tailored resume or job is no longer available.', 404)
    if (job.status === 'applied') return err('This job has already been submitted.', 409)
    await db.job.update({ where: { id: job.id }, data: {
      finalResumeId: resume.id,
      status: 'saved',
      workflowState: 'ready_to_apply',
      analysisNote: job.url
        ? '[Application ready] Open the employer form, use the ApplyMate extension to fill it, then review and submit it yourself.'
        : '[Application ready] Missing application URL.',
    } })
    const event = await db.agentTranscriptEvent.create({
      data: {
        sessionId: id, taskId: null, type: 'resume_finalized', speaker: 'Reviewer', title: 'Application pack ready',
        durationMs: null,
        ...safeEventFields('resume_finalized', job.url
          ? `${resume.name} is confirmed for ${job.company} · ${job.role}. Open the employer form, let the extension fill the fields, review everything, then submit it yourself.`
          : `${resume.name} is confirmed and linked to ${job.company} · ${job.role}, but this job has no application URL.`, { resume: { id: resume.id, name: resume.name }, job }),
      },
    })
    await updateAgentSession(db, { sessionId: id, status: 'completed', completedAt: new Date() })
    return ok({ event: serializeEvent(event) })
  }

  if (approval?.type === "review_application") {
    const payload = applicationPayload(approval.payload)
    if (!payload) return err("Application review is missing its task.", 400)
    if (action.decision !== "approved") {
      await db.applicationTask.updateMany({
        where: { id: payload.applicationTaskId, userId: auth.userId, jobId: payload.jobId },
        data: { status: "cancelled", checkpoint: "review_declined", completedAt: new Date() },
      })
      await db.applicationTaskEvent.create({
        data: { taskId: payload.applicationTaskId, type: "review_declined", actor: "user", body: safeEventFields("review_declined", action.body, {}).body },
      })
    } else {
      const job = await db.job.findFirst({ where: { id: payload.jobId, userId: auth.userId }, select: { company: true, role: true, url: true } })
      if (!job) return err("Job not found", 404)
      try {
        const queued = await queueApplicationFill({ userId: auth.userId, jobId: payload.jobId, applyUrl: job.url, applicationTaskId: payload.applicationTaskId })
        const event = await db.agentTranscriptEvent.create({
          data: { sessionId: id, taskId: null, type: "application_queued", speaker: "Executor", title: "Form fill queued", durationMs: null, ...safeEventFields("application_queued", "The worker will fill this form without submitting it. Refresh this session when it is ready for final review.", { ...queued, jobId: payload.jobId, operation: "fill" }) },
        })
        await updateAgentSession(db, { sessionId: id, status: "running", completedAt: null })
        return ok({ event: serializeEvent(event) })
      } catch (error) {
        return err(error instanceof Error ? error.message : "Could not queue the form-fill review pass.", 409)
      }
    }
  }

  if (action.decision === "approved" && approval?.type === "submit_application") {
    const payload = applicationPayload(approval.payload)
    if (!payload) return err("Submission authorization is missing its task.", 400)
    const job = await db.job.findFirst({ where: { id: payload.jobId, userId: auth.userId }, select: { url: true } })
    if (!job) return err("Job not found", 404)
    try {
      const queued = await queueAutonomousApplication({
        userId: auth.userId,
        jobId: payload.jobId,
        applyUrl: job.url,
        applicationTaskId: payload.applicationTaskId,
        approvalId: action.approvalId!,
        receiptNonce: action.receiptNonce!,
        sessionId: id,
      })
      const event = await db.agentTranscriptEvent.create({
        data: { sessionId: id, taskId: null, type: "application_queued", speaker: "Executor", title: "Submission queued", durationMs: null, ...safeEventFields("application_queued", "Your approved application was queued for background execution.", { ...queued, jobId: payload.jobId }) },
      })
      await updateAgentSession(db, { sessionId: id, status: "running", completedAt: null })
      return ok({ event: serializeEvent(event) })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not queue the approved application."
      await db.applicationTask.updateMany({ where: { id: payload.applicationTaskId, userId: auth.userId }, data: { status: "waiting_for_authorization", checkpoint: "queue_retry", error: message } })
      return err(message, 409)
    }
  }

  if (approval?.type === "submit_application") {
    const payload = applicationPayload(approval.payload)
    if (payload) {
      await db.applicationTask.updateMany({
        where: { id: payload.applicationTaskId, userId: auth.userId, jobId: payload.jobId, status: "waiting_for_authorization" },
        data: {
          status: action.decision === "cancelled" ? "cancelled" : "waiting_for_user",
          checkpoint: action.decision === "cancelled" ? "submission_cancelled" : "review_requested",
          completedAt: action.decision === "cancelled" ? new Date() : null,
        },
      })
      await db.applicationTaskEvent.create({
        data: { taskId: payload.applicationTaskId, type: `submission_${action.decision}`, actor: "user", body: safeEventFields(`submission_${action.decision}`, action.body, {}).body },
      })
    }
  }

  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId: id,
      taskId: null,
      type: "approval_response",
      speaker: "You",
      title: approvalTitle(action.decision),
      durationMs: null,
      ...safeEventFields("approval_response", action.body, { approvalId: action.approvalId, decision: action.decision }),
      },
  })

  await updateAgentSession(db, {
    sessionId: id,
    status: "completed",
    completedAt: new Date(),
  })

  return ok({ event: serializeEvent(event as Parameters<typeof serializeEvent>[0]) })
}

function resumeTailoringPayload(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const resumeId = text(payload.resumeId)
  const jobId = text(payload.jobId)
  return resumeId && jobId ? { resumeId, jobId } : null
}

function applicationPayload(value: unknown) {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const applicationTaskId = text(payload.applicationTaskId)
  const jobId = text(payload.jobId)
  return applicationTaskId && jobId ? { applicationTaskId, jobId } : null
}

function approvalPolicyInput(approval: ScopedApproval) {
  if (approval.type === "submit_application") return { toolName: "application.submit", domain: "application" as const, risk: "external_write" as const, capabilities: ["read", "write", "external_write"] as const }
  if (approval.type === "review_application") return { toolName: "application.fill", domain: "application" as const, risk: "internal_write" as const, capabilities: ["read", "write", "browser"] as const }
  if (approval.type === "send_gmail") return { toolName: "gmail.send", domain: "gmail" as const, risk: "external_write" as const, capabilities: ["read", "write", "external_write"] as const }
  if (approval.type === "automation_mutation") return { toolName: "automation.mutate", domain: "automation" as const, risk: "internal_write" as const, capabilities: ["read", "write"] as const }
  return { toolName: "resume.tailor", domain: "resume" as const, risk: "draft_write" as const, capabilities: ["read", "write"] as const }
}

function policyErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The policy did not permit this action"
  const status = error && typeof error === "object" && "outcome" in error && (error as { outcome?: unknown }).outcome === "require_user_input"
    ? 422
    : 428
  return err(message, status)
}

async function consumeReceiptForApproval(db: Parameters<typeof consumeLegacyReceipt>[0], approval: ScopedApproval, nonce: string, userId: string, sessionId: string, resource?: unknown) {
  if (!approval.turnId || !approval.toolCallId || !approval.jobId || !approval.expiresAt) {
    throw new Error("Approval is missing its immutable receipt scope")
  }
  await consumeLegacyReceipt(db, {
    approvalId: approval.id,
    userId,
    sessionId,
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    jobId: approval.jobId,
    action: approval.type as never,
    nonce,
    resource: resource ?? { jobId: approval.jobId },
    material: approval.payload,
    answers: null,
    revision: approval.revision,
    expiresAt: approval.expiresAt,
  })
}

async function validateReceiptForApproval(db: Parameters<typeof validateLegacyReceipt>[0], approval: ScopedApproval, nonce: string, userId: string, sessionId: string, resource?: unknown) {
  if (!approval.turnId || !approval.toolCallId || !approval.jobId || !approval.expiresAt) {
    throw new Error("Approval is missing its immutable receipt scope")
  }
  await validateLegacyReceipt(db, {
    approvalId: approval.id,
    userId,
    sessionId,
    turnId: approval.turnId,
    toolCallId: approval.toolCallId,
    jobId: approval.jobId,
    action: approval.type as never,
    nonce,
    resource: resource ?? { jobId: approval.jobId },
    material: approval.payload,
    answers: null,
    revision: approval.revision,
    expiresAt: approval.expiresAt,
  })
}

function safeEventFields(type: string, body: string, data: unknown) {
  const safe = redactAgentEvent({ type, body, data })
  return { body: safe.body, ...(safe.data === null ? {} : { data: safe.data as Prisma.InputJsonValue }) }
}
