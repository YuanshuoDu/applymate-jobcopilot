import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"

import { getEffectiveEntitlements } from "@/lib/entitlements"

import { normalizeUsageOwner, UsageOwnerFenceError, type UsageAdmissionOwnerInput, type UsageExecutionOwner } from "./usage-owner-fence"
import { reconcileAbandonedAgentUsage } from "./agent-usage-reconciliation"
import {
  findRootOutputReservation,
  lockRootUsageAdmissionScope,
  lockRootUsageReservationScope,
  releaseRootOutputReservation,
  reserveRootOutputTokens,
  RootUsageReservationError,
  settleRootOutputReservation,
  startRootOutputReservation,
  type RootUsageReservationRef,
} from "./agent-root-usage-reservations"

export type UsageBrokerQuery = { $queryRaw<T>(query: Prisma.Sql): Promise<T> }
export type UsageBrokerDatabase = { $transaction<T>(work: (tx: UsageBrokerQuery) => Promise<T>): Promise<T> }

type UsageAdmissionCommon = {
  userId: string; sessionId: string; turnId: string; stepId: string; featureKey: string
  provider: string; model: string; attemptId?: string; requestedOutputTokens?: number; startProtocolVersion?: 0 | 1
  /** Resolved by the trusted route from the server-side AI configuration. */
  credentialSource?: "platform" | "user"
}
export type UsageAdmissionInput = UsageAdmissionCommon & UsageAdmissionOwnerInput
export type UsageReleaseInput = UsageAdmissionInput & { status: "released" }
export type UsageSettlementInput = UsageReleaseInput | {
  operationId: string; userId: string; provider: string; model: string; status: "success" | "error"
  inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null; errorCode?: string
}
export type UsageStartInput = UsageAdmissionInput & { operationId: string; startProtocolVersion: 1 }
export type UsageStartResult = { startProtocolVersion: 1; outputReservationRequired: boolean; maxOutputTokens: number | null }
export type UsageAdmissionResult = { operationId: string; startProtocolVersion: 0 | 1; outputReservationRequired: boolean; maxOutputTokens: number | null }

export class UsageBrokerError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) { super(message); this.name = "UsageBrokerError" }
}

