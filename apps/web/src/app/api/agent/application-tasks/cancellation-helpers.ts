import { Prisma } from "@prisma/client"
import { err } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { TaskInterruptError, TaskInterruptService } from "@/lib/agent/control-plane/commands/task-interrupt-service"

type FillTurnBinding = {
  sessionId: string | null
  fillTurnId: string | null
  fillTurnSessionId: string | null
  fillTurnUserId: string | null
}

type StoppedFill = FillTurnBinding & { status: string; checkpoint: string | null }
type ReplayCandidate = FillTurnBinding & { id: string }

export function hasBoundFillTurn(task: FillTurnBinding, userId: string): boolean {
  return Boolean(task.sessionId && task.fillTurnId && task.fillTurnSessionId === task.sessionId && task.fillTurnUserId === userId)
}

export function isStoppedFill(task: StoppedFill, userId: string): boolean {
  return task.status === "cancelled" && task.checkpoint === "turn_stopped_before_submit" && hasBoundFillTurn(task, userId)
}

export async function cancelPendingSubmitApprovals(
  tx: Prisma.TransactionClient, taskId: string, sessionId: string, userId: string,
): Promise<void> {
  await tx.agentApproval.updateMany({
    where: {
      sessionId, userId, type: "submit_application", status: "pending",
      payload: { path: ["applicationTaskId"], equals: taskId },
    },
    data: { status: "cancelled", decidedAt: new Date() },
  })
}

export async function lockStoppedFillReplay(
  tx: Prisma.TransactionClient, task: ReplayCandidate, userId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "application_tasks"
    WHERE "id" = ${task.id}
      AND "userId" = ${userId}
      AND "sessionId" = ${task.sessionId}
      AND "fillTurnId" = ${task.fillTurnId}
      AND "fillTurnSessionId" = ${task.fillTurnSessionId}
      AND "fillTurnUserId" = ${task.fillTurnUserId}
      AND "status" = ${"cancelled"}
      AND "checkpoint" = ${"turn_stopped_before_submit"}
    FOR UPDATE
  `)
  return rows.length === 1
}

export async function interruptBoundFiller(
  task: { id: string; sessionId: string; fillTurnId: string }, userId: string,
): Promise<Response | null> {
  const fillers = await db.subAgentTask.findMany({
    where: { sessionId: task.sessionId, turnId: task.fillTurnId, role: "application_filler", taskType: "application_fill_for_review" },
    select: { id: true, status: true },
  })
  if (fillers.length > 1) return err("Multiple application fillers are bound to this Turn", 409)
  const filler = fillers[0]
  if (!filler) return null
  if (["completed", "failed", "interrupted", "cancelled", "closed"].includes(filler.status)) return null
  if (!["queued", "running", "retrying", "waiting", "waiting_for_user"].includes(filler.status)) {
    return err("The application filler is in an unrecognized state and cannot be cancelled safely", 409)
  }
  try {
    await new TaskInterruptService(db).interrupt({
      sessionId: task.sessionId, taskId: filler.id, userId,
      clientMessageId: `application-task-cancel:${task.id}:${task.fillTurnId}`,
    })
    return null
  } catch (error) {
    if (error instanceof TaskInterruptError) return err(error.message, error.status)
    return err("Could not persist an interrupt for the active application filler", 500)
  }
}
