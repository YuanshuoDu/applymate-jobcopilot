import { randomUUID } from "node:crypto"

import type { PrismaClient } from "@prisma/client"
import { AgentCommandError, activeTurnChanged, automationCannotSteerUserTurn, invalidCommand, isUniqueViolation, objectiveReplacementStateConflict, retryActiveConflict, retryTargetChanged, retryTargetInvalid, turnWaitRequiresDedicatedAction } from "./errors"
import { assertContent, dispositionFromEvent } from "./command-content"
import { cancelExecutionInTransaction, interruptActiveTurn, type CancelExecutionCommand } from "./execution-cancellation"
import { isRetryableTurnStatus, parsePersistedRetryContent } from "./retry-input"
import { assertSteeringCapacity } from "./steering-capacity"
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
import { lockOwnedSessionForObjectiveReplacement } from "./session-control"
import type {
  CommandDisposition,
  CommandResult,
  InterruptCommand,
  InterruptResult,
  MessageCommand,
  RetryCommand,
  ReplaceObjectiveCommand,
  StartCommand,
  SteerCommand,
} from "./types"

function activeTurnHasIntent(input: unknown, expected: NonNullable<StartCommand["intent"]>): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const intent = (input as Record<string, unknown>).intent
  return Boolean(intent && typeof intent === "object" && !Array.isArray(intent) &&
    (intent as Record<string, unknown>).kind === expected.kind &&
    (intent as Record<string, unknown>).version === expected.version)
}

export async function duplicateCommandResult(
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

  async replaceObjective(command: ReplaceObjectiveCommand): Promise<CommandResult> {
    if (command.source !== "user") throw invalidCommand("Only a user can replace a Turn objective")
    if (typeof command.expectedTurnId !== "string" || !command.expectedTurnId.trim() || command.expectedTurnId.length > 256
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw invalidCommand("Objective replacement requires the current Turn ID and revision")
    }
    assertContent(command.content)
    const goal = command.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
    if (!goal || new TextEncoder().encode(goal).byteLength > 2_000) {
      throw invalidCommand("Replacement objective must contain 1 to 2,000 UTF-8 bytes")
    }
    return this.retryUnique(() => this.replaceObjectiveOnce(command))
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
      if (command.intent && existingActive && !activeTurnHasIntent(existingActive.input, command.intent)) {
        throw new AgentCommandError("turn_intent_mismatch", "The active Turn has a different server-owned intent", 409, { turnId: existingActive.id })
      }
      const created = !existingActive
      const active = existingActive ?? await createRootTurn(tx, command, command.content, undefined, undefined, command.intent)
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
      if (command.selectedJobPreparation && active) {
        throw new AgentCommandError("selected_job_turn_active", "Stop or finish the active Turn before preparing a selected job", 409, { turnId: active.id })
      }
      const expectedTurnId = command.delivery === "steer" || command.expectedTurnId ? command.expectedTurnId : undefined
      await assertExpectedTurn(expectedTurnId, command.expectedRevision, active)
      if (command.delivery === "steer" && command.source === "automation" && active?.source === "user") {
        throw automationCannotSteerUserTurn(active.id)
      }
      if (active?.status === "waiting_for_user" || active?.status === "waiting_for_approval") {
        throw turnWaitRequiresDedicatedAction(active.id, active.status)
      }

      if (!active) {
        const turn = await createRootTurn(tx, command, command.content, undefined, command.selectedJobPreparation)
        return acceptInputFacts(tx, command, command.content, turn, command.delivery, "started", true)
          .then((facts) => ({ ...facts, disposition: "started" as const }))
      }

      if (command.delivery === "steer" && command.source === "user") {
        await assertSteeringCapacity(tx, { sessionId: command.sessionId, userId: command.userId, turnId: active.id })
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

  private replaceObjectiveOnce(command: ReplaceObjectiveCommand): Promise<CommandResult> {
    return this.db.$transaction(async (tx) => {
      const sessionStatus = await lockOwnedSessionForObjectiveReplacement(tx, command.sessionId, command.userId)
      const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
      if (existing) return duplicateCommandResult(tx, command, existing, "follow_up")
      if (sessionStatus !== "running") throw objectiveReplacementStateConflict(sessionStatus)

      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      await assertExpectedTurn(command.expectedTurnId, command.expectedRevision, active)
      if (!active) throw activeTurnChanged(command.expectedTurnId, null)

      const interruptCommand: InterruptCommand = {
        sessionId: command.sessionId,
        userId: command.userId,
        clientMessageId: randomUUID(),
        source: "user",
        expectedTurnId: active.id,
        expectedRevision: active.revision,
      }
      await interruptActiveTurn(tx, interruptCommand, active)

      const successor = await createRootTurn(tx, command, command.content)
      const accepted = await acceptInputFacts(
        tx, command, command.content, successor, "follow_up", "started", true,
      )
      return { ...accepted, disposition: "started" }
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

      const created = await createRootTurn(tx, command, persisted.content, persisted.goal, persisted.selectedJobPreparation, persisted.intent)
      const facts = await acceptInputFacts(tx, command, persisted.content, created, "follow_up", "started", true)
      return { ...facts, disposition: "started" as const }
    })
  }

}
