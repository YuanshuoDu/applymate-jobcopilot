import { describe, expect, it } from 'vitest'
import { parseScheduledPipelineAttestationValue } from './scheduled-pipeline-attestation-validation.js'

const hash = 'a'.repeat(64)
function wire() {
  return { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v2',
    owner: { userId: 'u', sessionId: 's', turnId: 't', rootTaskId: 'r', rootAttemptCount: 1, turnLeaseOwnerId: 'l', turnLeaseVersion: 1 },
    snapshotDigest: `sha256:${hash}`, graphRevision: 1,
    scouts: ['a', 'b'].map((key, index) => ({ nodeKey: `scout-${key}`, taskId: `task-${key}`, attemptCount: 1, status: 'completed', verification: 'passed',
      resultDigest: hash, nodeDigest: hash, evidenceDigest: hash, reportDigest: hash, candidateJobIds: [`job-${key}`],
      discoveryReceipt: { status: 'complete', taskId: `task-${key}`, attemptCount: 1, completedCalls: 1, candidateCount: 1,
        providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: hash } })),
    candidateUnionJobIds: ['job-a', 'job-b'],
    analyst: { nodeKey: 'analyst', taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: hash,
      nodeDigest: hash, evidenceDigest: hash, reportDigest: hash, dependsOnTaskIds: ['task-a', 'task-b'], jobIds: ['job-a'] }, evidenceDigest: hash }
}

describe('scheduled pipeline attestation validator boundary', () => {
  it('copies safe structured data into a parsed protocol value', () => {
    const input = wire(), parsed = parseScheduledPipelineAttestationValue(input)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toBe(input)
    expect(parsed?.schemaVersion).toBe('agent-harness.v2.scheduled-pipeline-attestation.v2')
  })

  it('preserves a source result order while requiring the complete sorted union', () => {
    const input = wire()
    input.scouts[0]!.candidateJobIds = ['job-z', 'job-a']
    input.scouts[0]!.discoveryReceipt.candidateCount = 2
    input.candidateUnionJobIds = ['job-a', 'job-b', 'job-z']
    const parsed = parseScheduledPipelineAttestationValue(input)
    expect(parsed?.schemaVersion.endsWith('.v2')).toBe(true)
    if (parsed?.schemaVersion.endsWith('.v2')) expect(parsed.scouts[0]?.candidateJobIds).toEqual(['job-z', 'job-a'])
  })

  it('rejects a throwing own-key trap without propagating the exception', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('blocked trap') } })
    expect(() => parseScheduledPipelineAttestationValue(hostile)).not.toThrow()
    expect(parseScheduledPipelineAttestationValue(hostile)).toBeNull()
  })

  it('rejects non-enumerable data and accessor-backed source fields', () => {
    const hidden = wire(); Object.defineProperty(hidden.scouts[0]!, 'nodeDigest', { enumerable: false, value: hash })
    const getter = wire(); Object.defineProperty(getter.scouts[0]!, 'nodeDigest', { enumerable: true, get: () => hash })
    expect(parseScheduledPipelineAttestationValue(hidden)).toBeNull()
    expect(parseScheduledPipelineAttestationValue(getter)).toBeNull()
  })
})
