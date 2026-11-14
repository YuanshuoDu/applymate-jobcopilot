import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db as defaultDb } from '@/lib/db'
import { estimateAiCostUsd, prepareReservedModelTransport, type AiConfig, type ChatMessage, type ChatResult } from '@/lib/model-router'
import { reconcileAbandonedAgentUsage } from './agent-usage-reconciliation'
import { admitAiUsageInTransaction, settleAiUsage, startAiUsageInTransaction,
  settleAiUsageInTransaction, type UsageAdmissionInput, type UsageBrokerDatabase, type UsageBrokerQuery,
  type UsageSettlementInput, type UsageStartInput } from './usage-broker'

export type GateQualityValidatedOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; gateTaskId: string
  gateLeaseOwnerId: string; gateAttemptCount: number; executionId: string; executionAttemptCount: number
  continuationKey: string; claimToken: string
}>
export type GateQualityModelInput = Readonly<{ jobId: string; config: AiConfig; messages: ChatMessage[]; maxTokens: number }>
export type GateQualityUsageDatabase = { $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> }
export type GateQualityOwnerLock = (tx: Prisma.TransactionClient) => Promise<GateQualityValidatedOwner | null>
type PriorReview = { stepId: string; inputDigest: string | null; operationId: string | null; usageStatus: string | null; reservationStatus: string | null; providerStartedAt: Date | null }

const REVIEW_MARKER = 'gateQualityReview'

export function createGateQualityUsageCaller(input: {
  db?: GateQualityUsageDatabase; owner: GateQualityValidatedOwner; lockCurrentOwner: GateQualityOwnerLock; signal?: AbortSignal
}): (call: GateQualityModelInput) => Promise<ChatResult> {
  const database = input.db ?? defaultDb as unknown as GateQualityUsageDatabase
  return async call => {
    if (!Number.isSafeInteger(call.maxTokens) || call.maxTokens < 1 || call.maxTokens > 300) throw new Error('gate_quality_output_limit_invalid')
    const transport = prepareReservedModelTransport(call.config)
    const logicalReviewKey = digest([input.owner.sessionId, input.owner.turnId, input.owner.gateTaskId, call.jobId])
    const inputDigest = digest(call.messages.map(message => ({ role: message.role, content: message.content })))
    const stepId = randomUUID()
    const usageInput: UsageAdmissionInput = {
      userId: input.owner.userId, sessionId: input.owner.sessionId, turnId: input.owner.turnId, stepId,
      executionOwner: { kind: 'task', taskId: input.owner.gateTaskId, rootTaskId: input.owner.rootTaskId,
        ownerId: input.owner.gateLeaseOwnerId, attemptCount: input.owner.gateAttemptCount },
      featureKey: 'autoApply', provider: transport.provider, model: transport.model, attemptId: 'gate-quality-review',
      requestedOutputTokens: call.maxTokens, startProtocolVersion: 1, credentialSource: transport.credentialSource,
    }

    const admitted = await database.$transaction(async tx => {
      await setUserScope(tx, input.owner.userId)
      await requireCurrentOwner(tx, input)
      await reconcileAbandonedAgentUsage(tx, { userId: input.owner.userId, sessionId: input.owner.sessionId,
        turnId: input.owner.turnId, rootTaskId: input.owner.rootTaskId })
      await rejectPriorStartedReview(tx, input.owner, logicalReviewKey, inputDigest)
      const ordinal = await nextOrdinal(tx, input.owner.turnId)
      await tx.$queryRaw(Prisma.sql`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence",
         "consumedInputIds", "modelProfileSnapshot", "startedAt")
        VALUES (${stepId}, ${input.owner.sessionId}, ${input.owner.turnId}, ${input.owner.gateTaskId}, ${ordinal},
          ${input.owner.gateAttemptCount}, 'streaming', 0, '[]'::jsonb, ${JSON.stringify({ schemaVersion: 1,
            provider: transport.provider, model: transport.model, [REVIEW_MARKER]: { logicalReviewKey, inputDigest } })}::jsonb, CURRENT_TIMESTAMP)`)
      const admission = await admitAiUsageInTransaction(tx, usageInput)
      return { admission, stepId, usageInput }
    })
    const startInput: UsageStartInput = { ...admitted.usageInput, operationId: admitted.admission.operationId, startProtocolVersion: 1 }
    const maxTokens = admitted.admission.maxOutputTokens ?? call.maxTokens
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > call.maxTokens) {
      await releaseUnstarted(database, startInput, admitted.stepId)
      throw new Error('gate_quality_output_limit_invalid')
    }
    if (input.signal?.aborted) {
      await releaseUnstarted(database, startInput, admitted.stepId)
      throw input.signal.reason ?? abortError()
    }
    try {
      await database.$transaction(async tx => {
        await setUserScope(tx, input.owner.userId)
        await requireCurrentOwner(tx, input)
        await startAiUsageInTransaction(tx, startInput)
      })
    } catch (error: unknown) {
      await releaseUnstarted(database, startInput, admitted.stepId)
      throw error
    }

    const startedAt = Date.now()
    let response: ChatResult
    try {
      response = await transport.chat(call.messages, maxTokens, input.signal)
    } catch (error: unknown) {
      const errorCode = input.signal?.aborted ? 'gate_quality_cancelled' : 'gate_quality_provider_error'
      await settleAndCloseStep(database, { operationId: startInput.operationId, userId: startInput.userId,
        provider: startInput.provider, model: startInput.model, status: 'error', inputTokens: null,
        outputTokens: null, estimatedCostUsd: null, errorCode: 'gate_quality_provider_error' }, {
        stepId: admitted.stepId, userId: input.owner.userId, status: input.signal?.aborted ? 'interrupted' : 'failed',
        errorCode, durationMs: Date.now() - startedAt, usage: { inputTokens: null, outputTokens: null, estimatedCostUsd: null },
      })
      throw error
    }
    const responseMatches = response.provider === transport.provider && response.model === transport.model
    const inputTokens = responseMatches ? tokenCount(response.inputTokens) : null
    const outputTokens = responseMatches ? tokenCount(response.outputTokens) : null
    const estimatedCostUsd = inputTokens === null || outputTokens === null || transport.provider === 'custom' ? null
      : estimateAiCostUsd(response.provider, response.model, inputTokens, outputTokens)
    if (inputTokens === null || outputTokens === null || estimatedCostUsd === null || outputTokens > maxTokens) {
      const errorCode = 'gate_quality_usage_unknown'
      await settleAndCloseStep(database, { operationId: startInput.operationId, userId: startInput.userId,
        provider: startInput.provider, model: startInput.model, status: 'error', inputTokens, outputTokens,
        estimatedCostUsd, errorCode }, { stepId: admitted.stepId, userId: input.owner.userId, status: 'failed',
        errorCode, durationMs: Date.now() - startedAt, usage: { inputTokens, outputTokens, estimatedCostUsd } })
      throw new Error('gate_quality_usage_unknown')
    }
    await settleAndCloseStep(database, { operationId: startInput.operationId, userId: startInput.userId,
      provider: startInput.provider, model: startInput.model, status: 'success', inputTokens,
      outputTokens, estimatedCostUsd }, { stepId: admitted.stepId, userId: input.owner.userId, status: 'completed',
      errorCode: null, durationMs: Date.now() - startedAt, usage: { inputTokens, outputTokens, estimatedCostUsd } })
    await database.$transaction(async tx => {
      await setUserScope(tx, input.owner.userId)
      await requireCurrentOwner(tx, input)
    })
    return response
  }
}

