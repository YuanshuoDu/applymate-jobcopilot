import { NextRequest } from "next/server"
import type { Prisma } from "@prisma/client"

import { schemaVersion } from "@jobcopilot/agent-protocol"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import { isScheduledTaskGraphSourceChangeTerminal } from "@/lib/agent/scheduled-taskgraph-source-change-terminal"
import { scheduledMaterialDriftGateTaskId, scheduledMaterialDriftRecoveryReason } from "@/lib/agent/scheduled-taskgraph-gate-material-drift-projection"

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
const SOURCE_CHANGE_RECOVERY_REASON = "scheduled_pipeline_source_changed" as const
const MATERIAL_DRIFT_GATE_TERMINAL_STATUSES = ["failed", "interrupted"] as const

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

function objectRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function sourceChangeRecoveryReason(input: {
  userId: string; sessionId: string; activeTurn: Promise<{ id: string } | null>
}): Promise<typeof SOURCE_CHANGE_RECOVERY_REASON | null> {
  const [execution, activeTurn] = await Promise.all([
    db.agentExecution.findFirst({
      where: { userId: input.userId, sessionId: input.sessionId },
      select: { id: true, status: true, error: true, state: true, attemptCount: true },
    }),
    input.activeTurn,
  ])
  if (!execution || execution.status !== "failed" || execution.error !== SOURCE_CHANGE_RECOVERY_REASON) return null

  const marker = objectRow(objectRow(execution.state)?.scheduledTaskGraphSourceChangeTerminal)
  const markerOwner = objectRow(marker?.owner)
  const turnId = typeof markerOwner?.turnId === "string" ? markerOwner.turnId : null
  if (!turnId) return null

  const turn = await db.agentTurn.findFirst({
    where: { id: turnId, userId: input.userId, sessionId: input.sessionId },
    select: { id: true, source: true, status: true, executionMode: true, rootTaskId: true, input: true },
  })
  if (!turn || !turn.rootTaskId || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
    || !["waiting_for_dependency", "interrupted"].includes(turn.status)
    || objectRow(turn.input)?.automationRunMode !== "scheduled") return null

  const [root, newestTurn] = await Promise.all([
    db.subAgentTask.findFirst({
      where: { id: turn.rootTaskId, sessionId: input.sessionId, turnId: turn.id, rootTaskId: turn.rootTaskId,
        parentTaskId: null, role: "orchestrator", taskType: "root" },
      select: { id: true, attemptCount: true },
    }),
    db.agentTurn.findFirst({
      where: { userId: input.userId, sessionId: input.sessionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true },
    }),
  ])
  if (!root || newestTurn?.id !== turn.id || activeTurn && activeTurn.id !== turn.id) return null

  const owner = {
    userId: input.userId, sessionId: input.sessionId, turnId: turn.id, rootTaskId: root.id,
    rootAttemptCount: root.attemptCount, executionId: execution.id, executionAttemptCount: execution.attemptCount,
  }
  return isScheduledTaskGraphSourceChangeTerminal({ owner, status: execution.status, error: execution.error, state: execution.state })
    ? SOURCE_CHANGE_RECOVERY_REASON
    : null
}

async function materialDriftRecoveryReason(input: {
  userId: string; sessionId: string; activeTurn: Promise<{ id: string } | null>
}) {
  const [execution, activeTurn, newestTurn] = await Promise.all([
    db.agentExecution.findFirst({
      where: { userId: input.userId, sessionId: input.sessionId },
      select: { id: true, userId: true, sessionId: true, status: true, error: true, state: true, attemptCount: true },
    }),
    input.activeTurn,
    db.agentTurn.findFirst({
      where: { userId: input.userId, sessionId: input.sessionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, userId: true, sessionId: true, status: true, source: true, executionMode: true,
        rootTaskId: true, input: true, leaseVersion: true },
    }),
  ])
  const gateTaskId = execution && scheduledMaterialDriftGateTaskId(execution.state)
  if (!execution || !newestTurn?.rootTaskId || !gateTaskId) return null

  const taskSelect = { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true,
    depth: true, role: true, taskType: true, status: true, attemptCount: true } satisfies Prisma.SubAgentTaskSelect
  const [root, gate] = await Promise.all([
    db.subAgentTask.findFirst({
      where: { id: newestTurn.rootTaskId, sessionId: input.sessionId, turnId: newestTurn.id,
        rootTaskId: newestTurn.rootTaskId, parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root",
        session: { userId: input.userId } },
      select: taskSelect,
    }),
    db.subAgentTask.findFirst({
      where: { id: gateTaskId, sessionId: input.sessionId, turnId: newestTurn.id,
        rootTaskId: newestTurn.rootTaskId, parentTaskId: newestTurn.rootTaskId, depth: 1,
        role: "prepare", taskType: "scheduled_taskgraph_gate", status: { in: [...MATERIAL_DRIFT_GATE_TERMINAL_STATUSES] },
        session: { userId: input.userId } },
      select: taskSelect,
    }),
  ])
  return scheduledMaterialDriftRecoveryReason({ userId: input.userId, sessionId: input.sessionId,
    activeTurnId: activeTurn?.id ?? null, newestTurnId: newestTurn.id, turn: newestTurn, root, gate, execution })
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth
  const { id: sessionId } = await context.params
  const page = parsePageRequest(request, "turns", sessionId)
  if (page instanceof Response) return page

  const session = await db.agentSession.findFirst({ where: { id: sessionId, userId: auth.userId }, select: { id: true } })
  if (!session) return sessionNotFound()

  const activeTurnQuery = db.agentTurn.findFirst({
    where: { sessionId, userId: auth.userId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "asc" }, select: TURN_SELECT,
  })
  const [rows, activeTurn, queuedInputCount, sourceChangeReason, materialDriftReason] = await Promise.all([
    db.agentTurn.findMany({
      where: { sessionId, userId: auth.userId, ...afterCursor(page.cursor) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: page.limit + 1,
      select: TURN_SELECT,
    }),
    activeTurnQuery,
    db.agentInput.count({ where: { sessionId, userId: auth.userId, status: "accepted", delivery: "follow_up" } }),
    sourceChangeRecoveryReason({ userId: auth.userId, sessionId, activeTurn: activeTurnQuery }),
    materialDriftRecoveryReason({ userId: auth.userId, sessionId, activeTurn: activeTurnQuery }),
  ])
  const result = pageResult(rows as TurnQueryRow[], page, "turns", sessionId)
  const activeProjection = activeTurnProjection(activeTurn as TurnQueryRow | null)
  const scheduledPipelineRecoveryReason = sourceChangeReason && materialDriftReason ? null
    : sourceChangeReason ?? materialDriftReason
  return ok({
    schemaVersion,
    turns: result.rows.map(turnDto),
    page: result.page,
    projection: {
      activeTurnId: activeProjection?.id ?? null,
      activeTurn: activeProjection,
      queuedInputCount,
      scheduledPipelineRecoveryReason,
    },
  })
}
