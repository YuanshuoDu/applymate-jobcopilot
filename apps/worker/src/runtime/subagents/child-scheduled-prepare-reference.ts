import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"

import type { ContextSeedBlock } from "../context/step-context-builder.js"
import { executionOwnerFence, type ExecutionOwner } from "../execution-owner.js"
import {
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_READ_BYTES,
  prepareToolResultJson,
  type CanonicalToolSourceName,
  type ToolResultReferenceRepository,
} from "../tools/tool-result-reference-types.js"
import { validateRoleResult, type PrepareResult } from "./role-results.js"

const PREPARE_TOOL = "scheduled.application.prepare" as CanonicalToolSourceName
const RESULT_REFERENCE_ID = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_REFERENCE_READS = Math.ceil(MAX_TOOL_RESULT_BYTES / (MAX_TOOL_RESULT_READ_BYTES / 2))
const REFERENCE_KEYS = ["$ref", "sizeBytes", "sha256"] as const
const CHUNK_KEYS = ["ref", "sha256", "byteCount", "chunk", "nextCursor"] as const

export type ScheduledPrepareReference = Readonly<{ $ref: string; sizeBytes: number; sha256: string }>
export type ResolvedScheduledPrepareReference = Readonly<{
  result: PrepareResult
  reference: ScheduledPrepareReference
}>
export type ScheduledPrepareReferenceResolver = (input: Readonly<{
  output: unknown; originalToolCallId: string; expectedTaskId: string; expectedAttemptCount: number
}>) => Promise<ResolvedScheduledPrepareReference>
export type ResolvedScheduledPrepareObservation = Readonly<{
  toolCallId: string; result: PrepareResult; reference?: ScheduledPrepareReference
}>
export type VerifyScheduledPrepareSourceBindingInput = Readonly<{
  owner: ExecutionOwner
  reference: ScheduledPrepareReference
  originalToolCallId: string
  expectedTaskId: string
  expectedAttemptCount: number
}>
export type ResolveScheduledPrepareReferenceInput = Readonly<{
  output: unknown
  repository: ToolResultReferenceRepository
  owner: ExecutionOwner
  originalToolCallId: string
  expectedTaskId: string
  expectedAttemptCount: number
  verifySourceBinding: (input: VerifyScheduledPrepareSourceBindingInput) => boolean | Promise<boolean>
}>
type PgClient = Pick<pg.PoolClient, "query" | "release">
type PgPool = Pick<pg.Pool, "connect">
type SourceRow = Readonly<{ id: string; byteCount: number; sha256: string; stepAttempt: number }>

const SOURCE_BINDING_QUERY = `SELECT ref."id", ref."byteCount", ref."sha256", step."attempt" AS "stepAttempt"
  FROM "agent_tool_result_references" ref
  JOIN "sub_agent_tasks" task ON task."id" = ref."taskId" AND task."sessionId" = ref."sessionId" AND task."turnId" = ref."turnId"
  JOIN "sub_agent_tasks" root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
  JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
  JOIN "agent_sessions" session ON session."id" = task."sessionId" AND session."userId" = ref."userId"
  JOIN "agent_steps" step ON step."id" = ref."stepId" AND step."sessionId" = ref."sessionId"
    AND step."turnId" = ref."turnId" AND step."taskId" = ref."taskId" AND step."attempt" = $8
  JOIN "agent_items" call ON call."stepId" = step."id" AND call."sessionId" = step."sessionId"
    AND call."turnId" = step."turnId" AND call."taskId" = step."taskId" AND call."type" = 'tool_call'
    AND call."content"->>'toolCallId' = ref."toolCallId"
  JOIN "agent_items" result ON result."stepId" = step."id" AND result."sessionId" = step."sessionId"
    AND result."turnId" = step."turnId" AND result."taskId" = step."taskId" AND result."type" = 'tool_result'
    AND result."content"->>'toolCallId' = ref."toolCallId"
  WHERE ref."id" = $1 AND ref."userId" = $2 AND ref."sessionId" = $3 AND ref."turnId" = $4
    AND ref."taskId" = $5 AND ref."toolCallId" = $6 AND ref."byteCount" = $7 AND ref."sha256" = $9
    AND task."role" = 'prepare' AND task."taskType" = 'scheduled_application_prepare'
    AND task."rootTaskId" = $10 AND task."status" = 'running' AND task."leaseOwner" = $11
    AND task."attemptCount" = $8 AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL
    AND root."rootTaskId" = root."id" AND root."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
    AND root."interruptRequestedAt" IS NULL AND turn."rootTaskId" = $10
    AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
    AND turn."userId" = $2 AND session."status" NOT IN ('aborted', 'archived')
    AND call."status" = 'completed' AND call."content"->>'toolName' = 'scheduled.application.prepare'
    AND call."content"->>'toolVersion' = '1' AND call."content"->>'status' = 'completed'
    AND call."content"->'errorCode' = 'null'::jsonb AND call."content"->'input' = '{}'::jsonb
    AND result."status" = 'completed' AND result."content"->'errorCode' = 'null'::jsonb
    AND result."content"->'output' = $12::jsonb`

