import { describe, expect, it } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { isScheduledPrepareChoiceWaitId, parseScheduledPrepareChoiceCandidate, parseScheduledPrepareChoiceReceipt,
  scheduledPrepareChoiceBinding, scheduledPrepareChoiceId } from './scheduled-taskgraph-run-receipt'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 3, turnLeaseOwnerId: 'worker-1', turnLeaseVersion: 8, executionId: 'execution-1', executionAttemptCount: 0 }
const receipt = (continuationKey = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`) => ({
  schemaVersion: 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1',
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion,
    executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  continuationKey, snapshotDigest: `sha256:${'b'.repeat(64)}`, evidenceDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64),
  analyzeGraphRevision: 9, prepareScheduleRevision: 10,
})

describe('scheduled Prepare receipt continuation binding', () => {
  it('accepts exact v1/v2 keys while preserving owner and digest checks', () => {
    expect(parseScheduledPrepareChoiceReceipt(receipt(), owner)?.continuationKey).toBe(receipt().continuationKey)
    const v2 = receipt(`scheduled-taskgraph:v2:sha256:${'e'.repeat(64)}`)
    expect(parseScheduledPrepareChoiceReceipt(v2, owner)?.continuationKey).toBe(v2.continuationKey)
    expect(parseScheduledPrepareChoiceReceipt(receipt(), { ...owner, executionAttemptCount: 1 })).toBeNull()
    expect(parseScheduledPrepareChoiceReceipt(receipt(), owner, `sha256:${'f'.repeat(64)}`)).toBeNull()
  })

  it('rejects suffixes, noncanonical casing, and extra receipt fields', () => {
    const key = receipt().continuationKey as string
    for (const suffix of ['\n', '\r', '\u2028', '\u2029', 'x']) {
      expect(parseScheduledPrepareChoiceReceipt(receipt(key + suffix), owner)).toBeNull()
    }
    expect(parseScheduledPrepareChoiceReceipt(receipt(`scheduled-taskgraph:v2:sha256:${'A'.repeat(64)}`), owner)).toBeNull()
    expect(parseScheduledPrepareChoiceReceipt({ ...receipt(), ignored: true }, owner)).toBeNull()
  })

  it('keeps the historical Prepare wait binding and id projection byte-for-byte', () => {
    const parsed = parseScheduledPrepareChoiceReceipt(receipt(), owner)!
    expect(scheduledPrepareChoiceBinding(parsed, 'prepare-step', 5)).toEqual({
      schemaVersion: 'agent-harness.v2.scheduled-prepare-choice-wait.v1',
      owner: { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 3,
        executionId: 'execution-1', executionAttemptCount: 0 }, continuationKey: `scheduled-taskgraph:sha256:${'a'.repeat(64)}`,
      snapshotDigest: `sha256:${'b'.repeat(64)}`, evidenceDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64),
      analyzeGraphRevision: 9, prepareScheduleRevision: 10, finalStepId: 'prepare-step', finalStepOrdinal: 5, finalStepAttempt: 1,
    })
    expect(scheduledPrepareChoiceId(parsed, 'prepare-step', 5)).toBe(
      'agent-question:turn-1:canonical:4db8b7ce63d9e4de753597f200af4639624a7fc3cfac205f761c8107a8f5e72d')
    expect(isScheduledPrepareChoiceWaitId('turn-1', scheduledPrepareChoiceId(parsed, 'prepare-step', 5))).toBe(true)
    expect(isScheduledPrepareChoiceWaitId('turn-2', scheduledPrepareChoiceId(parsed, 'prepare-step', 5))).toBe(false)
  })

  it('retains the exact candidate event and root-task binding', () => {
    const candidate = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-candidate.v2', sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, finalStepId: 'prepare-step',
      finalStepOrdinal: 5, stepAttempt: 1, candidateText: 'Ready', finishReason: 'completed', usage: null }
    expect(parseScheduledPrepareChoiceCandidate(candidate, 'native_verification.scheduled_candidate_staged', owner.rootTaskId,
      'prepare-step', owner)).toEqual({ finalStepId: 'prepare-step', finalStepOrdinal: 5 })
    expect(parseScheduledPrepareChoiceCandidate(candidate, 'native_verification.scheduled_candidate_staged', 'other-root',
      'prepare-step', owner)).toBeNull()
  })
})
