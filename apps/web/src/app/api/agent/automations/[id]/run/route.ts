import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAfterCurrent } from "@/lib/agent/automation-schedule"

type RouteCtx = { params: Promise<{ id: string }> }

type AutomationForRun = {
  id: string
  name: string
  enabled: boolean
  cron: string | null
  timezone: string
  triggerType: string
  targetRoles: string[]
  targetLocations: string[]
  minScore: number
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}

type SessionRow = {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

function serializeSession(session: SessionRow) {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
  }
}

function serializeEvent(event: {
  id: string
  sessionId: string
  taskId?: string | null
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown
  durationMs: number | null
  createdAt: Date
}) {
  return { ...event, createdAt: event.createdAt.toISOString() }
}

function automationPayload(automation: AutomationForRun) {
  return {
    name: automation.name,
    triggerType: automation.triggerType,
    targetRoles: automation.targetRoles,
    targetLocations: automation.targetLocations,
    minScore: automation.minScore,
    dailyCap: automation.dailyCap,
    requireApproval: automation.requireApproval,
    autoApply: automation.autoApply,
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await ctx.params
  const automation = await db.agentAutomation.findFirst({
    where: { id, userId: auth.userId },
  }) as AutomationForRun | null
  if (!automation) return err("Automation not found", 404)
  if (!automation.enabled) return err("Automation is paused", 409)

  const runAt = new Date()
  const claim = await db.agentAutomation.updateMany({
    where: { id, userId: auth.userId, enabled: true },
    data: {
      lastRunAt: runAt,
      nextRunAt: nextRunAfterCurrent(automation.cron, runAt, automation.timezone),
    },
  })
  if (claim.count === 0) return err("Automation is paused", 409)

  const session = await db.agentSession.create({
    data: {
      userId: auth.userId,
      goal: `Run automation: ${automation.name}`,
      source: "automation",
      status: "running",
      memorySummary: "Automation queued for execution.",
    },
  })

  const event = await db.agentTranscriptEvent.create({
    data: {
      sessionId: session.id,
      taskId: null,
      type: "automation_started",
      speaker: "Orchestrator",
      title: "Automation started",
      body: `Started automation: ${automation.name}`,
      data: {
        automationId: automation.id,
        automation: automationPayload(automation),
      },
      durationMs: null,
    },
  })

  return ok({
    session: serializeSession(session as SessionRow),
    event: serializeEvent(event),
  }, 201)
}
