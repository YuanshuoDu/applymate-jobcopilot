import { Prisma, type Job } from '@prisma/client'
import { db } from '@/lib/db'
import { AgentExecutionCancelledError } from './execution-control'
import { scheduledTaskGraphAuditChildOwnerIsCurrent, scheduledTaskGraphClaimMatches, scheduledTaskGraphOwnerMatches } from './scheduled-taskgraph-pipeline-fence'
import { buildScheduledTaskGraphPrepareCheckpoint, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ScheduledTaskGraphAuditActor } from './scheduled-taskgraph-audit-child-fence'
import { hasScheduledTaskGraphGateProof } from './scheduled-taskgraph-approval-fence'
import { AnalyzeRecoveryPersistenceError, runAnalyze, type AnalyzeRecoveryHooks } from './stages/analyze'
import { isAnalyzeSourceFingerprint, type AnalyzeSourceFingerprint } from './stages/analyze-model-input'
import type { AnalyzeOutput, PipelineCheckpointState, PipelineCtx, ScoredJob, StageResult } from './types'

import { MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS, readScheduledTaskGraphAnalysisJournalState,
  serializeScheduledTaskGraphAnalysisJournalState, isStructurallySafeScorelessV1AnalyzeJournal,
  SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA } from './scheduled-taskgraph-analysis-journal-state'

export { isStructurallySafeScorelessV1AnalyzeJournal, rebindScheduledTaskGraphAnalysisJournalForLease, rebindScheduledTaskGraphAnalysisStateForLease } from './scheduled-taskgraph-analysis-journal-state'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const PARTIAL_OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
function validPartialId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value }
function validPartialOwner(value: unknown): value is ScheduledTaskGraphPipelineOwner {
  const owner = record(value)
  return Boolean(owner && Object.keys(owner).length === PARTIAL_OWNER_KEYS.length
    && PARTIAL_OWNER_KEYS.every(key => Object.hasOwn(owner, key))
    && [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validPartialId)
    && Number.isSafeInteger(owner.rootAttemptCount) && Number(owner.rootAttemptCount) > 0
    && Number.isSafeInteger(owner.turnLeaseVersion) && Number(owner.turnLeaseVersion) > 0
    && Number.isSafeInteger(owner.executionAttemptCount) && Number(owner.executionAttemptCount) >= 0)
}
function partialCandidateIds(state: Record<string, unknown>): string[] | null {
  if (!Array.isArray(state.scoutedJobs)) return null
  const ids = state.scoutedJobs.map(job => record(job)?.id)
  return ids.every(validPartialId) && new Set(ids).size === ids.length ? ids : null
}
function validPartialClaim(claim: Record<string, unknown>): boolean {
  return Object.keys(claim).sort().join(',') === 'claimToken,claimedAt,key,leaseExpiresAt,owner,schemaVersion'
    && claim.schemaVersion === 'agent-harness.v2.scheduled-pipeline-claim.v1'
    && validPartialId(claim.key) && validPartialId(claim.claimToken)
    && typeof claim.claimedAt === 'string' && Number.isFinite(Date.parse(claim.claimedAt))
    && typeof claim.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(claim.leaseExpiresAt))
}

/** Structural preflight only; ownership, attestation, and CAS remain with the route. */
export function isStructurallySafeScorelessScheduledAnalyzePartial(value: unknown): boolean {
  if (isStructurallySafeScorelessV1AnalyzeJournal(value)) return true
  const state = record(value), journal = record(state?.scheduledTaskGraphAnalyzeJournal)
  const claim = record(state?.scheduledTaskGraphClaim), owner = record(journal?.owner)
  const candidates = state && partialCandidateIds(state)
  const key = journal?.key
  if (!state || !journal || !claim || !owner || !validPartialOwner(owner) || !candidates
    || journal.schemaVersion !== SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA
    || !validPartialClaim(claim) || claim.key !== key || !scheduledTaskGraphOwnerMatches(claim.owner, owner)
    || !scheduledTaskGraphClaimMatches(state, String(key), owner, String(claim.claimToken))
    || !validPartialId(key) || state.nextStage !== 'scout' || state.scheduledTaskGraphContinuation !== undefined
    || state.scheduledTaskGraphWait !== undefined || state.scheduledTaskGraphAnalyzeSourceFingerprints !== undefined
    || !Array.isArray(state.scoredJobs) || state.scoredJobs.length !== 0) return false
  try {
    readScheduledTaskGraphAnalysisJournalState({ state, jobsById: new Map(), candidateIds: new Set(candidates), key, owner })
    return true
  } catch { return false }
}