async function rejectPriorStartedReview(tx: Prisma.TransactionClient, owner: GateQualityValidatedOwner, key: string, inputDigest: string): Promise<void> {
  const rows = await tx.$queryRaw<PriorReview[]>(Prisma.sql`
    SELECT step."id" AS "stepId", step."modelProfileSnapshot" #>> '{gateQualityReview,inputDigest}' AS "inputDigest",
      reservation."id" AS "operationId", reservation."status" AS "reservationStatus",
      event."status" AS "usageStatus", event."provider_started_at" AS "providerStartedAt"
    FROM "agent_steps" AS step
    LEFT JOIN "agent_root_usage_reservations" AS reservation
      ON reservation."stepId" = step."id" AND reservation."userId" = ${owner.userId}
        AND reservation."sessionId" = ${owner.sessionId} AND reservation."turnId" = ${owner.turnId}
        AND reservation."rootTaskId" = ${owner.rootTaskId} AND reservation."taskId" = ${owner.gateTaskId}
    LEFT JOIN ai_usage_events AS event ON event.id = reservation."id" AND event.user_id = ${owner.userId}
    WHERE step."sessionId" = ${owner.sessionId} AND step."turnId" = ${owner.turnId} AND step."taskId" = ${owner.gateTaskId}
      AND step."modelProfileSnapshot" #>> '{gateQualityReview,logicalReviewKey}' = ${key}
    ORDER BY step."attempt", step."ordinal" FOR UPDATE OF step`)
  if (!rows.length && owner.executionAttemptCount > 1) throw new Error('gate_quality_replay_lineage_missing')
  for (const row of rows) {
    if (row.inputDigest !== inputDigest) throw new Error('gate_quality_replay_input_changed')
    if (!row.operationId || !row.usageStatus || !row.reservationStatus) throw new Error('gate_quality_replay_evidence_missing')
    if (row.providerStartedAt !== null || row.usageStatus !== 'released' || row.reservationStatus !== 'released') {
      throw new Error('gate_quality_review_already_attempted')
    }
    await tx.$queryRaw(Prisma.sql`UPDATE "agent_steps" SET "status" = 'interrupted', "completedAt" = CURRENT_TIMESTAMP,
      "errorCode" = 'gate_quality_unstarted_recovered' WHERE "id" = ${row.stepId} AND "status" = 'streaming'`)
  }
}

