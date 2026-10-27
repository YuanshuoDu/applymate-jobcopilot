import { describe, expect, it } from 'vitest'
import type { PipelineCtx } from './pipeline-context'
import { allowVerifiedEmptyScheduledTaskGraphContinuation, isScheduledTaskGraphContinuationKey } from './scheduled-taskgraph-continuation-contract'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 1,
  turnLeaseOwnerId: 'lease-1', turnLeaseVersion: 2, executionId: 'execution-1', executionAttemptCount: 0 }
function emptyState(key: string) {
  return { nextStage: 'prepare', scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
    scheduledTaskGraphContinuation: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1', key,
      owner: { ...owner }, snapshotDigest: `sha256:${'b'.repeat(64)}`, graphRevision: 1, evidenceDigest: 'c'.repeat(64) },
    scheduledTaskGraphClaim: { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken: 'claim-1',
      owner: { ...owner }, claimedAt: '2026-10-25T10:00:00.000Z', leaseExpiresAt: '2026-10-25T10:05:00.000Z' } }
}

describe('scheduled TaskGraph continuation key contract', () => {
  it('accepts exact historical and multi-Scout key prefixes', () => {
    expect(isScheduledTaskGraphContinuationKey(`scheduled-taskgraph:sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isScheduledTaskGraphContinuationKey(`scheduled-taskgraph:v2:sha256:${'b'.repeat(64)}`)).toBe(true)
  })

  it('rejects malformed or trailing data without prefix downgrade', () => {
    const v1 = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`
    const v2 = `scheduled-taskgraph:v2:sha256:${'b'.repeat(64)}`
    for (const suffix of ['\n', '\r', '\u2028', '\u2029', 'x']) {
      expect(isScheduledTaskGraphContinuationKey(v1 + suffix)).toBe(false)
      expect(isScheduledTaskGraphContinuationKey(v2 + suffix)).toBe(false)
    }
    expect(isScheduledTaskGraphContinuationKey(v2.replace('v2:', 'v3:'))).toBe(false)
    expect(isScheduledTaskGraphContinuationKey(`scheduled-taskgraph:v2:sha256:${'B'.repeat(64)}`)).toBe(false)
    expect(isScheduledTaskGraphContinuationKey(null)).toBe(false)
  })

  it('allows a verified empty v2 continuation only with its matching owner and claim', () => {
    const key = `scheduled-taskgraph:v2:sha256:${'d'.repeat(64)}`
    const ctx = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount } } as PipelineCtx
    expect(allowVerifiedEmptyScheduledTaskGraphContinuation(emptyState(key), ctx)).toBe(true)
    expect(allowVerifiedEmptyScheduledTaskGraphContinuation(emptyState(`${key}\n`), ctx)).toBe(false)
    expect(allowVerifiedEmptyScheduledTaskGraphContinuation(emptyState(key), { ...ctx, sessionId: 'foreign-session' })).toBe(false)
  })
})