/** Pure v1 empty-journal migration; caller must persist the result with an exact-state CAS. */
export function upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; currentClaimToken: string; claimToken: string
  candidateJobIds: readonly string[]; now: string; claimedAt: string; leaseExpiresAt: string
}): Record<string, unknown> | null {
  const state = record(input.state), journal = record(state?.scheduledTaskGraphAnalyzeJournal)
  const claim = record(state?.scheduledTaskGraphClaim), candidates = state && partialCandidateIds(state)
  const now = Date.parse(input.now), claimedAt = Date.parse(input.claimedAt), expiresAt = Date.parse(input.leaseExpiresAt)
  const candidateSet = new Set(input.candidateJobIds)
  if (!isStructurallySafeScorelessV1AnalyzeJournal(state) || !state || !journal || !claim || !candidates
    || !validPartialOwner(input.owner) || !validPartialClaim(claim) || journal.key !== input.key || claim.key !== input.key
    || !scheduledTaskGraphOwnerMatches(journal.owner, input.owner) || !scheduledTaskGraphOwnerMatches(claim.owner, input.owner)
    || !scheduledTaskGraphClaimMatches(state, input.key, input.owner, input.currentClaimToken)
    || candidates.length !== candidateSet.size || candidateSet.size !== input.candidateJobIds.length
    || input.candidateJobIds.some(id => !validPartialId(id) || !candidateSet.has(id))
    || candidates.some(id => !candidateSet.has(id)) || claim.claimToken !== input.currentClaimToken
    || !Number.isFinite(now) || Date.parse(String(claim.leaseExpiresAt)) > now
    || !validPartialId(input.claimToken) || input.claimToken === input.currentClaimToken
    || !Number.isFinite(claimedAt) || !Number.isFinite(expiresAt) || claimedAt > now || expiresAt <= now) return null
  return { ...state,
    scheduledTaskGraphClaim: { ...claim, claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt },
    scheduledTaskGraphAnalyzeJournal: { schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA,
      key: input.key, owner: { ...input.owner }, attemptsByJob: { ...record(journal.attemptsByJob) }, failedJobIds: [], sourceFingerprintsByJob: {} },
  }
}

export function completedScheduledTaskGraphReport(input: {
  execution: { status: string; state: unknown }; key: string; owner: ScheduledTaskGraphPipelineOwner
  snapshot: unknown; attestation: unknown; ownedJobs: readonly Job[]; checkpointValidatedByPrior?: boolean
}): Record<string, unknown> | null {
  const state = record(input.execution.state), marker = record(state?.scheduledTaskGraphContinuation), report = record(state?.report)
  if (!marker || marker.key !== input.key || !scheduledTaskGraphOwnerMatches(marker.owner, input.owner)
    || input.execution.status !== 'completed' || !report
    || !['processed', 'applied', 'queued', 'pending', 'skipped', 'failed', 'durationMs'].every(key => safeCount(report[key]))) return null
  if (!input.checkpointValidatedByPrior) try {
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner: input.owner, snapshot: input.snapshot,
      attestation: input.attestation, ownedJobs: input.ownedJobs, existingCheckpoint: state })
    if (!checkpoint.alreadyPersisted || checkpoint.continuationKey !== input.key) return null
  } catch { return null }
  return report
}

