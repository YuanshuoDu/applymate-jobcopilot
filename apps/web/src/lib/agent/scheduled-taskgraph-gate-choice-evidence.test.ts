import { describe, expect, it } from 'vitest'
import { parseScheduledGateChoiceBinding, scheduledGateChoiceState } from './scheduled-taskgraph-gate-choice-evidence'

function binding(key = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`) {
  return { schemaVersion: 'agent-harness.v2.scheduled-gate-choice-wait.v1',
    owner: { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 2,
      executionId: 'execution-1', executionAttemptCount: 0 }, continuationKey: key, snapshotDigest: `sha256:${'b'.repeat(64)}`,
    evidenceDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64), analyzeGraphRevision: 8, graphRevision: 10,
    gateTaskId: 'gate-1', gateAttempt: 1, kind: 'weak_cover_letter', jobIds: ['job-1'], allowedChoiceIds: ['continue', 'review', 'skip'] }
}
function content(value: ReturnType<typeof binding>, waitId: string) {
  return { waitKind: 'question', questionId: waitId, toolCallId: null, stage: 'scheduled_gate', question: 'Review this result?',
    options: [{ label: 'Continue with current materials', value: 'continue' }, { label: 'Place for review', value: 'review' },
      { label: 'Skip', value: 'skip' }], answer: null, answerAvailable: false, scheduledGateChoiceBinding: value }
}

describe('scheduled Gate choice binding', () => {
  it('preserves v1 and recognizes versioned v2 continuation keys only', () => {
    expect(parseScheduledGateChoiceBinding(binding())?.continuationKey).toBe(binding().continuationKey)
    const v2 = binding(`scheduled-taskgraph:v2:sha256:${'e'.repeat(64)}`)
    expect(parseScheduledGateChoiceBinding(v2)?.continuationKey).toBe(v2.continuationKey)
    for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
      expect(parseScheduledGateChoiceBinding(binding(`${v2.continuationKey}${suffix}`))).toBeNull()
    }
  })

  it('keeps started and acknowledged completed choice-state checks', () => {
    const proof = binding(), waitId = 'gate-wait-1', open = content(proof, waitId)
    expect(scheduledGateChoiceState(open, 'started', parseScheduledGateChoiceBinding(proof)!, waitId)).toBe(true)
    const answered = { ...open, answer: 'continue', answerAvailable: true, answeredAt: '2026-10-25T12:00:00.000Z',
      scheduledGateChoiceResumeAcknowledgement: { gateTaskId: 'gate-1', requestAttemptCount: 1, waitId,
        itemId: `agent-wait:question:${waitId}`, resumedAttemptCount: 2 } }
    expect(scheduledGateChoiceState(answered, 'completed', parseScheduledGateChoiceBinding(proof)!, waitId)).toBe(true)
    expect(scheduledGateChoiceState({ ...answered, scheduledGateChoiceResumeAcknowledgement: { ...answered.scheduledGateChoiceResumeAcknowledgement,
      resumedAttemptCount: 3 } }, 'completed', parseScheduledGateChoiceBinding(proof)!, waitId)).toBe(false)
  })
})
