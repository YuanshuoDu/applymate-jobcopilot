import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { redactAgentEvent } from "@jobcopilot/shared"
import { requireLegacyPolicy } from "./policy/legacy"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "./execution-control"

export const APPLICATION_TASK_STATUSES = [
  "discovered",
  "analyzing",
  "generating_materials",
  "filling",
  "waiting_for_user",
  "waiting_for_authorization",
  "submitted",
  "skipped",
  "failed",
  "cancelled",
] as const

export type ApplicationTaskStatus = (typeof APPLICATION_TASK_STATUSES)[number]

export const USER_TAKEOVER_REASONS = ["captcha", "login", "two_factor", "platform_restriction"] as const
export type UserTakeoverReason = (typeof USER_TAKEOVER_REASONS)[number]

type ReviewInput = {
  userId: string
  jobId: string
  sessionId?: string
  resumeId?: string | null
  coverLetterId?: string | null
  owner?: GateWriteOwner
}

type GateWriteOwner = {
  turnId: string
  executionAttempt?: { id: string; attemptCount: number }
  signal?: AbortSignal
}

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

async function assertGateWriteOwner(tx: Prisma.TransactionClient, input: { userId: string; sessionId: string; owner: GateWriteOwner }) {
  if (input.owner.signal?.aborted) throw new AgentExecutionCancelledError()
  const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
      AND "status" NOT IN ('aborted', 'archived')
    FOR UPDATE
  `)
  if (input.owner.signal?.aborted) throw new AgentExecutionCancelledError()
  if (!sessions[0]) throw new AgentExecutionCancelledError()
  const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_turns"
    WHERE "id" = ${input.owner.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
    FOR UPDATE
  `)
  if (input.owner.signal?.aborted) throw new AgentExecutionCancelledError()
  if (!turns[0] || !ACTIVE_TURN_STATUSES.includes(turns[0].status as (typeof ACTIVE_TURN_STATUSES)[number])) {
    throw new AgentExecutionCancelledError()
  }
  if (input.owner.executionAttempt) {
    const current = await refreshAgentExecutionAttempt(tx, { ...input.owner.executionAttempt, userId: input.userId })
    if (input.owner.signal?.aborted || !current) throw new AgentExecutionCancelledError()
  }
}

function safeTaskEvent(type: string, actor: "reviewer" | "worker", body: string) {
  const safe = redactAgentEvent({ type, body })
  return { type, actor, body: safe.body, data: safe.data as Prisma.InputJsonValue }
}

const PROTECTED_APPLICATION_CHECKPOINTS = [
  "turn_stopped_before_submit",
  "submission_request_started",
  "submission_uncertain",
] as const

/** Create or refresh the durable review checkpoint. This never submits externally. */
export async function holdForApplicationReview(input: ReviewInput) {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) throw new Error("application_review_session_scope_required")

  requireLegacyPolicy({
    userId: input.userId,
    sessionId,
    turnId: `review:${input.jobId}`,
    stepId: "application.review",
    toolCallId: `review:${input.jobId}`,
    toolName: "application.review",
    domain: "application",
    risk: "internal_write",
    capabilities: ["read", "write"],
    input: { requiresReceipt: false, unknownSensitiveFacts: false, jobId: input.jobId },
  })
  const result = await db.$transaction(async tx => {
    if (input.owner) await assertGateWriteOwner(tx, { userId: input.userId, sessionId, owner: input.owner })
    const identity = { userId: input.userId, jobId: input.jobId }
    await tx.applicationTask.upsert({
      where: { userId_jobId: identity },
      create: {
        ...identity,
        sessionId,
        status: "waiting_for_user",
        checkpoint: "materials_ready",
        resumeId: input.resumeId ?? null,
        coverLetterId: input.coverLetterId ?? null,
      },
      // Creation is atomic, while refresh happens below under a conditional
      // update so a submission-start checkpoint cannot be overwritten.
      update: {},
      select: { id: true },
    })
    const refreshed = await tx.applicationTask.updateMany({
      where: {
        ...identity,
        sessionId,
        OR: [
          {
            status: "generating_materials",
            OR: [
              { checkpoint: null },
              { checkpoint: { notIn: [...PROTECTED_APPLICATION_CHECKPOINTS] } },
            ],
          },
          { status: "waiting_for_user", checkpoint: "materials_ready" },
        ],
      },
      data: {
        sessionId,
        status: "waiting_for_user",
        checkpoint: "materials_ready",
        resumeId: input.resumeId ?? undefined,
        coverLetterId: input.coverLetterId ?? undefined,
        error: null,
        completedAt: null,
      },
    })
    const task = await tx.applicationTask.findUnique({ where: { userId_jobId: identity } })
    if (refreshed.count === 1 && task) {
      await tx.applicationTaskEvent.create({ data: { taskId: task.id, ...safeTaskEvent("materials_ready", "reviewer", "Application materials are ready for user review.") } })
    }
    return { task, refreshed: refreshed.count === 1 }
  })
  if (!result.task) throw new Error("Application review task could not be loaded after its upsert")
  return result.task
}

