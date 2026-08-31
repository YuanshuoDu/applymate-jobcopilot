import { NextRequest } from "next/server"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  afterCursor,
  pageResult,
  parsePageRequest,
  sessionNotFound,
} from "../../query-helpers"
import { taskDto, type TaskQueryRow } from "../../query-dto"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const page = parsePageRequest(request, "tasks", sessionId)
  if (page instanceof Response) return page

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  const rows = await db.subAgentTask.findMany({
    where: { sessionId, ...afterCursor(page.cursor) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    select: {
      id: true, sessionId: true, role: true, taskType: true, status: true, goal: true, confidence: true,
      failureReason: true, result: true, createdAt: true, updatedAt: true,
    },
  })
  const result = pageResult(rows as TaskQueryRow[], page, "tasks", sessionId)
  return ok({ tasks: result.rows.map(taskDto), page: result.page })
}