function invalid(): never { throw new Error("scheduled_prepare_reference_invalid") }

function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expectedKeys.length
      || keys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) return undefined
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value as Record<string, unknown>
  } catch { return undefined }
}

/** Accepts only the exact lifecycle marker emitted for an oversized Prepare receipt. */
export function parseScheduledPrepareReference(value: unknown): ScheduledPrepareReference {
  const row = exactDataRecord(value, REFERENCE_KEYS)
  if (!row || typeof row.$ref !== "string" || !RESULT_REFERENCE_ID.test(row.$ref)
    || !Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) < 1 || Number(row.sizeBytes) > MAX_TOOL_RESULT_BYTES
    || typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) return invalid()
  return { $ref: row.$ref, sizeBytes: Number(row.sizeBytes), sha256: row.sha256 }
}

function parseChunk(value: unknown, reference: ScheduledPrepareReference, offset: number): { bytes: Buffer; nextCursor: string | null } {
  const row = exactDataRecord(value, CHUNK_KEYS)
  if (!row || row.ref !== reference.$ref || row.sha256 !== reference.sha256 || row.byteCount !== reference.sizeBytes
    || typeof row.chunk !== "string" || Buffer.from(row.chunk, "utf8").toString("utf8") !== row.chunk
    || (row.nextCursor !== null && typeof row.nextCursor !== "string")) return invalid()
  const bytes = Buffer.from(row.chunk, "utf8")
  const end = offset + bytes.length
  const nextCursor = end === reference.sizeBytes ? null : String(end)
  if (bytes.length === 0 || bytes.length > MAX_TOOL_RESULT_READ_BYTES || end > reference.sizeBytes
    || row.nextCursor !== nextCursor || Buffer.byteLength(JSON.stringify(row), "utf8") > MAX_TOOL_RESULT_READ_BYTES) return invalid()
  return { bytes, nextCursor }
}

function parseCompletePrepare(bytes: Buffer, reference: ScheduledPrepareReference, taskId: string, attemptCount: number): PrepareResult {
  if (bytes.length !== reference.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return invalid()
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) return invalid()
  let value: unknown
  try { value = JSON.parse(text) } catch { return invalid() }
  try {
    if (canonicalJson(value) !== text) return invalid()
    const prepared = prepareToolResultJson(value, PREPARE_TOOL, taskId, attemptCount)
    if (prepared.encoded !== text || prepared.bytes !== reference.sizeBytes || prepared.sha256 !== reference.sha256) return invalid()
    const result = validateRoleResult(prepared.value, "prepare")
    if (result.taskId !== taskId || result.attemptCount !== attemptCount) return invalid()
    return result
  } catch { return invalid() }
}

