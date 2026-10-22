import { createHash } from "node:crypto"
import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"

import {
  MAX_TOOL_RESULT_BYTES,
  verifyToolResultSanitization,
  type CanonicalToolSourceName,
  type ToolResultReferenceRecord,
} from "../tools/tool-result-reference-types.js"
import { validateRoleResult, type PrepareResult } from "./role-results.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

export type ScheduledPrepareToolResultScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  taskId: string
  attemptCount: number
}>

export type ScheduledPrepareToolResultVerificationMode =
  | Readonly<{ phase: "finish"; ownerId: string }>
  | Readonly<{ phase: "persisted_gate" }>

export type ScheduledPrepareToolResultReference = Readonly<{
  $ref: string
  sizeBytes: number
  sha256: string
}>

export type ScheduledPrepareToolResultVerificationInput = Readonly<{
  reference: unknown
  scope: ScheduledPrepareToolResultScope
  mode: ScheduledPrepareToolResultVerificationMode
  stepId: string
  toolCallId: string
  expectedResult: PrepareResult
}>

const PREPARE_TOOL = "scheduled.application.prepare" as CanonicalToolSourceName
const REFERENCE_ID = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const REFERENCE_FIELDS = ["$ref", "sizeBytes", "sha256"] as const
const ROW_FIELDS = [
  "id", "userId", "sessionId", "turnId", "stepId", "taskId", "toolCallId", "sanitizedJson", "sha256", "byteCount",
  "createdAt", "updatedAt", "currentRootTaskId", "currentAttemptCount", "currentTaskStatus", "currentTaskFailureReason", "currentLeaseOwner",
  "currentLeaseExpiresAt", "currentInterruptRequestedAt", "leaseCheckedAt",
  "currentStepAttempt", "sourceCallItemId", "sourceCallStepId", "sourceCallTaskId", "sourceCallType", "sourceCallStatus", "sourceCallContent",
] as const

const SELECT_REFERENCE_BASE = `SELECT ref."id", ref."userId", ref."sessionId", ref."turnId",
    ref."stepId", ref."taskId", ref."toolCallId", ref."sanitizedJson", ref."sha256",
    ref."byteCount", ref."createdAt", ref."updatedAt", task."rootTaskId" AS "currentRootTaskId",
    task."attemptCount" AS "currentAttemptCount", task."status" AS "currentTaskStatus", task."failureReason" AS "currentTaskFailureReason",
    task."leaseOwner" AS "currentLeaseOwner", task."leaseExpiresAt" AS "currentLeaseExpiresAt",
    task."interruptRequestedAt" AS "currentInterruptRequestedAt", clock_timestamp() AS "leaseCheckedAt",
    step."attempt" AS "currentStepAttempt",
    call."id" AS "sourceCallItemId", call."stepId" AS "sourceCallStepId", call."taskId" AS "sourceCallTaskId",
    call."type" AS "sourceCallType", call."status" AS "sourceCallStatus", call."content" AS "sourceCallContent"
  FROM "agent_tool_result_references" AS ref
  JOIN "sub_agent_tasks" AS task ON task."id" = ref."taskId" AND task."sessionId" = ref."sessionId"
    AND task."turnId" = ref."turnId"
  JOIN "agent_steps" AS step ON step."id" = ref."stepId" AND step."sessionId" = ref."sessionId"
    AND step."turnId" = ref."turnId" AND step."taskId" = ref."taskId" AND step."attempt" = $9
  JOIN "agent_items" AS call ON call."stepId" = step."id" AND call."sessionId" = step."sessionId"
    AND call."turnId" = step."turnId" AND call."taskId" = step."taskId" AND call."type" = 'tool_call'
    AND call."content"->>'toolCallId' = ref."toolCallId"
  JOIN "agent_turns" AS turn ON turn."id" = ref."turnId" AND turn."sessionId" = ref."sessionId"
    AND turn."userId" = ref."userId"
  JOIN "agent_sessions" AS session ON session."id" = ref."sessionId" AND session."userId" = ref."userId"
  WHERE ref."id" = $1 AND ref."userId" = $2 AND ref."sessionId" = $3
    AND ref."turnId" = $4 AND ref."taskId" = $5 AND ref."stepId" = $6
    AND ref."toolCallId" = $7 AND task."rootTaskId" = $8 AND task."attemptCount" = $9
    AND step."attempt" = $9 AND call."content"->>'toolName' = 'scheduled.application.prepare'
    AND call."content"->>'toolVersion' = '1' AND call."content"->>'status' = 'completed'
    AND call."content"->'errorCode' = 'null'::jsonb AND call."status" = 'completed'
    AND turn."rootTaskId" = $8`