function month(now: Date): string { return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}` }
function operationId(input: UsageAdmissionInput, owner: UsageExecutionOwner): string {
  const ownerIdentity = owner.kind === "task" ? [owner.kind, owner.taskId, owner.rootTaskId, owner.ownerId, owner.attemptCount] : [owner.kind, owner.leaseOwnerId, owner.leaseVersion]
  const identity = [input.userId, input.sessionId, input.turnId, input.stepId, ...ownerIdentity, input.attemptId ?? "1", input.featureKey, input.provider, input.model, input.startProtocolVersion ?? 0].join("\u001f")
  return `agent-usage-${createHash("sha256").update(identity).digest("hex")}`
}
function stableErrorCode(value: string | undefined): string | null { return !value ? null : /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : "provider_error" }
function ownerFor(input: UsageAdmissionInput): UsageExecutionOwner {
  try { return normalizeUsageOwner(input) }
  catch (error: unknown) { if (error instanceof UsageOwnerFenceError) throw new UsageBrokerError("usage_fence_rejected", 409); throw error }
}
function rootError(error: unknown): never { if (error instanceof RootUsageReservationError) throw new UsageBrokerError(error.code, error.status); throw error }
function rejectExisting(row: { id: string; status: string; userId: string | null; provider: string; model: string }, input: UsageAdmissionInput): never {
  if (row.userId !== input.userId || row.provider !== input.provider || row.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
  if (row.status === "released") throw new UsageBrokerError("usage_attempt_released", 409)
  if (row.status !== "reserved") throw new UsageBrokerError("usage_attempt_settled", 409)
  throw new UsageBrokerError("usage_attempt_in_flight", 409)
}

async function setUserScope(tx: UsageBrokerQuery, userId: string): Promise<void> {
  // RLS policies read this transaction-local setting. It must be set on the
  // same Prisma transaction that performs the fence and ledger mutations.
  await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${userId}, true)`)
}
async function reserveCredit(tx: UsageBrokerQuery, input: UsageAdmissionInput, limit: number, currentMonth: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    INSERT INTO ai_budgets (id, user_id, month, used, "limit", created_at, updated_at)
    VALUES (${randomUUID()}, ${input.userId}, ${currentMonth}, 0, ${limit}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, month) DO UPDATE SET "limit" = EXCLUDED."limit", updated_at = CURRENT_TIMESTAMP`)
  const updated = await tx.$queryRaw<Array<{ used: number }>>(Prisma.sql`
    UPDATE ai_budgets SET used = used + 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ${input.userId} AND month = ${currentMonth} AND used < "limit"
    RETURNING used`)
  if (!updated[0]) throw new UsageBrokerError("ai_credits_exhausted", 429)
}

export async function admitAiUsageInTransaction(tx: UsageBrokerQuery, input: UsageAdmissionInput, now = new Date()): Promise<UsageAdmissionResult> {
  const owner = ownerFor(input)
  const entitlements = await getEffectiveEntitlements(input.userId)
  if (!Object.prototype.hasOwnProperty.call(entitlements.limits, "ai_credits")) throw new UsageBrokerError("ai_credits_disabled", 403)
  const limit = entitlements.limits.ai_credits
  const id = operationId(input, owner)
  try {
    await setUserScope(tx, input.userId)
    const scope = await lockRootUsageAdmissionScope(tx, input, owner)
    const startProtocolVersion = input.startProtocolVersion ?? 0
    await reconcileAbandonedAgentUsage(tx, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: scope.rootTaskId })
    const previous = await findRootOutputReservation(tx, id, input.userId)
    if (previous) rejectExisting({ id, status: previous.status, userId: previous.userId, provider: previous.provider, model: previous.model }, input)
    const output = await reserveRootOutputTokens(tx, scope, { operationId: id, attemptId: input.attemptId ?? "1",
      provider: input.provider, model: input.model, requestedOutputTokens: input.requestedOutputTokens, startProtocolVersion })
    const existing = await tx.$queryRaw<Array<{ id: string; status: string; userId: string | null; provider: string; model: string }>>(Prisma.sql`
      SELECT id, user_id AS "userId", provider, model, status FROM ai_usage_events WHERE id = ${id} FOR UPDATE`)
    if (existing[0]) rejectExisting(existing[0], input)
    const creditMonth = limit === null || limit === undefined ? null : month(now)
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO ai_usage_events
        (id, user_id, feature_key, provider, model, input_tokens, output_tokens, estimated_cost_usd, output_reservation_required,
         latency_ms, status, error_code, credential_source, runtime, created_at, usage_start_protocol_version)
      VALUES (${id}, ${input.userId}, ${input.featureKey}, ${input.provider}, ${input.model}, 0, 0, 0, ${output.required},
          0, 'reserved', ${creditMonth ? `credit_reserved_${creditMonth}` : null}, ${input.credentialSource ?? "platform"}, 'worker', CURRENT_TIMESTAMP AT TIME ZONE 'UTC', ${startProtocolVersion})
      ON CONFLICT (id) DO NOTHING RETURNING id`)
    if (!inserted[0]) {
      const raced = await tx.$queryRaw<Array<{ id: string; status: string; userId: string | null; provider: string; model: string }>>(Prisma.sql`
        SELECT id, user_id AS "userId", provider, model, status FROM ai_usage_events WHERE id = ${id} FOR UPDATE`)
      if (raced[0]) rejectExisting(raced[0], input)
      throw new UsageBrokerError("usage_attempt_conflict", 409)
    }
    if (limit !== null && limit !== undefined) await reserveCredit(tx, input, limit, month(now))
    return { operationId: id, startProtocolVersion, outputReservationRequired: output.required, maxOutputTokens: output.maxOutputTokens }
  } catch (error: unknown) { rootError(error) }
}

