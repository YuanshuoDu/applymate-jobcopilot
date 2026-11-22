import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

import { schemaVersion, TurnIntentSchema, validate } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { objectiveLocationVerificationEnabled } from "@/lib/agent/control-plane/commands/types"
import { readActiveTurnLocationScope, type ActiveTurnLocationScopeProjection } from "@/lib/agent/session/active-turn-location-scope"

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
  id: true, sessionId: true, source: true, executionMode: true, status: true, revision: true, input: true,
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

const ACTIVE_TURN_SELECT = { ...TURN_SELECT, executionMode: true, rootTaskId: true } satisfies Prisma.AgentTurnSelect
type ActiveTurnQueryRow = TurnQueryRow & Readonly<{ executionMode: string | null; rootTaskId: string | null }>

function hasObjectiveTaskGraphIntent(value: unknown): boolean {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  const intent = input?.intent
  return validate(TurnIntentSchema, intent) && !!intent && typeof intent === "object" && !Array.isArray(intent)
    && "kind" in intent && intent.kind === "objective_task_graph_execution"
}

function activeTurnProjection(row: ActiveTurnQueryRow | null, locationScope: ActiveTurnLocationScopeProjection | null) {
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
    ...(projected.selectedJobBatchPreparation ? { selectedJobBatchPreparation: true as const } : {}),
    ...(hasCanonicalGoal ? { goal: projected.goal } : {}),
    ...(objectiveLocationVerificationEnabled() && row.source === "user" && row.executionMode === "canonical_task_graph"
      && typeof row.rootTaskId === "string" && Boolean(row.rootTaskId.trim()) && hasObjectiveTaskGraphIntent(row.input)
      && (row.status === "in_progress" || row.status === "waiting_for_dependency") ? { canSteerLocation: true as const } : {}),
    ...(locationScope ? { locationScope } : {}),
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

  const [rows, activeState, queuedInputCount] = await Promise.all([
    db.agentTurn.findMany({
      where: { sessionId, userId: auth.userId, ...afterCursor(page.cursor) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: page.limit + 1,
      select: TURN_SELECT,
    }),
    db.$transaction(async tx => {
      const activeTurn = await tx.agentTurn.findFirst({
        where: { sessionId, userId: auth.userId, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: "asc" }, select: ACTIVE_TURN_SELECT,
      })
      const activeRow = activeTurn as ActiveTurnQueryRow | null
      const canProjectLocationScope = objectiveLocationVerificationEnabled() && activeRow?.source === "user"
        && activeRow.executionMode === "canonical_task_graph" && typeof activeRow.rootTaskId === "string"
        && Boolean(activeRow.rootTaskId.trim()) && hasObjectiveTaskGraphIntent(activeRow.input)
        && (activeRow.status === "in_progress" || activeRow.status === "waiting_for_dependency")
      const locationScope = canProjectLocationScope ? await readActiveTurnLocationScope(tx, {
        userId: auth.userId, sessionId, turnId: activeRow.id, rootTaskId: activeRow.rootTaskId,
      }) : null
      return { activeRow, locationScope }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
    db.agentInput.count({ where: { sessionId, userId: auth.userId, status: "accepted", delivery: "follow_up" } }),
  ])
  const result = pageResult(rows as TurnQueryRow[], page, "turns", sessionId)
  const activeProjection = activeTurnProjection(activeState.activeRow, activeState.locationScope)
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