export async function skipApplicationForGate(input: {
  userId: string
  jobId: string
  sessionId?: string
  checkpoint: "review_quality_declined" | "below_match_threshold"
  owner?: GateWriteOwner
}): Promise<boolean> {
  return db.$transaction(async tx => {
    if (input.owner) {
      const sessionId = input.sessionId?.trim()
      if (!sessionId) throw new Error("application_review_session_scope_required")
      await assertGateWriteOwner(tx, { userId: input.userId, sessionId, owner: input.owner })
    }
    const updated = await tx.applicationTask.updateMany({
      where: {
        userId: input.userId,
        jobId: input.jobId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        status: { in: ["analyzing", "generating_materials"] },
      },
      data: { status: "skipped", checkpoint: input.checkpoint, completedAt: new Date() },
    })
    return updated.count === 1
  })
}

export async function requestUserTakeover(input: {
  userId: string
  jobId: string
  reason: UserTakeoverReason
  detail: string
}) {
  requireLegacyPolicy({
    userId: input.userId,
    sessionId: `application-takeover:${input.jobId}`,
    turnId: `takeover:${input.jobId}`,
    stepId: "application.user_takeover",
    toolCallId: `takeover:${input.jobId}`,
    toolName: "application.user_takeover",
    domain: "application",
    risk: "internal_write",
    capabilities: ["read", "write"],
    input: { requiresReceipt: false, unknownSensitiveFacts: false, reason: input.reason },
  })
  const identity = { userId: input.userId, jobId: input.jobId }
  const result = await db.$transaction(async tx => {
    const updated = await tx.applicationTask.updateMany({
      where: {
        ...identity,
        OR: [{ checkpoint: null }, { checkpoint: { notIn: [...PROTECTED_APPLICATION_CHECKPOINTS] } }],
      },
      data: {
        status: "waiting_for_user",
        checkpoint: "user_takeover",
        question: { reason: input.reason, detail: input.detail },
        error: input.detail,
      },
    })
    const task = await tx.applicationTask.findUnique({ where: { userId_jobId: identity } })
    return { task, updated: updated.count === 1 }
  })
  if (!result.task) throw new Error("Application takeover task could not be loaded")
  if (result.updated) {
    await appendApplicationTaskEvent(result.task.id, "user_takeover_required", "worker", input.detail, { reason: input.reason })
  }
  return result.task
}

export async function appendApplicationTaskEvent(
  taskId: string,
  type: string,
  actor: "orchestrator" | "reviewer" | "worker" | "user" | "system",
  body: string,
  data?: Record<string, unknown>,
) {
  const safe = redactAgentEvent({ type, body, data })
  return db.applicationTaskEvent.create({
    data: { taskId, type, actor, body: safe.body, data: safe.data as Prisma.InputJsonValue },
  })
}