const SELECT_FINISH_REFERENCE = `${SELECT_REFERENCE_BASE}
    AND task."status" = 'running' AND task."failureReason" IS NULL AND task."leaseOwner" = $10
    AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL
  FOR UPDATE OF task`
const SELECT_PERSISTED_GATE_REFERENCE = `${SELECT_REFERENCE_BASE}
    AND task."status" = 'completed' AND task."failureReason" IS NULL
    AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL AND task."interruptRequestedAt" IS NULL`

/**
 * Resolves a durable Prepare result under an explicit live-finish lease or immutable completed-task Gate binding.
 */
export async function verifyScheduledPrepareToolResultReference(
  client: Queryable,
  input: ScheduledPrepareToolResultVerificationInput,
): Promise<PrepareResult | null> {
  try {
    const reference = parseReference(input.reference)
    const { scope, mode } = input
    if (!reference || !validScope(scope) || !validMode(mode) || !validText(input.stepId) || !validText(input.toolCallId)) return null
    const expected = validateRoleResult(input.expectedResult, "prepare")
    if (expected.taskId !== scope.taskId || expected.attemptCount !== scope.attemptCount) return null

    const values: unknown[] = [reference.$ref, scope.userId, scope.sessionId, scope.turnId, scope.taskId,
      input.stepId, input.toolCallId, scope.rootTaskId, scope.attemptCount]
    if (mode.phase === "finish") values.push(mode.ownerId)
    const result = await client.query<Row>(mode.phase === "finish" ? SELECT_FINISH_REFERENCE : SELECT_PERSISTED_GATE_REFERENCE, values)
    if (result.rows.length !== 1) return null
    const row = dataRecord(result.rows[0], ROW_FIELDS)
    if (!row || !rowMatches(row, reference, scope, mode, input.stepId, input.toolCallId)) return null

    const encoded = canonicalJson(row.sanitizedJson as Parameters<typeof canonicalJson>[0])
    const byteCount = Buffer.byteLength(encoded, "utf8")
    const sha256 = createHash("sha256").update(encoded, "utf8").digest("hex")
    if (byteCount > MAX_TOOL_RESULT_BYTES || byteCount !== reference.sizeBytes || byteCount !== row.byteCount
      || sha256 !== reference.sha256 || sha256 !== row.sha256) return null

    const stored = toReferenceRecord(row)
    const verified = validateRoleResult(verifyToolResultSanitization(stored, PREPARE_TOOL, scope.attemptCount), "prepare")
    if (verified.taskId !== scope.taskId || verified.attemptCount !== scope.attemptCount
      || canonicalJson(verified) !== canonicalJson(expected)) return null
    return verified
  } catch {
    return null
  }
}

function parseReference(value: unknown): ScheduledPrepareToolResultReference | null {
  const row = dataRecord(value, REFERENCE_FIELDS)
  if (!row || typeof row.$ref !== "string" || !REFERENCE_ID.test(row.$ref)
    || !Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) < 0 || Number(row.sizeBytes) > MAX_TOOL_RESULT_BYTES
    || typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) return null
  return { $ref: row.$ref, sizeBytes: Number(row.sizeBytes), sha256: row.sha256 }
}

