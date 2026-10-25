import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { TurnUsage } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, turnEngineTenantTransaction } from "../turns/turn-engine-owner-sql.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { readScheduledPipelineRecoveryStepProfile, type ScheduledPipelineRecoveryOwner,
  type ScheduledPipelineRecoverySource, type ScheduledPipelineRecoveryTail } from "./scheduled-pipeline-recovery-step.js"
import { readScheduledPipelineRecoveryEvidence } from "./scheduled-pipeline-recovery-evidence.js"

export const SCHEDULED_PIPELINE_CANDIDATE_EVENT = "native_verification.scheduled_candidate_staged"
export const SCHEDULED_PIPELINE_CANDIDATE_SCHEMA = "agent-harness.v2.scheduled-pipeline-candidate.v2"
const CANDIDATE_SCHEMA = SCHEDULED_PIPELINE_CANDIDATE_SCHEMA
const ELIGIBLE_STEP_STATUSES = new Set(["streaming", "completed", "waiting_for_user", "waiting_for_tool"])

type CandidatePayload = Readonly<{
  schemaVersion: typeof CANDIDATE_SCHEMA
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  finalStepId: string
  finalStepOrdinal: number
  stepAttempt: 1
  candidateText: string
  finishReason: string
  usage: TurnUsage | null
}>
type CandidateRow = Record<string, unknown>
export type ScheduledPipelineCandidateIdentity = Readonly<{
  owner: TurnExecutionOwnerFence
  rootAttemptCount: number
  finalStepId: string
  finalStepOrdinal: number
}>
export type ScheduledPipelineCandidate = Readonly<{ candidateText: string; finalStepId: string; finalStepOrdinal: number; finishReason: string; usage: TurnUsage | null;
  recoverySource: ScheduledPipelineRecoverySource; recoveryTail: ScheduledPipelineRecoveryTail | null }>
export type ScheduledPipelineCandidateStore = Readonly<{
  stage(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  /** undefined means no staged event; null means a staged event was invalidated by later state. */
  read(input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): Promise<ScheduledPipelineCandidate | null | undefined>
}>

type ScheduledCandidateModelOutput = Readonly<{
  owner: TurnExecutionOwnerFence
  finalStepId: string
  finalStepOrdinal: number
  candidateText: string
  finishReason: string
  usage: TurnUsage | null
}>

const pendingModelOutputs = new Map<string, ScheduledCandidateModelOutput>()
const recoveredCandidates = new Map<string, ScheduledPipelineCandidate>()
const MAX_RECOVERED_CANDIDATES = 64

/** Bridges the exact model result into the scheduled candidate write without widening generic completion contracts. */
export async function withScheduledPipelineCandidateModelOutput<T>(input: ScheduledCandidateModelOutput, work: () => Promise<T>): Promise<T> {
  assertTurnRoot({ owner: input.owner, rootAttemptCount: 1 })
  if (!nonempty(input.finalStepId) || !Number.isSafeInteger(input.finalStepOrdinal) || input.finalStepOrdinal < 0
    || !nonempty(input.candidateText) || !validFinishReason(input.finishReason) || !validUsage(input.usage)) {
    throw new Error("scheduled_candidate_model_receipt_invalid")
  }
  const key = modelOutputKey(input.owner, input.finalStepId, input.finalStepOrdinal)
  if (pendingModelOutputs.has(key)) throw new Error("scheduled_candidate_model_receipt_conflict")
  pendingModelOutputs.set(key, input)
  try { return await work() }
  finally { if (pendingModelOutputs.get(key) === input) pendingModelOutputs.delete(key) }
}

/** Consumes exact model metadata restored by read(); generic candidate recovery remains untouched. */
export function takeRecoveredScheduledPipelineCandidate(input: { owner: TurnExecutionOwnerFence; candidateText: string }): ScheduledPipelineCandidate | undefined {
  const key = candidateOwnerKey(input.owner), candidate = recoveredCandidates.get(key)
  recoveredCandidates.delete(key)
  if (!candidate) return undefined
  if (candidate.candidateText !== input.candidateText) throw new Error("scheduled_candidate_recovery_mismatch")
  return candidate
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function object(value: unknown): CandidateRow | null {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return null } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as CandidateRow : null
}
function parseCandidatePayload(value: unknown): CandidatePayload | null {
  const row = object(value)
  const keys = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "finalStepId", "finalStepOrdinal", "stepAttempt", "candidateText", "finishReason", "usage"]
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.schemaVersion !== CANDIDATE_SCHEMA || !nonempty(row.sessionId) || !nonempty(row.turnId) || !nonempty(row.rootTaskId)
    || !positive(row.rootAttemptCount) || !nonempty(row.finalStepId) || row.stepAttempt !== 1
    || !Number.isSafeInteger(row.finalStepOrdinal) || Number(row.finalStepOrdinal) < 0 || !nonempty(row.candidateText)
    || !validFinishReason(row.finishReason) || !validUsage(row.usage)) return null
  return row as CandidatePayload
}
function candidateIdentityMatches(row: CandidateRow, payload: CandidatePayload, input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): boolean {
  const owner = input.owner
  return nonempty(row.sourceEventId) && row.sourceEventId.length <= 256
    && row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.taskId === owner.rootTaskId && row.type === SCHEDULED_PIPELINE_CANDIDATE_EVENT
    && payload.schemaVersion === CANDIDATE_SCHEMA && payload.sessionId === owner.sessionId && payload.turnId === owner.turnId
    && payload.rootTaskId === owner.rootTaskId && payload.rootAttemptCount === input.rootAttemptCount
    && payload.finalStepId === row.correlationId
    && payload.finalStepOrdinal === Number(row.stepOrdinal) && nonempty(payload.candidateText)
}
function assertTurnRoot(input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): void {
  if (input.owner.kind !== "turn" || input.owner.taskId !== input.owner.rootTaskId
    || !positive(input.rootAttemptCount)) throw new Error("scheduled_candidate_owner_invalid")
}

