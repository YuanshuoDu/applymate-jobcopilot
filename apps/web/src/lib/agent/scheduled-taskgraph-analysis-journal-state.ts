import type { Job } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import { rebindScheduledTaskGraphClaimForLease, scheduledTaskGraphClaimMatches } from './scheduled-taskgraph-pipeline-fence'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { hasCompleteAnalyzeSourceFingerprints, type AnalyzeSourceFingerprint } from './stages/analyze-model-input'
import type { PipelineCheckpointState, ScoredJob } from './types'

export const SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v2'
export const MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS = 2
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const

type RestoredJournal = {
  hasJournal: boolean
  scoredJobs: ScoredJob[]
  attemptsByJob: Record<string, number>
  failedJobIds: Set<string>
  sourceFingerprintsByJob: Record<string, AnalyzeSourceFingerprint>
}

export function readScheduledTaskGraphAnalysisJournalState(input: {
  state: unknown; jobsById: ReadonlyMap<string, Job>; candidateIds: ReadonlySet<string>
  key: string; owner: ScheduledTaskGraphPipelineOwner
}): RestoredJournal {
  const state = record(input.state), rawJournal = state?.scheduledTaskGraphAnalyzeJournal
  const restored: RestoredJournal = {
    hasJournal: rawJournal !== undefined, scoredJobs: [], attemptsByJob: {}, failedJobIds: new Set(),
    sourceFingerprintsByJob: {},
  }
  if (rawJournal === undefined) {
    if ((Array.isArray(state?.scoredJobs) && state.scoredJobs.length > 0)
      || (state?.scoredJobs !== undefined && !Array.isArray(state.scoredJobs))
      || (state?.analysisFailed !== undefined && (!safeCount(state.analysisFailed) || Number(state.analysisFailed) !== 0))) {
      throw new AgentExecutionCancelledError()
    }
    return restored
  }

  const journal = record(rawJournal), attempts = record(journal?.attemptsByJob)
  if (!journal || Object.keys(journal).sort().join(',') !== 'attemptsByJob,failedJobIds,key,owner,schemaVersion,sourceFingerprintsByJob'
    || journal.schemaVersion !== SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA || journal.key !== input.key
    || !sameOwner(journal.owner, input.owner) || !attempts || !Array.isArray(journal.failedJobIds)
    || state?.nextStage !== 'scout' || !Array.isArray(state.scoredJobs)) throw new AgentExecutionCancelledError()

  for (const [id, count] of Object.entries(attempts)) {
    if (!input.candidateIds.has(id) || !Number.isSafeInteger(count) || Number(count) < 1
      || Number(count) > MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS) throw new AgentExecutionCancelledError()
    restored.attemptsByJob[id] = Number(count)
  }
  const failed = journal.failedJobIds as unknown[]
  if (failed.some(id => typeof id !== 'string' || !input.candidateIds.has(id))
    || failed.some(id => typeof id === 'string' && !Object.hasOwn(restored.attemptsByJob, id))
    || new Set(failed).size !== failed.length || state.analysisFailed !== failed.length) throw new AgentExecutionCancelledError()
  restored.failedJobIds = new Set(failed as string[])

  for (const raw of state.scoredJobs) {
    const score = record(raw), rawJob = record(score?.job), id = rawJob?.id
    if (!score || typeof id !== 'string' || !input.candidateIds.has(id)
      || restored.scoredJobs.some(row => row.job.id === id) || restored.failedJobIds.has(id)
      || (restored.attemptsByJob[id] ?? 0) < 1 || !Number.isSafeInteger(score.score)
      || Number(score.score) < 0 || Number(score.score) > 100 || !stringList(score.matchedKeywords)
      || !stringList(score.missingKeywords) || typeof score.recommendation !== 'string' || !realFence(score.analysisFenceAt)) {
      throw new AgentExecutionCancelledError()
    }
    restored.scoredJobs.push({ ...score, job: input.jobsById.get(id)! } as unknown as ScoredJob)
  }

  const fingerprints = record(journal.sourceFingerprintsByJob)
  const scoredIds = restored.scoredJobs.map(row => row.job.id)
  if (!fingerprints || !hasCompleteAnalyzeSourceFingerprints(scoredIds, fingerprints)
    || restored.scoredJobs.length + restored.failedJobIds.size > input.candidateIds.size) throw new AgentExecutionCancelledError()
  restored.sourceFingerprintsByJob = { ...fingerprints } as Record<string, AnalyzeSourceFingerprint>
  return restored
}