export async function runScheduledTaskGraphAnalyze(input: {
  jobs: readonly Job[]; ctx: PipelineCtx; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
  snapshot: unknown; attestation: unknown; state: unknown
  assertScoreOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
  persist: (state: PipelineCheckpointState, expectedState: unknown, tx?: Prisma.TransactionClient) => Promise<void>
}): Promise<{ analysis: StageResult<AnalyzeOutput>; checkpoint: PipelineCheckpointState; persistedState: PipelineCheckpointState }> {
  const jobs = [...input.jobs], jobsById = new Map(jobs.map(job => [job.id, job])), candidateIds = new Set(jobsById.keys())
  if (jobsById.size !== jobs.length || jobs.some(job => job.userId !== input.owner.userId)) throw new AgentExecutionCancelledError()
  let state: unknown = input.state
  if (!scheduledTaskGraphClaimMatches(state, input.key, input.owner, input.claimToken)) throw new AgentExecutionCancelledError()
  const restored = readScheduledTaskGraphAnalysisJournalState({ state, jobsById, candidateIds, key: input.key, owner: input.owner })
  let { scoredJobs, attemptsByJob: attempts, failedJobIds: failedIds, sourceFingerprintsByJob } = restored
  let writeQueue = Promise.resolve()
  const writeJournal = (change: () => boolean | void, tx?: Prisma.TransactionClient) => {
    const write = writeQueue.then(async () => {
      if (change() === false) return
      const next = serializeScheduledTaskGraphAnalysisJournalState({ state, key: input.key, owner: input.owner,
        jobs, scoredJobs, attemptsByJob: attempts, failedJobIds: failedIds, sourceFingerprintsByJob })
      if (!scheduledTaskGraphClaimMatches(next, input.key, input.owner, input.claimToken)) throw new AgentExecutionCancelledError()
      const expectedState = state
      let persistedState: PipelineCheckpointState
      try {
        persistedState = next
        await input.persist(persistedState, expectedState, tx)
      }
      catch (error) {
        if (error instanceof AgentExecutionCancelledError) throw error
        throw new AnalyzeRecoveryPersistenceError()
      }
      state = persistedState
    })
    writeQueue = write
    return write
  }
  if (!restored.hasJournal) await writeJournal(() => true)
  const scoredIds = new Set(scoredJobs.map(row => row.job.id))
  const pendingJobs = jobs.filter(job => !scoredIds.has(job.id) && !failedIds.has(job.id))
  const recovery: AnalyzeRecoveryHooks = {
    existingScoredJobs: scoredJobs, initialFailed: failedIds.size,
    beforeScore: async jobId => {
      let allowed = false
      await writeJournal(() => {
        const count = attempts[jobId] ?? 0
        if (count >= MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS) return false
        attempts[jobId] = count + 1; allowed = true; return true
      })
      if (!allowed) throw new Error('Analyze recovery retry limit reached before a durable score was recorded.')
    },
    sourceFingerprintsByJob,
    onScoredJob: async (scored, tx, sourceFingerprint) => {
      await writeJournal(() => {
        if (!candidateIds.has(scored.job.id) || scoredJobs.some(row => row.job.id === scored.job.id)
          || failedIds.has(scored.job.id) || !isAnalyzeSourceFingerprint(sourceFingerprint)) throw new AgentExecutionCancelledError()
        scoredJobs.push(scored)
        sourceFingerprintsByJob[scored.job.id] = sourceFingerprint
        return true
      }, tx)
    },
    onScoreFailure: async jobId => { await writeJournal(() => { failedIds.add(jobId); return true }) },
    ...(input.assertScoreOwnerCurrent ? { assertScoreOwnerCurrent: input.assertScoreOwnerCurrent } : {}),
  }
  const analysis = await runAnalyze(pendingJobs, input.ctx, recovery)
  await writeQueue
  if (analysis.data?.scoredJobs.some(row => !scoredJobs.some(saved => saved.job.id === row.job.id && saved.score === row.score))) throw new AgentExecutionCancelledError()
  const prepared = buildScheduledTaskGraphPrepareCheckpoint({ owner: input.owner, snapshot: input.snapshot,
    attestation: input.attestation, ownedJobs: jobs, analyzeResult: analysis, existingCheckpoint: state })
  if (prepared.alreadyPersisted || prepared.continuationKey !== input.key) throw new AgentExecutionCancelledError()
  const checkpoint = { ...prepared.checkpoint,
    scheduledTaskGraphAnalyzeSourceFingerprints: { ...sourceFingerprintsByJob },
  } as PipelineCheckpointState & Record<string, unknown>
  delete checkpoint.scheduledTaskGraphAnalyzeJournal
  return { analysis, checkpoint, persistedState: state as PipelineCheckpointState }
}