export async function admitAiUsage(db: UsageBrokerDatabase, input: UsageAdmissionInput, now = new Date()): Promise<UsageAdmissionResult> {
  return db.$transaction(tx => admitAiUsageInTransaction(tx, input, now))
}
export async function startAiUsageInTransaction(tx: UsageBrokerQuery, input: UsageStartInput): Promise<UsageStartResult> {
  const owner = ownerFor(input)
  if (input.startProtocolVersion !== 1) throw new UsageBrokerError("usage_start_protocol_required", 409)
  if (operationId(input, owner) !== input.operationId) throw new UsageBrokerError("usage_attempt_conflict", 409)
  try {
    await setUserScope(tx, input.userId)
    const row = await findRootOutputReservation(tx, input.operationId, input.userId)
    if (row && (row.provider !== input.provider || row.model !== input.model)) throw new UsageBrokerError("usage_attempt_conflict", 409)
    const event = (await tx.$queryRaw<Array<{ outputReservationRequired: boolean; startProtocolVersion: number; status: string; credentialSource: string; providerStartedAt: Date | null }>>(Prisma.sql`
      SELECT output_reservation_required AS "outputReservationRequired", usage_start_protocol_version AS "startProtocolVersion", status,
        credential_source AS "credentialSource", provider_started_at AS "providerStartedAt" FROM ai_usage_events
      WHERE id = ${input.operationId} AND user_id = ${input.userId} AND provider = ${input.provider} AND model = ${input.model}`))[0]
    const required = event?.outputReservationRequired
    if (!row || !event || event.startProtocolVersion !== 1 || required !== row.outputReservationRequired) throw new UsageBrokerError("usage_attempt_missing", 409)
    if (event.credentialSource !== (input.credentialSource ?? "platform")) throw new UsageBrokerError("usage_attempt_conflict", 409)
    if (event.status !== "reserved" || event.providerStartedAt !== null || row.status !== "reserved") throw new UsageBrokerError("usage_start_replayed", 409)
    await lockRootUsageAdmissionScope(tx, input, owner, row ?? undefined)
    const reservedOutputTokens = await startRootOutputReservation(tx, row)
    const maxOutputTokens = row.outputReservationRequired ? reservedOutputTokens : null
    const started = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE ai_usage_events SET provider_started_at = CURRENT_TIMESTAMP
      WHERE id = ${input.operationId} AND user_id = ${input.userId} AND provider = ${input.provider} AND model = ${input.model}
        AND status = 'reserved' AND provider_started_at IS NULL AND usage_start_protocol_version = 1
        AND output_reservation_required = ${required}
      RETURNING id`)
    if (!started[0]) throw new UsageBrokerError("usage_start_replayed", 409)
    return { startProtocolVersion: 1, outputReservationRequired: required, maxOutputTokens }
  } catch (error: unknown) { rootError(error) }
}

export async function startAiUsage(db: UsageBrokerDatabase, input: UsageStartInput): Promise<UsageStartResult> {
  return db.$transaction(tx => startAiUsageInTransaction(tx, input))
}

async function releaseAiUsage(db: UsageBrokerDatabase, input: UsageReleaseInput): Promise<void> {
  const owner = ownerFor(input), id = operationId(input, owner)
  await db.$transaction(async tx => {
    try {
      await setUserScope(tx, input.userId)
      const tokenRow = await findRootOutputReservation(tx, id, input.userId)
      if (tokenRow) {
        if (tokenRow.provider !== input.provider || tokenRow.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
        await lockRootUsageReservationScope(tx, tokenRow)
        await releaseRootOutputReservation(tx, tokenRow)
      }
      const read = () => tx.$queryRaw<Array<{ userId: string | null; provider: string; model: string; status: string; errorCode: string | null; providerStartedAt: Date | null; startProtocolVersion: number }>>(Prisma.sql`
        SELECT user_id AS "userId", provider, model, status, error_code AS "errorCode", provider_started_at AS "providerStartedAt",
          usage_start_protocol_version AS "startProtocolVersion"
        FROM ai_usage_events WHERE id = ${id} FOR UPDATE`)
      let row = (await read())[0]
      if (!row) {
        const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO ai_usage_events
            (id, user_id, feature_key, provider, model, input_tokens, output_tokens, estimated_cost_usd,
             latency_ms, status, error_code, credential_source, runtime, created_at, usage_start_protocol_version)
          VALUES (${id}, ${input.userId}, ${input.featureKey}, ${input.provider}, ${input.model}, 0, 0, 0,
              0, 'released', 'cancelled_before_provider', ${input.credentialSource ?? "platform"}, 'worker', CURRENT_TIMESTAMP AT TIME ZONE 'UTC', ${input.startProtocolVersion ?? 0})
          ON CONFLICT (id) DO NOTHING RETURNING id`)
        if (inserted[0]) return
        row = (await read())[0]
      }
      if (!row) throw new UsageBrokerError("usage_attempt_missing", 409)
      if (row.userId !== input.userId || row.provider !== input.provider || row.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
      if ((input.startProtocolVersion ?? 0) !== row.startProtocolVersion) throw new UsageBrokerError("usage_attempt_conflict", 409)
      if ((input.startProtocolVersion ?? 0) === 1 && !tokenRow) throw new UsageBrokerError("usage_attempt_missing", 409)
      if (row.providerStartedAt) throw new UsageBrokerError("usage_attempt_started", 409)
      if (row.status === "released") return
      if (row.status !== "reserved") throw new UsageBrokerError("usage_attempt_settled", 409)
      const reservedMonth = /^credit_reserved_(\d{4}-\d{2})$/.exec(row.errorCode ?? "")?.[1]
      if (reservedMonth) {
        const refunded = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        UPDATE ai_budgets SET used = GREATEST(used - 1, 0), updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${input.userId} AND month = ${reservedMonth} RETURNING user_id AS "userId"`)
        if (!refunded[0]) throw new UsageBrokerError("usage_credit_refund_unavailable", 503)
      }
      await tx.$queryRaw(Prisma.sql`
        UPDATE ai_usage_events SET status = 'released', input_tokens = 0, output_tokens = 0,
          estimated_cost_usd = 0, error_code = 'cancelled_before_provider'
        WHERE id = ${id} AND status = 'reserved'`)
    } catch (error: unknown) { rootError(error) }
  })
}

function knownUsage(value: number | null, integer: boolean): number | null {
  if (value === null) return null
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new UsageBrokerError("usage_settlement_invalid", 400)
  return value
}
export async function settleAiUsageInTransaction(tx: UsageBrokerQuery, input: Exclude<UsageSettlementInput, UsageReleaseInput>): Promise<void> {
  const inputTokens = knownUsage(input.inputTokens, true), outputTokens = knownUsage(input.outputTokens, true)
  const estimatedCostUsd = knownUsage(input.estimatedCostUsd, false), errorCode = stableErrorCode(input.errorCode)
  try {
    await setUserScope(tx, input.userId)
    const tokenRow = await findRootOutputReservation(tx, input.operationId, input.userId)
    if (tokenRow) {
      if (tokenRow.provider !== input.provider || tokenRow.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
      await lockRootUsageReservationScope(tx, tokenRow)
      if (inputTokens !== null && outputTokens !== null && estimatedCostUsd !== null) await settleRootOutputReservation(tx, tokenRow, { status: input.status, outputTokens, errorCode })
    }
    const event = (await tx.$queryRaw<Array<{ startProtocolVersion: number; providerStartedAt: Date | null; status: string }>>(Prisma.sql`
      SELECT usage_start_protocol_version AS "startProtocolVersion", provider_started_at AS "providerStartedAt", status
      FROM ai_usage_events WHERE id = ${input.operationId} AND user_id = ${input.userId}
        AND provider = ${input.provider} AND model = ${input.model} FOR UPDATE`))[0]
    if (!event) throw new UsageBrokerError("usage_attempt_missing", 409)
    if (event.startProtocolVersion === 1 && (!tokenRow || event.providerStartedAt === null)) throw new UsageBrokerError("usage_attempt_not_started", 409)
    if (event.status !== "reserved" && event.status !== input.status) throw new UsageBrokerError("usage_attempt_settled", 409)
    // Unknown usage never becomes zero; the started output hold remains reserved until every dimension exists.
    if (inputTokens === null || outputTokens === null || estimatedCostUsd === null) return
    const row = (await tx.$queryRaw<Array<{
      userId: string | null; provider: string; model: string; status: string
      inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode: string | null
    }>>(Prisma.sql`
      SELECT user_id AS "userId", provider, model, status, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
        estimated_cost_usd AS "estimatedCostUsd", error_code AS "errorCode"
      FROM ai_usage_events WHERE id = ${input.operationId} FOR UPDATE`))[0]
    if (!row) throw new UsageBrokerError("usage_attempt_missing", 409)
    if (row.userId !== input.userId || row.provider !== input.provider || row.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
    if (row.status === input.status) {
      if (Number(row.inputTokens) !== inputTokens || Number(row.outputTokens) !== outputTokens || Number(row.estimatedCostUsd) !== estimatedCostUsd || (row.errorCode ?? null) !== errorCode) throw new UsageBrokerError("usage_settlement_conflict", 409)
      return
    }
    if (row.status !== "reserved") throw new UsageBrokerError("usage_attempt_settled", 409)
    await tx.$queryRaw(Prisma.sql`
      UPDATE ai_usage_events SET status = ${input.status}, input_tokens = ${inputTokens}, output_tokens = ${outputTokens},
        estimated_cost_usd = ${estimatedCostUsd}, error_code = ${errorCode}
      WHERE id = ${input.operationId} AND status = 'reserved'`)
  } catch (error: unknown) { rootError(error) }
}
export async function settleAiUsage(db: UsageBrokerDatabase, input: UsageSettlementInput): Promise<void> {
  if (input.status === "released") return releaseAiUsage(db, input)
  return db.$transaction(tx => settleAiUsageInTransaction(tx, input))
}