function validFinishReason(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128
}
function validUsage(value: unknown): value is TurnUsage | null {
  if (value === null) return true
  const row = object(value)
  return !!row && Object.getPrototypeOf(row) === Object.prototype && Object.keys(row).length === 3 && Object.hasOwn(row, "inputTokens") && Object.hasOwn(row, "outputTokens")
    && Object.hasOwn(row, "estimatedCostUsd") && Number.isSafeInteger(row.inputTokens) && Number(row.inputTokens) >= 0
    && Number.isSafeInteger(row.outputTokens) && Number(row.outputTokens) >= 0
    && typeof row.estimatedCostUsd === "number" && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0
}
function candidateOwnerKey(owner: TurnExecutionOwnerFence): string {
  return JSON.stringify([owner.userId, owner.sessionId, owner.turnId, owner.taskId, owner.ownerId, owner.leaseVersion])
}
function stableOwner(owner: TurnExecutionOwnerFence): ScheduledPipelineRecoveryOwner {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId }
}
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function stringIds(value: unknown): string[] | null {
  const row = parseJson(value)
  return Array.isArray(row) && row.every(id => typeof id === "string" && id.trim() === id && id.length > 0) && new Set(row).size === row.length ? row : null
}
function validCursor(value: string): boolean { return /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n }
function modelOutputKey(owner: TurnExecutionOwnerFence, stepId: string, ordinal: number): string {
  return JSON.stringify([candidateOwnerKey(owner), stepId, ordinal])
}
function rememberRecoveredCandidate(owner: TurnExecutionOwnerFence, candidate: ScheduledPipelineCandidate): void {
  const key = candidateOwnerKey(owner)
  recoveredCandidates.delete(key)
  recoveredCandidates.set(key, candidate)
  while (recoveredCandidates.size > MAX_RECOVERED_CANDIDATES) {
    const oldest = recoveredCandidates.keys().next().value
    if (oldest === undefined) break
    recoveredCandidates.delete(oldest)
  }
}

