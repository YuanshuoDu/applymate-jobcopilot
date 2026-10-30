import { parseTaskGraphSnapshot } from '@jobcopilot/agent-protocol'
import { NextRequest } from 'next/server'

import { isErrorResponse, ok, requireAuth } from '@/lib/api-helpers'
import { db } from '@/lib/db'
import { runWithTenantContext } from '@/lib/db/tenant-store'
import {
  canonicalTaskGraphItemId,
  isCanonicalTaskGraphSourceManifest,
  projectFinalTaskGraphSourceDetail,
} from '@/lib/agent/session/final-task-graph-source-detail'
import { parseFinalTaskGraphSourceManifest } from '@/lib/agent/session/final-task-graph-source-manifest'

export const dynamic = 'force-dynamic'

const FINAL_ITEM_SELECT = {
  id: true, sessionId: true, turnId: true, taskId: true, type: true, status: true, phase: true, content: true,
} as const
const TURN_SELECT = { id: true, sessionId: true, userId: true, status: true, rootTaskId: true } as const
const GRAPH_SELECT = { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true } as const
const TASK_SELECT = {
  id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, role: true, taskType: true,
  status: true, goal: true, result: true, failureReason: true, attemptCount: true, updatedAt: true,
} as const

interface RouteContext {
  params: Promise<{ id: string; itemId: string; sourceKey: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId, itemId, sourceKey } = await context.params
  if (!boundedId(sessionId) || !boundedId(itemId) || !/^src_[A-Za-z0-9_-]{43}$/.test(sourceKey)) return unavailable()
  return runWithTenantContext(auth.userId, () => resolveSource(auth.userId, sessionId, itemId, sourceKey))
}

async function resolveSource(userId: string, sessionId: string, finalItemId: string, sourceKey: string) {
  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId }, select: { id: true, userId: true } })
  if (!session) return unavailable()
  const finalItem = await db.agentItem.findFirst({
    where: { id: finalItemId, sessionId, type: 'agent_message', status: 'completed', phase: 'final_answer' },
    select: FINAL_ITEM_SELECT,
  })
  if (!finalItem || !boundedId(finalItem.turnId) || !boundedId(finalItem.taskId)) return unavailable()
  const turn = await db.agentTurn.findFirst({
    where: { id: finalItem.turnId, sessionId, userId }, select: TURN_SELECT,
  })
  if (!turn || turn.status !== 'completed' || turn.rootTaskId !== finalItem.taskId) return unavailable()
  const manifest = parseFinalTaskGraphSourceManifest(record(finalItem.content)?.taskGraphSources)
  if (!manifest || !isCanonicalTaskGraphSourceManifest(finalItemId, manifest)
    || manifest.sources.filter(source => source.sourceKey === sourceKey).length !== 1) return unavailable()

  const graphRows = await db.agentItem.findMany({
    where: { id: canonicalTaskGraphItemId(turn.rootTaskId), sessionId, turnId: turn.id, taskId: turn.rootTaskId,
      type: 'task_graph', revision: manifest.graphRevision },
    take: 2, select: GRAPH_SELECT,
  }) as unknown[]
  if (graphRows.length !== 1) return unavailable()
  const graph = record(graphRows[0])
  const snapshot = graph ? parseTaskGraphSnapshot(graph.content) : null
  if (!snapshot || snapshot.nodes.length < 1 || snapshot.nodes.length > 8) return unavailable()
  const taskIds = [turn.rootTaskId, ...snapshot.nodes.map(node => node.taskId)]
  if (new Set(taskIds).size !== taskIds.length) return unavailable()
  const taskRows = await db.subAgentTask.findMany({
    where: { sessionId, turnId: turn.id, rootTaskId: turn.rootTaskId, id: { in: taskIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: taskIds.length + 1, select: TASK_SELECT,
  }) as unknown[]
  const detail = projectFinalTaskGraphSourceDetail({
    userId, sessionId, finalItemId, sourceKey, session, finalItem, turn, graphRows, taskRows,
  })
  if (!detail) return unavailable()
  const response = ok({ task: detail })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

function unavailable(): Response {
  return Response.json({ error: { code: 'task_graph_source_unavailable', message: 'Related task details are unavailable.', details: {} } }, { status: 404 })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
