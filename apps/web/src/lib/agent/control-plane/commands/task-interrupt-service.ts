import { randomUUID } from "node:crypto"

import { Prisma, type PrismaClient } from "@prisma/client"
import { appendAgentEventWithOutboxInTransaction } from "../../session/fact-store"
import type { CommandTransaction } from "./transaction"
import {
  enqueueTaskInterruptIntent,
  taskInterruptAcceptedEventKey,
  taskInterruptOutboxKey,
} from "./task-interrupt-intent"

const ACTIVE_TURN = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
const ACTIVE_TASK = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])

export class TaskInterruptError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409 | 422, message: string) {
    super(message)
    this.name = "TaskInterruptError"
  }
}

export type TaskInterruptCommand = Readonly<{
  sessionId: string
  taskId: string
  userId: string
  clientMessageId: string
}>

type LineageRow = Readonly<{
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null
  path: string; depth: number
}>
type TaskIdentity = Readonly<{
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null
  path: string; depth: number; status: string; interruptRequestedAt: Date | string | null
  turnRootTaskId: string | null; turnStatus: string; rootId: string; rootParentTaskId: string | null
  rootRootTaskId: string | null; rootTurnId: string | null; rootPath: string; rootDepth: number
  rootRole: string; rootTaskType: string; rootStatus: string
}>

