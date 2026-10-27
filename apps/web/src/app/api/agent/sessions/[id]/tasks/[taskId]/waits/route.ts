import { Prisma } from "@prisma/client"
import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

import { sessionNotFound } from "../../../../query-helpers"
import { parseAgentWaitTargetIds, projectCurrentAgentTaskWait, type WaitProjectionScope } from "./wait-projection"

const MAX_TASK_ID_LENGTH = 256
const TERMINAL_TURN_STATUSES = ["completed", "failed", "interrupted", "cancelled", "closed"]
const TERMINAL_ROOT_STATUSES = TERMINAL_TURN_STATUSES

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

function apiError(code: string, message: string, status: number): Response {
  return noStore(NextResponse.json({ error: { code, message, details: {} } }, { status }))
}

function validPathId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_ID_LENGTH && value.trim() === value
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return noStore(auth)

  const { id: sessionId, taskId } = await context.params
  if (!validPathId(sessionId) || !validPathId(taskId)) return apiError("invalid_task_id", "Task lookup identifiers are invalid", 400)
  if (new URL(request.url).searchParams.toString().length > 0) return apiError("invalid_wait_query", "Wait lookup does not accept query parameters", 400)

  try {
    const lookup = await db.$transaction(async (tx) => {
      const session = await tx.agentSession.findFirst({
        where: { id: sessionId, userId: auth.userId },
        select: { id: true, status: true },
      })
      if (!session) return { kind: "not-found" as const }
      if (session.status === "aborted" || session.status === "archived") return { kind: "ok" as const, wait: null }

      const parent = await tx.subAgentTask.findFirst({
        where: { id: taskId, sessionId },
        select: {
          id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true,
          attemptCount: true, status: true, leaseOwner: true, leaseExpiresAt: true, absoluteDeadlineAt: true,
        },
      })
      if (!parent) return { kind: "not-found" as const }
      if (!parent.turnId || !parent.rootTaskId || !parent.parentTaskId || parent.status !== "waiting"
        || parent.leaseOwner !== null || parent.leaseExpiresAt !== null
        || !Number.isSafeInteger(parent.attemptCount) || parent.attemptCount < 1) return { kind: "ok" as const, wait: null }

      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
      const databaseNow = clockRows[0]?.now
      if (!(databaseNow instanceof Date) || !Number.isFinite(databaseNow.getTime())) return { kind: "ok" as const, wait: null }
      if (parent.absoluteDeadlineAt !== null) {
        if (!(parent.absoluteDeadlineAt instanceof Date) || !Number.isFinite(parent.absoluteDeadlineAt.getTime())
          || parent.absoluteDeadlineAt.getTime() <= databaseNow.getTime()) return { kind: "ok" as const, wait: null }
      }

      const [turn, root] = await Promise.all([
        tx.agentTurn.findFirst({
          where: { id: parent.turnId, sessionId, userId: auth.userId, status: { notIn: TERMINAL_TURN_STATUSES } },
          select: { id: true },
        }),
        tx.subAgentTask.findFirst({
          where: { id: parent.rootTaskId, sessionId, turnId: parent.turnId, status: { notIn: TERMINAL_ROOT_STATUSES } },
          select: { id: true },
        }),
      ])
      if (!turn || !root) return { kind: "ok" as const, wait: null }

      const step = await tx.agentStep.findFirst({
        where: { sessionId, turnId: parent.turnId, taskId: parent.id, attempt: parent.attemptCount },
        orderBy: { ordinal: "desc" },
        select: { id: true, sessionId: true, turnId: true, taskId: true, attempt: true, ordinal: true, status: true },
      })
      if (!step || step.sessionId !== sessionId || step.turnId !== parent.turnId || step.taskId !== parent.id
        || step.attempt !== parent.attemptCount || step.status !== "waiting_for_tool"
        || !Number.isSafeInteger(step.ordinal) || step.ordinal < 0) return { kind: "ok" as const, wait: null }

      const waits = await tx.agentWaitCondition.findMany({
        where: {
          userId: auth.userId, sessionId, turnId: parent.turnId, parentTaskId: parent.id, stepId: step.id,
          status: "waiting", suspendedAt: { not: null }, consumedAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
        select: {
          userId: true, sessionId: true, turnId: true, parentTaskId: true, stepId: true,
          targetTaskIds: true, matchedTaskIds: true, mode: true, status: true,
          deadlineAt: true, suspendedAt: true, consumedAt: true,
        },
      })
      if (waits.length !== 1) return { kind: "ok" as const, wait: null }

      const wait = waits[0]
      const targetIds = parseAgentWaitTargetIds(wait.targetTaskIds)
      if (!targetIds) return { kind: "ok" as const, wait: null }
      const targets = await tx.subAgentTask.findMany({
        where: {
          id: { in: targetIds }, sessionId, turnId: parent.turnId,
          rootTaskId: parent.rootTaskId, parentTaskId: parent.id,
        },
        orderBy: { id: "asc" },
        take: 8,
        select: {
          id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true,
          role: true, taskType: true, status: true,
        },
      })
      const scope: WaitProjectionScope = {
        userId: auth.userId, sessionId, turnId: parent.turnId, rootTaskId: parent.rootTaskId,
        parentTaskId: parent.id, stepId: step.id,
      }
      return { kind: "ok" as const, wait: projectCurrentAgentTaskWait(wait, targets, scope, parent.absoluteDeadlineAt) }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })

    if (lookup.kind === "not-found") return noStore(sessionNotFound())
    return noStore(ok({ wait: lookup.wait }))
  } catch {
    return apiError("wait_projection_unavailable", "Wait projection is unavailable", 500)
  }
}
