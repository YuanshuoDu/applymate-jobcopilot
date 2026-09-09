import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"

import { getEffectiveEntitlements } from "@/lib/entitlements"

import { normalizeUsageOwner, UsageOwnerFenceError, type UsageAdmissionOwnerInput, type UsageExecutionOwner } from "./usage-owner-fence"

export type UsageBrokerQuery = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>
}

export type UsageBrokerDatabase = {
  $transaction<T>(work: (tx: UsageBrokerQuery) => Promise<T>): Promise<T>
}

type UsageAdmissionCommon = {
  userId: string
  sessionId: string
  turnId: string
  stepId: string
  featureKey: string
  provider: string
  model: string
  attemptId?: string
  /** Resolved by the trusted route from the server-side AI configuration. */
  credentialSource?: "platform" | "user"
}

export type UsageAdmissionInput = UsageAdmissionCommon & UsageAdmissionOwnerInput

export type UsageSettlementInput = {
  operationId: string
  userId: string
  provider: string
  model: string
  status: "success" | "error"
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  errorCode?: string
}

export type UsageAdmissionResult = { operationId: string }

export class UsageBrokerError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) {
    super(message)
    this.name = "UsageBrokerError"
  }
}

function month(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

function operationId(input: UsageAdmissionInput, owner: UsageExecutionOwner): string {
  const ownerIdentity = owner.kind === "task"
    ? [owner.kind, owner.taskId, owner.rootTaskId, owner.ownerId, owner.attemptCount]
    : []
  const identity = [input.userId, input.sessionId, input.turnId, input.stepId, ...ownerIdentity, input.attemptId ?? "1", input.featureKey, input.provider, input.model].join("\u001f")
  return `agent-usage-${createHash("sha256").update(identity).digest("hex")}`
}

function numberValue(value: number, integer = false): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return integer ? Math.trunc(value) : value
}

function stableErrorCode(value: string | undefined): string | null {
  if (!value) return null
  return /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : "provider_error"
}

