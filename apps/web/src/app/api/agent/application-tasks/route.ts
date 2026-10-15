import { NextRequest } from "next/server"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { applicationTaskSummary } from "@/lib/agent/application-task-view"
import { sanitizeConfirmedAnswers } from "@/lib/agent/application-task-input"
import { applicationFillTaskGraphEnabled, queueApplicationFill } from "@/lib/auto-apply"
import {
  cancelPendingSubmitApprovals,
  hasBoundFillTurn,
  interruptBoundFiller,
  isStoppedFill,
  lockStoppedFillReplay,
} from "./cancellation-helpers"

type ResumeTask = {
  id: string; sessionId: string | null; fillTurnId: string | null
  fillTurnSessionId: string | null; fillTurnUserId: string | null; status: string
  checkpoint: string | null; question: Prisma.JsonValue | null; confirmedAnswers: Prisma.JsonValue | null; job: { id: string; url: string | null }
}

function confirmedAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function answersMatchPersisted(answers: Record<string, string>, value: unknown): boolean {
  const persisted = confirmedAnswers(value)
  return Object.entries(answers).every(([field, answer]) => persisted[field] === answer)
}

function questionWaitId(value: unknown): string | null {
  const waitId = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).waitId : null
  return typeof waitId === "string" && waitId.trim() ? waitId : null
}

async function queueTaskGraphResume(
  task: ResumeTask, userId: string, duplicateOnly = false,
): Promise<Response> {
  try {
    const queued = await queueApplicationFill({
      userId, jobId: task.job.id, applyUrl: task.job.url, applicationTaskId: task.id,
      sessionId: task.sessionId!, resumeAfterUserInput: true,
    })
    if (duplicateOnly && queued.disposition !== "duplicate") return err("The application fill changed before the duplicate request was resolved", 409)
    return ok({ resumed: true, ...(duplicateOnly ? { duplicate: true } : {}), ...queued })
  } catch (error) {
    return err(error instanceof Error ? error.message : "Could not resume the application fill pass", 409)
  }
}

async function returnTaskGraphResumeDuplicate(task: ResumeTask, userId: string, waitId: string, answers?: Record<string, string>): Promise<Response> {
  if (!hasBoundFillTurn(task, userId)) return err("This application has no scoped TaskGraph fill Turn to resume", 409)
  if (questionWaitId(task.question) !== waitId) return err("This form-answer wait has changed; refresh before answering", 409)
  if (answers && !answersMatchPersisted(answers, task.confirmedAnswers)) return err("The submitted answers do not match the answers already saved for this fill", 409)
  return queueTaskGraphResume(task, userId, true)
}

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
    select: {
      id: true, sessionId: true, status: true, checkpoint: true,
      fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true,
    },
  })
  if (!task) return err("Application task not found", 404)
  if (task.status === "cancelled") {
    if (!isStoppedFill(task, auth.userId)) return err("This application task cannot be cancelled", 409)
    const replayed = await db.$transaction(async tx => {
      if (!await lockStoppedFillReplay(tx, task, auth.userId)) return false
      await cancelPendingSubmitApprovals(tx, id, task.sessionId!, auth.userId)
      return true
    })
    if (!replayed) return err("This application task changed and cannot be cancelled", 409)
    return ok({ cancelled: true })
  }
  if (["submitted", "skipped"].includes(task.status) || ["submission_request_started", "submission_uncertain"].includes(task.checkpoint ?? "")) {
    return err("This application task cannot be cancelled", 409)
  }
  const taskGraphCancel = typeof task.fillTurnId === "string" && ["filling", "waiting_for_user"].includes(task.status)
  if (taskGraphCancel) {
    if (!task.sessionId || task.fillTurnSessionId !== task.sessionId || task.fillTurnUserId !== auth.userId) {
      return err("The active application fill has no scoped TaskGraph Turn", 409)
    }
    const interrupt = await interruptBoundFiller({ id: task.id, sessionId: task.sessionId, fillTurnId: task.fillTurnId! }, auth.userId)
    if (interrupt) return interrupt
  }
  const cancelled = await db.$transaction(async tx => {
    const updated = await tx.applicationTask.updateMany({
      where: {
        id,
        userId: auth.userId,
        sessionId: task.sessionId,
        fillTurnId: task.fillTurnId,
        fillTurnSessionId: task.fillTurnSessionId,
        fillTurnUserId: task.fillTurnUserId,
        status: { notIn: ["submitted", "skipped", "cancelled"] },
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }],
      },
      data: { status: "cancelled", checkpoint: "cancelled_by_user", completedAt: new Date() },
    })
    if (updated.count !== 1) {
      if (!taskGraphCancel || !await lockStoppedFillReplay(tx, task, auth.userId)) return false
    } else {
      await tx.applicationTaskEvent.create({ data: { taskId: id, type: "cancelled", actor: "user", body: "User cancelled the application task." } })
    }
    if (task.sessionId) {
      await cancelPendingSubmitApprovals(tx, id, task.sessionId, auth.userId)
    }
    return true
  })
  if (!cancelled) return err("This application task changed and cannot be cancelled", 409)
  if (taskGraphCancel && task.sessionId && task.fillTurnId) {
    const interrupt = await interruptBoundFiller({ id: task.id, sessionId: task.sessionId, fillTurnId: task.fillTurnId }, auth.userId)
    if (interrupt) return interrupt
  }
  return ok({ cancelled: true })
}

