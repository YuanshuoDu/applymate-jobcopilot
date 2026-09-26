import type { Prisma } from "@prisma/client"
import { redactAgentEvent } from "@jobcopilot/shared"
import { randomUUID } from "node:crypto"
import { db } from "@/lib/db"

import { AgentExecutionCancelledError } from "../execution-control"
import { clientReceipt, issueLegacyReceipt } from "../approval/legacy-receipt"
import type { ApplicationPackage, PipelineCtx } from "../types"

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const
const PROTECTED_APPLICATION_CHECKPOINTS = ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] as const

export async function createGateReviewReceipt(
  ctx: PipelineCtx,
  pkg: ApplicationPackage,
  projectedWaitAlreadyIssued: boolean,
) {
  const { sessionId, turnId } = ctx
  if (!sessionId || !turnId || !ctx.executionAttempt || ctx.signal?.aborted) throw new AgentExecutionCancelledError()
  const currentTurn = await db.agentTurn.findFirst({
    where: { id: turnId, sessionId, userId: ctx.userId },
    select: { revision: true, status: true },
  })
  if (!currentTurn || !ACTIVE_TURN_STATUSES.includes(currentTurn.status as (typeof ACTIVE_TURN_STATUSES)[number])) {
    throw new AgentExecutionCancelledError()
  }
  if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()

  const artifactBindings = (pkg.artifactReviews ?? []).map(review => ({
    artifactId: review.artifactId,
    artifactHash: review.artifactHash,
    constraintHash: review.constraintHash,
    status: review.status,
  }))
  const basePayload = {
    jobId: pkg.job.id,
    ...(artifactBindings.length ? { artifactBindings } : {}),
  }
  const projectedWait = !projectedWaitAlreadyIssued && currentTurn.status !== "waiting_for_approval"
  const result = await issueLegacyReceipt(db, {
    userId: ctx.userId,
    sessionId,
    turnId,
    toolCallId: `application-review:${randomUUID()}`,
    jobId: pkg.job.id,
    action: "review_application",
    title: `Review application: ${pkg.job.company} · ${pkg.job.role}`,
    body: "Review the job, tailored materials, and every proposed answer. Approval here only unlocks the form-fill pass; it never submits by itself.",
    impact: { externalSubmission: false, jobId: pkg.job.id },
    payload: basePayload,
    resource: { jobId: pkg.job.id },
    material: basePayload,
    revision: currentTurn.revision,
    projectWait: projectedWait,
    executionAttempt: ctx.executionAttempt,
    signal: ctx.signal,
    prepareInTransaction: async tx => {
      if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()
      const identity = { userId: ctx.userId, jobId: pkg.job.id }
      await tx.applicationTask.upsert({
        where: { userId_jobId: identity },
        create: {
          ...identity,
          sessionId,
          status: "waiting_for_user",
          checkpoint: "materials_ready",
          resumeId: pkg.tailoredResumeId ?? ctx.defaultResume.id,
          coverLetterId: pkg.coverLetterId ?? null,
        },
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
          resumeId: pkg.tailoredResumeId ?? ctx.defaultResume.id,
          coverLetterId: pkg.coverLetterId ?? null,
          error: null,
          completedAt: null,
        },
      })
      const task = await tx.applicationTask.findUnique({ where: { userId_jobId: identity } })
      if (!task || refreshed.count !== 1) throw new AgentExecutionCancelledError()
      if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()

      const safe = redactAgentEvent({ type: "materials_ready", body: "Application materials are ready for user review." })
      await tx.applicationTaskEvent.create({
        data: {
          taskId: task.id,
          type: "materials_ready",
          actor: "reviewer",
          body: safe.body,
          data: safe.data as Prisma.InputJsonValue,
        },
      })
      if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()

      const payload = { ...basePayload, applicationTaskId: task.id }
      return { taskId: task.id, payload, material: payload }
    },
  })
  return {
    projectedWait,
    receipt: clientReceipt(result, { externalSubmission: false, jobId: pkg.job.id }),
  }
}
