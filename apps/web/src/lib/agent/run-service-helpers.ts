import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError } from "@/lib/agent/execution-control"
import type { PipelineCheckpointState, RunReport } from "@/lib/agent/types"
import { AgentPauseError } from "@/lib/agent/orchestrator"
import { PipelineInterruptedError } from "@/lib/agent/pipeline"
import { isAnalyzeSourceChangedError } from "@/lib/agent/stages/analyze-model-input"
import { createAnalyzeSourceChangedCleanup } from "@/lib/agent/stages/analyze-ownership"


export type RunHistoryEvent = { event: string; at: string; data: unknown }
export type DurableEventWriter = {
  record: (event: string, data: unknown) => Promise<unknown>; publish?: (event: string, data: unknown) => void
  onError?: (error: unknown) => void
}
/** Serializes event persistence and publishes each event only after its write commits. */
export function createDurableEventWriter(input: DurableEventWriter) {
  let pending = Promise.resolve()
  return {
    emit(event: string, data: unknown): void {
      pending = pending.then(async () => { await input.record(event, data); input.publish?.(event, data) }).catch(error => input.onError?.(error))
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
 type PauseStage = "scout" | "analyst" | "writer" | "reviewer" | "executor" | "auditor" | "post-run"
type AgentRecorderOwner = { turnId: string; executionAttempt: { id: string; userId: string; attemptCount: number }; terminalStatus: RecorderTerminalStatus | "running"; executionTransitionTo?: "waiting_for_user" }
type RunWaitResult = { status: "waiting_for_user"; waitId: string; stage: string }
type RunFailureResult = { kind: "return"; result: null | RunWaitResult } | { kind: "throw"; error: unknown }
export async function handleAgentPipelineFailure(input: {
  error: unknown; scheduled: boolean; scheduledQuestionPersistenceFailed: boolean; signal?: AbortSignal
  cleanupAnalyzeSourceChanged: (error: unknown) => Promise<void>
  drainEvents: () => Promise<void>; isCurrentAttempt: () => Promise<boolean>; scheduledOwnerIsCurrent: () => Promise<boolean>
  recorderOwner: (status: "running" | "failed", transition?: "waiting_for_user") => AgentRecorderOwner | undefined
  pause: (message: string, stage: PauseStage, owner: AgentRecorderOwner) => Promise<boolean>; finishAttempt: (status: "failed", error: string) => Promise<boolean>
  canPublish: (status: string) => Promise<boolean>; emit: (event: string, data: unknown) => void
  finalize: (status: "failed", report: null) => Promise<boolean>; saveFailedHistory: () => Promise<void>
}): Promise<RunFailureResult> {
  const { error } = input
  if (isAnalyzeSourceChangedError(error) && input.signal?.aborted) { await input.drainEvents(); return { kind: "return", result: null } }
  if (isAnalyzeSourceChangedError(error) && input.scheduled) { await input.drainEvents(); return { kind: "throw", error } }
  if (error instanceof AgentExecutionCancelledError || error instanceof PipelineInterruptedError) { await input.drainEvents(); return { kind: "return", result: null } }
  if (error instanceof AgentPauseError) {
    await input.drainEvents()
    if (input.scheduled && input.scheduledQuestionPersistenceFailed) return { kind: "return", result: null }
    if (!await input.isCurrentAttempt() || input.scheduled && !await input.scheduledOwnerIsCurrent()) return { kind: "return", result: null }
    const owner = input.recorderOwner("running", "waiting_for_user")
    if (!owner || !await input.pause(`Waiting for your answer at ${error.stage}.`, error.stage as PauseStage, owner)) return { kind: "return", result: null }
    return { kind: "return", result: input.scheduled ? { status: "waiting_for_user", waitId: error.questionId, stage: error.stage } : null }
  }
  const message = error instanceof Error ? error.message : "Agent run failed"
  if (!await input.isCurrentAttempt()) {
    await input.drainEvents(); return { kind: "return", result: null }
  }
  if (isAnalyzeSourceChangedError(error)) {
    await input.drainEvents()
    try { await input.cleanupAnalyzeSourceChanged(error) }
    catch (cleanupError) { return cleanupError instanceof AgentExecutionCancelledError || input.signal?.aborted
      ? { kind: "return", result: null } : { kind: "throw", error: analyzeSourceChangeCleanupFailure() } }
  }
  if (!await input.finishAttempt("failed", message) || !await input.canPublish("failed")) { await input.drainEvents(); return { kind: "return", result: null } }
  input.emit("error", { message })
  await input.drainEvents()
  if (!await input.finalize("failed", null)) return { kind: "return", result: null }
  await input.saveFailedHistory()
  return isAnalyzeSourceChangedError(error) ? { kind: "throw", error } : { kind: "return", result: null }
}

function analyzeSourceChangeCleanupFailure(): Error {
  const error = new Error("Analyze source-change cleanup failed.")
  error.name = "AnalyzeSourceChangeCleanupError"
  return error
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
  return { isCurrentAttempt, finishAttempt, canPublishAttemptResult, recorderOwner,
    cleanupAnalyzeSourceChanged: (error: unknown) => createAnalyzeSourceChangedCleanup({ userId: input.userId,
      sessionId: input.sessionId, executionAttempt: { id: input.id, attemptCount: input.attemptCount },
      signal: input.signal })(error) }
}
