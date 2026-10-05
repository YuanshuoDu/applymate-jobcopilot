import { createHash, randomUUID } from "node:crypto"
import type pg from "pg"
import { canonicalJson, redactSensitiveValue } from "@jobcopilot/shared"

import { executionOwnerFence, type ExecutionOwner, type ExecutionOwnerFence } from "../execution-owner.js"
import {
  MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES, type PutToolResultInput,
  type ToolResultChunk, type ToolResultReadInput, type ToolResultReferenceRecord,
  type ToolResultReferenceRepository, type VerifiedReadProvenance, type CanonicalToolSourceName,
  matchesVerifiedToolResultRetry, prepareToolResultJson, ToolResultSanitizationError, verifyToolResultSanitization,
} from "./tool-result-reference-types.js"

type Client = Pick<pg.PoolClient, "query" | "release">
type Pool = Pick<pg.Pool, "connect">
type QueryResult<T> = { rows: T[]; rowCount: number | null }
type ResultRow = Omit<ToolResultReferenceRecord, "sanitizedJson" | "createdAt" | "updatedAt"> & {
  sanitizedJson: unknown; createdAt: Date | string; updatedAt: Date | string
}
const OPEN_SESSION = `"status" NOT IN ('aborted', 'archived')`
const VERIFIED_READS = new WeakMap<object, VerifiedReadProvenance>()

export class ToolResultRepositoryError extends Error {
  constructor(readonly code: "invalid_owner" | "tool_result_too_large" | "tool_result_invalid_json" | "tool_result_conflict" | "tool_result_corrupt" | "tool_result_cursor_invalid" | "tool_result_fence_rejected", message: string = code) {
    super(message)
    this.name = "ToolResultRepositoryError"
  }
}

function text(value: string, name: string, maxBytes = 256): string {
  if (value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) throw new ToolResultRepositoryError("invalid_owner", `${name} is invalid`)
  return value
}

function row(value: ResultRow): ToolResultReferenceRecord {
  return { ...value, sanitizedJson: value.sanitizedJson as ToolResultReferenceRecord["sanitizedJson"], createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) }
}

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function assertNow(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new ToolResultRepositoryError("tool_result_fence_rejected")
}

