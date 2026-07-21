import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"
import { updateAgentSession } from "@/lib/agent/session/repository"
import { loadUserAiConfig } from "@/lib/model-router"
import { tailorResumeForAgent } from "@/lib/agent/resume-tailoring"

interface RouteCtx {
  params: Promise<{ id: string }>
}

type ApprovalDecision = "approved" | "rejected" | "cancelled" | "review"

type ApprovalAction = {
  type: "approval_response"
  approvalId: string | null
  decision: ApprovalDecision
  body: string
}

type CreateAutomationAction = {
  type: "create_automation"
  draft: AutomationDraft
}

type SessionAction = ApprovalAction | CreateAutomationAction

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
    draft?: unknown
  }
  if (row.type === "create_automation") {
    const draft = readAutomationDraft(row.draft)
    return draft ? { type: "create_automation", draft } : null
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
        body: `${existing ? "Updated" : "Created"} automation: ${action.draft.name}`,
        data: {
          automationId: automation.id,
          draft: action.draft,
          mode: existing ? "updated_existing" : "created_new",
        },
        durationMs: null,
      },
    })

    return ok({
      event: serializeEvent(event as Parameters<typeof serializeEvent>[0]),
      automation,
    })
  }

  let approval: { type: string; payload: unknown } | null = null
  if (action.approvalId) {
    approval = await db.agentApproval.findFirst({
      where: { id: action.approvalId, sessionId: id, userId: auth.userId, status: 'pending' },
      select: { type: true, payload: true },
    })
    if (!approval) return err("Approval is no longer pending", 409)
    const result = await db.agentApproval.updateMany({
      where: {
        id: action.approvalId,
        sessionId: id,
        userId: auth.userId,
        status: "pending",
      },
      data: {
        status: action.decision,
        decidedAt: new Date(),
      },
    })
    if (result.count === 0) return err("Approval is no longer pending", 409)
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
          body: `${artifact.name} is ready for Reviewer and your final confirmation.`,
          data: { resume: { ...artifact } }, durationMs: null,
        },
      })
      const finalApproval = await db.agentApproval.create({
        data: {
          sessionId: id, userId: auth.userId, type: 'confirm_tailored_resume', status: 'pending',
          title: 'Confirm tailored resume',
          body: `Reviewer: confirm ${artifact.name} as the final resume for ${artifact.company} · ${artifact.role} before handing it to Executor.`,
          impact: { resume: artifact.name, company: artifact.company, role: artifact.role },
          payload: { resumeId: artifact.id, jobId: artifact.jobId },
        },
      })
      const reviewEvent = await db.agentTranscriptEvent.create({
        data: {
          sessionId: id, taskId: null, type: 'approval_request', speaker: 'Reviewer',
          title: 'Final resume review', body: finalApproval.body,
          data: { approval: { id: finalApproval.id, type: finalApproval.type, title: finalApproval.title, body: finalApproval.body, impact: finalApproval.impact, payload: finalApproval.payload, status: finalApproval.status } }, durationMs: null,
        },
      })
      await updateAgentSession(db, { sessionId: id, status: 'waiting_for_user', completedAt: null })
      return ok({ events: [serializeEvent(tailoredEvent), serializeEvent(reviewEvent)] })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not tailor the resume.'
      const event = await db.agentTranscriptEvent.create({
        data: { sessionId: id, taskId: null, type: 'error', speaker: 'Writer', title: 'Tailoring failed', body: message, data: { approvalId: action.approvalId }, durationMs: null },
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
      status: 'review',
      analysisNote: job.url
        ? '[Application ready] Open the employer form, use the ApplyMate extension to fill it, then review and submit it yourself.'
        : '[Application ready] Missing application URL.',
    } })
    const event = await db.agentTranscriptEvent.create({
      data: {
        sessionId: id, taskId: null, type: 'resume_finalized', speaker: 'Reviewer', title: 'Application pack ready',
        body: job.url
          ? `${resume.name} is confirmed for ${job.company} · ${job.role}. Open the employer form, let the extension fill the fields, review everything, then submit it yourself.`
          : `${resume.name} is confirmed and linked to ${job.company} · ${job.role}, but this job has no application URL.`,
        data: { resume: { id: resume.id, name: resume.name }, job }, durationMs: null,
      },
    })
    await updateAgentSession(db, { sessionId: id, status: 'completed', completedAt: new Date() })
    return ok({ event: serializeEvent(event) })
  }

  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId: id,
      taskId: null,
      type: "approval_response",
      speaker: "You",
      title: approvalTitle(action.decision),
      body: action.body,
      data: {
        approvalId: action.approvalId,
        decision: action.decision,
      },
      durationMs: null,
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