export function createScheduledPipelineCandidateStore(
  pool: Pick<pg.Pool, "connect">,
  eventStore: Pick<TurnEngineStore, "appendEvent">,
): ScheduledPipelineCandidateStore {
  return {
    async stage(input): Promise<void> {
      assertTurnRoot(input)
      if (!nonempty(input.finalStepId) || !Number.isSafeInteger(input.finalStepOrdinal) || input.finalStepOrdinal < 0
        || typeof input.candidateText !== "string" || input.candidateText.trim().length === 0) throw new Error("scheduled_candidate_identity_invalid")
      const { owner } = input
      const modelOutput = pendingModelOutputs.get(modelOutputKey(owner, input.finalStepId, input.finalStepOrdinal))
      if (!modelOutput || modelOutput.candidateText !== input.candidateText) throw new Error("scheduled_candidate_model_receipt_missing")
      const payload: CandidatePayload = {
        schemaVersion: CANDIDATE_SCHEMA, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        rootAttemptCount: input.rootAttemptCount, finalStepId: input.finalStepId,
        finalStepOrdinal: input.finalStepOrdinal, candidateText: input.candidateText,
        stepAttempt: 1, finishReason: modelOutput.finishReason, usage: modelOutput.usage,
      }
      const identity = `scheduled-candidate:${owner.rootTaskId}:${input.rootAttemptCount}:${input.finalStepId}`
      await eventStore.appendEvent({ owner, id: `scheduled-candidate-${randomUUID()}`, itemId: null,
        type: SCHEDULED_PIPELINE_CANDIDATE_EVENT, correlationId: input.finalStepId, causationId: null,
        idempotencyKey: identity, payload })
    },
    async read(input): Promise<ScheduledPipelineCandidate | null | undefined> {
      assertTurnRoot(input)
      return turnEngineTenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockTurnEngineOpenSession(client, input.owner) || !await lockTurnEngineOwnedTurn(client, input.owner)) {
          throw new Error("scheduled_candidate_owner_lost")
        }
        const root = await client.query<CandidateRow>(`SELECT task."attemptCount" FROM "sub_agent_tasks" AS task
          JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1
            AND session."userId" = $4 AND task."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') FOR SHARE`,
        [input.owner.rootTaskId, input.owner.sessionId, input.owner.turnId, input.owner.userId])
        if (Number(root.rows[0]?.attemptCount) !== input.rootAttemptCount) throw new Error("scheduled_candidate_root_attempt_changed")
        const latest = await client.query<CandidateRow>(`SELECT event."id" AS "sourceEventId", session."userId" AS "userId", event."sessionId", event."turnId", event."taskId", event."type",
            event."correlationId", event."payload", step."id" AS "stepId", step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt",
            step."ordinal" AS "stepOrdinal", step."status" AS "stepStatus", step."inputThroughSequence" AS "stepInputThroughSequence",
            step."consumedInputIds" AS "stepConsumedInputIds", step."modelProfileSnapshot" AS "stepModelProfileSnapshot",
            step."finishReason" AS "stepFinishReason", step."inputTokens" AS "stepInputTokens", step."outputTokens" AS "stepOutputTokens",
            step."estimatedCostUsd" AS "stepEstimatedCostUsd"
          FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
          LEFT JOIN "agent_steps" AS step ON step."id" = event."correlationId" AND step."sessionId" = event."sessionId" AND step."turnId" = event."turnId"
          WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3 AND session."userId" = $4
          ORDER BY event."sequence" DESC LIMIT 1`,
        [input.owner.sessionId, input.owner.turnId, SCHEDULED_PIPELINE_CANDIDATE_EVENT, input.owner.userId])
        const row = latest.rows[0]
        if (!row) return undefined
        const payload = parseCandidatePayload(row.payload)
        if (!payload || !candidateIdentityMatches(row, payload, input)) {
          throw new Error("scheduled_candidate_identity_mismatch")
        }
        if (row.stepId !== payload.finalStepId || row.stepTaskId !== input.owner.rootTaskId
          || Number(row.stepAttempt) !== 1 || Number(row.stepOrdinal) !== payload.finalStepOrdinal
          || !ELIGIBLE_STEP_STATUSES.has(String(row.stepStatus))) throw new Error("scheduled_candidate_step_mismatch")
        if (row.stepFinishReason !== null && row.stepFinishReason !== undefined && row.stepFinishReason !== payload.finishReason) throw new Error("scheduled_candidate_finish_reason_mismatch")
        if (payload.usage && row.stepFinishReason !== null && row.stepFinishReason !== undefined
          && (Number(row.stepInputTokens) !== payload.usage.inputTokens || Number(row.stepOutputTokens) !== payload.usage.outputTokens
            || Number(row.stepEstimatedCostUsd) !== payload.usage.estimatedCostUsd)) throw new Error("scheduled_candidate_usage_mismatch")
        const inputCursor = String(row.stepInputThroughSequence)
        const consumedInputIds = stringIds(row.stepConsumedInputIds)
        if (!validCursor(inputCursor) || !consumedInputIds || readScheduledPipelineRecoveryStepProfile(row.stepModelProfileSnapshot)) throw new Error("scheduled_candidate_step_mismatch")
        const recoverySource: ScheduledPipelineRecoverySource = { owner: stableOwner(input.owner), sourceEventId: String(row.sourceEventId),
          sourceStepId: payload.finalStepId, sourceStepOrdinal: payload.finalStepOrdinal, rootAttemptCount: input.rootAttemptCount,
          inputThroughSequence: inputCursor, consumedInputIds }
        const recoveryTail = await readScheduledPipelineRecoveryEvidence(client, input.owner, recoverySource)
        if (recoveryTail === false) return null
        const unconsumed = await client.query(`SELECT 1 FROM "agent_inputs" WHERE "sessionId" = $1 AND "userId" = $2
          AND "targetTurnId" = $3 AND "acceptedSequence" > $4::bigint AND "status" IN ('accepted', 'queued')
          AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL LIMIT 1`,
        [input.owner.sessionId, input.owner.userId, input.owner.turnId, inputCursor])
        if (unconsumed.rows.length) return null
        const recovered: ScheduledPipelineCandidate = { candidateText: payload.candidateText, finalStepId: payload.finalStepId,
          finalStepOrdinal: payload.finalStepOrdinal, finishReason: payload.finishReason, usage: payload.usage,
          recoverySource, recoveryTail }
        rememberRecoveredCandidate(input.owner, recovered)
        return recovered
      })
    },
  }
}
