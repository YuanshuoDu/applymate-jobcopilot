import type { PrismaClient } from "@prisma/client"
import { AgentCommandError, activeTurnChanged, automationCannotSteerUserTurn, isUniqueViolation, retryActiveConflict, retryTargetChanged, retryTargetInvalid, turnWaitRequiresDedicatedAction } from "./errors"
import { assertContent, dispositionFromEvent } from "./command-content"
import { cancelExecutionInTransaction, interruptActiveTurn, type CancelExecutionCommand } from "./execution-cancellation"
import { isRetryableTurnStatus, parsePersistedRetryContent } from "./retry-input"
import {
  acceptInputFacts,
  assertExpectedTurn,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  lockOpenSession,
  fallbackDisposition,
  type CommandTransaction,
} from "./transaction"
import type {
  CommandDisposition,
  CommandResult,
  InterruptCommand,
  InterruptResult,
  MessageCommand,
  RetryCommand,
  StartCommand,
  SteerCommand,
} from "./types"

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

  async retry(command: RetryCommand): Promise<CommandResult> {
    return this.retryUnique(() => this.retryOnce(command))
  }

  async cancelExecution(command: CancelExecutionCommand): Promise<boolean> {
    return this.retryUnique(() => this.db.$transaction((tx) => cancelExecutionInTransaction(tx, command)))
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
      await lockOpenSession(tx, command.sessionId, command.userId)
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
      await lockOpenSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateCommandResult(tx, command, existing, command.delivery)

      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      const expectedTurnId = command.delivery === "steer" || command.expectedTurnId ? command.expectedTurnId : undefined
      await assertExpectedTurn(expectedTurnId, command.expectedRevision, active)
      if (command.delivery === "steer" && command.source === "automation" && active?.source === "user") {
        throw automationCannotSteerUserTurn(active.id)
      }
      if (active?.status === "waiting_for_user" || active?.status === "waiting_for_approval") {
        throw turnWaitRequiresDedicatedAction(active.id, active.status)
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
      await lockOpenSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateInterruptResult(tx, command, existing)

      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      await assertExpectedTurn(command.expectedTurnId, command.expectedRevision, active)
      if (!active) throw activeTurnChanged(command.expectedTurnId, null)
      return interruptActiveTurn(tx, command, active)
    })
  }

  private retryOnce(command: RetryCommand): Promise<CommandResult> {
    return this.db.$transaction(async (tx) => {
      await lockOpenSession(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateCommandResult(tx, command, existing, "follow_up")

      const target = await tx.agentTurn.findFirst({
        where: { id: command.targetTurnId, sessionId: command.sessionId, userId: command.userId },
        select: { id: true, status: true, revision: true, input: true },
      })
      if (!target || !isRetryableTurnStatus(target.status)) throw retryTargetInvalid(command.targetTurnId, target?.status ?? null)
      if (command.expectedRevision !== undefined && command.expectedRevision !== null && command.expectedRevision !== target.revision) {
        throw retryTargetChanged(command.targetTurnId, command.expectedRevision, target.revision)
      }
      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      if (active) throw retryActiveConflict(active.id)
      const persisted = parsePersistedRetryContent(target.id, target.input)

      const created = await createRootTurn(tx, command, persisted.content, persisted.goal)
      const facts = await acceptInputFacts(tx, command, persisted.content, created, "follow_up", "started", true)
      return { ...facts, disposition: "started" as const }
    })
  }

}
