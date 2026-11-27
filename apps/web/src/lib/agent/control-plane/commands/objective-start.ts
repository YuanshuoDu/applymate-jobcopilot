import type { PrismaClient } from "@prisma/client"
import { InputContentPartSchema, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, validate } from "@jobcopilot/agent-protocol"
import { parseObjectiveSponsorshipTargetCountry, type ObjectiveSponsorshipTargetCountry } from "@jobcopilot/shared"

import { invalidCommand, isUniqueViolation, objectiveStartStateConflict, retryActiveConflict } from "./errors"
import { lockOwnedSessionForObjectiveReplacement } from "./session-control"
import { lockObjectiveStartAttempt, lookupAttemptForStart, objectiveStartRequestHash, recordAcceptedObjectiveStart } from "./objective-start-attempt-ledger"
import {
  acceptInputFacts,
  createRootTurn,
  findActiveTurn,
  type CommandTransaction,
} from "./transaction"
import {
  OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
  objectiveLocationVerificationEnabled,
  parseObjectiveVerificationRequirements,
  type ObjectiveStartCommand,
  type ObjectiveStartResult,
  type ObjectiveVerificationRequirements,
} from "./types"

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
        if (typeof record.text !== "string" || record.text.length === 0 || record.text.length > MAX_TEXT_PART_LENGTH) return false
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
  const requestHash = objectiveStartRequestHash(command)
  return db.$transaction(async (tx) => {
    await lockObjectiveStartAttempt(tx, command.userId, command.clientMessageId)
    const existingAttempt = await lookupAttemptForStart(tx, command, requestHash)
    if (existingAttempt) {
      return {
        inputId: existingAttempt.inputId,
        turnId: existingAttempt.turnId,
        sequence: existingAttempt.sequence,
        disposition: "duplicate",
        originalDisposition: "started",
      }
    }
    const status = await lockOwnedSessionForObjectiveReplacement(tx, command.sessionId, command.userId)
    const racedAttempt = await lookupAttemptForStart(tx, command, requestHash)
    if (racedAttempt) {
      return {
        inputId: racedAttempt.inputId,
        turnId: racedAttempt.turnId,
        sequence: racedAttempt.sequence,
        disposition: "duplicate",
        originalDisposition: "started",
      }
    }
    if (status !== "running") throw objectiveStartStateConflict(status)

    const active = await findActiveTurn(tx, command.sessionId, command.userId)
    if (active) throw retryActiveConflict(active.id)

    const turn = await createRootTurn(
      tx, command, command.content, command.objective, undefined, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, command.verificationRequirements, undefined, command.sponsorshipTargetCountry,
    )
    const facts = await acceptInputFacts(tx, command, command.content, turn, "follow_up", "started", true)
    await recordAcceptedObjectiveStart(tx, command, requestHash, { sessionId: command.sessionId, ...facts })
    return { ...facts, disposition: "started" }
  })
}

export class ObjectiveStartCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(command: ObjectiveStartCommand): Promise<ObjectiveStartResult> {
    if (command.source !== "user") throw invalidCommand("Only a user can start an objective")
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(command, "verificationRequirements")
    } catch {
      throw invalidCommand("Objective verification requirements are invalid")
    }
    const hasRequirements = descriptor !== undefined
    let requirements: ObjectiveVerificationRequirements | null | undefined
    if (descriptor) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw invalidCommand("Objective verification requirements are invalid")
      }
      if (descriptor.value === null) {
        requirements = null
      } else {
        requirements = parseObjectiveVerificationRequirements(descriptor.value) ?? undefined
        if (!requirements) throw invalidCommand("Objective verification requirements are invalid or unsupported")
        if (requirements.schemaVersion === OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION &&
            !objectiveLocationVerificationEnabled()) {
          throw invalidCommand("Explicit location verification is not enabled yet")
        }
      }
    }
    let sponsorshipDescriptor: PropertyDescriptor | undefined
    try { sponsorshipDescriptor = Object.getOwnPropertyDescriptor(command, "sponsorshipTargetCountry") }
    catch { throw invalidCommand("Objective sponsorship target country is invalid") }
    const hasSponsorshipTargetCountry = sponsorshipDescriptor !== undefined
    let sponsorshipTargetCountry: ObjectiveSponsorshipTargetCountry | undefined
    if (sponsorshipDescriptor) {
      if (!("value" in sponsorshipDescriptor) || !sponsorshipDescriptor.enumerable) {
        throw invalidCommand("Objective sponsorship target country is invalid")
      }
      sponsorshipTargetCountry = parseObjectiveSponsorshipTargetCountry(sponsorshipDescriptor.value) ?? undefined
      if (!sponsorshipTargetCountry) throw invalidCommand("Objective sponsorship target country is invalid or unsupported")
    }
    const normalized: ObjectiveStartCommand = {
      sessionId: command.sessionId,
      userId: command.userId,
      clientMessageId: command.clientMessageId,
      source: command.source,
      objective: normalizeObjective(command.objective),
      content: command.content,
      ...(hasRequirements ? { verificationRequirements: requirements ?? null } : {}),
      ...(hasSponsorshipTargetCountry ? { sponsorshipTargetCountry } : {}),
    }
    if (!hasBoundedContent(command.content)) throw invalidCommand("Objective context is invalid or exceeds the command limits")
    try {
      return await startOnce(normalized, this.db)
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return startOnce(normalized, this.db)
    }
  }
}
