import { describe, expect, it } from 'vitest'
import type { Job } from '@prisma/client'
import { AgentExecutionCancelledError } from './execution-control'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import {
  MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS, SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA,
  isStructurallySafeScorelessV1AnalyzeJournal,
  readScheduledTaskGraphAnalysisJournalState, rebindScheduledTaskGraphAnalysisJournalForLease,
  serializeScheduledTaskGraphAnalysisJournalState,
} from './scheduled-taskgraph-analysis-journal-state'
import { isStructurallySafeScorelessScheduledAnalyzePartial, upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim }
  from './scheduled-taskgraph-analysis-journal'

const jobId = 'c' + '1'.repeat(24)
const key = 'continuation-key'
const claimToken = 'claim-token'
const owner: ScheduledTaskGraphPipelineOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 3,
  turnLeaseOwnerId: 'lease-owner-1', turnLeaseVersion: 7, executionId: 'execution-1', executionAttemptCount: 5,
}
const fingerprint = { version: 'agent-harness.v2.analyze-source-input.v1', digest: 'e'.repeat(64) }
const analysisFenceAt = '2026-10-19T12:00:00.123Z'

function job(): Job { return { id: jobId, userId: owner.userId } as Job }
function scored() {
  return { job: job(), score: 82, matchedKeywords: ['TypeScript'], missingKeywords: ['AWS'],
    recommendation: 'Apply after tailoring.', analysisFenceAt }
}
function state() {
  return {
    nextStage: 'scout', scoutedJobs: [job()], scoredJobs: [scored()], analysisFailed: 0,
    scheduledTaskGraphClaim: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken, owner },
    scheduledTaskGraphAnalyzeJournal: {
      schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA, key, owner,
      attemptsByJob: { [jobId]: 1 }, failedJobIds: [], sourceFingerprintsByJob: { [jobId]: fingerprint },
    },
  } as Record<string, unknown>
}
function read(input: Record<string, unknown>) {
  return readScheduledTaskGraphAnalysisJournalState({
    state: input, jobsById: new Map([[jobId, job()]]), candidateIds: new Set([jobId]), key, owner,
  })
}

describe('scheduled Analyze journal state helper', () => {
  it('reads and serializes a complete v2 journal without losing score provenance', () => {
    const original = state()
    const restored = read(original)
    const serialized = serializeScheduledTaskGraphAnalysisJournalState({
      state: original, key, owner, jobs: [job()], scoredJobs: restored.scoredJobs,
      attemptsByJob: restored.attemptsByJob, failedJobIds: restored.failedJobIds,
      sourceFingerprintsByJob: restored.sourceFingerprintsByJob,
    })

    expect(restored).toMatchObject({
      hasJournal: true, scoredJobs: [{ job: { id: jobId }, score: 82 }],
      attemptsByJob: { [jobId]: 1 }, sourceFingerprintsByJob: { [jobId]: fingerprint },
    })
    expect([...restored.failedJobIds]).toEqual([])
    expect((serialized as unknown as Record<string, unknown>).scheduledTaskGraphAnalyzeJournal).toEqual(original.scheduledTaskGraphAnalyzeJournal)
    expect(read(serialized as unknown as Record<string, unknown>)).toMatchObject(restored)
  })

  it.each([
    ['legacy version', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).schemaVersion = 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1'
    }],
    ['missing map', (value: Record<string, unknown>) => {
      delete (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob
    }],
    ['missing scored job key', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob = {}
    }],
    ['extra fingerprint key', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob =
        { [jobId]: fingerprint, other: fingerprint }
    }],
    ['malformed fingerprint', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob =
        { [jobId]: { ...fingerprint, digest: 'invalid' } }
    }],
    ['extra journal property', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).extra = true
    }],
    ['invalid score', (value: Record<string, unknown>) => {
      (value.scoredJobs as Array<Record<string, unknown>>)[0].score = 101
    }],
    ['invalid attempt count', (value: Record<string, unknown>) => {
      (value.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob = { [jobId]: MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS + 1 }
    }],
  ])('fails closed for %s', (_name, corrupt) => {
    const invalid = state()
    corrupt(invalid)
    expect(() => read(invalid)).toThrow(AgentExecutionCancelledError)
  })

  it('rejects legacy score state without a journal and incomplete provenance on serialization', () => {
    const legacy = state()
    delete legacy.scheduledTaskGraphAnalyzeJournal
    expect(() => read(legacy)).toThrow(AgentExecutionCancelledError)

    expect(() => serializeScheduledTaskGraphAnalysisJournalState({
      state: state(), key, owner, jobs: [job()], scoredJobs: [scored()], attemptsByJob: { [jobId]: 1 },
      failedJobIds: new Set(), sourceFingerprintsByJob: {},
    })).toThrow(AgentExecutionCancelledError)
  })

  it('preserves valid fingerprints across lease rebind and rejects legacy journals', () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
    expect(rebindScheduledTaskGraphAnalysisJournalForLease({ state: state(), owner: nextOwner, key: 'continuation-next' }))
      .toMatchObject({ schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA,
        key: 'continuation-next', owner: nextOwner, sourceFingerprintsByJob: { [jobId]: fingerprint } })

    const legacy = state()
    ;(legacy.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).schemaVersion =
      'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1'
    expect(rebindScheduledTaskGraphAnalysisJournalForLease({ state: legacy, owner: nextOwner, key: 'continuation-next' })).toBeNull()
  })

