import type { PrismaClient } from "@prisma/client"
import {
  parseVerifiedShortlistJobIds, parseVerifiedShortlistSourceIdentity, SELECTED_JOB_BATCH_PREPARATION_INTENT,
  TurnIntentSchema, validate, type InputContentPart,
} from "@jobcopilot/agent-protocol"

import { invalidCommand, objectiveStartIdempotencyConflict, objectiveStartStateConflict, retryActiveConflict } from "./errors"
import { lockOwnedSessionForObjectiveReplacement } from "./session-control"
import {
  acceptInputFacts, commandEventKey, createRootTurn, findActiveTurn, findExistingCommand, type CommandTransaction,
} from "./transaction"
import { sameVerifiedShortlistSelectionBinding, verifyVerifiedShortlistSelection } from "./verified-shortlist-selection"
import type { CommandIdentity, CommandResult } from "./types"

export type SelectedJobBatchCommand = Readonly<CommandIdentity & {
  sourceIdentity: unknown
  selectedJobIds: unknown
}>

type ParsedCommand = CommandIdentity & Readonly<{
  source: "user"
  sourceIdentity: NonNullable<ReturnType<typeof parseVerifiedShortlistSourceIdentity>>
  selectedJobIds: readonly string[]
}>

const BATCH_GOAL = "Prepare draft materials for the selected Jobs from the verified shortlist. Do not submit applications."
const BATCH_CONTENT: InputContentPart[] = [{ type: "text", text: BATCH_GOAL }]

export class SelectedJobBatchCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(value: SelectedJobBatchCommand): Promise<CommandResult> {
    const command = parseCommand(value)
    if (!command) throw invalidCommand("Selected Job batch command is invalid")
    return this.db.$transaction(tx => startInTransaction(tx, command))
  }
}

async function startInTransaction(tx: CommandTransaction, command: ParsedCommand): Promise<CommandResult> {
  const sessionStatus = await lockOwnedSessionForObjectiveReplacement(tx, command.sessionId, command.userId)
  const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
  if (existing) {
    const binding = await verifyVerifiedShortlistSelection(tx, { id: command.sessionId, userId: command.userId },
      command.sourceIdentity, command.selectedJobIds)
    if (!binding || !sameVerifiedShortlistSelectionBinding(binding, await storedBatchBinding(tx, command, existing.targetTurnId))) {
      throw objectiveStartIdempotencyConflict()
    }
    return replayAcceptedCommand(tx, command, existing)
  }
  if (sessionStatus !== "running") throw objectiveStartStateConflict(sessionStatus)

  const binding = await verifyVerifiedShortlistSelection(tx, { id: command.sessionId, userId: command.userId },
    command.sourceIdentity, command.selectedJobIds)
  if (!binding) throw invalidCommand("The verified shortlist or selected Jobs are no longer available")
  const active = await findActiveTurn(tx, command.sessionId, command.userId)
  if (active) throw retryActiveConflict(active.id)

  const turn = await createRootTurn(tx, command, BATCH_CONTENT, BATCH_GOAL, undefined,
    SELECTED_JOB_BATCH_PREPARATION_INTENT, undefined, binding)
  const accepted = await acceptInputFacts(tx, command, BATCH_CONTENT, turn, "follow_up", "started", true)
  return { ...accepted, disposition: "started" }
}

async function storedBatchBinding(tx: CommandTransaction, command: ParsedCommand, turnId: string | null) {
  if (!turnId) return null
  const turn = await tx.agentTurn.findFirst({
    where: { id: turnId, sessionId: command.sessionId, userId: command.userId },
    select: { id: true, sessionId: true, userId: true, source: true, executionMode: true, input: true },
  })
  const input = dataRecord(turn?.input, ["clientMessageId", "content", "goal", "intent", "verifiedShortlistSelection"])
  const intent = input ? dataRecord(input.intent, ["kind", "version"]) : null
  if (!turn || turn.id !== turnId || turn.sessionId !== command.sessionId || turn.userId !== command.userId
    || turn.source !== "user" || turn.executionMode !== "canonical_task_graph" || !input
    || input.clientMessageId !== command.clientMessageId || input.goal !== BATCH_GOAL || !sameContent(input.content)
    || !intent || !validate(TurnIntentSchema, intent) || intent.kind !== SELECTED_JOB_BATCH_PREPARATION_INTENT.kind
    || intent.version !== SELECTED_JOB_BATCH_PREPARATION_INTENT.version) return null
  return input.verifiedShortlistSelection
}

