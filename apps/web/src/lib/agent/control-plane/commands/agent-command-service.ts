import type { PrismaClient } from "@prisma/client"
import type { InputContentPart } from "@jobcopilot/agent-protocol"

import { AgentCommandError, activeTurnChanged, automationCannotSteerUserTurn, invalidCommand, isUniqueViolation, retryActiveConflict, retryInputInvalid, retryTargetChanged, retryTargetInvalid } from "./errors"
import { cancelExecutionInTransaction, interruptActiveTurn, type CancelExecutionCommand } from "./execution-cancellation"
import {
  acceptInputFacts,
  assertExpectedTurn,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  fallbackDisposition,
  lockOpenSession,
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

type CommandEvent = { sequence: bigint; payload: unknown }
type OriginalDisposition = Exclude<CommandDisposition, "duplicate"> | "interrupted"

const RETRYABLE_STATUSES = new Set(["failed", "interrupted", "cancelled"])
const MAX_RETRY_PARTS = 32
const MAX_RETRY_ATTACHMENT_REFS = 8
const MAX_RETRY_TEXT_BYTES = 20_000
const MAX_RETRY_CONTENT_BYTES = 256 * 1024

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && new TextEncoder().encode(value).byteLength <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)
}

function boundedGoal(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && new TextEncoder().encode(value).byteLength <= MAX_RETRY_CONTENT_BYTES && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
}

function persistedRetryContent(turnId: string, value: unknown): { goal: string; content: InputContentPart[] } {
  if (!isRecord(value) || !exactKeys(value, ["goal", "content", "clientMessageId"]) ||
    !boundedGoal(value.goal) || (value.clientMessageId !== undefined && !boundedString(value.clientMessageId, 256)) ||
    !Array.isArray(value.content) || value.content.length < 1 || value.content.length > MAX_RETRY_PARTS) throw retryInputInvalid(turnId)
  const content: InputContentPart[] = []
  let attachmentCount = 0
  for (const part of value.content) {
    if (!isRecord(part) || typeof part.type !== "string") throw retryInputInvalid(turnId)
    if (part.type === "text") {
      if (Object.keys(part).length !== 2 || !boundedString(part.text, MAX_RETRY_TEXT_BYTES)) throw retryInputInvalid(turnId)
      content.push({ type: "text", text: part.text })
    } else if (part.type === "attachment_ref") {
      if (!exactKeys(part, ["type", "attachmentId", "mediaType", "filename"]) || !boundedString(part.attachmentId, 256) || !boundedString(part.mediaType, 256) || (part.filename !== undefined && !boundedString(part.filename, 256))) throw retryInputInvalid(turnId)
      attachmentCount += 1
      if (attachmentCount > MAX_RETRY_ATTACHMENT_REFS) throw retryInputInvalid(turnId)
      content.push({ type: "attachment_ref", attachmentId: part.attachmentId, mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }) })
    } else throw retryInputInvalid(turnId)
  }
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > MAX_RETRY_CONTENT_BYTES) throw retryInputInvalid(turnId)
  return { goal: value.goal, content }
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
      if (!target || !RETRYABLE_STATUSES.has(target.status)) throw retryTargetInvalid(command.targetTurnId, target?.status ?? null)
      if (command.expectedRevision !== undefined && command.expectedRevision !== null && command.expectedRevision !== target.revision) {
        throw retryTargetChanged(command.targetTurnId, command.expectedRevision, target.revision)
      }
      const active = await findActiveTurn(tx, command.sessionId, command.userId)
      if (active) throw retryActiveConflict(active.id)
      const persisted = persistedRetryContent(target.id, target.input)

      const created = await createRootTurn(tx, command, persisted.content, persisted.goal)
      const facts = await acceptInputFacts(tx, command, persisted.content, created, "follow_up", "started", true)
      return { ...facts, disposition: "started" as const }
    })
  }
}