async function assertOpenSession(client: Client, fence: ExecutionOwnerFence): Promise<void> {
  const result = await client.query<{ id: string }>(`SELECT "id", "userId", "status" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [fence.sessionId, fence.userId]) as QueryResult<{ id: string }>
  if (!result.rows[0]) throw new ToolResultRepositoryError("tool_result_fence_rejected")
}

async function assertWriteFence(client: Client, fence: ExecutionOwnerFence, stepId: string, now: Date): Promise<void> {
  assertNow(now)
  const values = fence.kind === "turn"
    ? [fence.taskId, fence.sessionId, fence.userId, fence.turnId, fence.ownerId, fence.leaseVersion]
    : [fence.taskId, fence.sessionId, fence.userId, fence.turnId, fence.ownerId, fence.attemptCount, fence.rootTaskId]
  const sql = fence.kind === "turn" ? `
    SELECT root."id" FROM "sub_agent_tasks" root
    JOIN "agent_turns" turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."rootTaskId" = root."id"
      AND root."turnId" = $4 AND turn."id" = $4 AND turn."sessionId" = $2 AND turn."userId" = $3
      AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
      AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP AND root."status" IN ('running', 'waiting', 'waiting_for_user')
      AND root."interruptRequestedAt" IS NULL FOR UPDATE` : `
    SELECT task."id" FROM "sub_agent_tasks" task
    JOIN "sub_agent_tasks" root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $4
      AND task."leaseOwner" = $5 AND task."attemptCount" = $6 AND task."rootTaskId" = $7 AND task."status" = 'running'
      AND task."leaseExpiresAt" > CURRENT_TIMESTAMP AND task."interruptRequestedAt" IS NULL
      AND turn."userId" = $3 AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
      AND root."rootTaskId" = root."id" AND root."turnId" = task."turnId"
      AND root."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
      AND root."interruptRequestedAt" IS NULL FOR UPDATE`
  const result = await client.query<{ id: string }>(sql, values) as QueryResult<{ id: string }>
  if (!result.rows[0]) throw new ToolResultRepositoryError("tool_result_fence_rejected")
  const step = await client.query<{ id: string }>(`SELECT step."id" FROM "agent_steps" step
    WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3
      AND step."taskId" = $4 AND step."attempt" = $5 FOR UPDATE`,
  [stepId, fence.sessionId, fence.turnId, fence.taskId, fence.kind === "task" ? fence.attemptCount : 1]) as QueryResult<{ id: string }>
  if (!step.rows[0]) throw new ToolResultRepositoryError("tool_result_fence_rejected")
}

async function assertReadFence(client: Client, fence: ExecutionOwnerFence, now: Date): Promise<void> {
  assertNow(now)
  const values = fence.kind === "turn"
    ? [fence.taskId, fence.sessionId, fence.userId, fence.turnId, fence.ownerId, fence.leaseVersion]
    : [fence.taskId, fence.sessionId, fence.userId, fence.turnId, fence.ownerId, fence.attemptCount, fence.rootTaskId]
  const sql = fence.kind === "turn" ? `SELECT root."id" FROM "sub_agent_tasks" root
    JOIN "agent_turns" turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."rootTaskId" = root."id" AND root."turnId" = $4
      AND turn."userId" = $3 AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $5
      AND turn."leaseVersion" = $6 AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP
      AND root."status" IN ('running', 'waiting', 'waiting_for_user') AND root."interruptRequestedAt" IS NULL` : `SELECT task."id" FROM "sub_agent_tasks" task
    JOIN "sub_agent_tasks" root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $4 AND task."leaseOwner" = $5
      AND task."attemptCount" = $6 AND task."rootTaskId" = $7 AND task."status" = 'running' AND task."leaseExpiresAt" > CURRENT_TIMESTAMP
      AND task."interruptRequestedAt" IS NULL AND turn."userId" = $3 AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
      AND root."rootTaskId" = root."id" AND root."turnId" = task."turnId"
      AND root."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
      AND root."interruptRequestedAt" IS NULL`
  const result = await client.query<{ id: string }>(sql, values) as QueryResult<{ id: string }>
  if (!result.rows[0]) throw new ToolResultRepositoryError("tool_result_fence_rejected")
}

type SourceScope = Pick<ExecutionOwnerFence, "userId" | "sessionId" | "turnId" | "taskId"> & { readonly stepId: string; readonly toolCallId: string }

async function findCanonicalToolName(client: Client, scope: SourceScope): Promise<CanonicalToolSourceName> {
  const result = await client.query<{ toolName: string | null }>(`SELECT item."content"->>'toolName' AS "toolName" FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" JOIN "agent_sessions" AS session ON session."id" = item."sessionId" AND session."userId" = turn."userId"
    JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4 AND item."type" = 'tool_call' AND item."content"->>'toolCallId' = $5
      AND turn."userId" = $6 AND session."userId" = $6 ORDER BY item."id" LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.taskId, scope.stepId, scope.toolCallId, scope.userId]) as QueryResult<{ toolName: string | null }>
  if (result.rows.length !== 1 || typeof result.rows[0]?.toolName !== "string") throw new ToolResultRepositoryError("tool_result_fence_rejected")
  return result.rows[0].toolName as CanonicalToolSourceName
}

function safeJson(value: unknown, toolName: CanonicalToolSourceName): { value: ToolResultReferenceRecord["sanitizedJson"]; encoded: string; bytes: number; sha256: string } {
  try {
    const safe = prepareToolResultJson(value, toolName)
    if (safe.bytes > MAX_TOOL_RESULT_BYTES) throw new ToolResultRepositoryError("tool_result_too_large")
    return safe
  } catch (error) {
    if (error instanceof ToolResultRepositoryError) throw error
    throw new ToolResultRepositoryError(error instanceof ToolResultSanitizationError ? error.code : "tool_result_invalid_json")
  }
}

