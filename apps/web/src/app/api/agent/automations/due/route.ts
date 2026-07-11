import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, ok } from "@/lib/api-helpers"
import { nextRunAfterCurrent } from "@/lib/agent/automation-schedule"

type AutomationForRun = {
  id: string
  userId: string
  name: string
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

function authorized(req: NextRequest) {
  const secret = process.env.AGENT_AUTOMATION_CRON_SECRET ?? process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  return bearer === secret || req.headers.get("x-agent-cron-secret") === secret
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

async function startAutomation(automation: AutomationForRun, now: Date) {
  const claimed = await db.agentAutomation.updateMany({
    where: { id: automation.id, userId: automation.userId, enabled: true, nextRunAt: { lte: now } },
    data: {
      lastRunAt: now,
      nextRunAt: nextRunAfterCurrent(automation.cron, now, automation.timezone),
    },
  })
  if (claimed.count === 0) return null

  const session = await db.agentSession.create({
    data: {
      userId: automation.userId,
      goal: `Run automation: ${automation.name}`,
      source: "automation",
      status: "running",
      memorySummary: "Automation picked up by scheduler.",
    },
  })

  await db.agentTranscriptEvent.create({
    data: {
      sessionId: session.id,
      taskId: null,
      type: "automation_started",
      speaker: "Orchestrator",
      title: "Automation started",
      body: `Started scheduled automation: ${automation.name}`,
      data: { automationId: automation.id, automation: automationPayload(automation) },
      durationMs: null,
    },
  })

  return { automationId: automation.id, sessionId: session.id }
}

async function runDueAutomations(req: NextRequest) {
  if (!authorized(req)) return err("Unauthorized", 401)

  const now = new Date()
  const automations = await db.agentAutomation.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 20,
  }) as AutomationForRun[]

  const started = []
  for (const automation of automations) {
    const result = await startAutomation(automation, now)
    if (result) started.push(result)
  }

  return ok({ checkedAt: now.toISOString(), started })
}

export async function GET(req: NextRequest) {
  return runDueAutomations(req)
}

export async function POST(req: NextRequest) {
  return runDueAutomations(req)
}
