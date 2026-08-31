import { NextRequest } from "next/server"

import { schemaVersion } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import {
  afterCursor,
  pageResult,
  parsePageRequest,
  sessionNotFound,
} from "../../query-helpers"
import { turnDto, type TurnQueryRow } from "../../query-dto"

interface RouteContext {
  params: Promise<{ id: string }>
}

const ACTIVE_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const page = parsePageRequest(request, "turns", sessionId)
  if (page instanceof Response) return page

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  const [rows, activeTurn, queuedInputCount] = await Promise.all([
    db.agentTurn.findMany({
      where: { sessionId, userId: auth.userId, ...afterCursor(page.cursor) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: page.limit + 1,
      select: {
        id: true, sessionId: true, source: true, status: true, revision: true, input: true,
        createdAt: true, updatedAt: true, completedAt: true,
        steps: {
          where: { status: { in: [...ACTIVE_STATUSES] } }, orderBy: [{ ordinal: "desc" }, { attempt: "desc" }], take: 1,
          select: { id: true },
        },
        items: {
          where: { type: "agent_message", phase: "final_answer", status: "completed" },
          orderBy: { createdAt: "desc" }, take: 1, select: { id: true },
        },
      },
    }),
    db.agentTurn.findFirst({
      where: { sessionId, userId: auth.userId, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" }, select: { id: true, status: true, revision: true },
    }),
    db.agentInput.count({ where: { sessionId, userId: auth.userId, status: "accepted", delivery: "follow_up" } }),
  ])
  const result = pageResult(rows as TurnQueryRow[], page, "turns", sessionId)
  return ok({
    schemaVersion,
    turns: result.rows.map(turnDto),
    page: result.page,
    projection: {
      activeTurnId: activeTurn?.id ?? null,
      activeTurn: activeTurn ? { id: activeTurn.id, status: activeTurn.status, revision: activeTurn.revision } : null,
      queuedInputCount,
    },
  })
}
