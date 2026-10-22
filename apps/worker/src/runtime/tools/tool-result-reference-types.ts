import { createHash } from "node:crypto"
import { canonicalJson, redactSensitiveText, redactSensitiveValue } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { validateRoleResult, type PrepareResult } from "../subagents/role-results.js"
import { redactDurableWaitOutput } from "./durable-wait-output-redaction.js"
import { redactJobReadOutput } from "./job-read-output-redaction.js"

export const MAX_TOOL_RESULT_BYTES = 1024 * 1024
export const MAX_TOOL_RESULT_READ_BYTES = 4096
const SCHEDULED_PREPARE_TOOL = "scheduled.application.prepare"
const PREPARE_TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PREPARE_JOB_ID = /^c[a-z0-9]{24}$/
const PREPARE_ARTIFACT_ID = /^scheduled-draft:[a-f0-9]{64}$/
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

function sanitizeSource(value: unknown, toolName: CanonicalToolSourceName, expectedTaskId?: string): RepositoryJsonValue {
  if (toolName === SCHEDULED_PREPARE_TOOL) return projectScheduledPrepareLifecycleOutput(value, expectedTaskId)
  if (toolName === "agent.wait" || toolName === "wait_subagents") return redactDurableWaitOutput(value)
  if (toolName === "jobs.search" || toolName === "jobs.get" || toolName === "jobs.discover") return redactJobReadOutput(toolName, value)
  return redactSensitiveValue(value)
}

function prepareJson(value: RepositoryJsonValue): PreparedToolResult {
  try {
    const encoded = canonicalJson(value)
    return { value, encoded, bytes: Buffer.byteLength(encoded, "utf8"), sha256: createHash("sha256").update(encoded, "utf8").digest("hex") }
  } catch { throw new ToolResultSanitizationError("tool_result_invalid_json") }
}

export function prepareToolResultJson(value: unknown, toolName: CanonicalToolSourceName, expectedTaskId?: string): PreparedToolResult {
  try { return prepareJson(sanitizeSource(value, toolName, expectedTaskId)) }
  catch { throw new ToolResultSanitizationError("tool_result_invalid_json") }
}

/** Rebuilds only the verified scheduled Prepare receipt, preserving its safe artifact digests. */
export function projectScheduledPrepareLifecycleOutput(value: unknown, expectedTaskId?: string): RepositoryJsonValue {
  if (!isPlainScheduledPrepareData(value)) throw invalidScheduledPrepareOutput()
  let result: PrepareResult
  try { result = validateRoleResult(value, "prepare") }
  catch { throw invalidScheduledPrepareOutput() }
  const taskIdFence = expectedTaskId === undefined ? result.taskId : expectedTaskId
  const safeIdentifier = (identifier: string) => identifier.trim() === identifier && redactSensitiveText(identifier) === identifier
  if (typeof taskIdFence !== "string" || result.taskId !== taskIdFence || !safePrepareTaskId(result.taskId)
    || result.jobs.some(job => !PREPARE_JOB_ID.test(job.jobId) || !safeIdentifier(job.jobId))
    || result.materials.some(material => !PREPARE_JOB_ID.test(material.jobId) || !safeIdentifier(material.jobId)
      || !safeScheduledDraftArtifactId(material.artifactRef.artifactId))) throw invalidScheduledPrepareOutput()
  return {
    schemaVersion: result.schemaVersion, role: result.role, status: result.status, taskId: result.taskId,
    attemptCount: result.attemptCount, snapshotDigest: result.snapshotDigest, checkpointDigest: result.checkpointDigest,
    jobs: result.jobs.map(job => ({ jobId: job.jobId, status: job.status })),
    materials: result.materials.map(material => ({
      jobId: material.jobId, kind: material.kind,
      artifactRef: { artifactId: material.artifactRef.artifactId, version: material.artifactRef.version,
        contentHash: material.artifactRef.contentHash, sourceDigest: material.artifactRef.sourceDigest },
    })),
  }
}

function safePrepareTaskId(value: string): boolean {
  // Only a valid generated subagent UUID may bypass the text redactor's phone false positive.
  const stable = PREPARE_TASK_ID.test(value) ? value.replace(PREPARE_TASK_ID, "subagent-opaque") : ""
  return stable !== "" && redactSensitiveText(stable) === stable
}

function safeScheduledDraftArtifactId(value: string): boolean {
  // Only the exact generated artifact digest format may bypass numeric redaction false positives.
  const stable = PREPARE_ARTIFACT_ID.test(value) ? value.replace(PREPARE_ARTIFACT_ID, "scheduled-draft:opaque") : ""
  return stable !== "" && redactSensitiveText(stable) === stable
}

function invalidScheduledPrepareOutput(): Error { return new Error("scheduled_prepare_lifecycle_output_invalid") }

function isPlainScheduledPrepareData(value: unknown, active = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return true
  if (typeof value !== "object" || depth > 16 || active.has(value)) return false
  active.add(value); try {
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value), stringKeys = keys as string[]
    if (keys.some(key => typeof key !== "string") || array && (keys.length !== (value as unknown[]).length + 1
      || stringKeys.some(key => key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) return false
    for (const key of stringKeys) {
      if (array && key === "length") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor) || !isPlainScheduledPrepareData(descriptor.value, active, depth + 1)) return false
    }
    return true
  } catch { return false } finally { active.delete(value) }
}

function matchesStored(value: ToolResultReferenceRecord, safe: PreparedToolResult): boolean {
  return safe.sha256 === value.sha256 && safe.bytes === value.byteCount && safe.encoded === canonicalJson(value.sanitizedJson)
}

export function verifyToolResultSanitization(value: ToolResultReferenceRecord, toolName: CanonicalToolSourceName): RepositoryJsonValue {
  if (toolName === SCHEDULED_PREPARE_TOOL) {
    try {
      if (typeof value.taskId !== "string") throw new Error("scheduled_prepare_task_fence_missing")
      const safe = prepareToolResultJson(value.sanitizedJson, toolName, value.taskId)
      if (matchesStored(value, safe)) return safe.value
    } catch { /* Prepare references must be valid under their stored task fence. */ }
    throw new ToolResultSanitizationError("tool_result_corrupt")
  }
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
  if (toolName === SCHEDULED_PREPARE_TOOL) {
    try { return matchesStored(value, prepareToolResultJson(retryInput, toolName, value.taskId)) }
    catch { return false }
  }
  try { return matchesStored(value, prepareJson(redactSensitiveValue(retryInput))) }
  catch { return false }
}
export interface ToolResultReferenceRepository {
  put(owner: import("../execution-owner.js").ExecutionOwner, input: PutToolResultInput): Promise<ToolResultReferenceRecord>
  read(owner: import("../execution-owner.js").ExecutionOwner, input: ToolResultReadInput, toolCallId?: string): Promise<ToolResultChunk | null>
}