function unavailable(): TaskInterruptError {
  return new TaskInterruptError("task_interrupt_target_unavailable", 409, "The selected task cannot be interrupted")
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function lockOwnedLiveSession(tx: CommandTransaction, command: TaskInterruptCommand): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${command.sessionId} AND "userId" = ${command.userId}
      AND "status" NOT IN ('aborted', 'archived') FOR UPDATE
  `)
  if (!rows[0]) throw new TaskInterruptError("task_interrupt_target_not_found", 404, "The selected task is unavailable")
}

async function resolveTaskLineage(tx: CommandTransaction, command: TaskInterruptCommand): Promise<{ identity: TaskIdentity; turnId: string }> {
  const rows = await tx.$queryRaw<TaskIdentity[]>(Prisma.sql`
    SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth",
      task."status", task."interruptRequestedAt", turn."rootTaskId" AS "turnRootTaskId", turn."status" AS "turnStatus",
      root."id" AS "rootId", root."parentTaskId" AS "rootParentTaskId", root."rootTaskId" AS "rootRootTaskId",
      root."turnId" AS "rootTurnId", root."path" AS "rootPath", root."depth" AS "rootDepth",
      root."role" AS "rootRole", root."taskType" AS "rootTaskType", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = ${command.taskId} AND task."sessionId" = ${command.sessionId}
      AND session."userId" = ${command.userId} AND turn."userId" = ${command.userId}
    FOR UPDATE OF task, turn, root
  `)
  const identity = rows[0]
  if (!identity || !identity.turnId) throw new TaskInterruptError("task_interrupt_target_not_found", 404, "The selected task is unavailable")
  const lineage = await tx.$queryRaw<LineageRow[]>(Prisma.sql`
    WITH RECURSIVE lineage AS (
      SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth",
        0 AS "hops", ARRAY[task."id"]::text[] AS "visited"
      FROM "sub_agent_tasks" AS task
      WHERE task."id" = ${command.taskId} AND task."sessionId" = ${command.sessionId}
        AND task."turnId" = ${identity.turnId} AND task."rootTaskId" = ${identity.rootTaskId}
      UNION ALL
      SELECT parent."id", parent."sessionId", parent."turnId", parent."rootTaskId", parent."parentTaskId", parent."path", parent."depth",
        child."hops" + 1, child."visited" || parent."id"
      FROM "sub_agent_tasks" AS parent JOIN lineage AS child ON child."parentTaskId" = parent."id"
      WHERE parent."sessionId" = ${command.sessionId} AND parent."turnId" = ${identity.turnId}
        AND parent."rootTaskId" = ${identity.rootTaskId} AND NOT parent."id" = ANY(child."visited") AND child."hops" < 10
    )
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth" FROM lineage ORDER BY "depth" ASC
  `)
  const chain = lineage.sort((left, right) => left.depth - right.depth)
  if (identity.parentTaskId === null || identity.id === identity.rootTaskId || identity.turnRootTaskId !== identity.rootId
    || identity.rootId !== identity.rootTaskId || identity.rootParentTaskId !== null || identity.rootRootTaskId !== identity.rootId
    || identity.rootTurnId !== identity.turnId || identity.rootPath !== `/${identity.rootId}` || identity.rootDepth !== 0
    || identity.rootRole !== "orchestrator" || identity.rootTaskType !== "root" || !ACTIVE_TASK.has(identity.rootStatus)
    || !ACTIVE_TURN.has(identity.turnStatus)
    || !ACTIVE_TASK.has(identity.status) || identity.interruptRequestedAt !== null || chain.length < 2) throw unavailable()
  let expectedPath = ""
  for (const [index, row] of chain.entries()) {
    expectedPath = index === 0 ? `/${row.id}` : `${expectedPath}/${row.id}`
    if (row.sessionId !== command.sessionId || row.turnId !== identity.turnId || row.rootTaskId !== identity.rootId
      || row.depth !== index || row.path !== expectedPath || (index === 0 && row.id !== identity.rootId)
      || row.parentTaskId !== (index === 0 ? null : chain[index - 1]?.id)) throw unavailable()
  }
  if (chain.at(-1)?.id !== command.taskId) throw unavailable()
  return { identity, turnId: identity.turnId }
}

function replayResult(value: unknown, taskId: string): { intentId: string; turnId: string; sequence: string } | null {
  const row = object(value)
  return row && row.taskId === taskId && typeof row.intentId === "string" && typeof row.turnId === "string"
    ? { intentId: row.intentId, turnId: row.turnId, sequence: typeof row.sequence === "string" ? row.sequence : "" }
    : null
}

export class TaskInterruptService {
  constructor(private readonly db: PrismaClient) {}

  async interrupt(command: TaskInterruptCommand): Promise<{
    intentId: string; taskId: string; turnId: string; disposition: "accepted" | "duplicate"; sequence: string
  }> {
    const outboxKey = taskInterruptOutboxKey(command.sessionId, command.clientMessageId)
    const eventKey = taskInterruptAcceptedEventKey(command.sessionId, command.clientMessageId)
    return this.db.$transaction(async tx => {
      await lockOwnedLiveSession(tx, command)
      const existing = await tx.agentOutbox.findUnique({
        where: { idempotencyKey: outboxKey },
        select: { aggregateId: true, payload: true },
      })
      if (existing) {
        const saved = replayResult(existing.payload, command.taskId)
        if (existing.aggregateId !== command.sessionId || !saved) {
          throw new TaskInterruptError("task_interrupt_idempotency_conflict", 409, "The idempotency key was already used for another task")
        }
        const event = await tx.agentEvent.findFirst({
          where: { sessionId: command.sessionId, idempotencyKey: eventKey, taskId: command.taskId, turnId: saved.turnId },
          select: { sequence: true },
        })
        if (!event) throw new TaskInterruptError("task_interrupt_replay_unavailable", 409, "The original interrupt result is unavailable")
        return { intentId: saved.intentId, taskId: command.taskId, turnId: saved.turnId, disposition: "duplicate", sequence: String(event.sequence) }
      }

      const { turnId } = await resolveTaskLineage(tx, command)
      const intentId = randomUUID()
      const event = await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: command.sessionId, turnId, taskId: command.taskId, itemId: null,
        type: "task.interrupt.accepted", actor: "user", correlationId: turnId,
        idempotencyKey: eventKey, payload: { intentId, taskId: command.taskId, status: "accepted" },
        outboxTopic: "agent.session.event",
      })
      await enqueueTaskInterruptIntent(tx, { ...command, turnId, intentId })
      return { intentId, taskId: command.taskId, turnId, disposition: "accepted", sequence: String(event.event.sequence) }
    })
  }
}