/** Locks and verifies every durable owner row inside the score write transaction. */
export async function scheduledTaskGraphScoreOwnerIsCurrent(input: {
  tx: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
}): Promise<boolean> {
  const { tx, owner, key, claimToken } = input
  const lockedTurn = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns"
    WHERE "id" = ${owner.turnId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "rootTaskId" = ${owner.rootTaskId}
    FOR UPDATE
  `)
  if (lockedTurn.length !== 1) return false
  const turn = await tx.$queryRaw<Array<{ id: string; status: string; source: string; executionMode: string | null; input: unknown }>>(Prisma.sql`
    SELECT "id", "status", "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id" = ${owner.turnId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "rootTaskId" = ${owner.rootTaskId}
      AND "status" IN ('in_progress', 'waiting_for_approval') AND "leaseOwnerId" = ${owner.turnLeaseOwnerId}
      AND "leaseVersion" = ${owner.turnLeaseVersion} AND "leaseExpiresAt" > clock_timestamp()
  `)
  if (turn.length !== 1) return false
  const root = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "sub_agent_tasks"
    WHERE "id" = ${owner.rootTaskId} AND "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId}
      AND "rootTaskId" = ${owner.rootTaskId} AND "parentTaskId" IS NULL
      AND "role" = 'orchestrator' AND "taskType" = 'root'
      AND "attemptCount" = ${owner.rootAttemptCount} AND "status" = 'running'
      AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
    FOR UPDATE
  `)
  if (root.length !== 1) return false
  const execution = await tx.$queryRaw<Array<{ id: string; checkpoint: string; state: unknown }>>(Prisma.sql`
    SELECT "id", "checkpoint", "state" FROM "agent_executions"
    WHERE "id" = ${owner.executionId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "status" = 'running' AND "attemptCount" = ${owner.executionAttemptCount}
      AND CASE WHEN jsonb_typeof("state"->'scheduledTaskGraphClaim') = 'object'
        THEN (SELECT count(*) FROM jsonb_object_keys("state"->'scheduledTaskGraphClaim')) = 6 ELSE FALSE END
      AND "state"->'scheduledTaskGraphClaim'->>'schemaVersion' = 'agent-harness.v2.scheduled-pipeline-claim.v1'
      AND "state"->'scheduledTaskGraphClaim'->>'key' = ${key}
      AND "state"->'scheduledTaskGraphClaim'->>'claimToken' = ${claimToken}
      AND "state"->'scheduledTaskGraphClaim'->'owner' = CAST(${JSON.stringify(owner)} AS jsonb)
    FOR UPDATE
  `)
  if (execution.length !== 1) return false
  if (turn[0].status === 'in_progress') return true
  return turn[0].status === 'waiting_for_approval' && turn[0].source === 'automation'
    && turn[0].executionMode === 'canonical_task_graph' && record(turn[0].input)?.automationRunMode === 'scheduled'
    && await hasScheduledTaskGraphGateProof({ reader: tx, owner, key, claimToken,
      executionStatus: 'running', checkpoint: execution[0].checkpoint, state: execution[0].state })
}

export function createScheduledTaskGraphOwnerFence(scheduled: {
  owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
} | undefined) {
  return scheduled ? (tx: Prisma.TransactionClient) => scheduledTaskGraphScoreOwnerIsCurrent({ tx, ...scheduled }) : async () => false
}

export type ScheduledTaskGraphAuditChildOwnerInput = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner; auditActor: ScheduledTaskGraphAuditActor; key: string; claimToken: string
}>
export function createScheduledTaskGraphAuditChildOwnerFence(scheduled: ScheduledTaskGraphAuditChildOwnerInput | undefined) {
  return scheduled ? (tx: Prisma.TransactionClient) => scheduledTaskGraphAuditChildOwnerIsCurrent({ tx, ...scheduled }) : async () => false
}
export async function isScheduledTaskGraphAuditChildOwnerCurrent(input: ScheduledTaskGraphAuditChildOwnerInput): Promise<boolean> {
  try { return await db.$transaction(tx => scheduledTaskGraphAuditChildOwnerIsCurrent({ tx, ...input })) }
  catch { return false }
}

function safeCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
