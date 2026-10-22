import { NextRequest } from "next/server"
import type { Prisma } from "@prisma/client"

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

const TURN_SELECT = {
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
} satisfies Prisma.AgentTurnSelect

function activeTurnProjection(row: TurnQueryRow | null) {
  if (!row) return null
  const input = row.input && typeof row.input === "object" && !Array.isArray(row.input)
    ? row.input as Record<string, unknown>
    : null
  const hasCanonicalGoal = typeof input?.goal === "string" && Boolean(input.goal.trim())
  const projected = turnDto(row)
  return {
    id: projected.id,
    status: projected.status,
    revision: projected.revision,
    ...(hasCanonicalGoal ? { goal: projected.goal } : {}),
  }
}

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
      select: TURN_SELECT,
    }),
    db.agentTurn.findFirst({
      where: { sessionId, userId: auth.userId, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { createdAt: "asc" }, select: TURN_SELECT,
    }),
    db.agentInput.count({ where: { sessionId, userId: auth.userId, status: "accepted", delivery: "follow_up" } }),
  ])
  const result = pageResult(rows as TurnQueryRow[], page, "turns", sessionId)
  const activeProjection = activeTurnProjection(activeTurn as TurnQueryRow | null)
  return ok({
    schemaVersion,
    turns: result.rows.map(turnDto),
    page: result.page,
    projection: {
      activeTurnId: activeProjection?.id ?? null,
      activeTurn: activeProjection,
      queuedInputCount,
    },
  })
}