async function replayAcceptedCommand(
  tx: CommandTransaction,
  command: ParsedCommand,
  existing: NonNullable<Awaited<ReturnType<typeof findExistingCommand>>>,
): Promise<CommandResult> {
  if (!existing.targetTurnId || existing.delivery !== "follow_up") throw objectiveStartIdempotencyConflict()
  const saved = await tx.agentInput.findFirst({
    where: { id: existing.id, sessionId: command.sessionId, userId: command.userId, clientMessageId: command.clientMessageId },
    select: { id: true, userId: true, sessionId: true, targetTurnId: true, delivery: true, status: true, content: true,
      acceptedSequence: true, consumedByStepId: true, consumedAt: true, cancelledAt: true },
  })
  const step = saved?.status === "consumed" && typeof saved.consumedByStepId === "string"
    ? await tx.agentStep.findFirst({ where: { id: saved.consumedByStepId, sessionId: command.sessionId, turnId: existing.targetTurnId },
      select: { id: true, sessionId: true, turnId: true, inputThroughSequence: true, consumedInputIds: true } }) : null
  const event = await tx.agentEvent.findFirst({
    where: { sessionId: command.sessionId, idempotencyKey: commandEventKey(command.clientMessageId) },
    select: { type: true, actor: true, turnId: true, sequence: true, payload: true },
  })
  const payload = dataRecord(event?.payload, ["clientMessageId", "delivery", "disposition", "inputId", "source"])
  if (!saved || saved.id !== existing.id || saved.userId !== command.userId || saved.sessionId !== command.sessionId
    || saved.targetTurnId !== existing.targetTurnId || saved.delivery !== "follow_up" || saved.cancelledAt !== null
    || !validConsumption(saved, step) || !sameContent(saved.content) || !event || event.type !== "input.accepted"
    || String(saved.acceptedSequence) !== String(existing.acceptedSequence) || event.actor !== "user"
    || event.turnId !== existing.targetTurnId || String(event.sequence) !== String(existing.acceptedSequence)
    || !payload || payload.clientMessageId !== command.clientMessageId || payload.inputId !== existing.id
    || payload.delivery !== "follow_up" || payload.disposition !== "started" || payload.source !== "user") {
    throw objectiveStartIdempotencyConflict()
  }
  return { inputId: existing.id, turnId: existing.targetTurnId, disposition: "duplicate",
    originalDisposition: "started", sequence: String(event.sequence) }
}

function parseCommand(value: unknown): ParsedCommand | null {
  const row = dataRecord(value, ["clientMessageId", "selectedJobIds", "sessionId", "source", "sourceIdentity", "userId"])
  if (!row || row.source !== "user" || !boundedId(row.userId) || !boundedId(row.clientMessageId)) return null
  const sourceIdentity = parseVerifiedShortlistSourceIdentity(row.sourceIdentity)
  const selectedJobIds = parseVerifiedShortlistJobIds(row.selectedJobIds)
  if (!sourceIdentity || sourceIdentity.sessionId !== row.sessionId || !selectedJobIds) return null
  return { sessionId: row.sessionId, userId: row.userId, clientMessageId: row.clientMessageId, source: "user",
    sourceIdentity, selectedJobIds }
}

function sameContent(value: unknown): boolean {
  try {
    if (!Array.isArray(value) || value.length !== 1 || Reflect.ownKeys(value).length !== 2) return false
    const part = dataRecord(value[0], ["type", "text"])
    return part?.type === "text" && part.text === BATCH_GOAL
  } catch { return false }
}

function validConsumption(value: unknown, step: unknown): boolean {
  const saved = dataRecord(value)
  if (!saved) return false
  if (saved.status === "accepted" || saved.status === "queued") {
    return saved.consumedByStepId === null && saved.consumedAt === null
  }
  if (saved.status !== "consumed" || typeof saved.consumedByStepId !== "string"
    || !(saved.consumedAt instanceof Date) || !Number.isFinite(saved.consumedAt.getTime())) return false
  const row = dataRecord(step, ["id", "sessionId", "turnId", "inputThroughSequence", "consumedInputIds"])
  if (!row || row.id !== saved.consumedByStepId || row.sessionId !== saved.sessionId || row.turnId !== saved.targetTurnId
    || !Array.isArray(row.consumedInputIds) || !row.consumedInputIds.every(id => typeof id === "string")
    || !row.consumedInputIds.includes(String(saved.id))) return false
  try { return BigInt(String(row.inputThroughSequence)) >= BigInt(String(saved.acceptedSequence)) } catch { return false }
}

function boundedId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 }

function dataRecord(value: unknown, expectedKeys?: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const keys = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string")
      || (expectedKeys && (keys.length !== expectedKeys.length || keys.some(key => !expectedKeys.includes(key as string))))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}