export function isVerifiedToolResultChunk(value: unknown, owner: ExecutionOwner, toolCallId: string): value is ToolResultChunk {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) return false
  let fence: ExecutionOwnerFence
  try { fence = executionOwnerFence(owner) } catch { return false }
  const proof = VERIFIED_READS.get(value)
  if (!proof || proof.userId !== fence.userId || proof.sessionId !== fence.sessionId || proof.turnId !== fence.turnId
    || proof.taskId !== fence.taskId || proof.toolCallId !== toolCallId) return false
  const output = value as Partial<ToolResultChunk>
  return output.ref === proof.ref && proof.referenceId === proof.ref && output.sha256 === proof.sha256
    && output.byteCount === proof.byteCount && output.nextCursor === proof.nextCursor
    && typeof output.chunk === "string" && createHash("sha256").update(output.chunk, "utf8").digest("hex") === proof.chunkSha256
    && (proof.cursor === null || /^(0|[1-9]\d*)$/.test(proof.cursor))
}

async function findIdentity(client: Client, stepId: string, toolCallId: string): Promise<ToolResultReferenceRecord | null> {
  const result = await client.query<ResultRow>(`SELECT "id", "userId", "sessionId", "turnId", "stepId", "taskId", "toolCallId", "sanitizedJson", "sha256", "byteCount", "createdAt", "updatedAt"
    FROM "agent_tool_result_references" WHERE "stepId" = $1 AND "toolCallId" = $2 FOR UPDATE`, [stepId, toolCallId]) as QueryResult<ResultRow>
  return result.rows[0] ? row(result.rows[0]) : null
}

function checkRow(value: ToolResultReferenceRecord, safe: ReturnType<typeof safeJson>, retryInput: unknown, toolName: CanonicalToolSourceName): ToolResultReferenceRecord {
  if (!matchesVerifiedToolResultRetry(value, safe, retryInput, toolName)) throw new ToolResultRepositoryError("tool_result_conflict")
  return value
}

function utf8End(bytes: Buffer, start: number, end: number, total: number): number {
  while (end > start && end < total && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return end
}

function chunk(value: ToolResultReferenceRecord, cursor: string | undefined): ToolResultChunk {
  let encoded: string
  try { encoded = canonicalJson(value.sanitizedJson) } catch { throw new ToolResultRepositoryError("tool_result_corrupt") }
  const bytes = Buffer.from(encoded, "utf8")
  if (!Number.isSafeInteger(value.byteCount) || value.byteCount < 0 || value.byteCount > MAX_TOOL_RESULT_BYTES || bytes.length !== value.byteCount || createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new ToolResultRepositoryError("tool_result_corrupt")
  const parsed = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > bytes.length || String(parsed) !== cursor && cursor !== undefined) throw new ToolResultRepositoryError("tool_result_corrupt")
  if (parsed < bytes.length && (bytes[parsed]! & 0xc0) === 0x80) throw new ToolResultRepositoryError("tool_result_cursor_invalid")
  if (parsed === bytes.length) return { ref: value.id, sha256: value.sha256, byteCount: value.byteCount, chunk: "", nextCursor: null }
  let end = utf8End(bytes, parsed, Math.min(bytes.length, parsed + MAX_TOOL_RESULT_READ_BYTES), bytes.length)
  while (end > parsed) {
    const item = { ref: value.id, sha256: value.sha256, byteCount: value.byteCount, chunk: bytes.subarray(parsed, end).toString("utf8"), nextCursor: end < bytes.length ? String(end) : null }
    if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TOOL_RESULT_READ_BYTES) return item
    end = utf8End(bytes, parsed, end - 1, bytes.length)
  }
  throw new ToolResultRepositoryError("tool_result_corrupt")
}

