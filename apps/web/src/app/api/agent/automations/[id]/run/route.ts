import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { redactAgentEvent } from "@jobcopilot/shared"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAfterCurrent } from "@/lib/agent/automation-schedule"
import { enqueueAgentRun } from "@/lib/agent-run-queue-client"
import { ensureAgentExecution } from "@/lib/agent/execution-control"
import { ensureAutomationTurn, isActiveAutomationExecution, resolveAutomationSession } from "@/lib/agent/automation-session"
import { hasEffectiveEntitlement } from '@/lib/entitlements'
import { isRuntimeAgentHarnessFeatureEnabled } from '@/lib/runtime-feature-flags'
import { createDualWriteSession } from '@/lib/agent/session/dual-write'
import { requireLegacyPolicy } from '@/lib/agent/policy/legacy'

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
  sessionId: string | null
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
  if (!await hasEffectiveEntitlement(auth.userId, 'auto_apply')) return err('Your current plan does not include autonomous applications.', 403)

  const { id } = await ctx.params
  try {
    requireLegacyPolicy({
      userId: auth.userId, sessionId: `automation-api:${auth.userId}`, turnId: `automation-run:${id}`,
      stepId: "automation.run", toolCallId: `automation-run:${id}`, toolName: "automation.run",
      domain: "automation", risk: "internal_write", capabilities: ["read", "write", "coordination"],
      input: { mutation: "run", requiresReceipt: false, unknownSensitiveFacts: false },
    })
  } catch (error) {
    return err(error instanceof Error ? error.message : "Automation policy denied this run", 403)
  }
  const automation = await db.agentAutomation.findFirst({
    where: { id, userId: auth.userId },
  }) as AutomationForRun | null
  if (!automation) return err("Automation not found", 404)
  if (!automation.enabled) return err("Automation is paused", 409)

  if (automation.sessionId) {
    const execution = await db.agentExecution.findFirst({
      where: { userId: auth.userId, sessionId: automation.sessionId },
      select: { status: true },
    })
    if (isActiveAutomationExecution(execution?.status)) return err("Automation is already running", 409)
  }

  const runAt = new Date()
  const claim = await db.agentAutomation.updateMany({
    where: { id, userId: auth.userId, enabled: true },
    data: {
      lastRunAt: runAt,
      nextRunAt: nextRunAfterCurrent(automation.cron, runAt, automation.timezone),
    },
  })
  if (claim.count === 0) return err("Automation is paused", 409)

  const { session, created } = await resolveAutomationSession(db, {
    automationId: automation.id,
    userId: auth.userId,
    sessionId: automation.sessionId,
    name: automation.name,
  })
  if (!created) {
    await db.agentSession.update({
      where: { id: session.id },
      data: { status: "running", completedAt: null, memorySummary: "Automation queued for execution." },
    })
  }

  const canonicalTurn = await ensureAutomationTurn(db, {
    sessionId: session.id,
    userId: auth.userId,
    name: automation.name,
  })

  const dualWriteEnabled = await isRuntimeAgentHarnessFeatureEnabled(
    'AGENT_PROTOCOL_V2_DUAL_WRITE',
    auth.userId,
  ).catch(() => false)
  const dualWrite = dualWriteEnabled
    ? await createDualWriteSession(db, {
      sessionId: session.id,
      userId: auth.userId,
      goal: `Run automation: ${automation.name}`,
      source: 'automation',
      turnId: canonicalTurn.turnId,
    })
    : null
  const eventInput = {
    sessionId: session.id,
    taskId: null,
    type: "automation_started" as const,
    speaker: "Orchestrator",
    title: "Automation started",
    body: `Started automation: ${automation.name}`,
    data: {
      automationId: automation.id,
      automation: automationPayload(automation),
    },
  }
  const safeEvent = redactAgentEvent(eventInput)
  let event: Parameters<typeof serializeEvent>[0]
  try {
    event = (dualWrite
      ? await dualWrite.record(eventInput)
      : await db.agentTranscriptEvent.create({ data: { ...eventInput, body: safeEvent.body, data: safeEvent.data ?? Prisma.JsonNull, durationMs: null } })) as Parameters<typeof serializeEvent>[0]
  } catch (error) {
    if (dualWrite) {
      await dualWrite.finalize({
        status: 'failed',
        error: error instanceof Error ? error.message : 'Could not record automation start',
      }).catch(() => undefined)
    }
    throw error
  }

  let executionId: string | null = null
  try {
    const execution = await ensureAgentExecution({ userId: auth.userId, sessionId: session.id, autonomous: true, restartForRun: true })
    if (!execution) throw new Error("Could not prepare automation execution")
    executionId = execution.id
    const taskId = await enqueueAgentRun({ userId: auth.userId, sessionId: session.id, turnId: canonicalTurn.turnId, executionId: execution.id })
    await db.agentExecution.update({ where: { id: execution.id }, data: { workerTaskId: taskId } })
    return ok({ session: serializeSession(session as SessionRow), event: serializeEvent(event), executionId: execution.id, taskId }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not dispatch automation"
    await Promise.allSettled([
      db.agentSession.update({ where: { id: session.id }, data: { status: "failed", completedAt: new Date(), memorySummary: `Dispatch failed: ${message}` } }),
      ...(executionId ? [db.agentExecution.update({ where: { id: executionId }, data: { status: "failed", completedAt: new Date(), error: message } })] : []),
      ...(dualWrite ? [dualWrite.finalize({ status: 'failed', error: message })] : []),
    ])
    return err(message, 503)
  }

}
