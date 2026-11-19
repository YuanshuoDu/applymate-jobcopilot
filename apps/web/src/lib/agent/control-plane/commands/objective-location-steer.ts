import { Prisma, type PrismaClient } from "@prisma/client"
import {
  OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE,
  OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  ObjectiveLocationSteerReceiptSchema,
  ObjectiveLocationSteerRequestSchema,
  formatObjectiveLocationSteerMessage,
  validate,
  type ObjectiveLocationSteerRequest,
} from "@jobcopilot/agent-protocol"
import { canonicalJson, normalizeAgentLocationAllowlist, redactSensitiveText } from "@jobcopilot/shared"
import { appendAgentEventWithOutboxInTransaction } from "../../session/fact-store"
import { AgentCommandError, activeTurnChanged, invalidCommand, isUniqueViolation } from "./errors"
import { acceptInputFacts, commandEventKey, lockOpenSession, type ActiveTurn, type CommandTransaction } from "./transaction"
import { assertSteeringCapacity } from "./steering-capacity"
import type { CommandResult } from "./types"

const REQUEST_KEYS = ["clientMessageId", "expectedRevision", "expectedTurnId", "locations", "schemaVersion"]
const COMMAND_KEYS = [...REQUEST_KEYS, "sessionId", "userId"]
const ACCEPTED_INPUT_STATUSES = new Set(["accepted", "queued", "consumed"])
const MAX_SAFE_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER)
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu

type Command = ObjectiveLocationSteerRequest & Readonly<{ sessionId: string; userId: string }>
type TurnRow = Readonly<{ id: string; sessionId: string; userId: string; source: string; status: string; revision: number; rootTaskId: string | null; executionMode: string | null; input: unknown; leaseOwnerId: string | null; leaseExpiresAt: Date | string | null }>
type RootRow = Readonly<{ id: string; sessionId: string; userId: string; turnId: string; rootTaskId: string | null; parentTaskId: string | null; path: string; depth: number; role: string; taskType: string; status: string; interruptRequestedAt: unknown; leaseOwner: string | null; leaseExpiresAt: Date | string | null }>
type StoredInput = Readonly<{ id: string; sessionId: string; userId: string; targetTurnId: string | null; clientMessageId: string; delivery: string; status: string; content: unknown; acceptedSequence: unknown }>
type StoredEvent = Readonly<{ id: string; sessionId: string; turnId: string; itemId: string | null; taskId: string | null; type: string; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string | null; sequence: unknown; payload: unknown }>