function validScope(value: ScheduledPrepareToolResultScope): boolean {
  return Boolean(value && validText(value.userId) && validText(value.sessionId) && validText(value.turnId)
    && validText(value.rootTaskId) && typeof value.taskId === "string"
    && /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.taskId)
    && Number.isSafeInteger(value.attemptCount) && value.attemptCount > 0)
}

function validMode(value: ScheduledPrepareToolResultVerificationMode): boolean {
  const fields = value?.phase === "finish" ? ["phase", "ownerId"] : value?.phase === "persisted_gate" ? ["phase"] : []
  const row = fields.length ? dataRecord(value, fields) : null
  return Boolean(row && (row.phase === "finish" ? validText(row.ownerId) : row.phase === "persisted_gate"))
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function dataRecord(value: unknown, fields: readonly string[]): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length
      || keys.some(key => typeof key !== "string" || !fields.includes(key))) return null
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Row
  } catch { return null }
}

function rowMatches(row: Row, reference: ScheduledPrepareToolResultReference, scope: ScheduledPrepareToolResultScope,
  mode: ScheduledPrepareToolResultVerificationMode, stepId: string, toolCallId: string): boolean {
  const taskMatches = mode.phase === "finish"
    ? row.currentTaskStatus === "running" && row.currentTaskFailureReason === null && row.currentLeaseOwner === mode.ownerId
      && row.currentLeaseExpiresAt instanceof Date && Number.isFinite(row.currentLeaseExpiresAt.getTime())
      && row.leaseCheckedAt instanceof Date && Number.isFinite(row.leaseCheckedAt.getTime())
      && row.currentLeaseExpiresAt > row.leaseCheckedAt
    : row.currentTaskStatus === "completed" && row.currentTaskFailureReason === null
      && row.currentLeaseOwner === null && row.currentLeaseExpiresAt === null
  return row.id === reference.$ref && row.userId === scope.userId && row.sessionId === scope.sessionId
    && row.turnId === scope.turnId && row.taskId === scope.taskId && row.stepId === stepId && row.toolCallId === toolCallId
    && row.currentRootTaskId === scope.rootTaskId && row.currentAttemptCount === scope.attemptCount
    && taskMatches && row.currentInterruptRequestedAt === null
    && row.currentStepAttempt === scope.attemptCount && row.sourceCallStepId === stepId && row.sourceCallTaskId === scope.taskId
    && validText(row.sourceCallItemId) && row.sourceCallType === "tool_call" && row.sourceCallStatus === "completed"
    && validPrepareCall(row.sourceCallContent, toolCallId)
    && Number.isSafeInteger(row.byteCount) && Number(row.byteCount) >= 0 && Number(row.byteCount) <= MAX_TOOL_RESULT_BYTES
    && typeof row.sha256 === "string" && SHA256.test(row.sha256)
    && row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime())
    && row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime())
}

function validPrepareCall(value: unknown, toolCallId: string): boolean {
  const row = dataRecord(value, ["toolCallId", "toolName", "toolVersion", "input", "status", "errorCode"])
  const input = dataRecord(row?.input, [])
  return Boolean(row && input && row.toolCallId === toolCallId && row.toolName === "scheduled.application.prepare"
    && row.toolVersion === "1" && row.status === "completed" && row.errorCode === null)
}

function toReferenceRecord(row: Row): ToolResultReferenceRecord {
  return {
    id: row.id as string,
    userId: row.userId as string,
    sessionId: row.sessionId as string,
    turnId: row.turnId as string,
    stepId: row.stepId as string,
    taskId: row.taskId as string,
    toolCallId: row.toolCallId as string,
    sanitizedJson: row.sanitizedJson as ToolResultReferenceRecord["sanitizedJson"],
    sha256: row.sha256 as string,
    byteCount: row.byteCount as number,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}
