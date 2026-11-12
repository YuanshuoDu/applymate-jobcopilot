import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { InputContentPartSchema, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, TurnIntentSchema, validate, type InputContentPart } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"

import { objectiveStartIdempotencyConflict } from "./errors"
import { stateWithAvailableReceiptTarget } from "./objective-start-attempt-read-model"
import type { CommandTransaction } from "./transaction"
import { parseObjectiveVerificationRequirements, type ObjectiveStartCommand } from "./types"

export { listObjectiveStartAttempts } from "./objective-start-attempt-read-model"

export type ObjectiveStartReceipt = Readonly<{
  sessionId: string
  inputId: string
  turnId: string
  sequence: string
}>

export type ObjectiveStartAttemptState =
  | Readonly<{ state: "accepted"; receipt: ObjectiveStartReceipt }>
  | Readonly<{ state: "abandoned" }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "unknown" }>

type LedgerRow = {
  status: "accepted" | "abandoned"
  sessionId: string | null
  requestHash: string | null
  inputId: string | null
  turnId: string | null
  acceptedSequence: bigint | null
}

type LegacyLookup =
  | { kind: "none" }
  | { kind: "not_objective" }
  | { kind: "unverified" }
  | { kind: "accepted"; requestHash: string; receipt: ObjectiveStartReceipt }

type LegacyInputLifecycle = { status: string; consumedByStepId: string | null; consumedAt: Date | null; cancelledAt: Date | null }

type AttemptIdentity = Pick<ObjectiveStartCommand, "userId" | "clientMessageId" | "sessionId" | "objective" | "content" | "verificationRequirements">

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function persistedCanonicalJson(value: unknown): string { return canonicalJson(JSON.parse(JSON.stringify(value) ?? "null")) }

function sameJson(left: unknown, right: unknown): boolean {
  try { return persistedCanonicalJson(left) === persistedCanonicalJson(right) } catch { return false }
}

function validLegacyInputLifecycle(input: LegacyInputLifecycle): boolean {
  const hasConsumer = typeof input.consumedByStepId === "string" && input.consumedByStepId.length > 0
  const hasConsumedAt = input.consumedAt instanceof Date && Number.isFinite(input.consumedAt.getTime())
  const hasCancelledAt = input.cancelledAt instanceof Date && Number.isFinite(input.cancelledAt.getTime())
  if (input.status === "accepted" || input.status === "queued") return !hasConsumer && input.consumedAt === null && input.cancelledAt === null
  if (input.status === "consumed") return hasConsumer && hasConsumedAt && input.cancelledAt === null
  return input.status === "cancelled" && hasCancelledAt && hasConsumer === hasConsumedAt
}

export function objectiveStartRequestHash(command: AttemptIdentity): string {
  const hasRequirements = Object.hasOwn(command, "verificationRequirements")
  const canonical = {
    sessionId: command.sessionId,
    objective: command.objective.trim(),
    content: command.content,
    verificationRequirements: hasRequirements
      ? { present: true, value: command.verificationRequirements ?? null }
      : { present: false },
  }
  return createHash("sha256").update(persistedCanonicalJson(canonical)).digest("hex")
}

