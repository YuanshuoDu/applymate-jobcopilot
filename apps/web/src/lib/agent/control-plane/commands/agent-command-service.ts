import type { PrismaClient } from "@prisma/client"
import type { InputContentPart } from "@jobcopilot/agent-protocol"

import { AgentCommandError, activeTurnChanged, automationCannotSteerUserTurn, invalidCommand, isUniqueViolation } from "./errors"
import {
  acceptInputFacts,
  assertExpectedTurn,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  fallbackDisposition,
  lockOwnedSession,
  type CommandTransaction,
} from "./transaction"
import type {
  CommandDisposition,
  CommandResult,
  InterruptCommand,
  InterruptResult,
  MessageCommand,
  StartCommand,
  SteerCommand,
} from "./types"

type CommandEvent = { sequence: bigint; payload: unknown }
type OriginalDisposition = Exclude<CommandDisposition, "duplicate"> | "interrupted"

function assertContent(content: InputContentPart[]): void {
  if (content.length === 0) {
    throw invalidCommand("Agent commands require at least one content part")
  }
}

function dispositionFromEvent(event: CommandEvent | null, fallback: OriginalDisposition): OriginalDisposition {
  if (typeof event?.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return fallback
  const value = (event.payload as { disposition?: unknown }).disposition
  return typeof value === "string" && ["started", "steered", "queued_follow_up", "interrupted"].includes(value)
    ? (value as OriginalDisposition)
    : fallback
}

async function duplicateCommandResult(
  tx: CommandTransaction,
  command: { sessionId: string; clientMessageId: string },
  existing: { id: string; targetTurnId: string | null; delivery: string; acceptedSequence: bigint },
  requestedDelivery: "steer" | "follow_up",
): Promise<CommandResult> {
  const event = await tx.agentEvent.findFirst({
    where: { sessionId: command.sessionId, idempotencyKey: `agent-command:${command.clientMessageId}` },
    select: { sequence: true, payload: true },
  })
  const original = dispositionFromEvent(event, fallbackDisposition(existing, requestedDelivery))
  if (!existing.targetTurnId) throw new AgentCommandError("turn_not_active", "Duplicate command has no target Turn", 409)
  return {
    inputId: existing.id,
    turnId: existing.targetTurnId,
    disposition: "duplicate",
    originalDisposition: original === "interrupted" ? "started" : original,
    sequence: (event?.sequence ?? existing.acceptedSequence).toString(),
  }
}

async function duplicateInterruptResult(
  tx: CommandTransaction,
  command: InterruptCommand,
  existing: { id: string; targetTurnId: string | null; delivery: string; acceptedSequence: bigint },
): Promise<InterruptResult> {
  const event = await tx.agentEvent.findFirst({
    where: { sessionId: command.sessionId, idempotencyKey: `agent-command:${command.clientMessageId}` },
    select: { sequence: true, payload: true },
  })
  if (!existing.targetTurnId) throw new AgentCommandError("turn_not_active", "Duplicate interrupt has no target Turn", 409)
  return {
    inputId: existing.id,
    turnId: existing.targetTurnId,
    disposition: "duplicate",
    originalDisposition: "interrupted",
    sequence: (event?.sequence ?? existing.acceptedSequence).toString(),
  }
}

export class AgentCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(command: StartCommand): Promise<CommandResult> {
    assertContent(command.content)
    return this.retryUnique(() => this.startOnce(command))
  }

  async message(command: MessageCommand): Promise<CommandResult> {
    assertContent(command.content)
    return this.retryUnique(() => this.messageOnce(command))
  }

  async steer(command: SteerCommand): Promise<CommandResult> {
    return this.message({ ...command, delivery: "steer" })
  }

  async interrupt(command: InterruptCommand): Promise<InterruptResult> {
    return this.retryUnique(() => this.interruptOnce(command))
  }

  private async retryUnique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return work()
    }
  }

  private startOnce(command: StartCommand): Promise<CommandResult> {
    return this.db.$transaction(async (tx) => {
      await lockOwnedSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateCommandResult(tx, command, existing, "follow_up")

      const existingActive = await findActiveTurn(tx, command.sessionId, command.userId)
      const created = !existingActive
      const active = existingActive ?? await createRootTurn(tx, command, command.content)
      const disposition: CommandDisposition = created ? "started" : "queued_follow_up"
      return acceptInputFacts(tx, command, command.content, active, "follow_up", disposition, disposition === "started")
        .then((facts) => ({ ...facts, disposition }))
    })
  }

  private messageOnce(command: MessageCommand): Promise<CommandResult> {
    return this.db.$transaction(async (tx) => {
      await lockOwnedSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateCommandResult(tx, command, existing, command.delivery)

      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      const expectedTurnId = command.delivery === "steer" || command.expectedTurnId ? command.expectedTurnId : undefined
      await assertExpectedTurn(expectedTurnId, command.expectedRevision, active)
      if (command.delivery === "steer" && command.source === "automation" && active?.source === "user") {
        throw automationCannotSteerUserTurn(active.id)
      }

      if (!active) {
        const turn = await createRootTurn(tx, command, command.content)
        return acceptInputFacts(tx, command, command.content, turn, command.delivery, "started", true)
          .then((facts) => ({ ...facts, disposition: "started" as const }))
      }

      const disposition = command.delivery === "steer" ? "steered" : "queued_follow_up"
      return acceptInputFacts(tx, command, command.content, active, command.delivery, disposition, false)
        .then((facts) => ({ ...facts, disposition }))
    })
  }

  private interruptOnce(command: InterruptCommand): Promise<InterruptResult> {
    return this.db.$transaction(async (tx) => {
      await lockOwnedSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateInterruptResult(tx, command, existing)

      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      await assertExpectedTurn(command.expectedTurnId, command.expectedRevision, active)
      if (!active) throw activeTurnChanged(command.expectedTurnId, null)
      const interrupted = await tx.agentTurn.updateMany({
        where: { id: active.id, sessionId: command.sessionId, userId: command.userId, status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] }, revision: active.revision },
        data: { status: "interrupted", revision: { increment: 1 }, completedAt: new Date() },
      })
      if (interrupted.count !== 1) throw activeTurnChanged(command.expectedTurnId, active.id)

      const content: InputContentPart[] = [{ type: "text", text: "Interrupt requested" }]
      return acceptInputFacts(tx, command, content, active, "steer", "interrupted", false)
        .then((facts) => ({ ...facts, disposition: "interrupted" as const }))
    })
  }
}