export function createToolResultReferenceRepository(pool: Pool): ToolResultReferenceRepository {
  return {
    async put(owner: ExecutionOwner, input: PutToolResultInput): Promise<ToolResultReferenceRecord> {
      let fence: ExecutionOwnerFence
      try { fence = executionOwnerFence(owner) } catch { throw new ToolResultRepositoryError("invalid_owner") }
      const stepId = text(input.stepId, "stepId")
      const toolCallId = text(input.toolCallId, "toolCallId")
      const now = input.now ?? new Date()
      return transaction(pool, fence.userId, async client => {
        await assertOpenSession(client, fence)
        await assertWriteFence(client, fence, stepId, now)
        const toolName = await findCanonicalToolName(client, { ...fence, stepId, toolCallId })
        const safe = safeJson(input.value, toolName)
        const id = `tool-result-${randomUUID()}`
        await client.query(`INSERT INTO "agent_tool_result_references"
          ("id", "userId", "sessionId", "turnId", "stepId", "taskId", "toolCallId", "sanitizedJson", "sha256", "byteCount", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $11)
          ON CONFLICT ("stepId", "toolCallId") DO NOTHING`, [id, fence.userId, fence.sessionId, fence.turnId, stepId, fence.taskId, toolCallId, safe.encoded, safe.sha256, safe.bytes, now])
        const existing = await findIdentity(client, stepId, toolCallId)
        if (!existing || existing.userId !== fence.userId || existing.sessionId !== fence.sessionId || existing.turnId !== fence.turnId || existing.taskId !== fence.taskId) throw new ToolResultRepositoryError("tool_result_conflict")
        return checkRow(existing, safe, input.value, toolName)
      })
    },
    async read(owner: ExecutionOwner, input: ToolResultReadInput, toolCallId?: string): Promise<ToolResultChunk | null> {
      let fence: ExecutionOwnerFence
      try { fence = executionOwnerFence(owner) } catch { throw new ToolResultRepositoryError("invalid_owner") }
      text(input.referenceId, "referenceId")
      if (toolCallId !== undefined) text(toolCallId, "toolCallId")
      return transaction(pool, fence.userId, async client => {
        await assertReadFence(client, fence, new Date())
        const sql = fence.kind === "turn" ? `SELECT ref.* FROM "agent_tool_result_references" ref
          WHERE ref."id" = $1 AND ref."userId" = $2 AND ref."sessionId" = $3` : `SELECT ref.* FROM "agent_tool_result_references" ref
          JOIN "sub_agent_tasks" target ON target."id" = ref."taskId" AND target."sessionId" = ref."sessionId"
          JOIN "sub_agent_tasks" current ON current."id" = $4 AND current."sessionId" = $3
          WHERE ref."id" = $1 AND ref."userId" = $2 AND ref."sessionId" = $3
            AND ref."turnId" = $5 AND target."turnId" = $5 AND target."rootTaskId" = $6
            AND (target."id" = current."id" OR (length(target."path") > length(current."path")
              AND left(target."path", length(current."path") + 1) = current."path" || '/'))`
        const values = fence.kind === "turn" ? [input.referenceId, fence.userId, fence.sessionId] : [input.referenceId, fence.userId, fence.sessionId, fence.taskId, fence.turnId, fence.rootTaskId]
        const result = await client.query<ResultRow>(sql, values) as QueryResult<ResultRow>
        if (!result.rows[0]) return null
        const stored = row(result.rows[0])
        const sourceName = await findCanonicalToolName(client, stored)
        let sanitizedJson: ToolResultReferenceRecord["sanitizedJson"]
        try { sanitizedJson = verifyToolResultSanitization(stored, sourceName) }
        catch { throw new ToolResultRepositoryError("tool_result_corrupt") }
        const verified = { ...stored, sanitizedJson }
        const output = Object.freeze(chunk(verified, input.cursor))
        if (toolCallId !== undefined) {
          VERIFIED_READS.set(output, {
            userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId, taskId: fence.taskId,
            toolCallId, referenceId: input.referenceId, cursor: input.cursor ?? null,
            ref: output.ref, sha256: output.sha256, byteCount: output.byteCount, nextCursor: output.nextCursor,
            chunkSha256: createHash("sha256").update(output.chunk, "utf8").digest("hex"),
          })
        }
        return output
      })
    },
  }
}
