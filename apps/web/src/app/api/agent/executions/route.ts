import { NextRequest } from "next/server"
import { AgentCommandError, AgentCommandService } from "@/lib/agent/control-plane/commands"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const sessionId = new URL(req.url).searchParams.get("sessionId")
  const executions = await db.agentExecution.findMany({
    where: { userId: auth.userId, ...(sessionId ? { sessionId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, sessionId: true, status: true, checkpoint: true, error: true, workerTaskId: true, attemptCount: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true },
  })
  return ok({ executions: executions.map(execution => ({
    ...execution,
    startedAt: execution.startedAt?.toISOString() ?? null,
    completedAt: execution.completedAt?.toISOString() ?? null,
    createdAt: execution.createdAt.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
  })) })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const params = new URL(req.url).searchParams
  let id = params.get("id")
  const sessionId = params.get("sessionId")
  if (!id && sessionId) {
    const execution = await db.agentExecution.findFirst({
      where: {
        userId: auth.userId,
        sessionId,
        status: { notIn: ["completed", "failed"] },
      },
      select: { id: true },
    })
    id = execution?.id ?? null
  }
  if (!id) return err(sessionId ? "No active execution found for this session" : "Execution id is required", 404)
  try {
    const cancelled = await new AgentCommandService(db).cancelExecution({
      executionId: id,
      userId: auth.userId,
      sessionId,
    })
    if (!cancelled) return err("Execution cannot be cancelled", 409)
    return ok({ cancelled: true })
  } catch (error: unknown) {
    if (error instanceof AgentCommandError) return err(error.message, error.status)
    throw error
  }
}
