import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import type { Actor, AgentMessagePhase, ItemStatus } from "@jobcopilot/agent-protocol"
import { redactAgentEvent } from "@jobcopilot/shared"

export interface AppendAgentEventInput {
  sessionId: string
  /** Omitted only for the nullable session control lifecycle events. */
  turnId?: string | null
  itemId?: string | null
  taskId?: string | null
  type: string
  actor: Actor
  correlationId: string
  causationId?: string | null
  idempotencyKey?: string | null
  payload: Prisma.InputJsonValue
  outboxTopic: string
}

export interface UpdateAgentItemRevisionInput {
  itemId: string
  expectedRevision: number
  content: Prisma.InputJsonValue
  status: ItemStatus
  phase?: AgentMessagePhase | null
  startedAt?: Date | null
  completedAt?: Date | null
}

export class AgentSessionNotFoundError extends Error {
  readonly code = "agent_session_not_found"

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} does not exist`)
    this.name = "AgentSessionNotFoundError"
  }
}

export class AgentItemRevisionConflictError extends Error {
  readonly code = "agent_item_revision_conflict"

  constructor(itemId: string, expectedRevision: number) {
    super(`Agent item ${itemId} revision ${expectedRevision} is stale`)
    this.name = "AgentItemRevisionConflictError"
  }
}

type AgentEventRecord = Prisma.AgentEventGetPayload<{}>

const SESSION_CONTROL_EVENT_TYPES = new Set(["session.paused", "session.resumed"])
const SESSION_CONTROL_PAYLOAD_KEYS = ["sessionId", "operation", "previousGate", "nextGate", "controlRevision", "pausedAt"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

function assertAppendableEvent(input: AppendAgentEventInput): void {
  const controlEvent = SESSION_CONTROL_EVENT_TYPES.has(input.type)
  if (!controlEvent) {
    if (!input.turnId) throw new Error("Turn-scoped AgentEvents require a turnId")
    return
  }
  if ((input.turnId !== undefined && input.turnId !== null) || input.itemId != null || input.taskId != null || input.actor !== "system" || input.correlationId !== input.sessionId || !input.idempotencyKey) {
    throw new Error("Session control AgentEvents require system scope and a stable idempotency key")
  }
  const payload: unknown = input.payload
  if (!isRecord(payload) || Object.keys(payload).length !== SESSION_CONTROL_PAYLOAD_KEYS.length || !SESSION_CONTROL_PAYLOAD_KEYS.every(key => key in payload)) {
    throw new Error("Session control AgentEvents contain an invalid payload")
  }
  const operation = payload.operation
  const previousGate = payload.previousGate
  const nextGate = payload.nextGate
  const pausedAt = payload.pausedAt
  const validLifecycle = input.type === "session.paused"
    ? operation === "pause" && previousGate === "open" && nextGate === "user_paused" && typeof pausedAt === "string"
    : operation === "resume" && previousGate === "user_paused" && nextGate === "open" && pausedAt === null
  if (payload.sessionId !== input.sessionId || !validLifecycle || typeof payload.controlRevision !== "number" || !Number.isSafeInteger(payload.controlRevision) || payload.controlRevision < 1 || (pausedAt !== null && !isTimestamp(pausedAt))) {
    throw new Error("Session control AgentEvents contain invalid lifecycle facts")
  }
}

interface EventReader {
  agentEvent: {
    findFirst(args: Prisma.AgentEventFindFirstArgs): Promise<AgentEventRecord | null>
  }
}

async function findExistingEvent(
  db: EventReader,
  input: AppendAgentEventInput,
): Promise<AgentEventRecord | null> {
  if (!input.idempotencyKey) return null

  return db.agentEvent.findFirst({
    where: {
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
    },
  })
}

async function allocateSessionSequence(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ eventSequence: bigint }>>(Prisma.sql`
    UPDATE "agent_sessions"
    SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = ${sessionId}
    RETURNING "eventSequence" AS "eventSequence"
  `)

  const sequence = rows[0]?.eventSequence
  if (typeof sequence !== "bigint") throw new AgentSessionNotFoundError(sessionId)
  return sequence
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as { code?: unknown }).code === "P2002"
}

function buildOutboxPayload(
  input: AppendAgentEventInput,
  eventId: string,
  sequence: bigint,
): Prisma.InputJsonObject {
  return {
    eventId,
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    itemId: input.itemId ?? null,
    taskId: input.taskId ?? null,
    sequence: sequence.toString(),
    type: input.type,
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: safeEventPayload(input),
  }
}

function safeEventPayload(input: Pick<AppendAgentEventInput, "type" | "payload">): Prisma.InputJsonValue {
  return redactAgentEvent({ type: input.type, body: "", data: input.payload }).data as Prisma.InputJsonValue
}

export async function appendAgentEventWithOutbox(
  db: PrismaClient,
  input: AppendAgentEventInput,
): Promise<{ event: AgentEventRecord; duplicate: boolean }> {
  assertAppendableEvent(input)
  const existing = await findExistingEvent(db, input)
  if (existing) return { event: existing, duplicate: true }

  try {
    return await db.$transaction((tx) => appendAgentEventWithOutboxInTransaction(tx, input))
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error

    const duplicate = await findExistingEvent(db, input)
    if (duplicate) return { event: duplicate, duplicate: true }
    throw error
  }
}

/**
 * Appends a fact and its outbox dispatch inside a caller-owned transaction.
 * The dual writer uses this to commit the legacy projection and V2 fact
 * together, preserving the atomicity guarantee of the fact store.
 */
export async function appendAgentEventWithOutboxInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendAgentEventInput,
): Promise<{ event: AgentEventRecord; duplicate: boolean }> {
  assertAppendableEvent(input)
  const transactionExisting = await findExistingEvent(tx, input)
  if (transactionExisting) return { event: transactionExisting, duplicate: true }

  const sequence = await allocateSessionSequence(tx, input.sessionId)
  const eventId = randomUUID()
  const event = await tx.agentEvent.create({
    data: {
      id: eventId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      itemId: input.itemId ?? null,
      taskId: input.taskId ?? null,
      sequence,
      type: input.type,
      actor: input.actor,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: safeEventPayload(input),
    },
  })

  await tx.agentOutbox.create({
    data: {
      id: randomUUID(),
      topic: input.outboxTopic,
      aggregateId: input.sessionId,
      idempotencyKey: `agent-event:${eventId}`,
      payload: buildOutboxPayload(input, eventId, sequence),
    },
  })

  return { event, duplicate: false }
}

export async function updateAgentItemRevision(
  db: PrismaClient,
  input: UpdateAgentItemRevisionInput,
): Promise<{ updated: true; revision: number }> {
  const nextRevision = input.expectedRevision + 1

  return db.$transaction(async (tx) => {
    const result = await tx.agentItem.updateMany({
      where: {
        id: input.itemId,
        revision: input.expectedRevision,
      },
      data: {
        content: input.content,
        status: input.status,
        revision: nextRevision,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      },
    })

    if (result.count !== 1) {
      throw new AgentItemRevisionConflictError(input.itemId, input.expectedRevision)
    }

    return { updated: true as const, revision: nextRevision }
  })
}
