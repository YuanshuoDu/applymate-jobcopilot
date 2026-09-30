import { NextRequest } from "next/server"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { applicationTaskSummary } from "@/lib/agent/application-task-view"
import { sanitizeConfirmedAnswers } from "@/lib/agent/application-task-input"
import { queueApplicationFill } from "@/lib/auto-apply"

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const tasks = await db.applicationTask.findMany({
    where: { userId: auth.userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      job: { select: { company: true, role: true, url: true, workflowState: true } },
      events: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  })
  return ok({ tasks, summary: applicationTaskSummary(tasks) })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return err("Task id is required", 400)
  const task = await db.applicationTask.findFirst({
    where: { id, userId: auth.userId },
    select: { id: true, sessionId: true, status: true, checkpoint: true },
  })
  if (!task) return err("Application task not found", 404)
  if (["submitted", "skipped", "cancelled"].includes(task.status) || ["submission_request_started", "submission_uncertain"].includes(task.checkpoint ?? "")) {
    return err("This application task cannot be cancelled", 409)
  }
  const cancelled = await db.$transaction(async tx => {
    const updated = await tx.applicationTask.updateMany({
      where: {
        id,
        userId: auth.userId,
        status: { notIn: ["submitted", "skipped", "cancelled"] },
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }],
      },
      data: { status: "cancelled", checkpoint: "cancelled_by_user", completedAt: new Date() },
    })
    if (updated.count !== 1) return false
    await tx.applicationTaskEvent.create({ data: { taskId: id, type: "cancelled", actor: "user", body: "User cancelled the application task." } })
    if (task.sessionId) {
      await tx.agentApproval.updateMany({
        where: {
          sessionId: task.sessionId,
          userId: auth.userId,
          type: "submit_application",
          status: "pending",
          payload: { path: ["applicationTaskId"], equals: id },
        },
        data: { status: "cancelled", decidedAt: new Date() },
      })
    }
    return true
  })
  if (!cancelled) return err("This application task changed and cannot be cancelled", 409)
  return ok({ cancelled: true })
}

/** Resume a paused fill pass after the user has supplied the requested facts. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const body = await req.json().catch(() => null) as { id?: unknown; action?: unknown; answers?: unknown } | null
  const id = typeof body?.id === "string" ? body.id : ""
  const action = body?.action
  if (!id || (action !== "resume_after_input" && action !== "answer_and_resume")) return err("A task id and supported resume action are required", 400)
  const task = await db.applicationTask.findFirst({
    where: { id, userId: auth.userId, status: "waiting_for_user", checkpoint: "form_answer_required" },
    include: { job: { select: { id: true, url: true } } },
  })
  if (!task) return err("This task is not waiting for new form information", 409)
  if (action === "answer_and_resume") {
    const answers = sanitizeConfirmedAnswers(task.question, body?.answers)
    if (!answers) return err("Provide a concise answer for at least one requested field", 400)
    const existing = task.confirmedAnswers && typeof task.confirmedAnswers === "object" && !Array.isArray(task.confirmedAnswers)
      ? task.confirmedAnswers as Record<string, string>
      : {}
    await db.$transaction(async tx => {
      await tx.applicationTask.update({ where: { id: task.id }, data: { confirmedAnswers: { ...existing, ...answers } as Prisma.InputJsonValue } })
      await tx.applicationTaskEvent.create({ data: {
        taskId: task.id,
        type: "user_answers_confirmed",
        actor: "user",
        body: "Candidate explicitly confirmed application-specific form answers.",
        // Keep the event useful for audit without copying the sensitive values
        // that are required by the worker to fill the form.
        data: { answeredFieldCount: Object.keys(answers).length } as Prisma.InputJsonValue,
      } })
    })
  }
  try {
    const queued = await queueApplicationFill({ userId: auth.userId, jobId: task.job.id, applyUrl: task.job.url, applicationTaskId: task.id, resumeAfterUserInput: true })
    return ok({ resumed: true, ...queued })
  } catch (error) {
    return err(error instanceof Error ? error.message : "Could not resume the application fill pass", 409)
  }
}