export function serializeScheduledTaskGraphAnalysisJournalState(input: {
  state: unknown; key: string; owner: ScheduledTaskGraphPipelineOwner; jobs: readonly Job[]
  scoredJobs: readonly ScoredJob[]; attemptsByJob: Readonly<Record<string, number>>; failedJobIds: ReadonlySet<string>
  sourceFingerprintsByJob: Readonly<Record<string, AnalyzeSourceFingerprint>>
}): PipelineCheckpointState {
  if (!hasCompleteAnalyzeSourceFingerprints(input.scoredJobs.map(row => row.job.id), input.sourceFingerprintsByJob)) {
    throw new AgentExecutionCancelledError()
  }
  const next = { ...(record(input.state) ?? {}), nextStage: 'scout' as const, scoutedJobs: input.jobs,
    scoredJobs: input.scoredJobs, analysisFailed: input.failedJobIds.size,
    scheduledTaskGraphAnalyzeJournal: {
      schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA, key: input.key, owner: { ...input.owner },
      attemptsByJob: { ...input.attemptsByJob }, failedJobIds: [...input.failedJobIds],
      sourceFingerprintsByJob: { ...input.sourceFingerprintsByJob },
    } }
  return JSON.parse(JSON.stringify(next)) as PipelineCheckpointState
}

export function isStructurallySafeScorelessV1AnalyzeJournal(value: unknown): boolean {
  return readScorelessV1Journal(value) !== null
}

function readScorelessV1Journal(value: unknown): {
  priorOwner: ScheduledTaskGraphPipelineOwner; candidateIds: Set<string>; attemptsByJob: Record<string, unknown>
} | null {
  const state = record(value), journal = record(state?.scheduledTaskGraphAnalyzeJournal)
  const claim = record(state?.scheduledTaskGraphClaim), priorOwner = parseJournalOwner(journal?.owner)
  const attemptsByJob = record(journal?.attemptsByJob), failedJobIds = journal?.failedJobIds
  if (!state || !journal || !claim || !priorOwner || !attemptsByJob
    || !exactKeys(journal, ['attemptsByJob', 'failedJobIds', 'key', 'owner', 'schemaVersion'])
    || journal.schemaVersion !== 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1'
    || !validId(journal.key) || journal.key !== claim.key || !validPersistedClaim(claim)
    || !validJournalOwner(priorOwner) || !sameExactOwner(claim.owner, priorOwner) || !scheduledTaskGraphClaimMatches(state, journal.key, priorOwner, String(claim.claimToken))
    || state.nextStage !== 'scout' || state.scheduledTaskGraphContinuation !== undefined
    || state.scheduledTaskGraphAnalyzeSourceFingerprints !== undefined
    || !Array.isArray(state.scoutedJobs) || !Array.isArray(state.scoredJobs) || state.scoredJobs.length !== 0
    || state.analysisFailed !== 0 || !Array.isArray(failedJobIds) || failedJobIds.length !== 0) return null
  const candidateIds = candidateIdsFrom(state.scoutedJobs)
  if (!candidateIds) return null
  for (const [id, count] of Object.entries(attemptsByJob)) {
    if (!candidateIds.has(id) || !Number.isSafeInteger(count) || Number(count) < 1
      || Number(count) > MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS) return null
  }
  return { priorOwner, candidateIds, attemptsByJob }
}

function candidateIdsFrom(scoutedJobs: unknown[]): Set<string> | null {
  const ids = new Set<string>()
  for (const row of scoutedJobs) {
    const id = record(row)?.id
    if (!validId(id) || ids.has(id)) return null
    ids.add(id)
  }
  return ids
}
function sameCandidateIds(stored: ReadonlySet<string>, current: readonly string[] | undefined): boolean {
  if (!current) return false
  const ids = new Set(current)
  return ids.size === current.length && [...ids].every(validId) && stored.size === ids.size && [...stored].every(id => ids.has(id))
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validPersistedClaim(claim: Record<string, unknown>): boolean {
  return exactKeys(claim, ['schemaVersion', 'key', 'claimToken', 'owner', 'claimedAt', 'leaseExpiresAt'])
    && claim.schemaVersion === 'agent-harness.v2.scheduled-pipeline-claim.v1'
    && validId(claim.key) && validId(claim.claimToken)
    && validTimestamp(claim.claimedAt) && validTimestamp(claim.leaseExpiresAt)
}
function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function validJournalOwner(owner: ScheduledTaskGraphPipelineOwner): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    && Number.isSafeInteger(owner.rootAttemptCount) && owner.rootAttemptCount > 0
    && Number.isSafeInteger(owner.turnLeaseVersion) && owner.turnLeaseVersion > 0
    && Number.isSafeInteger(owner.executionAttemptCount) && owner.executionAttemptCount >= 0
}

