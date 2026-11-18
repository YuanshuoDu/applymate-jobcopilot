import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { redactAgentEvent } from "@jobcopilot/shared"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { nextRunAfterCurrent } from "@/lib/agent/automation-schedule"
import { buildScheduledAutomationSnapshot, ScheduledAutomationSnapshotValidationError } from "@/lib/agent/scheduled-automation-snapshot"
import { enqueueAgentRun } from "@/lib/agent-run-queue-client"
import { ensureAgentExecution } from "@/lib/agent/execution-control"
import { AutomationTurnOccupiedError, ensureAutomationTurn, isActiveAutomationExecution, resolveAutomationSession } from "@/lib/agent/automation-session"
import { startMaterialDriftRecovery } from "@/lib/agent/material-drift-recovery"
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

function runnableAutomationWhere(automation: Pick<AutomationForRun, "id">, userId: string) {
  return {
    id: automation.id,
    userId,
    enabled: true,
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

  let scheduledAutomationSnapshot: ReturnType<typeof buildScheduledAutomationSnapshot>
  try {
    scheduledAutomationSnapshot = buildScheduledAutomationSnapshot({
      targetRoles: automation.targetRoles,
      targetLocations: automation.targetLocations,
      minScore: automation.minScore,
      dailyCap: automation.dailyCap,
      requireApproval: automation.requireApproval,
      autoApply: automation.autoApply,
    })
  } catch (error: unknown) {
    if (error instanceof ScheduledAutomationSnapshotValidationError) return err(error.message, 400)
    throw error
  }

  const runAt = new Date()
  const recoveryResult = automation.sessionId
    ? await startMaterialDriftRecovery(db, { automationId: automation.id, userId: auth.userId, sessionId: automation.sessionId, now: runAt })
    : null
  if (recoveryResult?.kind === "rejected") return err("Automation recovery could not be verified", 409)
  if (recoveryResult?.kind === "already_started") return ok({
    session: serializeSession(recoveryResult.session as SessionRow), turnId: recoveryResult.turnId,
    executionId: recoveryResult.executionId, dispatchId: recoveryResult.dispatchId, turnStatus: recoveryResult.turnStatus,
  }, 202)
  const recovery = recoveryResult?.kind === "created" ? recoveryResult : null
  if (!recovery && automation.sessionId) {
    const execution = await db.agentExecution.findFirst({
      where: { userId: auth.userId, sessionId: automation.sessionId },
      select: { status: true },
    })
    if (isActiveAutomationExecution(execution?.status)) return err("Automation is already running", 409)
  }
  const runAutomation = recovery?.automation ?? automation
  if (!recovery) {
    const claim = await db.agentAutomation.updateMany({
      where: runnableAutomationWhere(automation, auth.userId),
      data: { lastRunAt: runAt, nextRunAt: nextRunAfterCurrent(automation.cron, runAt, automation.timezone) },
    })
    if (claim.count === 0) return err("Automation is paused", 409)
  }

  const resolution = recovery ? { session: recovery.session, created: false } : await resolveAutomationSession(db, {
    automationId: automation.id, userId: auth.userId, sessionId: automation.sessionId, name: automation.name,
  })
  const { session, created } = resolution
  if (!recovery && !created) {
    const reopened = await db.agentSession.updateMany({
      where: { id: session.id, userId: auth.userId },
      data: { status: "running", completedAt: null, memorySummary: "Automation queued for execution." },
    })
    if (reopened.count !== 1) return err(`Automation session ${session.id} is unavailable`, 409)
  }

  let canonicalTurn: Awaited<ReturnType<typeof ensureAutomationTurn>>
  try {
    canonicalTurn = recovery ? { turnId: recovery.turnId, created: true } : await ensureAutomationTurn(db, {
      sessionId: session.id,
      userId: auth.userId,
      name: runAutomation.name,
      automationRunMode: "manual",
      scheduledAutomationSnapshot,
    })
  } catch (error: unknown) {
    if (error instanceof AutomationTurnOccupiedError) return err(error.message, 409)
    throw error
  }

  const dualWriteEnabled = await isRuntimeAgentHarnessFeatureEnabled(
    'AGENT_PROTOCOL_V2_DUAL_WRITE',
    auth.userId,
  ).catch(() => false)
  let dualWrite: Awaited<ReturnType<typeof createDualWriteSession>> | null = null
  let dualWriteUnavailable = false
  if (dualWriteEnabled) {
    try {
      dualWrite = await createDualWriteSession(db, {
        sessionId: session.id, userId: auth.userId, goal: `Run automation: ${runAutomation.name}`,
        source: 'automation', turnId: canonicalTurn.turnId,
      })
    } catch (error) {
      if (!recovery) throw error
      dualWriteUnavailable = true
    }
  }
  const eventInput = {
    sessionId: session.id,
    taskId: null,
    type: "automation_started" as const,
    speaker: "Orchestrator",
    title: "Automation started",
    body: `Started automation: ${runAutomation.name}`,
    data: {
      automationId: runAutomation.id,
      automation: automationPayload(runAutomation),
    },
  }
  const safeEvent = redactAgentEvent(eventInput)
  let event: Parameters<typeof serializeEvent>[0] | null = null
  if (!dualWriteUnavailable) {
    try {
      event = (dualWrite
        ? await dualWrite.record(eventInput)
        : await db.agentTranscriptEvent.create({ data: { ...eventInput, body: safeEvent.body, data: safeEvent.data ?? Prisma.JsonNull, durationMs: null } })) as Parameters<typeof serializeEvent>[0]
    } catch (error) {
      if (dualWrite && !recovery) {
        await dualWrite.finalize({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Could not record automation start',
        }).catch(() => undefined)
      }
      if (!recovery) throw error
    }
  }

  if (recovery) return ok({ session: serializeSession(session as SessionRow), event: event ? serializeEvent(event) : null,
    turnId: recovery.turnId, executionId: recovery.executionId, dispatchId: recovery.dispatchId, turnStatus: "queued" }, 202)
  if (!event) throw new Error("Could not record automation start")

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