function invalid(): AgentCommandError { return invalidCommand("The confirmed location steer is invalid") }
function conflict(): AgentCommandError { return new AgentCommandError("invalid_command", "The location steer could not be verified or its idempotency key has another scope", 409) }

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const ownKeys = Reflect.ownKeys(value)
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}
function denseLocations(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 8) return null
    const keys = Reflect.ownKeys(value), length = value.length
    if (keys.length !== length + 1 || keys.some(key => key !== "length" && (typeof key !== "string"
      || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) return null
    const rows: string[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return null
      rows.push(descriptor.value)
    }
    return rows
  } catch { return null }
}
function snapshotCommand(value: unknown): { command: Command; locations: readonly string[] } {
  const row = exactDataRecord(value, COMMAND_KEYS), rawLocations = denseLocations(row?.locations)
  if (!row || !rawLocations) throw invalid()
  const request = { schemaVersion: row.schemaVersion, clientMessageId: row.clientMessageId, expectedTurnId: row.expectedTurnId, expectedRevision: row.expectedRevision, locations: rawLocations }
  if (!validate(ObjectiveLocationSteerRequestSchema, request) || typeof row.sessionId !== "string" || !row.sessionId.trim() || row.sessionId.length > 256
    || typeof row.userId !== "string" || !row.userId.trim() || row.userId.length > 256) throw invalid()
  const locations = normalizeAgentLocationAllowlist(rawLocations)
  if (!locations || !validate(ObjectiveLocationSteerRequestSchema, { ...request, locations })) throw invalid()
  return { command: { ...request, sessionId: row.sessionId, userId: row.userId } as Command, locations }
}
function intentMatches(input: unknown): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false
    const descriptor = Object.getOwnPropertyDescriptor(input, "intent")
    const intent = descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable
      ? exactDataRecord(descriptor.value, ["kind", "version"]) : null
    return intent?.kind === "objective_task_graph_execution" && intent.version === 1
  } catch { return false }
}
function sequence(value: unknown): bigint | null {
  try {
    const parsed = typeof value === "bigint" ? value
      : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value)
        : typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) ? BigInt(value) : null
    return parsed !== null && parsed > BigInt(0) && parsed <= BigInt("9223372036854775807") ? parsed : null
  } catch { return null }
}
function acceptedSequence(value: unknown): bigint | null { const parsed = sequence(value); return parsed !== null && parsed <= MAX_SAFE_SEQUENCE ? parsed : null }
function textPartsMatch(value: unknown, text: string): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 1 || Reflect.ownKeys(value).length !== 2) return false
  const slot = Object.getOwnPropertyDescriptor(value, "0"), part = slot && slot.enumerable && Object.hasOwn(slot, "value")
    ? exactDataRecord(slot.value, ["text", "type"]) : null
  return !!part && part.type === "text" && part.text === text
}
function itemContentMatches(value: unknown, command: Command, text: string): boolean {
  const row = exactDataRecord(value, ["clientMessageId", "disposition", "parts", "source"])
  return !!row && row.clientMessageId === command.clientMessageId && row.source === "user" && row.disposition === "steered"
    && textPartsMatch(row.parts, text)
}
function redactedIdMatches(value: unknown, id: string): boolean { return value === id || UUID.test(id) && value === redactSensitiveText(id) }
function acceptedEventMatches(value: unknown, command: Command, inputId: string, inputSequence: bigint): value is StoredEvent {
  const event = exactDataRecord(value, ["actor", "causationId", "correlationId", "id", "idempotencyKey", "itemId", "payload",
    "sequence", "sessionId", "taskId", "turnId", "type"])
  const payload = exactDataRecord(event?.payload, ["clientMessageId", "delivery", "disposition", "inputId", "source"])
  return !!event && !!payload && typeof event.id === "string" && event.sessionId === command.sessionId
    && event.turnId === command.expectedTurnId && event.itemId !== null && event.taskId === null
    && event.type === "input.accepted" && event.actor === "user" && event.correlationId === command.expectedTurnId
    && event.causationId === null && event.idempotencyKey === commandEventKey(command.clientMessageId)
    && redactedIdMatches(payload.inputId, inputId) && payload.clientMessageId === redactSensitiveText(command.clientMessageId) && payload.delivery === "steer"
    && payload.source === "user" && payload.disposition === "steered" && sequence(event.sequence) === inputSequence
}
function receiptMatches(value: unknown, command: Command, rootTaskId: string, acceptedEvent: StoredEvent,
  inputSequence: bigint, locations: readonly string[]): value is StoredEvent {
  const event = exactDataRecord(value, ["actor", "causationId", "correlationId", "id", "idempotencyKey", "itemId", "payload",
    "sequence", "sessionId", "taskId", "turnId", "type"])
  const payload = exactDataRecord(event?.payload, ["acceptedInputSequence", "locations", "schemaVersion"])
  const rawLocations = denseLocations(payload?.locations)
  const receipt = payload && rawLocations ? { schemaVersion: payload.schemaVersion,
    acceptedInputSequence: payload.acceptedInputSequence, locations: rawLocations } : null
  const eventSequence = sequence(event?.sequence)
  return !!event && !!receipt && validate(ObjectiveLocationSteerReceiptSchema, receipt)
    && receipt.schemaVersion === OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION
    && receipt.acceptedInputSequence === Number(inputSequence) && canonicalJson(receipt.locations) === canonicalJson(locations)
    && event.idempotencyKey === receiptEventKey(command) && event.sessionId === command.sessionId
    && event.turnId === command.expectedTurnId && event.itemId === null && event.taskId === rootTaskId
    && event.type === OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE && event.actor === "user"
    && event.correlationId === command.expectedTurnId && event.causationId === acceptedEvent.id
    && eventSequence !== null && eventSequence > inputSequence
}
function receiptEventKey(command: Command): string {
  return `agent-objective-locations:${command.clientMessageId}:${command.expectedRevision}`
}
async function acceptedFacts(tx: CommandTransaction, command: Command, locations: readonly string[]): Promise<{
  input: StoredInput; acceptedEvent: StoredEvent; sequence: bigint; message: string
}> {
  const rows = await tx.agentInput.findMany({ where: { sessionId: command.sessionId, clientMessageId: command.clientMessageId },
    select: { id: true, sessionId: true, userId: true, targetTurnId: true, clientMessageId: true, delivery: true,
      status: true, content: true, acceptedSequence: true } }) as unknown as StoredInput[]
  if (rows.length !== 1) throw conflict()
  const input = exactDataRecord(rows[0], ["acceptedSequence", "clientMessageId", "content", "delivery", "id", "sessionId", "status", "targetTurnId", "userId"]) as StoredInput | null
  const message = formatObjectiveLocationSteerMessage(locations), inputSequence = acceptedSequence(input?.acceptedSequence)
  if (!input || !inputSequence || input.id.length === 0 || input.sessionId !== command.sessionId || input.userId !== command.userId
    || input.targetTurnId !== command.expectedTurnId || input.clientMessageId !== command.clientMessageId || input.delivery !== "steer"
    || !ACCEPTED_INPUT_STATUSES.has(input.status) || !textPartsMatch(input.content, message)) throw conflict()
  const eventRow = await tx.agentEvent.findFirst({ where: { sessionId: command.sessionId, idempotencyKey: commandEventKey(command.clientMessageId) },
    select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
      correlationId: true, causationId: true, idempotencyKey: true, sequence: true, payload: true } })
  if (!acceptedEventMatches(eventRow, command, input.id, inputSequence)) throw conflict()
  const itemRow = await tx.agentItem.findFirst({ where: { id: eventRow.itemId!, sessionId: command.sessionId, turnId: command.expectedTurnId },
    select: { id: true, sessionId: true, turnId: true, taskId: true, stepId: true, type: true, status: true, phase: true, revision: true, content: true } })
  const item = exactDataRecord(itemRow, ["content", "id", "phase", "revision", "sessionId", "status", "stepId", "taskId", "turnId", "type"])
  if (!item || item.id !== eventRow.itemId || item.sessionId !== command.sessionId || item.turnId !== command.expectedTurnId
    || item.taskId !== null || item.stepId !== null || item.type !== "user_message" || item.status !== "completed"
    || item.phase !== "commentary" || item.revision !== 0 || !itemContentMatches(item.content, command, message)) throw conflict()
  return { input, acceptedEvent: eventRow, sequence: inputSequence, message }
}
async function readTurn(tx: CommandTransaction, command: Command): Promise<TurnRow | null> {
  const rows = await tx.$queryRaw<TurnRow[]>(Prisma.sql`SELECT "id", "sessionId", "userId", "source", "status", "revision", "rootTaskId", "executionMode", "input", "leaseOwnerId", "leaseExpiresAt"
    FROM "agent_turns" WHERE "id" = ${command.expectedTurnId} AND "sessionId" = ${command.sessionId} AND "userId" = ${command.userId} FOR UPDATE`)
  return rows.length === 1 ? rows[0]! : null
}
async function readRoot(tx: CommandTransaction, command: Command, rootTaskId: string): Promise<RootRow | null> {
  const rows = await tx.$queryRaw<RootRow[]>(Prisma.sql`SELECT task."id", task."sessionId", session."userId", task."turnId", task."rootTaskId", task."parentTaskId", task."path", task."depth", task."role", task."taskType", task."status", task."interruptRequestedAt", task."leaseOwner", task."leaseExpiresAt"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ${rootTaskId} AND task."sessionId" = ${command.sessionId} AND session."userId" = ${command.userId} AND task."turnId" = ${command.expectedTurnId} FOR UPDATE OF task`)
  return rows.length === 1 ? rows[0]! : null
}
function validRoot(root: RootRow | null, turn: TurnRow, command: Command, rootTaskId: string, active: boolean): boolean {
  return !!root && root.id === rootTaskId && root.sessionId === command.sessionId && root.userId === command.userId
    && root.turnId === command.expectedTurnId && root.rootTaskId === rootTaskId && root.parentTaskId === null
    && root.path === `/${rootTaskId}` && root.depth === 0 && root.role === "orchestrator" && root.taskType === "root"
    && (active ? root.interruptRequestedAt === null && (turn.status === "in_progress"
      ? root.status === "running" && typeof root.leaseOwner === "string" && root.leaseOwner === turn.leaseOwnerId
        && root.leaseExpiresAt !== null && turn.leaseExpiresAt !== null && new Date(root.leaseExpiresAt).getTime() === new Date(turn.leaseExpiresAt).getTime()
      : turn.status === "waiting_for_dependency" && root.status === "waiting" && root.leaseOwner === null && root.leaseExpiresAt === null
        && turn.leaseOwnerId === null && turn.leaseExpiresAt === null) : typeof root.status === "string")
}

