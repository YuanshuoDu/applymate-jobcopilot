import { createHash } from "node:crypto"
import { canonicalJson, redactSensitiveValue } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { redactDurableWaitOutput } from "./durable-wait-output-redaction.js"
import { redactJobReadOutput } from "./job-read-output-redaction.js"

export const MAX_TOOL_RESULT_BYTES = 1024 * 1024
export const MAX_TOOL_RESULT_READ_BYTES = 4096
declare const canonicalSource: unique symbol
export type CanonicalToolSourceName = string & { readonly [canonicalSource]: true }

export type ToolResultReferenceRecord = {
  readonly id: string
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId: string
  readonly toolCallId: string
  readonly sanitizedJson: RepositoryJsonValue
  readonly sha256: string
  readonly byteCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type PutToolResultInput = {
  readonly stepId: string
  readonly toolCallId: string
  readonly value: unknown
  readonly now?: Date
}

export type ToolResultReadInput = {
  readonly referenceId: string
  readonly cursor?: string
}

export type ToolResultReadScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
}

export type ToolResultChunk = {
  readonly ref: string
  readonly sha256: string
  readonly byteCount: number
  readonly chunk: string
  readonly nextCursor: string | null
}

export type PreparedToolResult = { readonly value: RepositoryJsonValue; readonly encoded: string; readonly bytes: number; readonly sha256: string }
export type VerifiedReadProvenance = Pick<ExecutionOwnerFence, "userId" | "sessionId" | "turnId" | "taskId"> & {
  readonly toolCallId: string; readonly referenceId: string; readonly cursor: string | null
  readonly ref: string; readonly sha256: string; readonly byteCount: number; readonly nextCursor: string | null; readonly chunkSha256: string
}

export class ToolResultSanitizationError extends Error {
  constructor(readonly code: "tool_result_invalid_json" | "tool_result_corrupt") { super(code) }
}

function sanitizeSource(value: unknown, toolName: CanonicalToolSourceName): RepositoryJsonValue {
  if (toolName === "agent.wait" || toolName === "wait_subagents") return redactDurableWaitOutput(value)
  if (toolName === "jobs.search" || toolName === "jobs.get") return redactJobReadOutput(toolName, value)
  return redactSensitiveValue(value)
}

function prepareJson(value: RepositoryJsonValue): PreparedToolResult {
  try {
    const encoded = canonicalJson(value)
    return { value, encoded, bytes: Buffer.byteLength(encoded, "utf8"), sha256: createHash("sha256").update(encoded, "utf8").digest("hex") }
  } catch { throw new ToolResultSanitizationError("tool_result_invalid_json") }
}

export function prepareToolResultJson(value: unknown, toolName: CanonicalToolSourceName): PreparedToolResult {
  try { return prepareJson(sanitizeSource(value, toolName)) }
  catch { throw new ToolResultSanitizationError("tool_result_invalid_json") }
}

function matchesStored(value: ToolResultReferenceRecord, safe: PreparedToolResult): boolean {
  return safe.sha256 === value.sha256 && safe.bytes === value.byteCount && safe.encoded === canonicalJson(value.sanitizedJson)
}

export function verifyToolResultSanitization(value: ToolResultReferenceRecord, toolName: CanonicalToolSourceName): RepositoryJsonValue {
  try {
    const safe = prepareToolResultJson(value.sanitizedJson, toolName)
    if (matchesStored(value, safe)) return safe.value
  } catch { /* Older references may already be generic-redacted. */ }
  try {
    const legacy = prepareJson(redactSensitiveValue(value.sanitizedJson))
    if (matchesStored(value, legacy)) return legacy.value
  } catch { /* An invalid or unsafe stored value remains unavailable. */ }
  throw new ToolResultSanitizationError("tool_result_corrupt")
}

export function matchesVerifiedToolResultRetry(
  value: ToolResultReferenceRecord,
  sourcePrepared: PreparedToolResult,
  retryInput: unknown,
  toolName: CanonicalToolSourceName,
): boolean {
  try { verifyToolResultSanitization(value, toolName) } catch { return false }
  if (matchesStored(value, sourcePrepared)) return true
  try { return matchesStored(value, prepareJson(redactSensitiveValue(retryInput))) }
  catch { return false }
}
export interface ToolResultReferenceRepository {
  put(owner: import("../execution-owner.js").ExecutionOwner, input: PutToolResultInput): Promise<ToolResultReferenceRecord>
  read(owner: import("../execution-owner.js").ExecutionOwner, input: ToolResultReadInput, toolCallId?: string): Promise<ToolResultChunk | null>
}
