import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, turnEngineTenantTransaction } from "../turns/turn-engine-owner-sql.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"

export const SCHEDULED_PIPELINE_CANDIDATE_EVENT = "native_verification.scheduled_candidate_staged"
const CANDIDATE_SCHEMA = "agent-harness.v2.scheduled-pipeline-candidate.v1"
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
  writerLeaseOwnerId: string
  writerLeaseVersion: number
}>
type CandidateRow = Record<string, unknown>
export type ScheduledPipelineCandidateIdentity = Readonly<{
  owner: TurnExecutionOwnerFence
  rootAttemptCount: number
  finalStepId: string
  finalStepOrdinal: number
}>
export type ScheduledPipelineCandidateStore = Readonly<{
  stage(input: ScheduledPipelineCandidateIdentity & { candidateText: string }): Promise<void>
  /** undefined means no staged event; null means a staged event was invalidated by later state. */
  read(input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): Promise<string | null | undefined>
}>

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function object(value: unknown): CandidateRow | null {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return null } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as CandidateRow : null
}
function parseCandidatePayload(value: unknown): CandidatePayload | null {
  const row = object(value)
  const keys = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "finalStepId", "finalStepOrdinal", "stepAttempt", "candidateText", "writerLeaseOwnerId", "writerLeaseVersion"]
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.schemaVersion !== CANDIDATE_SCHEMA || !nonempty(row.sessionId) || !nonempty(row.turnId) || !nonempty(row.rootTaskId)
    || !positive(row.rootAttemptCount) || !nonempty(row.finalStepId) || row.stepAttempt !== 1
    || !Number.isSafeInteger(row.finalStepOrdinal) || Number(row.finalStepOrdinal) < 0 || !nonempty(row.candidateText)
    || !nonempty(row.writerLeaseOwnerId) || !Number.isSafeInteger(row.writerLeaseVersion) || Number(row.writerLeaseVersion) < 0) return null
  return row as CandidatePayload
}
function candidateIdentityMatches(row: CandidateRow, payload: CandidatePayload, input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): boolean {
  const owner = input.owner
  return row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.taskId === owner.rootTaskId && row.type === SCHEDULED_PIPELINE_CANDIDATE_EVENT
    && payload.schemaVersion === CANDIDATE_SCHEMA && payload.sessionId === owner.sessionId && payload.turnId === owner.turnId
    && payload.rootTaskId === owner.rootTaskId && payload.rootAttemptCount === input.rootAttemptCount
    && payload.finalStepId === row.correlationId
    && payload.finalStepOrdinal === Number(row.stepOrdinal) && nonempty(payload.candidateText)
    && Number.isSafeInteger(payload.writerLeaseVersion) && payload.writerLeaseVersion >= 0
    && nonempty(payload.writerLeaseOwnerId)
}
function assertTurnRoot(input: Pick<ScheduledPipelineCandidateIdentity, "owner" | "rootAttemptCount">): void {
  if (input.owner.kind !== "turn" || input.owner.taskId !== input.owner.rootTaskId
    || !positive(input.rootAttemptCount)) throw new Error("scheduled_candidate_owner_invalid")
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
      const payload: CandidatePayload = {
        schemaVersion: CANDIDATE_SCHEMA, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        rootAttemptCount: input.rootAttemptCount, finalStepId: input.finalStepId,
        finalStepOrdinal: input.finalStepOrdinal, candidateText: input.candidateText,
        stepAttempt: 1,
        writerLeaseOwnerId: owner.ownerId, writerLeaseVersion: owner.leaseVersion,
      }
      const identity = `scheduled-candidate:${owner.rootTaskId}:${input.rootAttemptCount}:${input.finalStepId}`
      await eventStore.appendEvent({ owner, id: `scheduled-candidate-${randomUUID()}`, itemId: null,
        type: SCHEDULED_PIPELINE_CANDIDATE_EVENT, correlationId: input.finalStepId, causationId: null,
        idempotencyKey: identity, payload })
    },
    async read(input): Promise<string | null | undefined> {
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
        const latest = await client.query<CandidateRow>(`SELECT session."userId" AS "userId", event."sessionId", event."turnId", event."taskId", event."type",
            event."correlationId", event."payload", step."id" AS "stepId", step."taskId" AS "stepTaskId", step."attempt" AS "stepAttempt",
            step."ordinal" AS "stepOrdinal", step."status" AS "stepStatus", step."inputThroughSequence" AS "stepInputThroughSequence"
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
        const newestStep = await client.query<CandidateRow>(`SELECT "id", "ordinal", "attempt" FROM "agent_steps"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "ordinal" DESC LIMIT 1`,
        [input.owner.sessionId, input.owner.turnId, input.owner.rootTaskId])
        const last = newestStep.rows[0]
        if (!last || last.id !== payload.finalStepId || Number(last.ordinal) !== payload.finalStepOrdinal || Number(last.attempt) !== 1) return null
        const inputCursor = String(row.stepInputThroughSequence)
        if (!/^\d+$/.test(inputCursor)) throw new Error("scheduled_candidate_step_mismatch")
        const unconsumed = await client.query(`SELECT 1 FROM "agent_inputs" WHERE "sessionId" = $1 AND "userId" = $2
          AND "targetTurnId" = $3 AND "acceptedSequence" > $4::bigint AND "status" IN ('accepted', 'queued')
          AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL LIMIT 1`,
        [input.owner.sessionId, input.owner.userId, input.owner.turnId, inputCursor])
        if (unconsumed.rows.length) return null
        return payload.candidateText
      })
    },
  }
}