/** Resume a paused fill pass after the user has supplied the requested facts. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const body = await req.json().catch(() => null) as { id?: unknown; action?: unknown; waitId?: unknown; answers?: unknown } | null
  const id = typeof body?.id === "string" ? body.id : ""
  const action = body?.action
  if (!id || (action !== "resume_after_input" && action !== "answer_and_resume")) return err("A task id and supported resume action are required", 400)
  const taskGraph = applicationFillTaskGraphEnabled()
  const task = await db.applicationTask.findFirst({
    where: taskGraph ? { id, userId: auth.userId } : { id, userId: auth.userId, status: "waiting_for_user", checkpoint: "form_answer_required" },
    include: { job: { select: { id: true, url: true } } },
  })
  if (!task) return err("This task is not waiting for new form information", 409)
  if (!taskGraph && task.fillTurnId !== null) return err("This bound TaskGraph fill cannot resume while TaskGraph routing is disabled", 409)
  const waitId = typeof body?.waitId === "string" ? body.waitId : ""
  if (taskGraph && (!waitId || questionWaitId(task.question) !== waitId)) return err("This form-answer wait has changed; refresh before answering", 409)
  const answers = action === "answer_and_resume" ? sanitizeConfirmedAnswers(task.question, body?.answers) : null
  if (action === "answer_and_resume" && !answers) return err("Provide a concise answer for at least one requested field", 400)

  if (taskGraph) {
    const resumeTask = task as ResumeTask
    if (task.status !== "waiting_for_user" || task.checkpoint !== "form_answer_required") {
      return returnTaskGraphResumeDuplicate(resumeTask, auth.userId, waitId, answers ?? undefined)
    }
    if (!hasBoundFillTurn(resumeTask, auth.userId)) return err("This application has no scoped TaskGraph fill Turn to resume", 409)

    if (answers && !answersMatchPersisted(answers, task.confirmedAnswers)) {
      const merged = { ...confirmedAnswers(task.confirmedAnswers), ...answers }
      const saved = await db.$transaction(async tx => {
        const updated = await tx.applicationTask.updateMany({
          where: {
            id: task.id, userId: auth.userId, sessionId: task.sessionId,
            status: "waiting_for_user", checkpoint: "form_answer_required",
            fillTurnId: task.fillTurnId, fillTurnSessionId: task.fillTurnSessionId, fillTurnUserId: task.fillTurnUserId,
            question: { path: ["waitId"], equals: waitId },
            confirmedAnswers: { equals: task.confirmedAnswers === null ? Prisma.DbNull : task.confirmedAnswers as Prisma.InputJsonValue },
          },
          data: { confirmedAnswers: merged as Prisma.InputJsonValue },
        })
        if (updated.count !== 1) return false
        await tx.applicationTaskEvent.create({ data: {
          taskId: task.id,
          type: "user_answers_confirmed",
          actor: "user",
          body: "Candidate explicitly confirmed application-specific form answers.",
          // Keep the event useful for audit without copying the sensitive values
          // that are required by the worker to fill the form.
          data: { answeredFieldCount: Object.keys(answers).length } as Prisma.InputJsonValue,
        } })
        return true
      })
      if (!saved) {
        const current = await db.applicationTask.findFirst({ where: { id, userId: auth.userId }, include: { job: { select: { id: true, url: true } } } })
        if (current?.status === "waiting_for_user" && current.checkpoint === "form_answer_required"
          && current.fillTurnId === task.fillTurnId && current.fillTurnSessionId === task.fillTurnSessionId && current.fillTurnUserId === task.fillTurnUserId && questionWaitId(current.question) === waitId
          && answersMatchPersisted(answers, current.confirmedAnswers)) {
          return queueTaskGraphResume(current as ResumeTask, auth.userId)
        }
        if (current?.status === "filling" && current.checkpoint === "taskgraph_fill_queued") {
          return returnTaskGraphResumeDuplicate(current as ResumeTask, auth.userId, waitId, answers)
        }
        return err("This task changed before the requested answers could be saved", 409)
      }
    }

    try {
      const queued = await queueApplicationFill({
        userId: auth.userId, jobId: task.job.id, applyUrl: task.job.url, applicationTaskId: task.id,
        sessionId: task.sessionId!, resumeAfterUserInput: true,
      })
      return ok({ resumed: true, ...queued })
    } catch (error) {
      return err(error instanceof Error ? error.message : "Could not resume the application fill pass", 409)
    }
  }

  // Preserve the legacy ApplyQueue behavior while TaskGraph routing is disabled.
  if (action === "answer_and_resume") {
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
        data: { answeredFieldCount: Object.keys(answers ?? {}).length } as Prisma.InputJsonValue,
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
