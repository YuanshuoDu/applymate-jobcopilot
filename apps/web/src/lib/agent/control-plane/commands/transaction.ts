import { randomUUID } from "node:crypto"

import { Prisma } from "@prisma/client"
import type { InputContentPart, TurnSource } from "@jobcopilot/agent-protocol"

import { appendAgentEventWithOutboxInTransaction } from "../../session/fact-store"
import { activeTurnChanged, sessionNotFound } from "./errors"
import type { CommandIdentity, CommandDisposition, InterruptDisposition } from "./types"

export const ACTIVE_TURN_STATUSES = [
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
] as const

export type CommandTransaction = Prisma.TransactionClient

export interface ActiveTurn {
  id: string
  source: string
  status: string
  revision: number
}

export interface ExistingCommand {
  id: string
  targetTurnId: string | null
  delivery: string
  acceptedSequence: bigint
}

export interface AcceptedCommandFacts {
  inputId: string
  turnId: string
  sequence: string
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

export function commandEventKey(clientMessageId: string): string {
  return `agent-command:${clientMessageId}`
}

export async function lockOwnedSession(tx: CommandTransaction, sessionId: string, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${sessionId} AND "userId" = ${userId}
    FOR UPDATE
  `)
  if (!rows[0]) throw sessionNotFound(sessionId)
}

export async function findActiveTurn(
  tx: CommandTransaction,
  sessionId: string,
  userId: string,
): Promise<ActiveTurn | null> {
  return tx.agentTurn.findFirst({
    where: { sessionId, userId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, source: true, status: true, revision: true },
  })
}

export async function findExistingCommand(
  tx: CommandTransaction,
  sessionId: string,
  clientMessageId: string,
): Promise<ExistingCommand | null> {
  return tx.agentInput.findFirst({
    where: { sessionId, clientMessageId },
    select: { id: true, targetTurnId: true, delivery: true, acceptedSequence: true },
  })
}

export function fallbackDisposition(
  existing: ExistingCommand,
  requestedDelivery: "steer" | "follow_up",
): Exclude<CommandDisposition, "duplicate"> {
  if (existing.delivery === "steer" || requestedDelivery === "steer") return "steered"
  return existing.targetTurnId ? "queued_follow_up" : "started"
}

function actorFor(source: TurnSource): "user" | "system" {
  return source === "user" ? "user" : "system"
}

export async function createRootTurn(
  tx: CommandTransaction,
  command: CommandIdentity,
  content: InputContentPart[],
): Promise<ActiveTurn> {
  const goal = content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() || "Process the provided content"
  const turn = await tx.agentTurn.create({
    data: {
      id: randomUUID(),
      sessionId: command.sessionId,
      userId: command.userId,
      status: "queued",
      source: command.source,
      input: json({
        goal,
        content,
        clientMessageId: command.clientMessageId,
      }),
      modelProfileSnapshot: json({}),
      toolPolicySnapshot: json({}),
      budgetSnapshot: json({}),
    },
    select: { id: true },
  })
  return { id: turn.id, source: command.source, status: "queued", revision: 0 }
}

export async function acceptInputFacts(
  tx: CommandTransaction,
  command: CommandIdentity,
  content: InputContentPart[],
  turn: ActiveTurn,
  delivery: "steer" | "follow_up",
  disposition: CommandDisposition | InterruptDisposition,
  includeTurnStarted: boolean,
): Promise<AcceptedCommandFacts> {
  const inputId = randomUUID()
  const itemId = randomUUID()
  const actor = actorFor(command.source)
  const eventPayload = json({
    inputId,
    clientMessageId: command.clientMessageId,
    delivery,
    source: command.source,
    disposition,
  })

  await tx.agentItem.create({
    data: {
      id: itemId,
      sessionId: command.sessionId,
      turnId: turn.id,
      type: "user_message",
      status: "completed",
      phase: "commentary",
      revision: 0,
      content: json({ parts: content, clientMessageId: command.clientMessageId, source: command.source, disposition }),
      startedAt: new Date(),
      completedAt: new Date(),
    },
  })

  if (includeTurnStarted) {
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: command.sessionId,
      turnId: turn.id,
      itemId: null,
      taskId: null,
      type: "turn.started",
      actor: "orchestrator",
      correlationId: turn.id,
      causationId: null,
      idempotencyKey: `${commandEventKey(command.clientMessageId)}:turn-started`,
      payload: json({ turnId: turn.id, source: command.source }),
      outboxTopic: "agent.session.event",
    })
  }

  const accepted = await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: command.sessionId,
    turnId: turn.id,
    itemId,
    taskId: null,
    type: "input.accepted",
    actor,
    correlationId: turn.id,
    causationId: null,
    idempotencyKey: commandEventKey(command.clientMessageId),
    payload: eventPayload,
    outboxTopic: "agent.session.event",
  })

  await tx.agentInput.create({
    data: {
      id: inputId,
      sessionId: command.sessionId,
      targetTurnId: turn.id,
      userId: command.userId,
      clientMessageId: command.clientMessageId,
      delivery,
      status: "accepted",
      content: json(content),
      acceptedSequence: accepted.event.sequence,
    },
  })

  if (disposition === "interrupted") {
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: command.sessionId,
      turnId: turn.id,
      itemId: null,
      taskId: null,
      type: "turn.interrupted",
      actor: "orchestrator",
      correlationId: turn.id,
      causationId: null,
      idempotencyKey: `${commandEventKey(command.clientMessageId)}:turn-interrupted`,
      payload: json({ turnId: turn.id, reason: "command_interrupt" }),
      outboxTopic: "agent.session.event",
    })
  }

  return { inputId, turnId: turn.id, sequence: accepted.event.sequence.toString() }
}

export async function assertExpectedTurn(
  expectedTurnId: string | null | undefined,
  expectedRevision: number | null | undefined,
  active: ActiveTurn | null,
): Promise<void> {
  if (expectedTurnId !== undefined && expectedTurnId !== (active?.id ?? null)) {
    throw activeTurnChanged(expectedTurnId, active?.id ?? null)
  }
  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== (active?.revision ?? null)) {
    throw activeTurnChanged(expectedTurnId ?? null, active?.id ?? null)
  }
}