function canonicalTurn(turn: TurnRow | null, command: Command, active: boolean): turn is TurnRow {
  return !!turn && turn.id === command.expectedTurnId && turn.sessionId === command.sessionId && turn.userId === command.userId
    && turn.source === "user" && turn.executionMode === "canonical_task_graph" && intentMatches(turn.input)
    && (!active || (turn.status === "in_progress" || turn.status === "waiting_for_dependency")
      && turn.revision === command.expectedRevision)
}

async function replay(tx: CommandTransaction, command: Command, locations: readonly string[]): Promise<CommandResult> {
  const facts = await acceptedFacts(tx, command, locations)
  const turn = await readTurn(tx, command)
  const rootTaskId = turn?.rootTaskId
  if (!canonicalTurn(turn, command, false) || typeof rootTaskId !== "string" || !rootTaskId.trim()) throw conflict()
  const root = await readRoot(tx, command, rootTaskId)
  if (!validRoot(root, turn, command, rootTaskId, false)) throw conflict()
  const receipts = await tx.agentEvent.findMany({ where: { sessionId: command.sessionId, causationId: facts.acceptedEvent.id },
    select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
      correlationId: true, causationId: true, idempotencyKey: true, sequence: true, payload: true } })
  if (receipts.length !== 1 || !receiptMatches(receipts[0], command, rootTaskId, facts.acceptedEvent, facts.sequence, locations)) throw conflict()
  return { inputId: facts.input.id, turnId: command.expectedTurnId, disposition: "duplicate",
    originalDisposition: "steered", sequence: facts.sequence.toString() }
}

