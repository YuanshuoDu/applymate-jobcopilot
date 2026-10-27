import { describe, expect, it } from 'vitest'
import {
  SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA,
  SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA,
  parseScheduledPipelineAttestation,
} from './scheduled-pipeline-attestation.js'

const digest = (digit = 'a') => digit.repeat(64)
const owner = { userId: 'user', sessionId: 'session', turnId: 'turn', rootTaskId: 'root', rootAttemptCount: 1, turnLeaseOwnerId: 'lease', turnLeaseVersion: 1 }
function v1() {
  return { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, owner, snapshotDigest: `sha256:${digest()}`, graphRevision: 1,
    scout: { taskId: 'scout-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: digest(), candidateJobIds: ['job-a'],
      discoveryReceipt: { status: 'complete', taskId: 'different-task', attemptCount: 2, completedCalls: 0, candidateCount: 0,
        providerFailures: 1, materializationFailures: 2, hasMore: true, receiptDigest: digest() } },
    analyst: { taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: digest(),
      dependsOnTaskIds: ['scout-task'], jobIds: ['job-a'] }, evidenceDigest: digest() }
}
function source(nodeKey: string, taskId: string, candidates: string[], digit: string) {
  return { nodeKey, taskId, attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: digest(digit),
    nodeDigest: digest('b'), evidenceDigest: digest('c'), reportDigest: digest('d'), candidateJobIds: candidates,
    discoveryReceipt: { status: 'complete', taskId, attemptCount: 1, completedCalls: 1, candidateCount: candidates.length,
      providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest('e') } }
}
function v2() {
  return { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA, owner, snapshotDigest: `sha256:${digest()}`, graphRevision: 2,
    scouts: [source('scout-a', 'task-a', ['job-b', 'job-a'], 'a'), source('scout-b', 'task-b', ['job-c', 'job-b'], 'f')],
    candidateUnionJobIds: ['job-a', 'job-b', 'job-c'],
    analyst: { nodeKey: 'analyst', taskId: 'analyst-task', attemptCount: 1, status: 'completed', verification: 'passed',
      resultDigest: digest('1'), nodeDigest: digest('2'), evidenceDigest: digest('3'), reportDigest: digest('4'),
      dependsOnTaskIds: ['task-a', 'task-b'], jobIds: ['job-c', 'job-a'] }, evidenceDigest: digest('5') }
}

describe('scheduled pipeline attestation protocol', () => {
  it('preserves exact v1 shape and leaves incomplete receipt classification to its existing consumer', () => {
    const parsed = parseScheduledPipelineAttestation(v1())
    expect(parsed?.schemaVersion).toBe(SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA)
    if (parsed?.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA) throw new Error('v1 parse failed')
    expect(parsed.scout.discoveryReceipt).toMatchObject({ taskId: 'different-task', completedCalls: 0, providerFailures: 1, hasMore: true })
  })

  it('accepts sorted source proofs, the exact deduplicated union and an ordered bounded Analyst subset', () => {
    const parsed = parseScheduledPipelineAttestation(v2())
    expect(parsed?.schemaVersion).toBe(SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA)
    if (parsed?.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA) throw new Error('v2 parse failed')
    expect(parsed.candidateUnionJobIds).toEqual(['job-a', 'job-b', 'job-c'])
    expect(parsed.scouts[0]?.candidateJobIds).toEqual(['job-b', 'job-a'])
    expect(parsed.analyst.jobIds).toEqual(['job-c', 'job-a'])
  })

  it('rejects unsupported or extra fields, noncanonical order, bad bindings and incomplete v2 receipts', () => {
    const extra = { ...v2(), unrecognized: true }
    const unsorted = v2(); unsorted.scouts.reverse()
    const wrongUnion = v2(); wrongUnion.candidateUnionJobIds = ['job-a', 'job-c']
    const wrongDependencies = v2(); wrongDependencies.analyst.dependsOnTaskIds = ['task-b', 'task-a']
    const incomplete = v2(); incomplete.scouts[0]!.discoveryReceipt.hasMore = true
    const empty = v2(); empty.scouts = [source('scout-a', 'task-a', [], 'a'), source('scout-b', 'task-b', [], 'f')]; empty.candidateUnionJobIds = []; empty.analyst.jobIds = []
    for (const value of [extra, unsorted, wrongUnion, wrongDependencies, incomplete, empty]) expect(parseScheduledPipelineAttestation(value)).toBeNull()
  })

  it('rejects sparse arrays, accessors, custom prototypes and throwing Proxy traps', () => {
    const sparse = v2(); sparse.analyst.jobIds = Array(1)
    const getter = v2(); Object.defineProperty(getter.analyst, 'jobIds', { enumerable: true, get: () => ['job-a'] })
    const custom = Object.assign(Object.create({ inherited: true }), v2())
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error('trap') } })
    for (const value of [sparse, getter, custom, throwing]) expect(parseScheduledPipelineAttestation(value)).toBeNull()
  })
})
