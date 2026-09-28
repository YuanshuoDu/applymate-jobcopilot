import { NextRequest } from "next/server"
import { parseTaskGraphSnapshot, projectPlanLedger } from "@jobcopilot/agent-protocol"

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

interface TaskGraphLookupIdentity {
  graphItemId: string
  turnId: string
  rootTaskId: string
  revision: number
}

interface PersistedTaskGraph {
  id: string
  sessionId: string
  turnId: string | null
  taskId: string | null
  revision: number
  content: unknown
}

type TaskGraphLookup =
  | { kind: "identified"; identity: TaskGraphLookupIdentity }
  | { kind: "legacy"; revision: number }

function invalidTaskGraphIdentity(message: string): Response {
  return Response.json({ error: { code: "invalid_task_graph_identity", message, details: {} } }, { status: 400 })
}

function parseTaskGraphLookup(request: Request): TaskGraphLookup | Response | null {
  const params = new URL(request.url).searchParams
  const names = ["graphItemId", "graphTurnId", "rootTaskId", "graphRevision"]
  const values = names.map((name) => params.getAll(name))
  if (values.every(([value]) => value === undefined)) return null

  const [graphItemIds, turnIds, rootTaskIds, revisions] = values
  if (graphItemIds.length === 0 && turnIds.length === 0 && rootTaskIds.length === 0) {
    if (revisions.length !== 1 || !revisions[0]) return invalidTaskGraphIdentity("Legacy TaskGraph lookup requires one graphRevision")
    const revision = Number(revisions[0])
    if (!Number.isSafeInteger(revision) || revision < 1 || String(revision) !== revisions[0]) {
      return invalidTaskGraphIdentity("TaskGraph revision must be a positive integer")
    }
    return { kind: "legacy", revision }
  }

  if (values.some((entries) => entries.length !== 1 || !entries[0])) {
    return invalidTaskGraphIdentity("TaskGraph selectors must be supplied once as a complete set")
  }
  const [graphItemId, turnId, rootTaskId, revisionText] = values.map(([value]) => value!)
  const revision = Number(revisionText)
  if ([graphItemId, turnId, rootTaskId].some((value) => value.length > MAX_TASK_ID_LENGTH || value.trim() !== value)
    || !Number.isSafeInteger(revision) || revision < 1 || String(revision) !== revisionText) {
    return invalidTaskGraphIdentity("TaskGraph selectors must be bounded and valid")
  }
  return { kind: "identified", identity: { graphItemId, turnId, rootTaskId, revision } }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  return leftSet.size === left.length && leftSet.size === right.length && right.every((id) => leftSet.has(id))
}

function persistedGraphTaskIds(graph: PersistedTaskGraph): string[] | null {
  const snapshot = parseTaskGraphSnapshot(graph.content)
  if (!snapshot || snapshot.nodes.length === 0 || !graph.taskId || !graph.turnId
    || graph.id.length < 1 || graph.id.length > MAX_TASK_ID_LENGTH || graph.id.trim() !== graph.id
    || graph.turnId.length > MAX_TASK_ID_LENGTH || graph.turnId.trim() !== graph.turnId
    || graph.taskId.length > MAX_TASK_ID_LENGTH || graph.taskId.trim() !== graph.taskId) return null
  return [...new Set([graph.taskId, ...snapshot.nodes.map((node) => node.taskId)])]
}

function matchesLegacyTaskGraph(graph: PersistedTaskGraph, sessionId: string, revision: number, taskIds: readonly string[]): boolean {
  const graphTaskIds = persistedGraphTaskIds(graph)
  return graph.sessionId === sessionId && graph.revision === revision && graphTaskIds !== null && sameIds(taskIds, graphTaskIds)
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
  const graphLookup = parseTaskGraphLookup(request)
  if (graphLookup instanceof Response) return graphLookup
  if (graphLookup && !taskIds) {
    return Response.json({ error: { code: "task_graph_ids_required", message: "TaskGraph lookup requires referenced task IDs", details: {} } }, { status: 400 })
  }

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  if (taskIds) {
    let graph: PersistedTaskGraph | null = null
    if (graphLookup?.kind === "identified") {
      const { identity } = graphLookup
      graph = await db.agentItem.findFirst({
        where: { id: identity.graphItemId, sessionId, type: "task_graph" },
        select: { id: true, sessionId: true, turnId: true, taskId: true, revision: true, content: true },
      })
      const graphTaskIds = graph ? persistedGraphTaskIds(graph) : null
      if (!graph || graph.id !== identity.graphItemId || graph.sessionId !== sessionId
        || graph.turnId !== identity.turnId || graph.taskId !== identity.rootTaskId
        || graph.revision !== identity.revision || !graphTaskIds || !sameIds(taskIds, graphTaskIds)) {
        return ok({ tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
      }
    } else if (graphLookup?.kind === "legacy") {
      const candidates = await db.agentItem.findMany({
        where: { sessionId, type: "task_graph", revision: graphLookup.revision },
        select: { id: true, sessionId: true, turnId: true, taskId: true, revision: true, content: true },
        take: 2,
      })
      const revisionCandidates = candidates as PersistedTaskGraph[]
      if (revisionCandidates.length !== 1
        || !matchesLegacyTaskGraph(revisionCandidates[0], sessionId, graphLookup.revision, taskIds)) {
        return ok({ tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
      }
      graph = revisionCandidates[0]
    }

    if (graph) {
      const graphTaskIds = persistedGraphTaskIds(graph)
      if (!graphTaskIds || !graph.turnId || !graph.taskId) {
        return ok({ tasks: [], planLedger: null, page: { hasMore: false, nextCursor: null } })
      }
      const rows = await db.subAgentTask.findMany({
        where: { sessionId, turnId: graph.turnId, rootTaskId: graph.taskId, id: { in: graphTaskIds } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: graphTaskIds.length,
        select: TASK_SELECT,
      })
      const scopedRows = (rows as TaskQueryRow[]).filter((row) => row.sessionId === sessionId && row.turnId === graph.turnId
        && row.rootTaskId === graph.taskId && graphTaskIds.includes(row.id))
      const tasks = scopedRows.map(taskDto)
      const projection = projectPlanLedger({ sessionId, revision: graph.revision, rootTaskId: graph.taskId, graph: graph.content, tasks })
      const planLedger = projection ? {
        identity: { sessionId, graphItemId: graph.id, turnId: graph.turnId, rootTaskId: graph.taskId, revision: graph.revision },
        projection,
      } : null
      return ok({ tasks, planLedger, page: { hasMore: false, nextCursor: null } })
    }

    const rows = await db.subAgentTask.findMany({
      where: { sessionId, id: { in: taskIds } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: taskIds.length,
      select: TASK_SELECT,
    })
    const tasks = (rows as TaskQueryRow[]).map(taskDto)
    return ok({ tasks, page: { hasMore: false, nextCursor: null } })
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
