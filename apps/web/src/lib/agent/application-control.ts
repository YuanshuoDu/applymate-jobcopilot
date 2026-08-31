import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { redactAgentEvent } from "@jobcopilot/shared"
import { requireLegacyPolicy } from "./policy/legacy"

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
}

/** Create or refresh the durable review checkpoint. This never submits externally. */
export async function holdForApplicationReview(input: ReviewInput) {
  requireLegacyPolicy({
    userId: input.userId,
    sessionId: input.sessionId ?? `application-review:${input.jobId}`,
    turnId: `review:${input.jobId}`,
    stepId: "application.review",
    toolCallId: `review:${input.jobId}`,
    toolName: "application.review",
    domain: "application",
    risk: "internal_write",
    capabilities: ["read", "write"],
    input: { requiresReceipt: false, unknownSensitiveFacts: false, jobId: input.jobId },
  })
  const task = await db.applicationTask.upsert({
    where: { userId_jobId: { userId: input.userId, jobId: input.jobId } },
    create: {
      userId: input.userId,
      jobId: input.jobId,
      sessionId: input.sessionId ?? null,
      status: "waiting_for_user",
      checkpoint: "materials_ready",
      resumeId: input.resumeId ?? null,
      coverLetterId: input.coverLetterId ?? null,
    },
    update: {
      sessionId: input.sessionId ?? undefined,
      status: "waiting_for_user",
      checkpoint: "materials_ready",
      resumeId: input.resumeId ?? undefined,
      coverLetterId: input.coverLetterId ?? undefined,
      error: null,
      completedAt: null,
    },
  })
  await appendApplicationTaskEvent(task.id, "materials_ready", "reviewer", "Application materials are ready for user review.")
  return task
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
  const task = await db.applicationTask.update({
    where: { userId_jobId: { userId: input.userId, jobId: input.jobId } },
    data: {
      status: "waiting_for_user",
      checkpoint: "user_takeover",
      question: { reason: input.reason, detail: input.detail },
      error: input.detail,
    },
  })
  await appendApplicationTaskEvent(task.id, "user_takeover_required", "worker", input.detail, { reason: input.reason })
  return task
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
