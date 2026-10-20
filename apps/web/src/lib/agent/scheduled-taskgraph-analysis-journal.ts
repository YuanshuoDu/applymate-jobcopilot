import { Prisma, type Job } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import { rebindScheduledTaskGraphClaimForLease, scheduledTaskGraphClaimMatches, scheduledTaskGraphOwnerMatches } from './scheduled-taskgraph-pipeline-fence'
import { buildScheduledTaskGraphPrepareCheckpoint, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { AnalyzeRecoveryPersistenceError, runAnalyze, type AnalyzeRecoveryHooks } from './stages/analyze'
import type { AnalyzeOutput, PipelineCheckpointState, PipelineCtx, ScoredJob, StageResult } from './types'

const JOURNAL_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1'
const MAX_AMBIGUOUS_ATTEMPTS = 2
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
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
  let scoredJobs: ScoredJob[] = [], attempts: Record<string, number> = {}, failedIds = new Set<string>()
  const stateRow = record(state), rawJournal = stateRow?.scheduledTaskGraphAnalyzeJournal
  if (rawJournal !== undefined) {
    const journal = record(rawJournal), rawAttempts = record(journal?.attemptsByJob)
    if (!journal || Object.keys(journal).sort().join(',') !== 'attemptsByJob,failedJobIds,key,owner,schemaVersion'
      || journal.schemaVersion !== JOURNAL_SCHEMA || journal.key !== input.key || !sameOwner(journal.owner, input.owner)
      || !rawAttempts || !Array.isArray(journal.failedJobIds) || stateRow?.nextStage !== 'scout' || !Array.isArray(stateRow.scoredJobs)) {
      throw new AgentExecutionCancelledError()
    }
    for (const [id, count] of Object.entries(rawAttempts)) {
      if (!candidateIds.has(id) || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > MAX_AMBIGUOUS_ATTEMPTS) throw new AgentExecutionCancelledError()
      attempts[id] = Number(count)
    }
    if (journal.failedJobIds.some(id => typeof id !== 'string' || !candidateIds.has(id))
      || new Set(journal.failedJobIds).size !== journal.failedJobIds.length || stateRow.analysisFailed !== journal.failedJobIds.length) {
      throw new AgentExecutionCancelledError()
    }
    failedIds = new Set(journal.failedJobIds as string[])
    for (const raw of stateRow.scoredJobs) {
      const score = record(raw), rawJob = record(score?.job), id = rawJob?.id
      if (!score || typeof id !== 'string' || !candidateIds.has(id) || scoredJobs.some(row => row.job.id === id)
        || failedIds.has(id) || (attempts[id] ?? 0) < 1 || !Number.isSafeInteger(score.score) || Number(score.score) < 0 || Number(score.score) > 100
        || !stringList(score.matchedKeywords) || !stringList(score.missingKeywords) || typeof score.recommendation !== 'string' || !realFence(score.analysisFenceAt)) {
        throw new AgentExecutionCancelledError()
      }
      scoredJobs.push({ ...score, job: jobsById.get(id)! } as unknown as ScoredJob)
    }
    if (scoredJobs.length + failedIds.size > jobs.length) throw new AgentExecutionCancelledError()
  }
  let writeQueue = Promise.resolve()
  const writeJournal = (change: () => boolean | void, tx?: Prisma.TransactionClient) => {
    const write = writeQueue.then(async () => {
      if (change() === false) return
      const next = { ...(record(state) ?? {}), nextStage: 'scout' as const, scoutedJobs: jobs, scoredJobs,
        analysisFailed: failedIds.size, scheduledTaskGraphAnalyzeJournal: {
          schemaVersion: JOURNAL_SCHEMA, key: input.key, owner: { ...input.owner }, attemptsByJob: { ...attempts }, failedJobIds: [...failedIds],
        } }
      if (!scheduledTaskGraphClaimMatches(next, input.key, input.owner, input.claimToken)) throw new AgentExecutionCancelledError()
      const expectedState = state
      let persistedState: PipelineCheckpointState
      try {
        persistedState = JSON.parse(JSON.stringify(next)) as PipelineCheckpointState
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
  if (rawJournal === undefined) await writeJournal(() => true)
  const scoredIds = new Set(scoredJobs.map(row => row.job.id))
  const pendingJobs = jobs.filter(job => !scoredIds.has(job.id) && !failedIds.has(job.id))
  const recovery: AnalyzeRecoveryHooks = {
    existingScoredJobs: scoredJobs, initialFailed: failedIds.size,
    beforeScore: async jobId => {
      let allowed = false
      await writeJournal(() => {
        const count = attempts[jobId] ?? 0
        if (count >= MAX_AMBIGUOUS_ATTEMPTS) return false
        attempts[jobId] = count + 1; allowed = true; return true
      })
      if (!allowed) throw new Error('Analyze recovery retry limit reached before a durable score was recorded.')
    },
    onScoredJob: async (scored, tx) => { await writeJournal(() => { scoredJobs.push(scored); return true }, tx) },
    onScoreFailure: async jobId => { await writeJournal(() => { failedIds.add(jobId); return true }) },
    ...(input.assertScoreOwnerCurrent ? { assertScoreOwnerCurrent: input.assertScoreOwnerCurrent } : {}),
  }
  const analysis = await runAnalyze(pendingJobs, input.ctx, recovery)
  await writeQueue
  if (analysis.data?.scoredJobs.some(row => !scoredJobs.some(saved => saved.job.id === row.job.id && saved.score === row.score))) throw new AgentExecutionCancelledError()
  const prepared = buildScheduledTaskGraphPrepareCheckpoint({ owner: input.owner, snapshot: input.snapshot,
    attestation: input.attestation, ownedJobs: jobs, analyzeResult: analysis, existingCheckpoint: state })
  if (prepared.alreadyPersisted || prepared.continuationKey !== input.key) throw new AgentExecutionCancelledError()
  const checkpoint = { ...prepared.checkpoint } as PipelineCheckpointState & Record<string, unknown>
  delete checkpoint.scheduledTaskGraphAnalyzeJournal
  return { analysis, checkpoint, persistedState: state as PipelineCheckpointState }
}

/** Rebind a partial Analyze journal together with a scheduled claim after Turn lease rollover. */
export function rebindScheduledTaskGraphAnalysisJournalForLease(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string
}): Record<string, unknown> | null {
  const state = record(input.state), journal = record(state?.scheduledTaskGraphAnalyzeJournal)
  const claim = record(state?.scheduledTaskGraphClaim), priorOwner = parseJournalOwner(journal?.owner)
  const scoutedJobs = state?.scoutedJobs, scoredJobs = state?.scoredJobs
  const attemptsByJob = record(journal?.attemptsByJob), failedJobIds = journal?.failedJobIds
  if (!state || !journal || !claim || !priorOwner || !attemptsByJob || !Array.isArray(scoutedJobs)
    || !Array.isArray(scoredJobs) || !Array.isArray(failedJobIds) || state.nextStage !== 'scout'
    || state.scheduledTaskGraphContinuation !== undefined || Object.keys(journal).sort().join(',') !== 'attemptsByJob,failedJobIds,key,owner,schemaVersion'
    || journal.schemaVersion !== JOURNAL_SCHEMA || journal.key !== claim.key || !validId(claim.key) || !validId(claim.claimToken)
    || !sameExactOwner(claim.owner, priorOwner)
    || !scheduledTaskGraphClaimMatches(state, String(claim.key), priorOwner, typeof claim.claimToken === 'string' ? claim.claimToken : undefined)
    || !sameStableOwnerForRebind(priorOwner, input.owner) || !validId(input.key)) return null

  const candidateIds = new Set(scoutedJobs.map(row => record(row)?.id).filter((id): id is string => typeof id === 'string'))
  if (candidateIds.size !== scoutedJobs.length) return null
  const failed = new Set<string>()
  for (const id of failedJobIds) {
    if (typeof id !== 'string' || !candidateIds.has(id) || failed.has(id)) return null
    failed.add(id)
  }
  if (!Number.isSafeInteger(state.analysisFailed) || state.analysisFailed !== failed.size) return null
  for (const [id, count] of Object.entries(attemptsByJob)) {
    if (!candidateIds.has(id) || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > MAX_AMBIGUOUS_ATTEMPTS) return null
  }
  const scoredIds = new Set<string>()
  for (const raw of scoredJobs) {
    const row = record(raw), job = record(row?.job), id = job?.id
    if (typeof id !== 'string' || !candidateIds.has(id) || scoredIds.has(id) || failed.has(id)
      || (attemptsByJob[id] as number | undefined) === undefined || !Number.isSafeInteger(row?.score)
      || Number(row?.score) < 0 || Number(row?.score) > 100 || !stringList(row?.matchedKeywords)
      || !stringList(row?.missingKeywords) || typeof row?.recommendation !== 'string' || !realFence(row?.analysisFenceAt)) return null
    scoredIds.add(id)
  }
  if (scoredIds.size + failed.size > candidateIds.size) return null
  return { ...journal, key: input.key, owner: { ...input.owner } }
}

export function rebindScheduledTaskGraphAnalysisStateForLease(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string; ownedJobs: readonly Job[]
  snapshot: unknown; attestation: unknown; claimedAt: string; leaseExpiresAt: string
}): Record<string, unknown> | null {
  const rebound = rebindScheduledTaskGraphClaimForLease(input)
  if (!rebound || record(input.state)?.scheduledTaskGraphAnalyzeJournal === undefined) return rebound
  const journal = rebindScheduledTaskGraphAnalysisJournalForLease(input)
  return journal ? { ...rebound, scheduledTaskGraphAnalyzeJournal: journal } : null
}

/** Locks and verifies every durable owner row inside the score write transaction. */
export async function scheduledTaskGraphScoreOwnerIsCurrent(input: {
  tx: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
}): Promise<boolean> {
  const { tx, owner, key, claimToken } = input
  const lockedTurn = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns"
    WHERE "id" = ${owner.turnId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
    FOR UPDATE
  `)
  if (lockedTurn.length !== 1) return false
  const turn = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns"
    WHERE "id" = ${owner.turnId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "status" = 'in_progress' AND "leaseOwnerId" = ${owner.turnLeaseOwnerId}
      AND "leaseVersion" = ${owner.turnLeaseVersion} AND "leaseExpiresAt" > clock_timestamp()
  `)
  if (turn.length !== 1) return false
  const root = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "sub_agent_tasks"
    WHERE "id" = ${owner.rootTaskId} AND "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId}
      AND "rootTaskId" = ${owner.rootTaskId} AND "parentTaskId" IS NULL
      AND "attemptCount" = ${owner.rootAttemptCount} AND "status" = 'running'
      AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
    FOR UPDATE
  `)
  if (root.length !== 1) return false
  const execution = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_executions"
    WHERE "id" = ${owner.executionId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
      AND "status" = 'running' AND "attemptCount" = ${owner.executionAttemptCount}
      AND "state"->'scheduledTaskGraphClaim'->>'schemaVersion' = 'agent-harness.v2.scheduled-pipeline-claim.v1'
      AND "state"->'scheduledTaskGraphClaim'->>'key' = ${key}
      AND "state"->'scheduledTaskGraphClaim'->>'claimToken' = ${claimToken}
      AND "state"->'scheduledTaskGraphClaim'->'owner' = CAST(${JSON.stringify(owner)} AS jsonb)
    FOR UPDATE
  `)
  return execution.length === 1
}

export function createScheduledTaskGraphOwnerFence(scheduled: {
  owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string
} | undefined) {
  return scheduled ? (tx: Prisma.TransactionClient) => scheduledTaskGraphScoreOwnerIsCurrent({ tx, ...scheduled }) : async () => false
}

function sameOwner(value: unknown, expected: ScheduledTaskGraphPipelineOwner): boolean {
  const owner = record(value), fields = Object.keys(expected) as Array<keyof ScheduledTaskGraphPipelineOwner>
  return Boolean(owner && Object.keys(owner).length === fields.length && fields.every(field => owner[field] === expected[field]))
}
function parseJournalOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const owner = record(value)
  if (!owner || Object.keys(owner).sort().join(',') !== [...OWNER_KEYS].sort().join(',')
    || !OWNER_KEYS.every(key => Object.hasOwn(owner, key))) return null
  return owner as unknown as ScheduledTaskGraphPipelineOwner
}
function sameExactOwner(value: unknown, expected: ScheduledTaskGraphPipelineOwner): boolean {
  const owner = parseJournalOwner(value)
  return Boolean(owner && OWNER_KEYS.every(key => owner[key] === expected[key]))
}
function sameStableOwnerForRebind(previous: ScheduledTaskGraphPipelineOwner, current: ScheduledTaskGraphPipelineOwner): boolean {
  return previous.userId === current.userId && previous.sessionId === current.sessionId && previous.turnId === current.turnId
    && previous.rootTaskId === current.rootTaskId && previous.rootAttemptCount === current.rootAttemptCount
    && previous.executionId === current.executionId && previous.executionAttemptCount === current.executionAttemptCount
    && Number.isSafeInteger(previous.turnLeaseVersion) && previous.turnLeaseVersion < current.turnLeaseVersion
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function realFence(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value }
function safeCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