async function assertOwnerStep(tx: UsageBrokerQuery, input: UsageAdmissionInput, owner: UsageExecutionOwner): Promise<void> {
  if (owner.kind === "task") {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT task."id"
      FROM "sub_agent_tasks" AS task
      JOIN "sub_agent_tasks" AS root_task
        ON root_task."id" = task."rootTaskId" AND root_task."sessionId" = task."sessionId"
       AND root_task."rootTaskId" = root_task."id" AND root_task."turnId" = task."turnId"
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn
        ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
       AND turn."rootTaskId" = root_task."id"
      JOIN "agent_steps" AS step
        ON step."turnId" = task."turnId" AND step."sessionId" = task."sessionId"
       AND step."taskId" = task."id"
      WHERE task."id" = ${owner.taskId} AND task."sessionId" = ${input.sessionId}
        AND task."rootTaskId" = ${owner.rootTaskId} AND task."turnId" = ${input.turnId}
        AND session."userId" = ${input.userId} AND turn."userId" = ${input.userId}
        AND task."id" <> root_task."id" AND task."status" = 'running'
        AND task."leaseOwner" = ${owner.ownerId} AND task."attemptCount" = ${owner.attemptCount}
        AND task."leaseExpiresAt" > CURRENT_TIMESTAMP AND task."interruptRequestedAt" IS NULL
        AND root_task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
        AND root_task."interruptRequestedAt" IS NULL
        AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
        AND step."id" = ${input.stepId} AND step."attempt" = ${owner.attemptCount}
        AND step."status" = 'streaming'
      FOR UPDATE OF task, root_task, turn, step`)
    if (!rows[0]) throw new UsageBrokerError("usage_fence_rejected", 409)
    return
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT step."id"
    FROM "agent_turns" AS turn
    JOIN "agent_steps" AS step ON step."turnId" = turn."id" AND step."sessionId" = turn."sessionId"
    WHERE turn."id" = ${input.turnId} AND turn."sessionId" = ${input.sessionId}
      AND turn."userId" = ${input.userId} AND turn."status" = 'in_progress'
      AND turn."leaseOwnerId" = ${owner.leaseOwnerId} AND turn."leaseVersion" = ${owner.leaseVersion}
      AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP AND step."id" = ${input.stepId}
      AND step."attempt" = 1 AND step."status" = 'streaming'
      AND (step."taskId" IS NULL OR EXISTS (
        SELECT 1 FROM "sub_agent_tasks" AS root_task
        WHERE root_task."id" = step."taskId" AND root_task."sessionId" = step."sessionId"
          AND root_task."turnId" = turn."id" AND root_task."rootTaskId" = root_task."id"
          AND root_task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
          AND root_task."interruptRequestedAt" IS NULL AND root_task."attemptCount" = 1
      ))
    FOR UPDATE`)
  if (!rows[0]) throw new UsageBrokerError("usage_fence_rejected", 409)
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

/** Atomically claim one AI credit and create the provider-attempt ledger row. */
export async function admitAiUsage(
  db: UsageBrokerDatabase,
  input: UsageAdmissionInput,
  now = new Date(),
): Promise<UsageAdmissionResult> {
  let owner: UsageExecutionOwner
  try { owner = normalizeUsageOwner(input) } catch (error: unknown) {
    if (error instanceof UsageOwnerFenceError) throw new UsageBrokerError("usage_fence_rejected", 409)
    throw error
  }
  const entitlements = await getEffectiveEntitlements(input.userId)
  if (!Object.prototype.hasOwnProperty.call(entitlements.limits, "ai_credits")) throw new UsageBrokerError("ai_credits_disabled", 403)
  const limit = entitlements.limits.ai_credits
  const id = operationId(input, owner)
  return db.$transaction(async (tx) => {
    await setUserScope(tx, input.userId)
    await assertOwnerStep(tx, input, owner)
    const existing = await tx.$queryRaw<Array<{ id: string; status: string; userId: string | null; provider: string; model: string }>>(Prisma.sql`
      SELECT id, user_id AS "userId", provider, model, status FROM ai_usage_events WHERE id = ${id} FOR UPDATE`)
    const row = existing[0]
    if (row) {
      if (row.userId !== input.userId || row.provider !== input.provider || row.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
      if (row.status !== "reserved") throw new UsageBrokerError("usage_attempt_settled", 409)
      throw new UsageBrokerError("usage_attempt_in_flight", 409)
    }
    await tx.$queryRaw(Prisma.sql`
      INSERT INTO ai_usage_events
        (id, user_id, feature_key, provider, model, input_tokens, output_tokens, estimated_cost_usd,
         latency_ms, status, error_code, credential_source, runtime, created_at)
      VALUES (${id}, ${input.userId}, ${input.featureKey}, ${input.provider}, ${input.model}, 0, 0, 0,
         0, 'reserved', NULL, ${input.credentialSource ?? "platform"}, 'worker', CURRENT_TIMESTAMP)`)
    if (limit !== null && limit !== undefined) await reserveCredit(tx, input, limit, month(now))
    return { operationId: id }
  })
}

/** Settle a provider-attempt ledger row; repeated identical settlement is safe. */
export async function settleAiUsage(db: UsageBrokerDatabase, input: UsageSettlementInput): Promise<void> {
  const inputTokens = numberValue(input.inputTokens, true)
  const outputTokens = numberValue(input.outputTokens, true)
  const estimatedCostUsd = numberValue(input.estimatedCostUsd)
  const errorCode = stableErrorCode(input.errorCode)
  await db.$transaction(async (tx) => {
    await setUserScope(tx, input.userId)
    const rows = await tx.$queryRaw<Array<{
      userId: string | null; provider: string; model: string; status: string
      inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode: string | null
    }>>(Prisma.sql`
      SELECT user_id AS "userId", provider, model, status,
        input_tokens AS "inputTokens", output_tokens AS "outputTokens",
        estimated_cost_usd AS "estimatedCostUsd", error_code AS "errorCode"
      FROM ai_usage_events WHERE id = ${input.operationId} FOR UPDATE`)
    const row = rows[0]
    if (!row) throw new UsageBrokerError("usage_attempt_missing", 409)
    if (row.userId !== input.userId || row.provider !== input.provider || row.model !== input.model) throw new UsageBrokerError("usage_attempt_conflict", 409)
    if (row.status === input.status) {
      if (Number(row.inputTokens) !== inputTokens || Number(row.outputTokens) !== outputTokens ||
          Number(row.estimatedCostUsd) !== estimatedCostUsd || (row.errorCode ?? null) !== errorCode) {
        throw new UsageBrokerError("usage_settlement_conflict", 409)
      }
      return
    }
    if (row.status !== "reserved") throw new UsageBrokerError("usage_attempt_settled", 409)
    await tx.$queryRaw(Prisma.sql`
      UPDATE ai_usage_events
      SET status = ${input.status}, input_tokens = ${inputTokens}, output_tokens = ${outputTokens},
          estimated_cost_usd = ${estimatedCostUsd}, error_code = ${errorCode}
      WHERE id = ${input.operationId} AND status = 'reserved'`)
  })
}