async function nextOrdinal(tx: Prisma.TransactionClient, turnId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ ordinal: number }>>(Prisma.sql`
    SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal" FROM "agent_steps" WHERE "turnId" = ${turnId}`)
  const ordinal = Number(rows[0]?.ordinal)
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('gate_quality_step_ordinal_invalid')
  return ordinal
}

async function requireCurrentOwner(tx: Prisma.TransactionClient, input: { owner: GateQualityValidatedOwner; lockCurrentOwner: GateQualityOwnerLock; signal?: AbortSignal }): Promise<void> {
  const current = input.signal?.aborted ? null : await input.lockCurrentOwner(tx)
  if (!current || !sameOwner(input.owner, current)) throw new Error('gate_quality_owner_stale')
}
function sameOwner(a: GateQualityValidatedOwner, b: GateQualityValidatedOwner): boolean {
  return a.userId === b.userId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.rootTaskId === b.rootTaskId
    && a.gateTaskId === b.gateTaskId && a.gateLeaseOwnerId === b.gateLeaseOwnerId && a.gateAttemptCount === b.gateAttemptCount
    && a.executionId === b.executionId && a.executionAttemptCount === b.executionAttemptCount
    && a.continuationKey === b.continuationKey && a.claimToken === b.claimToken
}
async function releaseUnstarted(db: GateQualityUsageDatabase, input: UsageStartInput, stepId: string): Promise<void> {
  try {
    await settleAiUsage(brokerDatabase(db), { ...input, status: 'released' })
    await db.$transaction(async tx => {
      await setUserScope(tx, input.userId)
      await closeStepInTransaction(tx, { stepId, userId: input.userId, status: 'interrupted',
        errorCode: 'gate_quality_unstarted', usage: emptyUsage() })
    })
  } catch { /* A started or unknown attempt keeps its reservation; never force a release. */ }
}
type StepUsage = { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null }
type StepClose = { stepId: string; userId: string; status: 'completed' | 'failed' | 'interrupted'; errorCode: string | null; durationMs?: number; usage: StepUsage }
function emptyUsage(): StepUsage { return { inputTokens: null, outputTokens: null, estimatedCostUsd: null } }
async function settleAndCloseStep(db: GateQualityUsageDatabase, settlement: Exclude<UsageSettlementInput, { status: 'released' }>, step: StepClose): Promise<void> {
  await db.$transaction(async tx => {
    await setUserScope(tx, step.userId)
    await settleAiUsageInTransaction(tx, settlement)
    await closeStepInTransaction(tx, step)
  })
}
async function closeStepInTransaction(tx: Prisma.TransactionClient, step: StepClose): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`UPDATE "agent_steps" SET "status" = ${step.status},
    "inputTokens" = ${step.usage.inputTokens}, "outputTokens" = ${step.usage.outputTokens},
    "estimatedCostUsd" = ${step.usage.estimatedCostUsd}, "errorCode" = ${step.errorCode},
    "completedAt" = CURRENT_TIMESTAMP, "durationMs" = ${step.durationMs ?? null}
    WHERE "id" = ${step.stepId} AND "status" = 'streaming' RETURNING "id"`)
  if (!rows[0]) throw new Error('gate_quality_step_close_conflict')
}
async function setUserScope(tx: UsageBrokerQuery, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${userId}, true)`)
}
function tokenCount(value: number | undefined): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') }
function abortError(): Error { const error = new Error('The operation was aborted'); error.name = 'AbortError'; return error }

function brokerDatabase(db: GateQualityUsageDatabase): UsageBrokerDatabase { return db as unknown as UsageBrokerDatabase }