function scorelessV1State(): Record<string, unknown> {
  const value = state()
  const claim = value.scheduledTaskGraphClaim as Record<string, unknown>
  value.scheduledTaskGraphClaim = { ...claim, claimedAt: '2026-11-16T10:00:00.000Z', leaseExpiresAt: '2026-11-16T10:10:00.000Z' }
  value.scoredJobs = []
  value.analysisFailed = 0
  value.scheduledTaskGraphAnalyzeJournal = {
    schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
    attemptsByJob: { [jobId]: 1 }, failedJobIds: [],
  }
  return value
}

const nextOwner = { ...owner, turnLeaseOwnerId: 'lease-owner-2', turnLeaseVersion: 8 }
function rebindLegacy(value: Record<string, unknown>, candidateJobIds: readonly string[] | undefined = [jobId],
  currentOwner: ScheduledTaskGraphPipelineOwner = nextOwner) {
  return rebindScheduledTaskGraphAnalysisJournalForLease({
    state: value, owner: currentOwner, key: 'continuation-next', candidateJobIds,
  })
}

describe('scoreless v1 scheduled Analyze journal lease rebind', () => {
  it('structurally recognizes only a scoreless legacy partial and upgrades it to v2 with an empty map', () => {
    const legacy = scorelessV1State()
    expect(isStructurallySafeScorelessV1AnalyzeJournal(legacy)).toBe(true)
    expect(rebindLegacy(legacy)).toEqual({
      schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA, key: 'continuation-next', owner: nextOwner,
      attemptsByJob: { [jobId]: 1 }, failedJobIds: [], sourceFingerprintsByJob: {},
    })
  })

  it('requires attested candidate IDs and rejects missing, extra, or duplicate candidates', () => {
    const legacy = scorelessV1State()
    expect(rebindScheduledTaskGraphAnalysisJournalForLease({ state: legacy, owner: nextOwner, key: 'continuation-next' })).toBeNull()
    expect(rebindLegacy(legacy, [])).toBeNull()
    expect(rebindLegacy(legacy, [jobId, 'other'])).toBeNull()
    expect(rebindLegacy(legacy, [jobId, jobId])).toBeNull()
    legacy.scoutedJobs = [{ id: ' ' }]
    expect(isStructurallySafeScorelessV1AnalyzeJournal(legacy)).toBe(false)
    expect(rebindLegacy(legacy)).toBeNull()
  })

  it('rejects every v1 journal that carries score or failure evidence', () => {
    const withScore = scorelessV1State()
    withScore.scoredJobs = [scored()]
    expect(isStructurallySafeScorelessV1AnalyzeJournal(withScore)).toBe(false)
    expect(rebindLegacy(withScore)).toBeNull()

    const withFailure = scorelessV1State()
    withFailure.analysisFailed = 1
    ;(withFailure.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).failedJobIds = [jobId]
    expect(isStructurallySafeScorelessV1AnalyzeJournal(withFailure)).toBe(false)
    expect(rebindLegacy(withFailure)).toBeNull()
  })

  it('requires exact empty score state and exact v1 journal shape', () => {
    const missingScores = scorelessV1State()
    delete missingScores.scoredJobs
    expect(isStructurallySafeScorelessV1AnalyzeJournal(missingScores)).toBe(false)
    expect(rebindLegacy(missingScores)).toBeNull()

    const extraJournalKey = scorelessV1State()
    ;(extraJournalKey.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob = {}
    expect(isStructurallySafeScorelessV1AnalyzeJournal(extraJournalKey)).toBe(false)
    expect(rebindLegacy(extraJournalKey)).toBeNull()

    const checkpointMap = scorelessV1State()
    checkpointMap.scheduledTaskGraphAnalyzeSourceFingerprints = {}
    expect(isStructurallySafeScorelessV1AnalyzeJournal(checkpointMap)).toBe(false)
    expect(rebindLegacy(checkpointMap)).toBeNull()

    const continuation = scorelessV1State()
    continuation.scheduledTaskGraphContinuation = {}
    expect(isStructurallySafeScorelessV1AnalyzeJournal(continuation)).toBe(false)
    expect(rebindLegacy(continuation)).toBeNull()
  })

  it.each([
    ['zero attempt', 0],
    ['over-bound attempt', MAX_SCHEDULED_TASKGRAPH_ANALYSIS_ATTEMPTS + 1],
    ['fractional attempt', 1.5],
  ])('rejects a %s', (_name, count) => {
    const legacy = scorelessV1State()
    ;(legacy.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob = { [jobId]: count }
    expect(isStructurallySafeScorelessV1AnalyzeJournal(legacy)).toBe(false)
    expect(rebindLegacy(legacy)).toBeNull()
  })

  it('rejects out-of-candidate attempts and malformed owner, key, or claim', () => {
    const extraAttempt = scorelessV1State()
    ;(extraAttempt.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob = { other: 1 }
    expect(isStructurallySafeScorelessV1AnalyzeJournal(extraAttempt)).toBe(false)
    expect(rebindLegacy(extraAttempt)).toBeNull()

    const wrongJournalOwner = scorelessV1State()
    ;(wrongJournalOwner.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).owner =
      { ...owner, sessionId: 'other-session' }
    expect(isStructurallySafeScorelessV1AnalyzeJournal(wrongJournalOwner)).toBe(false)
    expect(rebindLegacy(wrongJournalOwner)).toBeNull()

    const wrongKey = scorelessV1State()
    ;(wrongKey.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).key = 'other-key'
    expect(isStructurallySafeScorelessV1AnalyzeJournal(wrongKey)).toBe(false)
    expect(rebindLegacy(wrongKey)).toBeNull()

    const malformedClaim = scorelessV1State()
    ;(malformedClaim.scheduledTaskGraphClaim as Record<string, unknown>).extra = true
    expect(isStructurallySafeScorelessV1AnalyzeJournal(malformedClaim)).toBe(false)
    expect(rebindLegacy(malformedClaim)).toBeNull()
  })

  it('requires the same stable owner and a strictly older prior lease', () => {
    const legacy = scorelessV1State()
    expect(rebindLegacy(legacy, [jobId], { ...nextOwner, rootAttemptCount: owner.rootAttemptCount + 1 })).toBeNull()
    expect(rebindLegacy(legacy, [jobId], owner)).toBeNull()
    expect(rebindLegacy(legacy, [jobId], { ...owner, turnLeaseOwnerId: 'new-owner', turnLeaseVersion: owner.turnLeaseVersion - 1 })).toBeNull()
  })

  it('rejects invalid prior owner IDs, counters, and claim timestamps', () => {
    const invalidOwners: ScheduledTaskGraphPipelineOwner[] = [
      { ...owner, userId: '' }, { ...owner, rootAttemptCount: 0 },
      { ...owner, turnLeaseVersion: 0 }, { ...owner, executionAttemptCount: -1 },
    ]
    for (const invalidOwner of invalidOwners) {
      const legacy = scorelessV1State()
      ;(legacy.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).owner = invalidOwner
      ;(legacy.scheduledTaskGraphClaim as Record<string, unknown>).owner = invalidOwner
      expect(isStructurallySafeScorelessV1AnalyzeJournal(legacy)).toBe(false)
      expect(rebindLegacy(legacy)).toBeNull()
    }

    const invalidTimestamp = scorelessV1State()
    ;(invalidTimestamp.scheduledTaskGraphClaim as Record<string, unknown>).leaseExpiresAt = 'invalid'
    expect(isStructurallySafeScorelessV1AnalyzeJournal(invalidTimestamp)).toBe(false)
    expect(rebindLegacy(invalidTimestamp)).toBeNull()
  })
})
})

describe('scoreless scheduled Analyze journal preflight and same-lease migration', () => {
  const otherJobId = 'c' + '2'.repeat(24)
  const now = '2026-11-17T10:00:00.000Z'
  const nextExpiry = '2026-11-17T10:10:00.000Z'
  function legacyState() {
    const value = state()
    const claim = value.scheduledTaskGraphClaim as Record<string, unknown>
    value.scheduledTaskGraphClaim = { ...claim, claimedAt: '2026-11-16T10:00:00.000Z', leaseExpiresAt: '2026-11-16T10:10:00.000Z' }
    value.scoredJobs = []
    value.analysisFailed = 0
    value.scheduledTaskGraphAnalyzeJournal = {
      schemaVersion: 'agent-harness.v2.scheduled-taskgraph-analysis-journal.v1', key, owner,
      attemptsByJob: { [jobId]: 1 }, failedJobIds: [],
    }
    return value
  }
  function upgrade(value: Record<string, unknown>, overrides: Partial<Parameters<typeof upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim>[0]> = {}) {
    return upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim({
      state: value, owner, key, currentClaimToken: claimToken, claimToken: 'claim-token-next',
      candidateJobIds: [jobId], now, claimedAt: now, leaseExpiresAt: nextExpiry, ...overrides,
    })
  }

  it('preflights v2 scoreless partials with a valid non-empty failed ledger', () => {
    const value = legacyState()
    value.scoutedJobs = [job(), { id: otherJobId }]
    value.analysisFailed = 1
    value.scheduledTaskGraphAnalyzeJournal = {
      schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA, key, owner,
      attemptsByJob: { [jobId]: 1 }, failedJobIds: [jobId], sourceFingerprintsByJob: {},
    }
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(value)).toBe(true)

    const mismatch = structuredClone(value)
    mismatch.analysisFailed = 0
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(mismatch)).toBe(false)
    const duplicate = structuredClone(value)
    ;(duplicate.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).failedJobIds = [jobId, jobId]
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(duplicate)).toBe(false)
    const missingAttempt = structuredClone(value)
    ;(missingAttempt.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).attemptsByJob = {}
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(missingAttempt)).toBe(false)
    expect(() => read(missingAttempt)).toThrow(AgentExecutionCancelledError)
    const withScore = structuredClone(value)
    withScore.scoredJobs = [scored()]
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(withScore)).toBe(false)
  })

  it('upgrades an expired same-owner, same-lease v1 empty journal without mutating input', () => {
    const legacy = legacyState()
    expect(isStructurallySafeScorelessScheduledAnalyzePartial(legacy)).toBe(true)
    const upgraded = upgrade(legacy)
    expect(upgraded).toMatchObject({
      scheduledTaskGraphClaim: { key, claimToken: 'claim-token-next', owner, claimedAt: now, leaseExpiresAt: nextExpiry },
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: SCHEDULED_TASKGRAPH_ANALYSIS_JOURNAL_SCHEMA,
        key, owner, attemptsByJob: { [jobId]: 1 }, failedJobIds: [], sourceFingerprintsByJob: {} },
    })
    expect((legacy.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).schemaVersion)
      .toBe('agent-harness.v2.scheduled-taskgraph-analysis-journal.v1')
  })

  it.each([
    ['foreign owner', { owner: { ...owner, sessionId: 'foreign-session' } }],
    ['different lease owner', { owner: { ...owner, turnLeaseOwnerId: 'another-lease-owner' } }],
    ['different key', { key: 'other-key' }],
    ['wrong current claim token', { currentClaimToken: 'wrong-claim-token' }],
    ['candidate mismatch', { candidateJobIds: [otherJobId] }],
    ['duplicate candidates', { candidateJobIds: [jobId, jobId] }],
    ['same claim token', { claimToken }],
    ['invalid claim token', { claimToken: ' ' }],
    ['unexpired old claim', { now: '2026-11-16T10:05:00.000Z' }],
    ['claim time in the future', { claimedAt: '2026-11-17T10:01:00.000Z' }],
    ['new lease already expired', { leaseExpiresAt: '2026-11-17T09:59:59.999Z' }],
    ['invalid new lease time', { leaseExpiresAt: 'invalid' }],
  ])('refuses migration for %s', (_name, overrides) => {
    expect(upgrade(legacyState(), overrides)).toBeNull()
  })

  it('refuses migration when v1 contains a score, failure, or malformed claim', () => {
    const withScore = legacyState()
    withScore.scoredJobs = [scored()]
    expect(upgrade(withScore)).toBeNull()

    const withFailure = legacyState()
    withFailure.analysisFailed = 1
    ;(withFailure.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).failedJobIds = [jobId]
    expect(upgrade(withFailure)).toBeNull()

    const malformed = legacyState()
    ;(malformed.scheduledTaskGraphClaim as Record<string, unknown>).extra = true
    expect(upgrade(malformed)).toBeNull()
  })
})
