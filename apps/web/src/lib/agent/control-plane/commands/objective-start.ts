import type { PrismaClient } from "@prisma/client"
import { InputContentPartSchema, validate } from "@jobcopilot/agent-protocol"

import { invalidCommand, isUniqueViolation, objectiveStartStateConflict, retryActiveConflict } from "./errors"
import { duplicateCommandResult } from "./agent-command-service"
import { lockOwnedSessionForObjectiveReplacement } from "./session-control"
import {
  acceptInputFacts,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  type CommandTransaction,
} from "./transaction"
import type { ObjectiveStartCommand, ObjectiveStartResult } from "./types"

const MAX_OBJECTIVE_BYTES = 2_000
const MAX_CONTENT_PARTS = 32
const MAX_TEXT_PART_LENGTH = 20_000
const MAX_ATTACHMENT_REFS = 8
const MAX_COMMAND_BODY_BYTES = 256 * 1024

function normalizeObjective(value: unknown): string {
  if (typeof value !== "string") throw invalidCommand("Objective must be a string")
  const objective = value.trim()
  if (!objective || new TextEncoder().encode(objective).byteLength > MAX_OBJECTIVE_BYTES) {
    throw invalidCommand("Objective must contain 1 to 2,000 UTF-8 bytes")
  }
  return objective
}

function hasBoundedContent(value: unknown): value is ObjectiveStartCommand["content"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTENT_PARTS) return false
  let attachmentCount = 0
  try {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false
      const part: unknown = value[index]
      if (!validate(InputContentPartSchema, part)) return false
      if (!part || typeof part !== "object" || Array.isArray(part)) return false
      const record = part as Record<string, unknown>
      if (record.type === "text") {
        if (typeof record.text !== "string" || !record.text.trim() || record.text.length > MAX_TEXT_PART_LENGTH) return false
      } else {
        for (const field of ["attachmentId", "mediaType", "filename"] as const) {
          const item = record[field]
          if (item !== undefined && (typeof item !== "string" || !item.trim() || item.trim() !== item)) return false
        }
        attachmentCount += 1
        if (attachmentCount > MAX_ATTACHMENT_REFS) return false
      }
    }
    const serialized = JSON.stringify(value)
    return typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= MAX_COMMAND_BODY_BYTES
  } catch {
    return false
  }
}

async function startOnce(command: ObjectiveStartCommand, db: PrismaClient): Promise<ObjectiveStartResult> {
  return db.$transaction(async (tx) => {
    const status = await lockOwnedSessionForObjectiveReplacement(tx, command.sessionId, command.userId)
    const existing = await findExistingCommand(tx, command.sessionId, command.clientMessageId)
    if (existing) return { ...await duplicateCommandResult(tx, command, existing, "follow_up"), disposition: "duplicate" }
    if (status !== "running") throw objectiveStartStateConflict(status)

    const active = await findActiveTurn(tx, command.sessionId, command.userId)
    if (active) throw retryActiveConflict(active.id)

    const turn = await createRootTurn(tx, command, command.content, command.objective)
    const facts = await acceptInputFacts(tx, command, command.content, turn, "follow_up", "started", true)
    return { ...facts, disposition: "started" }
  })
}

export class ObjectiveStartCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(command: ObjectiveStartCommand): Promise<ObjectiveStartResult> {
    if (command.source !== "user") throw invalidCommand("Only a user can start an objective")
    const normalized = { ...command, objective: normalizeObjective(command.objective) }
    if (!hasBoundedContent(command.content)) throw invalidCommand("Objective context is invalid or exceeds the command limits")
    try {
      return await startOnce(normalized, this.db)
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return startOnce(normalized, this.db)
    }
  }
}