/** Reads and verifies every owner-fenced chunk before exposing a canonical Prepare result. */
export async function resolveScheduledPrepareReference(input: ResolveScheduledPrepareReferenceInput): Promise<ResolvedScheduledPrepareReference> {
  try {
    const reference = parseScheduledPrepareReference(input.output)
    if (typeof input.originalToolCallId !== "string" || input.originalToolCallId.trim() !== input.originalToolCallId
      || input.originalToolCallId.length === 0 || typeof input.expectedTaskId !== "string" || input.expectedTaskId.length === 0
      || !Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 1
      || typeof input.verifySourceBinding !== "function") return invalid()
    const sourceMatches = await input.verifySourceBinding({ owner: input.owner, reference, originalToolCallId: input.originalToolCallId,
      expectedTaskId: input.expectedTaskId, expectedAttemptCount: input.expectedAttemptCount })
    if (sourceMatches !== true) return invalid()
    const parts: Buffer[] = []
    const seenCursors = new Set<string>()
    let offset = 0
    let cursor: string | undefined
    let reads = 0
    while (offset < reference.sizeBytes) {
      if (++reads > MAX_REFERENCE_READS) return invalid()
      if (cursor !== undefined) {
        if (seenCursors.has(cursor) || cursor !== String(offset)) return invalid()
        seenCursors.add(cursor)
      }
      const chunk = await input.repository.read(input.owner, {
        referenceId: reference.$ref,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (chunk === null) return invalid()
      const parsed = parseChunk(chunk, reference, offset)
      parts.push(parsed.bytes)
      offset += parsed.bytes.length
      cursor = parsed.nextCursor ?? undefined
    }
    const bytes = Buffer.concat(parts, reference.sizeBytes)
    return { result: parseCompletePrepare(bytes, reference, input.expectedTaskId, input.expectedAttemptCount), reference }
  } catch { return invalid() }
}

/** Confirms the marker came from this live Prepare call and attempt under tenant-scoped RLS. */
export async function verifyScheduledPrepareReferenceSourceBinding(
  pool: PgPool,
  input: VerifyScheduledPrepareSourceBindingInput,
): Promise<boolean> {
  let client: PgClient | undefined
  try {
    const fence = executionOwnerFence(input.owner)
    const reference = parseScheduledPrepareReference(input.reference)
    if (input.owner.kind !== "task" || fence.kind !== "task" || fence.taskId !== input.expectedTaskId
      || fence.attemptCount !== input.expectedAttemptCount || fence.taskId !== input.owner.lease.id
      || input.originalToolCallId.trim() !== input.originalToolCallId || input.originalToolCallId.length === 0) return false
    client = await pool.connect()
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [fence.userId])
    const result = await client.query<SourceRow>(SOURCE_BINDING_QUERY, [
      reference.$ref, fence.userId, fence.sessionId, fence.turnId, fence.taskId, input.originalToolCallId,
      reference.sizeBytes, fence.attemptCount, reference.sha256, fence.rootTaskId, fence.ownerId,
      JSON.stringify(reference),
    ])
    const row = result.rows.length === 1 ? result.rows[0] : undefined
    const valid = Boolean(row && row.id === reference.$ref && row.byteCount === reference.sizeBytes
      && row.sha256 === reference.sha256 && row.stepAttempt === fence.attemptCount)
    await client.query(valid ? "COMMIT" : "ROLLBACK")
    return valid
  } catch {
    await client?.query("ROLLBACK").catch(() => undefined)
    return false
  } finally { client?.release() }
}

/** Resolves only prior Prepare receipts that still match this exact live attempt; stale markers remain model context only. */
export async function resolveScheduledPrepareResumeEvidence(
  observations: readonly ContextSeedBlock[], resolve: ScheduledPrepareReferenceResolver | undefined, taskId: string, attemptCount: number,
): Promise<readonly ResolvedScheduledPrepareObservation[]> {
  const resolved: ResolvedScheduledPrepareObservation[] = []
  for (const block of observations) {
    const content = block && typeof block === "object" ? block.content : undefined
    if (!content || typeof content !== "object" || Array.isArray(content)) continue
    const row = content as Record<string, unknown>
    if (row.toolName !== "scheduled.application.prepare" || typeof row.toolCallId !== "string") continue
    if (row.output && typeof row.output === "object" && !Array.isArray(row.output) && Object.hasOwn(row.output, "$ref")) {
      if (!resolve) continue
      try {
        const reference = parseScheduledPrepareReference(row.output)
        const value = await resolve({ output: row.output, originalToolCallId: row.toolCallId, expectedTaskId: taskId, expectedAttemptCount: attemptCount })
        if (canonicalJson(value.reference) === canonicalJson(reference)) resolved.push({ toolCallId: row.toolCallId, result: value.result, reference })
      } catch { /* A stale or invalid reference cannot become current-attempt evidence. */ }
      continue
    }
    try {
      const result = validateRoleResult(row.output, "prepare")
      if (result.taskId === taskId && result.attemptCount === attemptCount) resolved.push({ toolCallId: row.toolCallId, result })
    } catch { /* A prior inline receipt is not evidence for this attempt. */ }
  }
  return resolved
}

export function createScheduledPrepareReferenceResolver(pool: PgPool, repository: ToolResultReferenceRepository,
  owner: ExecutionOwner): ScheduledPrepareReferenceResolver {
  return input => resolveScheduledPrepareReference({ ...input, repository, owner,
    verifySourceBinding: binding => verifyScheduledPrepareReferenceSourceBinding(pool, binding) })
}