/** Rebind a partial Analyze journal together with a scheduled claim after Turn lease rollover. */
export function rebindScheduledTaskGraphAnalysisJournalForLease(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; candidateJobIds?: readonly string[]
}): Record<string, unknown> | null {
  const state = record(input.state), journal = record(state?.scheduledTaskGraphAnalyzeJournal)
  const claim = record(state?.scheduledTaskGraphClaim), priorOwner = parseJournalOwner(journal?.owner)
  const scoutedJobs = state?.scoutedJobs
  const legacy = journal?.schemaVersion === 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1'
  const expectedJournalKeys = legacy
    ? ['attemptsByJob', 'failedJobIds', 'key', 'owner', 'schemaVersion']
    : ['attemptsByJob', 'failedJobIds', 'key', 'owner', 'schemaVersion', 'sourceFingerprintsByJob']
  if (!state || !journal || !claim || !priorOwner || !Array.isArray(scoutedJobs) || state.nextStage !== 'scout'
    || state.scheduledTaskGraphContinuation !== undefined || !exactKeys(journal, expectedJournalKeys)
    || (!legacy && journal.schemaVersion !== SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA)
    || journal.key !== claim.key || !validId(claim.key) || !validId(claim.claimToken)
    || !sameExactOwner(claim.owner, priorOwner)
    || !scheduledTaskGraphClaimMatches(state, String(claim.key), priorOwner, String(claim.claimToken))
    || !sameStableOwnerForRebind(priorOwner, input.owner) || !validId(input.key)) return null

  const candidateIds = candidateIdsFrom(scoutedJobs)
  if (!candidateIds || (input.candidateJobIds !== undefined && !sameCandidateIds(candidateIds, input.candidateJobIds))) return null

  if (legacy) {
    const scoreless = readScorelessV1Journal(input.state)
    if (!scoreless || !sameCandidateIds(scoreless.candidateIds, input.candidateJobIds)) return null
    return { schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA, key: input.key, owner: { ...input.owner },
      attemptsByJob: { ...scoreless.attemptsByJob }, failedJobIds: [], sourceFingerprintsByJob: {} }
  }

  const jobsById = new Map(scoutedJobs.map(job => [String(record(job)?.id), job as Job]))
  try { readScheduledTaskGraphAnalysisJournalState({ state, jobsById, candidateIds, key: String(journal.key), owner: priorOwner }) }
  catch { return null }
  return { ...journal, key: input.key, owner: { ...input.owner } }
}

export function rebindScheduledTaskGraphAnalysisStateForLease(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string; ownedJobs: readonly Job[]
  snapshot: unknown; attestation: unknown; claimedAt: string; leaseExpiresAt: string
}): Record<string, unknown> | null {
  const rebound = rebindScheduledTaskGraphClaimForLease(input)
  if (!rebound || record(input.state)?.scheduledTaskGraphAnalyzeJournal === undefined) return rebound
  const journal = rebindScheduledTaskGraphAnalysisJournalForLease({ ...input,
    candidateJobIds: input.ownedJobs.map(job => job.id) })
  return journal ? { ...rebound, scheduledTaskGraphAnalyzeJournal: journal } : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
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
  return validJournalOwner(previous) && validJournalOwner(current)
    && previous.userId === current.userId && previous.sessionId === current.sessionId && previous.turnId === current.turnId
    && previous.rootTaskId === current.rootTaskId && previous.rootAttemptCount === current.rootAttemptCount
    && previous.executionId === current.executionId && previous.executionAttemptCount === current.executionAttemptCount
    && previous.turnLeaseVersion < current.turnLeaseVersion
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function realFence(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value }
function safeCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