async function accept(tx: CommandTransaction, command: Command, locations: readonly string[]): Promise<CommandResult> {
  await lockOpenSession(tx, command.sessionId, command.userId)
  const existing = await tx.agentInput.findMany({ where: { sessionId: command.sessionId, clientMessageId: command.clientMessageId }, select: { id: true } })
  if (existing.length) return replay(tx, command, locations)
  const turn = await readTurn(tx, command)
  const actualTurnId = turn?.id ?? null
  if (!canonicalTurn(turn, command, true)) throw activeTurnChanged(command.expectedTurnId, actualTurnId)
  if (typeof turn.rootTaskId !== "string" || !turn.rootTaskId.trim()) throw conflict()
  const root = await readRoot(tx, command, turn.rootTaskId)
  if (!validRoot(root, turn, command, turn.rootTaskId, true)) throw conflict()
  await assertSteeringCapacity(tx, { sessionId: command.sessionId, userId: command.userId, turnId: turn.id })

  const message = formatObjectiveLocationSteerMessage(locations), identity = { sessionId: command.sessionId, userId: command.userId,
    clientMessageId: command.clientMessageId, source: "user" as const }
  const facts = await acceptInputFacts(tx, identity, [{ type: "text", text: message }],
    { id: turn.id, source: "user", status: turn.status, revision: turn.revision } satisfies ActiveTurn,
    "steer", "steered", false)
  const accepted = await acceptedFacts(tx, command, locations)
  if (accepted.input.id !== facts.inputId || accepted.sequence.toString() !== facts.sequence) throw conflict()
  const payload = { schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
    acceptedInputSequence: Number(accepted.sequence), locations: [...locations] }
  if (!validate(ObjectiveLocationSteerReceiptSchema, payload)) throw conflict()
  const appended = await appendAgentEventWithOutboxInTransaction(tx, {
    sessionId: command.sessionId, turnId: turn.id, itemId: null, taskId: turn.rootTaskId,
    type: OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, actor: "user", correlationId: turn.id,
    causationId: accepted.acceptedEvent.id, idempotencyKey: receiptEventKey(command), payload,
    outboxTopic: "agent.session.event",
  })
  const saved = await tx.agentEvent.findFirst({ where: { sessionId: command.sessionId, idempotencyKey: receiptEventKey(command) },
    select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
      correlationId: true, causationId: true, idempotencyKey: true, sequence: true, payload: true } })
  if (appended.duplicate || !receiptMatches(saved, command, turn.rootTaskId, accepted.acceptedEvent, accepted.sequence, locations)
    || appended.event.id !== (saved as StoredEvent).id) throw conflict()
  return { ...facts, disposition: "steered" }
}

/** Records an explicitly confirmed location steer without changing generic input or granting execution authority. */
export async function acceptObjectiveLocationSteer(db: PrismaClient, rawCommand: Command): Promise<CommandResult> {
  const { command, locations } = snapshotCommand(rawCommand)
  try {
    return await db.$transaction(tx => accept(tx, command, locations))
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error
    return db.$transaction(tx => accept(tx, command, locations))
  }
}
