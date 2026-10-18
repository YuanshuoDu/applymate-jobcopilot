import { randomUUID } from "node:crypto"

import { Prisma, type PrismaClient } from "@prisma/client"
import { AGENT_STREAM_SCHEMA_VERSION, type AgentItemRecord } from "@jobcopilot/agent-protocol"
import { appendAgentEventWithOutboxInTransaction } from "../../session/fact-store"
import type { CommandTransaction } from "./transaction"
import { TASK_INTERRUPT_OUTBOX_TOPIC } from "./task-interrupt-intent"

const MAILBOX_TOPIC = "agent.subagent.mailbox", MAX_TEXT_LENGTH = 20_000

export class TaskMessageError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409 | 422, message: string) {
    super(message)
    this.name = "TaskMessageError"
  }
}

export type TaskMessageCommand = Readonly<{
  sessionId: string
  taskId: string
  userId: string
  clientMessageId: string
  text: string
  expectedAttemptCount?: number
  now?: Date
}>

type LineageRow = Readonly<{
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null
  path: string; depth: number; status: string; interruptRequestedAt: Date | string | null
}>
type TaskIdentity = Readonly<{
  id: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string | null
  path: string; depth: number; status: string; attemptCount: number; leaseOwner: string | null
  leaseExpiresAt: Date | string | null; interruptRequestedAt: Date | string | null
  turnRootTaskId: string | null; turnStatus: string; rootId: string; rootParentTaskId: string | null
  rootRootTaskId: string | null; rootTurnId: string | null; rootPath: string; rootDepth: number
  rootRole: string; rootTaskType: string; rootStatus: string
  rootInterruptRequestedAt: Date | string | null
}>
type AcceptedResult = Readonly<{
  messageId: string; itemId: string; taskId: string; turnId: string; targetAttemptCount: number
  disposition: "accepted" | "duplicate"; sequence: string
}>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function notFound(): TaskMessageError {
  return new TaskMessageError("task_follow_up_target_not_found", 404, "The selected task is unavailable")
}
function unavailable(): TaskMessageError {
  return new TaskMessageError("task_follow_up_target_unavailable", 409, "The selected task cannot receive a follow-up")
}
function conflict(): TaskMessageError {
  return new TaskMessageError("task_follow_up_idempotency_conflict", 409, "The idempotency key is bound to another follow-up")
}
function replayUnavailable(): TaskMessageError {
  return new TaskMessageError("task_follow_up_replay_unavailable", 409, "The original follow-up result is unavailable")
}
function messageKey(clientMessageId: string): string { return `human-follow-up:${clientMessageId}` }
function outboxKey(sessionId: string, clientMessageId: string): string { return `agent-subagent-mailbox:${sessionId}:${clientMessageId}` }
function eventKey(sessionId: string, clientMessageId: string): string { return `agent-task-follow-up-accepted:${sessionId}:${clientMessageId}` }

