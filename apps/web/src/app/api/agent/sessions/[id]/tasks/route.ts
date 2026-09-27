import { NextRequest } from "next/server"
import { projectPlanLedger } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  afterCursor,
  pageResult,
  parsePageRequest,
  sessionNotFound,
} from "../../query-helpers"
import { taskDto, type TaskQueryRow } from "../../query-dto"

const MAX_REFERENCED_TASK_IDS = 9
const MAX_TASK_ID_LENGTH = 128

const TASK_SELECT = {
  id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, path: true,
  role: true, taskType: true, status: true, goal: true, confidence: true,
  failureReason: true, result: true, createdAt: true, updatedAt: true,
} as const

function parseTaskIdLookup(request: Request): string[] | Response | null {
  const ids = new URL(request.url).searchParams.getAll("taskId")
  if (ids.length === 0) return null
  if (ids.length > MAX_REFERENCED_TASK_IDS || ids.some((id) => id.length < 1 || id.length > MAX_TASK_ID_LENGTH || id.trim() !== id)
    || new Set(ids).size !== ids.length) {
    return Response.json({ error: { code: "invalid_task_ids", message: "taskId values must be unique and bounded", details: {} } }, { status: 400 })
  }
  return ids
}

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const page = parsePageRequest(request, "tasks", sessionId)
  if (page instanceof Response) return page
  const taskIds = parseTaskIdLookup(request)
  if (taskIds instanceof Response) return taskIds

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  if (taskIds) {
    const [rows, graph] = await Promise.all([db.subAgentTask.findMany({
      where: { sessionId, id: { in: taskIds } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: taskIds.length,
      select: TASK_SELECT,
    }), db.agentItem.findFirst({
      where: { sessionId, type: "task_graph" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { taskId: true, revision: true, content: true },
    })])
    const tasks = (rows as TaskQueryRow[]).map(taskDto)
    const requestedRevision = new URL(request.url).searchParams.get("graphRevision")
    const planLedger = graph && (requestedRevision === null || requestedRevision === String(graph.revision))
      ? projectPlanLedger({ sessionId, revision: graph.revision, rootTaskId: graph.taskId, graph: graph.content, tasks })
      : null
    return ok({ tasks, ...(planLedger ? { planLedger } : {}), page: { hasMore: false, nextCursor: null } })
  }

  const rows = await db.subAgentTask.findMany({
    where: { sessionId, ...afterCursor(page.cursor) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    select: TASK_SELECT,
  })
  const result = pageResult(rows as TaskQueryRow[], page, "tasks", sessionId)
  return ok({ tasks: result.rows.map(taskDto), page: result.page })
}
