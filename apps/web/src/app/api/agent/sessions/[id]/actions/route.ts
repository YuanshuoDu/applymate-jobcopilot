import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAtFromCron } from "@/lib/agent/automation-schedule"

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

  if (action.approvalId) {
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

  return ok({ event: serializeEvent(event as Parameters<typeof serializeEvent>[0]) })
}