async function lockOwnedSession(tx: CommandTransaction, command: TaskMessageCommand): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_sessions"
    WHERE "id" = ${command.sessionId} AND "userId" = ${command.userId}
    FOR UPDATE
  `)
  if (!rows[0]) throw notFound()
  return rows[0].status
}

async function resolveCurrentAttempt(
  tx: CommandTransaction,
  command: TaskMessageCommand,
  now: Date,
  requireActive: boolean,
): Promise<{ turnId: string; attempt: number; lineageTaskIds: string[] }> {
  const rows = await tx.$queryRaw<TaskIdentity[]>(Prisma.sql`
    SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth",
      task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt",
      turn."rootTaskId" AS "turnRootTaskId", turn."status" AS "turnStatus",
      root."id" AS "rootId", root."parentTaskId" AS "rootParentTaskId", root."rootTaskId" AS "rootRootTaskId",
      root."turnId" AS "rootTurnId", root."path" AS "rootPath", root."depth" AS "rootDepth",
      root."role" AS "rootRole", root."taskType" AS "rootTaskType", root."status" AS "rootStatus",
      root."interruptRequestedAt" AS "rootInterruptRequestedAt"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = ${command.taskId} AND task."sessionId" = ${command.sessionId}
      AND session."userId" = ${command.userId} AND turn."userId" = ${command.userId}
    FOR UPDATE OF task, turn, root
  `)
  const identity = rows[0]
  if (!identity) throw notFound()
  if (!identity.turnId) throw unavailable()
  const chain = await tx.$queryRaw<LineageRow[]>(Prisma.sql`
    WITH RECURSIVE lineage AS (
      SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth",
        task."status", task."interruptRequestedAt", 0 AS "hops", ARRAY[task."id"]::text[] AS "visited"
      FROM "sub_agent_tasks" AS task
      WHERE task."id" = ${command.taskId} AND task."sessionId" = ${command.sessionId}
        AND task."turnId" = ${identity.turnId} AND task."rootTaskId" = ${identity.rootTaskId}
      UNION ALL
      SELECT parent."id", parent."sessionId", parent."turnId", parent."rootTaskId", parent."parentTaskId", parent."path", parent."depth",
        parent."status", parent."interruptRequestedAt", child."hops" + 1, child."visited" || parent."id"
      FROM "sub_agent_tasks" AS parent JOIN lineage AS child ON child."parentTaskId" = parent."id"
      WHERE parent."sessionId" = ${command.sessionId} AND parent."turnId" = ${identity.turnId}
        AND parent."rootTaskId" = ${identity.rootTaskId} AND NOT parent."id" = ANY(child."visited") AND child."hops" < 10
    ) SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "status", "interruptRequestedAt"
      FROM lineage ORDER BY "depth" ASC
  `)
  const ordered = [...chain].sort((left, right) => left.depth - right.depth)
  let expectedPath = ""
  for (const [index, row] of ordered.entries()) {
    expectedPath = index === 0 ? `/${row.id}` : `${expectedPath}/${row.id}`
    if (row.sessionId !== command.sessionId || row.turnId !== identity.turnId || row.rootTaskId !== identity.rootId
      || row.depth !== index || row.path !== expectedPath || (index === 0 && row.id !== identity.rootId)
      || row.parentTaskId !== (index === 0 ? null : ordered[index - 1]?.id)
      || (requireActive && row.interruptRequestedAt !== null)) throw unavailable()
  }
  if (identity.parentTaskId === null || identity.id === identity.rootTaskId || ordered.length < 2
    || ordered.at(-1)?.id !== command.taskId || identity.turnRootTaskId !== identity.rootId
    || identity.rootId !== identity.rootTaskId || identity.rootParentTaskId !== null || identity.rootRootTaskId !== identity.rootId
    || identity.rootTurnId !== identity.turnId || identity.rootPath !== `/${identity.rootId}` || identity.rootDepth !== 0
    || identity.rootRole !== "orchestrator" || identity.rootTaskType !== "root"
    || !Number.isSafeInteger(identity.attemptCount) || identity.attemptCount < 1) throw unavailable()
  if (requireActive && (identity.rootStatus !== "running" || identity.turnStatus !== "in_progress" || identity.status !== "running"
    || identity.interruptRequestedAt !== null || identity.rootInterruptRequestedAt !== null
    || typeof identity.leaseOwner !== "string" || !identity.leaseOwner.trim()
    || !(identity.leaseExpiresAt instanceof Date) || identity.leaseExpiresAt <= now)) throw unavailable()
  return { turnId: identity.turnId, attempt: identity.attemptCount, lineageTaskIds: ordered.map(row => row.id) }
}

async function replayExisting(
  tx: CommandTransaction,
  command: TaskMessageCommand,
  turnId: string,
  text: string,
  saved: { id: string; sessionId: string; turnId: string; toTaskId: string | null; kind: string; payload: unknown; targetAttemptCount: number | null },
): Promise<AcceptedResult> {
  if (saved.sessionId !== command.sessionId || saved.turnId !== turnId || saved.toTaskId !== command.taskId
    || saved.kind !== "human_follow_up" || !Number.isSafeInteger(saved.targetAttemptCount) || saved.targetAttemptCount! < 1
    || record(saved.payload)?.text !== text || (command.expectedAttemptCount !== undefined && command.expectedAttemptCount !== saved.targetAttemptCount)) {
    if (command.expectedAttemptCount !== undefined && command.expectedAttemptCount !== saved.targetAttemptCount) {
      throw new TaskMessageError("task_follow_up_attempt_changed", 409, "The selected task attempt has changed")
    }
    throw conflict()
  }
  const attempt = saved.targetAttemptCount!
  const key = outboxKey(command.sessionId, command.clientMessageId)
  const [event, outbox] = await Promise.all([
    tx.agentEvent.findFirst({ where: { sessionId: command.sessionId, idempotencyKey: eventKey(command.sessionId, command.clientMessageId) },
      select: { sequence: true, itemId: true, taskId: true, turnId: true, payload: true } }),
    tx.agentOutbox.findUnique({ where: { idempotencyKey: key }, select: { aggregateId: true, topic: true, payload: true } }),
  ])
  const eventPayload = record(event?.payload), outboxPayload = record(outbox?.payload)
  if (!event || !event.itemId || event.taskId !== command.taskId || event.turnId !== turnId
    || eventPayload?.messageId !== saved.id || eventPayload?.clientMessageId !== command.clientMessageId
    || eventPayload.targetAttemptCount !== attempt
    || !outbox || outbox.aggregateId !== command.sessionId || outbox.topic !== MAILBOX_TOPIC
    || outboxPayload?.messageId !== saved.id || outboxPayload.sessionId !== command.sessionId
    || outboxPayload.turnId !== turnId || outboxPayload.toTaskId !== command.taskId
    || outboxPayload.targetAttemptCount !== attempt) throw replayUnavailable()
  return { messageId: saved.id, itemId: event.itemId, taskId: command.taskId, turnId, targetAttemptCount: attempt,
    disposition: "duplicate", sequence: String(event.sequence) }
}

export class TaskMessageService {
  constructor(private readonly db: PrismaClient) {}

  async send(command: TaskMessageCommand): Promise<AcceptedResult> {
    const text = command.text.trim()
    const clientMessageId = command.clientMessageId.trim()
    if (!text || text.length > MAX_TEXT_LENGTH || !clientMessageId || clientMessageId.length > 128
      || (command.expectedAttemptCount !== undefined && (!Number.isSafeInteger(command.expectedAttemptCount) || command.expectedAttemptCount < 1))) {
      throw new TaskMessageError("invalid_task_follow_up", 422, "A message and valid client message ID are required")
    }
    const normalized = { ...command, text, clientMessageId }
    return this.db.$transaction(async tx => {
      const sessionStatus = await lockOwnedSession(tx, normalized)
      const existing = await tx.agentMailboxMessage.findFirst({
        where: { sessionId: command.sessionId, idempotencyKey: messageKey(clientMessageId) },
        select: { id: true, sessionId: true, turnId: true, toTaskId: true, kind: true, payload: true, targetAttemptCount: true },
      })
      if (existing) {
        if (existing.toTaskId !== command.taskId || existing.kind !== "human_follow_up" || record(existing.payload)?.text !== text) throw conflict()
        const binding = await resolveCurrentAttempt(tx, normalized, command.now ?? new Date(), false)
        if (existing.turnId !== binding.turnId) throw conflict()
        if (command.expectedAttemptCount !== undefined && command.expectedAttemptCount !== existing.targetAttemptCount) {
          throw new TaskMessageError("task_follow_up_attempt_changed", 409, "The selected task attempt has changed")
        }
        return replayExisting(tx, normalized, binding.turnId, text, existing)
      }
      if (sessionStatus !== "running") throw notFound()
      const now = command.now ?? new Date()
      const { turnId, attempt, lineageTaskIds } = await resolveCurrentAttempt(tx, normalized, now, true)
      if (command.expectedAttemptCount !== undefined && command.expectedAttemptCount !== attempt) {
        throw new TaskMessageError("task_follow_up_attempt_changed", 409, "The selected task attempt has changed")
      }
      const pendingInterrupt = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT intent."id" FROM "agent_outbox" intent
        JOIN "agent_events" accepted ON accepted."sessionId" = intent."aggregateId" AND accepted."taskId" = intent."payload"->>'taskId' AND accepted."turnId" = ${turnId}
          AND accepted."type" = 'task.interrupt.accepted' AND accepted."actor" = 'user'
          AND accepted."payload"->>'status' = 'accepted' AND accepted."payload"->>'intentId' = intent."payload"->>'intentId'
        WHERE intent."aggregateId" = ${command.sessionId} AND intent."topic" = ${TASK_INTERRUPT_OUTBOX_TOPIC} AND intent."publishedAt" IS NULL
          AND intent."payload"->>'sessionId' = ${command.sessionId} AND intent."payload"->>'turnId' = ${turnId}
          AND intent."payload"->>'taskId' IN (${Prisma.join(lineageTaskIds)}) LIMIT 1`)
      if (pendingInterrupt.length > 0) throw unavailable()
      const messageId = randomUUID(), itemId = randomUUID()
      await tx.agentMailboxMessage.create({ data: {
        id: messageId, sessionId: command.sessionId, turnId, fromTaskId: null, toTaskId: command.taskId,
        kind: "human_follow_up", targetAttemptCount: attempt, payload: { text },
        idempotencyKey: messageKey(clientMessageId),
      } })
      await tx.agentOutbox.create({ data: {
        id: randomUUID(), topic: MAILBOX_TOPIC, aggregateId: command.sessionId,
        idempotencyKey: outboxKey(command.sessionId, clientMessageId),
        payload: { messageId, sessionId: command.sessionId, turnId, toTaskId: command.taskId, targetAttemptCount: attempt },
      } })
      const createdAt = now
      await tx.agentItem.create({ data: {
        id: itemId, sessionId: command.sessionId, turnId, taskId: command.taskId, type: "user_message",
        status: "completed", phase: "commentary", revision: 0,
        content: { parts: [{ type: "text", text }], clientMessageId, source: "user", delivery: "follow_up",
          disposition: "queued_follow_up", targetAttemptCount: attempt },
        startedAt: createdAt, completedAt: createdAt,
      } })
      const item = {
        schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: command.sessionId, turnId,
        stepId: null, taskId: command.taskId, type: "user_message", status: "completed", phase: "commentary",
        revision: 0, content: { parts: [{ type: "text", text }] },
        startedAt: createdAt.toISOString(), completedAt: createdAt.toISOString(),
        createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
      } satisfies AgentItemRecord & { schemaVersion: typeof AGENT_STREAM_SCHEMA_VERSION }
      const event = await appendAgentEventWithOutboxInTransaction(tx, {
        sessionId: command.sessionId, turnId, taskId: command.taskId, itemId,
        type: "input.accepted", actor: "user", correlationId: turnId,
        idempotencyKey: eventKey(command.sessionId, clientMessageId),
        payload: { messageId, clientMessageId, delivery: "follow_up", source: "user",
          disposition: "queued_follow_up", targetAttemptCount: attempt, item },
        outboxTopic: "agent.session.event",
      })
      return { messageId, itemId, taskId: command.taskId, turnId, targetAttemptCount: attempt,
        disposition: "accepted", sequence: event.event.sequence.toString() }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}
