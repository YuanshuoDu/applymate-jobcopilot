import { Prisma } from "@prisma/client"

import { db } from "@/lib/db"
import { enqueueApplyTask } from "@/lib/apply-queue-client"
import { hasObjectiveApplicationFillReservation } from "@/lib/agent/control-plane/commands/application-fill-preflight"
import { AutoApplyError } from "./auto-apply-guards"

const NOT_READY = "This application is no longer ready for the form-fill review pass."

export async function queueLegacyApplicationFill(input: {
  userId: string
  jobId: string
  applicationTaskId: string
  applyUrl: string
  resumeAfterUserInput?: boolean
}): Promise<{ taskId: string }> {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; sessionId: string | null }>>(Prisma.sql`
      SELECT "id", "sessionId" FROM "application_tasks"
      WHERE "id" = ${input.applicationTaskId} AND "userId" = ${input.userId} AND "jobId" = ${input.jobId}
      FOR UPDATE
    `)
    if (rows.length !== 1 || !rows[0]) return false
    const sessionId = rows[0].sessionId ?? ""
    if (await hasObjectiveApplicationFillReservation(tx, {
      applicationTaskId: input.applicationTaskId, userId: input.userId, sessionId,
    })) return false
    const update = await tx.applicationTask.updateMany({
      where: {
        id: input.applicationTaskId,
        userId: input.userId,
        jobId: input.jobId,
        status: "waiting_for_user",
        checkpoint: input.resumeAfterUserInput ? "form_answer_required" : "materials_ready",
      },
      data: { status: "filling", checkpoint: "form_fill_queued", question: Prisma.DbNull, startedAt: new Date() },
    })
    return update.count === 1
  })
  if (!claimed) throw new AutoApplyError(NOT_READY)

  try {
    const taskId = await enqueueApplyTask({
      applicationTaskId: input.applicationTaskId, jobId: input.jobId, userId: input.userId,
      applyUrl: input.applyUrl, operation: "fill",
    })
    await db.applicationTask.update({ where: { id: input.applicationTaskId }, data: { workerTaskId: taskId } })
    await db.applicationTaskEvent.create({ data: {
      taskId: input.applicationTaskId, type: "form_fill_queued", actor: "reviewer",
      body: "Material review approved; worker will fill the form without submitting it.", data: { workerTaskId: taskId },
    } })
    return { taskId }
  } catch (error) {
    await db.applicationTask.updateMany({
      where: { id: input.applicationTaskId, status: "filling", checkpoint: "form_fill_queued" },
      data: { status: "waiting_for_user", checkpoint: "materials_ready" },
    }).catch(() => undefined)
    throw error
  }
}
