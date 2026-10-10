import type { ExecutionOwnerFence } from "../execution-owner.js"
import { TurnEngineError } from "./turn-engine-types.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, type TurnEngineQueryClient, type TurnEngineRow } from "./turn-engine-owner-sql.js"

export type NativeSemanticProgressMode = "legacy_v1" | "durable_v1"

export type NativeSemanticRejectionIdentity = Readonly<{
  candidateDigest: string
  controlTaskId: string
  controlOperationId: string
  controlAttempt: number
  controlReportDigest: string
}>

export type NativeSemanticRejectionCount = Readonly<{
  inputThroughSequence: bigint
  distinctStepCount: number
}>

export type NativeSemanticRejectionHistory = Readonly<{
  inputThroughSequence: bigint
  stepIds: readonly string[]
}>

export type NativeSemanticProgressStore = {
  resolveNativeSemanticProgressMode?(input: {
    owner: ExecutionOwnerFence
    requestedEnabled: boolean
    now: Date
  }): Promise<NativeSemanticProgressMode>
  readNativeSemanticRejections?(input: {
    owner: ExecutionOwnerFence
    stepId: string
    identity: NativeSemanticRejectionIdentity
  }): Promise<NativeSemanticRejectionHistory>
  completeNativeSemanticRejectionStep?(input: {
    owner: ExecutionOwnerFence
    stepId: string
    finishReason: string
    errorCode: null
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    now: Date
    identity: NativeSemanticRejectionIdentity
  }): Promise<NativeSemanticRejectionCount>
}

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function parseNativeSemanticRejectionIdentity(value: unknown): NativeSemanticRejectionIdentity | null {
  const row = record(value)
  if (!row || Reflect.ownKeys(row).some(key => typeof key !== "string") || Object.keys(row).sort().join(",") !== "candidateDigest,controlAttempt,controlOperationId,controlReportDigest,controlTaskId"
    || typeof row.candidateDigest !== "string" || !SHA256.test(row.candidateDigest)
    || typeof row.controlTaskId !== "string" || !ID.test(row.controlTaskId)
    || typeof row.controlOperationId !== "string" || !ID.test(row.controlOperationId)
    || typeof row.controlReportDigest !== "string" || !SHA256.test(row.controlReportDigest)
    || !Number.isSafeInteger(row.controlAttempt) || Number(row.controlAttempt) < 1) return null
  return { candidateDigest: row.candidateDigest as string, controlTaskId: row.controlTaskId as string,
    controlOperationId: row.controlOperationId as string, controlAttempt: row.controlAttempt as number,
    controlReportDigest: row.controlReportDigest as string }
}

function conflict(reason: string): TurnEngineError {
  return new TurnEngineError("persistence_conflict", `Native semantic rejection conflict: ${reason}`)
}

export function nativeSemanticSchemaConflict(error: unknown): never {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  if (code === "42P01" || code === "42703" || code === "42501") throw conflict("durable schema or grants unavailable")
  throw error
}

export function nativeSemanticCheckpoint(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n && value <= 9_223_372_036_854_775_807n) return value
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value)
    if (parsed <= 9_223_372_036_854_775_807n) return parsed
  }
  throw conflict("input checkpoint is invalid")
}

export async function readNativeSemanticRejectionsWithClient(
  client: TurnEngineQueryClient,
  input: { owner: ExecutionOwnerFence; stepId: string; identity: NativeSemanticRejectionIdentity },
): Promise<NativeSemanticRejectionHistory> {
  const { owner } = input
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || !parseNativeSemanticRejectionIdentity(input.identity)) throw conflict("read requires canonical root identity")
  if (!await lockTurnEngineOpenSession(client, owner) || !await lockTurnEngineOwnedTurn(client, owner)) throw conflict("read owner fence")
  const mode = await client.query<TurnEngineRow>(`SELECT to_jsonb(turn)->>'native_semantic_progress_mode' AS mode
    FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`, [owner.turnId, owner.sessionId, owner.userId])
  if (mode.rows[0]?.mode !== "durable_v1") throw conflict("durable mode is not pinned")
  const current = await client.query<TurnEngineRow>(`SELECT "inputThroughSequence", "status", "attempt", "taskId"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
  [input.stepId, owner.sessionId, owner.turnId])
  const step = current.rows[0]
  if (!step || step.taskId !== owner.taskId || Number(step.attempt) !== 1 || step.status !== "streaming") throw conflict(`step ${input.stepId} is not current`)
  const checkpoint = nativeSemanticCheckpoint(step.inputThroughSequence)
  const rows = await client.query<TurnEngineRow>(`SELECT rejection."stepId"
    FROM "agent_native_semantic_rejections" AS rejection
    JOIN "agent_steps" AS completed_step ON completed_step."id" = rejection."stepId"
      AND completed_step."sessionId" = rejection."sessionId" AND completed_step."turnId" = rejection."turnId"
      AND completed_step."taskId" = rejection."rootTaskId" AND completed_step."attempt" = rejection."attempt"
      AND completed_step."status" = 'completed' AND completed_step."errorCode" IS NULL AND completed_step."finishReason" IS NOT NULL
    WHERE rejection."userId" = $1 AND rejection."sessionId" = $2 AND rejection."turnId" = $3 AND rejection."rootTaskId" = $4
      AND rejection."inputThroughSequence" = $5 AND rejection."candidateDigest" = $6
      AND rejection."controlTaskId" = $7 AND rejection."controlOperationId" = $8
      AND rejection."controlAttempt" = $9 AND rejection."controlReportDigest" = $10
    ORDER BY completed_step."ordinal" ASC LIMIT 3`,
  [owner.userId, owner.sessionId, owner.turnId, owner.taskId, checkpoint.toString(), input.identity.candidateDigest,
    input.identity.controlTaskId, input.identity.controlOperationId, input.identity.controlAttempt, input.identity.controlReportDigest])
  return { inputThroughSequence: checkpoint, stepIds: rows.rows.map(row => String(row.stepId)) }
}
