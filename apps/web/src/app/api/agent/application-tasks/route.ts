import { NextRequest } from "next/server"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { db } from "@/lib/db"
import { applicationTaskSummary } from "@/lib/agent/application-task-view"

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
  const task = await db.applicationTask.findFirst({ where: { id, userId: auth.userId }, select: { id: true, status: true } })
  if (!task) return err("Application task not found", 404)
  if (["submitted", "cancelled"].includes(task.status)) return err("This application task cannot be cancelled", 409)
  await db.$transaction([
    db.applicationTask.update({ where: { id }, data: { status: "cancelled", checkpoint: "cancelled_by_user", completedAt: new Date() } }),
    db.applicationTaskEvent.create({ data: { taskId: id, type: "cancelled", actor: "user", body: "User cancelled the application task." } }),
  ])
  return ok({ cancelled: true })
}
