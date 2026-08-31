import {
  type Actor,
  type AgentEventRecord,
  type AgentItemRecord,
  type AgentStepRecord,
  type AgentTurnRecord,
  type RepositoryJsonValue,
} from "@jobcopilot/agent-protocol"

import { AgentRepositoryJsonError } from "./errors"

interface TurnRow {
  id: string
  sessionId: string
  userId: string
  source: string
  status: string
  revision: number
  createdAt: Date | string
  updatedAt: Date | string
}

interface StepRow {
  id: string
  sessionId: string
  turnId: string
  ordinal: number
  attempt: number
  status: string
  inputThroughSequence: bigint
  consumedInputIds: unknown
  modelProfileSnapshot: unknown
  createdAt: Date | string
}

interface ItemRow {
  id: string
  sessionId: string
  turnId: string
  stepId: string | null
  taskId: string | null
  type: string
  status: string
  phase: string | null
  revision: number
  content: unknown
  startedAt: Date | string | null
  completedAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
}

interface EventRow {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  sequence: bigint
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
  createdAt: Date | string
}

function jsonValue(value: unknown, field: string): RepositoryJsonValue {
  if (!isJsonValue(value)) throw new AgentRepositoryJsonError(field)
  return value
}

function isJsonValue(value: unknown): value is RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJsonValue)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new AgentRepositoryJsonError(field)
  }
  return entryCopy(value)
}

function entryCopy(value: string[]): string[] {
  return [...value]
}

function iso(date: Date | string): string {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString()
}

function nullableIso(date: Date | string | null): string | null {
  return date ? iso(date) : null
}

export function mapTurn(row: TurnRow): AgentTurnRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    source: row.source as AgentTurnRecord["source"],
    status: row.status as AgentTurnRecord["status"],
    revision: row.revision,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function mapStep(row: StepRow): AgentStepRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    ordinal: row.ordinal,
    attempt: row.attempt,
    status: row.status as AgentStepRecord["status"],
    inputThroughSequence: row.inputThroughSequence,
    consumedInputIds: stringArray(row.consumedInputIds, "consumedInputIds"),
    modelProfileSnapshot: jsonValue(row.modelProfileSnapshot, "modelProfileSnapshot"),
    createdAt: iso(row.createdAt),
  }
}

export function mapItem(row: ItemRow): AgentItemRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    stepId: row.stepId,
    taskId: row.taskId,
    type: row.type,
    status: row.status as AgentItemRecord["status"],
    phase: row.phase as AgentItemRecord["phase"],
    revision: row.revision,
    content: jsonValue(row.content, "content"),
    startedAt: nullableIso(row.startedAt),
    completedAt: nullableIso(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function mapEvent(row: EventRow): AgentEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    itemId: row.itemId,
    taskId: row.taskId,
    sequence: row.sequence,
    type: row.type,
    actor: row.actor as Actor,
    correlationId: row.correlationId,
    causationId: row.causationId,
    idempotencyKey: row.idempotencyKey,
    payload: jsonValue(row.payload, "payload"),
    createdAt: iso(row.createdAt),
  }
}
