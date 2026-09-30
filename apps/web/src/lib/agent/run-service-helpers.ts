import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError } from "@/lib/agent/execution-control"
import type { PipelineCheckpointState, RunReport } from "@/lib/agent/types"

export type RunHistoryEvent = { event: string; at: string; data: unknown }
export type DurableEventWriter = {
  record: (event: string, data: unknown) => Promise<unknown>
  publish?: (event: string, data: unknown) => void
  onError?: (error: unknown) => void
}

/** Serializes event persistence and publishes each event only after its write commits. */
export function createDurableEventWriter(input: DurableEventWriter) {
  let pending = Promise.resolve()
  return {
    emit(event: string, data: unknown): void {
      pending = pending.then(async () => {
        await input.record(event, data)
        input.publish?.(event, data)
      }).catch(error => {
        input.onError?.(error)
      })
    },
    drain: () => pending,
  }
}

export type FinishedExecutionStatus = "completed" | "failed" | "waiting_for_user" | "cancelled"
export type RecorderTerminalStatus = "completed" | "failed" | "waiting_for_user"
const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

function pickNumber(data: unknown, keys: string[]): number | null {
  if (!data || typeof data !== "object") return null
  const row = data as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function historyStatus(report: RunReport | null, failed = false) {
  if (failed || !report) return "failed"
  return report.failed > 0 ? "partial" : "completed"
}

export function checkpointState(value: unknown): PipelineCheckpointState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const state = value as Partial<PipelineCheckpointState>
  const stages = ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]
  return typeof state.nextStage === "string" && stages.includes(state.nextStage)
    ? state as PipelineCheckpointState
    : undefined
}

export async function isActiveAccount(userId: string): Promise<boolean> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { accountStatus: true } })
    return user?.accountStatus === "active"
  } catch {
    // A background action must fail closed if the current account state is unavailable.
    return false
  }
}

export async function saveHistory(
  userId: string,
  events: RunHistoryEvent[],
  startedAt: number,
  report: RunReport | null,
  failed = false,
) {
  const stageEvents = events.filter(event => event.event === "stage_done")
  const scout = [...events].reverse().find(event => {
    const data = event.data as Record<string, unknown> | null
    return event.event === "role_done" && data?.role === "scout"
  })

  await db.agentRun.create({
    data: {
      userId,
      status: historyStatus(report, failed),
      durationMs: report?.durationMs ?? Math.max(0, Date.now() - startedAt),
      stagesCompleted: stageEvents.length,
      jobsFound: pickNumber(scout?.data, ["discovered", "count", "jobsFound"]) ?? 0,
      ...(report ? { report: report as unknown as Prisma.InputJsonValue } : {}),
      log: events as unknown as Prisma.InputJsonValue,
    },
  }).catch(error => console.warn("Failed to save agent run history", error))
}

export async function hasExecutionAttemptStatus(input: {
  id: string
  userId: string
  attemptCount: number
  status: string
  signal?: AbortSignal
}): Promise<boolean> {
  if (input.signal?.aborted) return false
  const execution = await db.agentExecution.findFirst({
    where: { id: input.id, userId: input.userId, status: input.status, attemptCount: input.attemptCount },
    select: { id: true },
  })
  return Boolean(execution) && !input.signal?.aborted
}

/** Durable post-CAS gate: an abort signal cannot erase a committed result, but Stop cannot be overwritten. */
export async function hasDurableRunOwnership(input: {
  id: string
  userId: string
  attemptCount: number
  status: string
  sessionId: string
  turnId?: string
}): Promise<boolean> {
  const execution = await db.agentExecution.findFirst({
    where: { id: input.id, userId: input.userId, sessionId: input.sessionId, status: input.status, attemptCount: input.attemptCount },
    select: { id: true },
  })
  if (!execution) return false
  if (!input.turnId) return true
  const turn = await db.agentTurn.findFirst({
    where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    select: { id: true },
  })
  return Boolean(turn)
}

export async function finishOwnedAttempt(input: {
  id: string
  userId: string
  attemptCount: number
  status: FinishedExecutionStatus
  error?: string | null
  signal?: AbortSignal
}): Promise<boolean> {
  if (input.signal?.aborted) return false
  return db.$transaction(async tx => {
    if (input.signal?.aborted) return false
    const result = await tx.agentExecution.updateMany({
      where: { id: input.id, userId: input.userId, status: "running", attemptCount: input.attemptCount },
      data: {
        status: input.status,
        error: input.error ?? null,
        completedAt: input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? new Date() : null,
      },
    })
    if (input.signal?.aborted) throw new AgentExecutionCancelledError()
    return result.count === 1
  })
}

export function createRunAttemptOwnership(input: {
  id: string
  userId: string
  sessionId: string
  attemptCount: number
  turnId: () => string | undefined
  signal?: AbortSignal
}) {
  const isCurrentAttempt = (status = "running") => hasExecutionAttemptStatus({ ...input, status })
  const finishAttempt = async (status: FinishedExecutionStatus, error?: string | null) => {
    try {
      return await finishOwnedAttempt({ ...input, status, error })
    } catch (finishError) {
      if (finishError instanceof AgentExecutionCancelledError || input.signal?.aborted) return false
      throw finishError
    }
  }
  const canPublishAttemptResult = (status: string) => hasDurableRunOwnership({
    id: input.id, userId: input.userId, sessionId: input.sessionId, attemptCount: input.attemptCount,
    status, turnId: input.turnId(),
  })
  const recorderOwner = (terminalStatus: RecorderTerminalStatus | "running", executionTransitionTo?: "waiting_for_user") => {
    const turnId = input.turnId()
    return turnId ? {
      turnId,
      executionAttempt: { id: input.id, userId: input.userId, attemptCount: input.attemptCount },
      terminalStatus,
      ...(executionTransitionTo ? { executionTransitionTo } : {}),
    } : undefined
  }
  return { isCurrentAttempt, finishAttempt, canPublishAttemptResult, recorderOwner }
}