export async function lockObjectiveStartAttempt(tx: CommandTransaction, userId: string, clientMessageId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      'applymate:objective-start-attempt:' || ${userId}::text || ':' || ${clientMessageId}::text,
      0
    ))::text AS lock_acquired
  `)
}

async function storedAttempt(tx: CommandTransaction, userId: string, clientMessageId: string): Promise<LedgerRow | null> {
  return tx.agentObjectiveStartAttempt.findUnique({
    where: { userId_clientMessageId: { userId, clientMessageId } },
    select: { status: true, sessionId: true, requestHash: true, inputId: true, turnId: true, acceptedSequence: true },
  })
}

function receiptFromRow(row: LedgerRow): ObjectiveStartReceipt {
  if (row.status !== "accepted" || !row.sessionId || !row.inputId || !row.turnId || row.acceptedSequence === null) {
    throw new Error("Accepted objective start ledger row has an incomplete receipt")
  }
  return { sessionId: row.sessionId, inputId: row.inputId, turnId: row.turnId, sequence: row.acceptedSequence.toString() }
}

function stateFromRow(row: LedgerRow): ObjectiveStartAttemptState {
  return row.status === "abandoned" ? { state: "abandoned" } : { state: "accepted", receipt: receiptFromRow(row) }
}

async function findLegacyObjectiveStart(tx: CommandTransaction, userId: string, clientMessageId: string): Promise<LegacyLookup> {
  const inputs = await tx.agentInput.findMany({
    where: { userId, clientMessageId },
    take: 2,
    select: {
      id: true, userId: true, sessionId: true, clientMessageId: true, targetTurnId: true,
      delivery: true, status: true, content: true, acceptedSequence: true,
      consumedByStepId: true, consumedAt: true, cancelledAt: true,
      session: { select: { userId: true } },
      targetTurn: { select: { id: true, userId: true, sessionId: true, source: true, input: true } },
    },
  })
  if (inputs.length === 0) return { kind: "none" }
  if (inputs.length !== 1) return { kind: "unverified" }
  const input = inputs[0]
  if (!input || !input.targetTurnId || !input.session || !input.targetTurn) return { kind: "unverified" }
  const turnInput = record(input.targetTurn.input)
  const intent = turnInput?.intent
  if (record(intent)?.kind !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind) return { kind: "not_objective" }
  if (!validate(TurnIntentSchema, intent)) return { kind: "unverified" }

  const content = turnInput?.content
  const objective = turnInput?.goal
  const requirementsPresent = turnInput !== null && Object.hasOwn(turnInput, "verificationRequirements")
  const rawRequirements = turnInput?.verificationRequirements
  const requirements = rawRequirements === null ? null : parseObjectiveVerificationRequirements(rawRequirements)
  if (input.userId !== userId || input.session.userId !== userId || input.targetTurn.userId !== userId
    || input.sessionId !== input.targetTurn.sessionId || input.targetTurn.id !== input.targetTurnId
    || input.clientMessageId !== clientMessageId
    || input.delivery !== "follow_up" || !validLegacyInputLifecycle(input)
    || turnInput?.clientMessageId !== clientMessageId || input.targetTurn.source !== "user"
    || typeof objective !== "string" || !objective || objective !== objective.trim()
    || !Array.isArray(content) || !content.every((part) => validate(InputContentPartSchema, part))
    || !sameJson(content, input.content)
    || (requirementsPresent && rawRequirements !== null && requirements === null)) return { kind: "unverified" }

  const event = await tx.agentEvent.findFirst({
    where: { sessionId: input.sessionId, idempotencyKey: `agent-command:${clientMessageId}` },
    select: { type: true, actor: true, turnId: true, sequence: true, payload: true },
  })
  const payload = record(event?.payload)
  if (event?.type !== "input.accepted" || event.actor !== "user" || event.turnId !== input.targetTurnId
    || event.sequence !== input.acceptedSequence || payload?.inputId !== input.id
    || payload.clientMessageId !== clientMessageId || payload.source !== "user" || payload.delivery !== "follow_up" || payload.disposition !== "started") {
    return { kind: "unverified" }
  }

  const requestHash = objectiveStartRequestHash({
    userId, clientMessageId, sessionId: input.sessionId, objective,
    content: content as InputContentPart[],
    ...(requirementsPresent ? { verificationRequirements: requirements } : {}),
  })
  return {
    kind: "accepted", requestHash,
    receipt: { sessionId: input.sessionId, inputId: input.id, turnId: input.targetTurnId, sequence: input.acceptedSequence.toString() },
  }
}

async function createAcceptedAttempt(
  tx: CommandTransaction,
  userId: string,
  clientMessageId: string,
  requestHash: string,
  receipt: ObjectiveStartReceipt,
): Promise<void> {
  await tx.agentObjectiveStartAttempt.create({
    data: {
      userId, clientMessageId, status: "accepted", requestHash,
      sessionId: receipt.sessionId, inputId: receipt.inputId, turnId: receipt.turnId,
      acceptedSequence: BigInt(receipt.sequence),
    },
  })
}

export async function getObjectiveStartAttempt(
  db: PrismaClient,
  userId: string,
  clientMessageId: string,
): Promise<ObjectiveStartAttemptState> {
  const row = await db.agentObjectiveStartAttempt.findUnique({
    where: { userId_clientMessageId: { userId, clientMessageId } },
    select: { status: true, sessionId: true, requestHash: true, inputId: true, turnId: true, acceptedSequence: true },
  }) as LedgerRow | null
  if (row) return stateWithAvailableReceiptTarget(db, userId, stateFromRow(row))
  return db.$transaction(async (tx) => {
    const legacy = await findLegacyObjectiveStart(tx, userId, clientMessageId)
    return legacy.kind === "accepted"
      ? stateWithAvailableReceiptTarget(tx, userId, { state: "accepted", receipt: legacy.receipt })
      : { state: "unknown" }
  })
}

export async function abandonObjectiveStartAttempt(
  db: PrismaClient,
  userId: string,
  clientMessageId: string,
): Promise<ObjectiveStartAttemptState> {
  return db.$transaction(async (tx) => {
    await lockObjectiveStartAttempt(tx, userId, clientMessageId)
    const row = await storedAttempt(tx, userId, clientMessageId)
    if (row) return stateWithAvailableReceiptTarget(tx, userId, stateFromRow(row))
    const legacy = await findLegacyObjectiveStart(tx, userId, clientMessageId)
    if (legacy.kind === "accepted") {
      await createAcceptedAttempt(tx, userId, clientMessageId, legacy.requestHash, legacy.receipt)
      return stateWithAvailableReceiptTarget(tx, userId, { state: "accepted", receipt: legacy.receipt })
    }
    if (legacy.kind === "unverified") return { state: "unknown" }
    await tx.agentObjectiveStartAttempt.create({ data: { userId, clientMessageId, status: "abandoned" } })
    return { state: "abandoned" }
  })
}

export async function recordAcceptedObjectiveStart(
  tx: CommandTransaction,
  command: ObjectiveStartCommand,
  requestHash: string,
  receipt: ObjectiveStartReceipt,
): Promise<void> {
  await createAcceptedAttempt(tx, command.userId, command.clientMessageId, requestHash, receipt)
}

export async function lookupAttemptForStart(
  tx: CommandTransaction,
  command: ObjectiveStartCommand,
  requestHash: string,
): Promise<ObjectiveStartReceipt | null> {
  const row = await storedAttempt(tx, command.userId, command.clientMessageId)
  if (row) {
    if (row.status !== "accepted" || row.requestHash !== requestHash || row.sessionId !== command.sessionId) {
      throw objectiveStartIdempotencyConflict()
    }
    return receiptFromRow(row)
  }
  const legacy = await findLegacyObjectiveStart(tx, command.userId, command.clientMessageId)
  if (legacy.kind === "none") return null
  if (legacy.kind !== "accepted") throw objectiveStartIdempotencyConflict()
  if (legacy.requestHash !== requestHash || legacy.receipt.sessionId !== command.sessionId) {
    throw objectiveStartIdempotencyConflict()
  }
  await createAcceptedAttempt(tx, command.userId, command.clientMessageId, legacy.requestHash, legacy.receipt)
  return legacy.receipt
}

export function isValidAttemptKey(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && value === value.trim()
}
