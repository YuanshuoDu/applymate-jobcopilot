import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { cancelAgentExecution } from "@/lib/agent/execution-control"

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
  const id = new URL(req.url).searchParams.get("id")
  if (!id) return err("Execution id is required", 400)
  const cancelled = await cancelAgentExecution({ id, userId: auth.userId })
  if (!cancelled) return err("Execution cannot be cancelled", 409)
  await db.agentSession.updateMany({
    where: { userId: auth.userId, execution: { is: { id } } },
    data: { status: "aborted", completedAt: new Date(), memorySummary: "Agent execution cancelled by user." },
  })
  return ok({ cancelled: true })
}
