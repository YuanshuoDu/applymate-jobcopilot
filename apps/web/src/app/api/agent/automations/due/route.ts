import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, ok } from "@/lib/api-helpers"
import { nextRunAfterCurrent } from "@/lib/agent/automation-schedule"
import { enqueueAgentRun } from "@/lib/agent-run-queue-client"
import { ensureAgentExecution } from "@/lib/agent/execution-control"
import { isActiveAutomationExecution, resolveAutomationSession } from "@/lib/agent/automation-session"
import { hasEffectiveEntitlement } from '@/lib/entitlements'
import { isRuntimeAgentHarnessFeatureEnabled } from '@/lib/runtime-feature-flags'
import { createDualWriteSession } from '@/lib/agent/session/dual-write'
import { appendTranscriptEvent, type AppendTranscriptEventInput } from '@/lib/agent/session/repository'

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
  sessionId: string | null
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
  if (automation.sessionId) {
    const execution = await db.agentExecution.findFirst({
      where: { userId: automation.userId, sessionId: automation.sessionId },
      select: { status: true },
    })
    if (isActiveAutomationExecution(execution?.status)) {
      await db.agentAutomation.updateMany({
        where: { id: automation.id, userId: automation.userId, enabled: true, nextRunAt: { lte: now }, user: { accountStatus: 'active' } },
        data: { lastRunAt: now, nextRunAt: nextRunAfterCurrent(automation.cron, now, automation.timezone) },
      })
      return null
    }
  }

  const claimed = await db.agentAutomation.updateMany({
    where: { id: automation.id, userId: automation.userId, enabled: true, nextRunAt: { lte: now }, user: { accountStatus: 'active' } },
    data: {
      lastRunAt: now,
      nextRunAt: nextRunAfterCurrent(automation.cron, now, automation.timezone),
    },
  })
  if (claimed.count === 0) return null

  const { session, created } = await resolveAutomationSession(db, {
    automationId: automation.id,
    userId: automation.userId,
    sessionId: automation.sessionId,
    name: automation.name,
    memorySummary: "Automation picked up by scheduler.",
  })
  if (!created) {
    await db.agentSession.update({
      where: { id: session.id },
      data: { status: "running", completedAt: null, memorySummary: "Automation picked up by scheduler." },
    })
  }

  const dualWriteEnabled = await isRuntimeAgentHarnessFeatureEnabled(
    'AGENT_PROTOCOL_V2_DUAL_WRITE',
    automation.userId,
  ).catch(() => false)
  const dualWrite = dualWriteEnabled
    ? await createDualWriteSession(db, {
      sessionId: session.id,
      userId: automation.userId,
      goal: `Run scheduled automation: ${automation.name}`,
      source: 'automation',
    })
    : null
  const recordTranscript = (input: AppendTranscriptEventInput) =>
    dualWrite ? dualWrite.record(input) : appendTranscriptEvent(db, input)

  await recordTranscript({
    sessionId: session.id,
    taskId: null,
    type: "automation_started",
    speaker: "Orchestrator",
    title: "Automation started",
    body: `Started scheduled automation: ${automation.name}`,
    data: { automationId: automation.id, automation: automationPayload(automation) },
    durationMs: null,
  })

  let executionId: string | null = null
  try {
    const execution = await ensureAgentExecution({ userId: automation.userId, sessionId: session.id, autonomous: true, restartForRun: true })
    if (!execution) throw new Error("Could not prepare automation execution")
    executionId = execution.id
    const taskId = await enqueueAgentRun({ userId: automation.userId, sessionId: session.id })
    await db.agentExecution.update({ where: { id: execution.id }, data: { workerTaskId: taskId } })
    await recordTranscript({
      sessionId: session.id,
      taskId: null,
      type: "subagent_result",
      speaker: "Scheduler",
      title: "Automation dispatched",
      body: "The unattended Agent worker accepted this scheduled run.",
      data: { automationId: automation.id, taskId },
      durationMs: null,
    })
    return { automationId: automation.id, sessionId: session.id, executionId: execution.id, taskId }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not dispatch automation"
    await Promise.allSettled([
      db.agentSession.update({
        where: { id: session.id },
        data: { status: "failed", completedAt: new Date(), memorySummary: `Dispatch failed: ${message}` },
      }),
      ...(executionId ? [db.agentExecution.update({ where: { id: executionId }, data: { status: "failed", completedAt: new Date(), error: message } })] : []),
      recordTranscript({
        sessionId: session.id, taskId: null, type: "error", speaker: "Scheduler",
        title: "Automation dispatch failed", body: message, data: { automationId: automation.id }, durationMs: null,
      }),
      db.agentAutomation.update({ where: { id: automation.id }, data: { nextRunAt: now } }),
      ...(dualWrite ? [dualWrite.finalize({ status: 'failed', error: message })] : []),
    ])
    throw error
  }
}

async function runDueAutomations(req: NextRequest) {
  if (!authorized(req)) return err("Unauthorized", 401)

  const now = new Date()
  const automations = await db.agentAutomation.findMany({
    where: { enabled: true, nextRunAt: { lte: now }, user: { accountStatus: 'active' } },
    orderBy: { nextRunAt: "asc" },
    take: 20,
  }) as AutomationForRun[]

  const started = []
  for (const automation of automations) {
    if (!await hasEffectiveEntitlement(automation.userId, 'auto_apply')) continue
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
