import { describe, expect, it } from 'vitest'
import { parseScheduledPipelineAttestation } from './scheduled-pipeline-attestation.js'
import { scheduledPipelineContinuationKeyMaterial, scheduledPipelineContinuationKeyVersion,
  scheduledPipelinePrepareReceiptKeyMaterial } from './scheduled-pipeline-continuation-key-material.js'

const hash = (char: string) => char.repeat(64)
const owner = { userId: 'u', sessionId: 's', turnId: 't', rootTaskId: 'r', rootAttemptCount: 3, turnLeaseOwnerId: 'volatile', turnLeaseVersion: 9 }
const execution = { executionId: 'exec', executionAttemptCount: 2 }
const receipt = (taskId: string, receiptDigest: string, candidateCount: number) => ({ status: 'complete', taskId, attemptCount: 1,
  completedCalls: 1, candidateCount, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest })
function v1() {
  return { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v1', owner, snapshotDigest: `sha256:${hash('a')}`, graphRevision: 4,
    scout: { taskId: 'st', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: hash('b'), candidateJobIds: ['job'], discoveryReceipt: receipt('st', hash('c'), 1) },
    analyst: { taskId: 'at', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: hash('d'), dependsOnTaskIds: ['st'], jobIds: ['job'] }, evidenceDigest: hash('e') }
}
function v2() {
  const scout = (nodeKey: string, taskId: string, jobId: string, digit: string) => ({ nodeKey, taskId, attemptCount: 1, status: 'completed', verification: 'passed',
    resultDigest: hash(digit), nodeDigest: hash('f'), evidenceDigest: hash('1'), reportDigest: hash('2'), candidateJobIds: [jobId], discoveryReceipt: receipt(taskId, hash('3'), 1) })
  return { schemaVersion: 'agent-harness.v2.scheduled-pipeline-attestation.v2', owner, snapshotDigest: `sha256:${hash('a')}`, graphRevision: 5,
    scouts: [scout('s-a', 'st-a', 'job-a', 'b'), scout('s-b', 'st-b', 'job-b', 'c')], candidateUnionJobIds: ['job-a', 'job-b'],
    analyst: { nodeKey: 'an', taskId: 'at', attemptCount: 1, status: 'completed', verification: 'passed', resultDigest: hash('d'), nodeDigest: hash('4'),
      evidenceDigest: hash('5'), reportDigest: hash('6'), dependsOnTaskIds: ['st-a', 'st-b'], jobIds: ['job-b'] }, evidenceDigest: hash('e') }
}

describe('scheduled pipeline continuation key material', () => {
  it('recognizes only exact v1 and v2 key forms without trailing line terminators', () => {
    const v1Key = `scheduled-taskgraph:sha256:${hash('a')}`, v2Key = `scheduled-taskgraph:v2:sha256:${hash('b')}`
    expect(scheduledPipelineContinuationKeyVersion(v1Key)).toBe('v1')
    expect(scheduledPipelineContinuationKeyVersion(v2Key)).toBe('v2')
    for (const value of [null, 1, 'scheduled-taskgraph:v3:sha256:' + hash('a'),
      ...[ '\n', '\r', '\u2028', '\u2029' ].map(ending => v1Key + ending),
      ...[ '\n', '\r', '\u2028', '\u2029' ].map(ending => v2Key + ending)]) {
      expect(scheduledPipelineContinuationKeyVersion(value)).toBeNull()
    }
  })

  it('keeps the legacy v1 JSON preimage and prefix byte-compatible', () => {
    const parsed = parseScheduledPipelineAttestation(v1())
    if (!parsed || parsed.schemaVersion.endsWith('.v2')) throw new Error('v1 fixture rejected')
    const material = scheduledPipelineContinuationKeyMaterial(parsed, execution)
    expect(material.keyPrefix).toBe('scheduled-taskgraph:sha256:')
    expect(material.serializedPreimage).toBe(JSON.stringify(['u', 's', 't', 'r', 3, 'exec', 2, `sha256:${hash('a')}`, 4,
      'st', 1, hash('b'), 'at', 1, hash('d'), hash('e'), hash('c')]))
  })

  it('domain-separates v2 and binds every source, receipt, union and Analyst selection', () => {
    const parsed = parseScheduledPipelineAttestation(v2())
    if (!parsed || parsed.schemaVersion.endsWith('.v1')) throw new Error('v2 fixture rejected')
    const material = scheduledPipelineContinuationKeyMaterial(parsed, execution)
    expect(material.keyPrefix).toBe('scheduled-taskgraph:v2:sha256:')
    expect(material.serializedPreimage.startsWith('["agent-harness.v2.scheduled-pipeline-attestation.v2"')).toBe(true)
    for (const marker of ['st-a', 'st-b', hash('3'), 'job-a', 'job-b', 'at']) expect(material.serializedPreimage).toContain(marker)
    const changed = structuredClone(v2()); changed.analyst.jobIds = ['job-a']
    const changedParsed = parseScheduledPipelineAttestation(changed)
    expect(changedParsed && scheduledPipelineContinuationKeyMaterial(changedParsed, execution).serializedPreimage).not.toBe(material.serializedPreimage)
  })

  it('projects the stable Prepare receipt key with its own v2 domain and legacy v1 bytes', () => {
    const binding = (continuationKey: string) => ({ owner: { userId: 'u', sessionId: 's', turnId: 't', rootTaskId: 'r', rootAttemptCount: 3,
      turnLeaseOwnerId: 'volatile', turnLeaseVersion: 99, executionId: 'exec', executionAttemptCount: 2 }, continuationKey,
      snapshotDigest: `sha256:${hash('a')}`, evidenceDigest: hash('b'), checkpointDigest: hash('c'), analyzeGraphRevision: 4, prepareScheduleRevision: 5 })
    const v1Binding = binding(`scheduled-taskgraph:sha256:${hash('d')}`), v2Binding = binding(`scheduled-taskgraph:v2:sha256:${hash('e')}`)
    const v1 = scheduledPipelinePrepareReceiptKeyMaterial(v1Binding), v2 = scheduledPipelinePrepareReceiptKeyMaterial(v2Binding)
    expect(v1?.serializedPreimage).toBe(JSON.stringify(['u', 's', 't', 'r', 3, 'exec', 2, v1Binding.snapshotDigest,
      v1Binding.evidenceDigest, v1Binding.checkpointDigest, 4, 5]))
    expect(v2?.keyPrefix).toBe('scheduled-taskgraph:v2:sha256:')
    expect(v2?.serializedPreimage.startsWith('["agent-harness.v2.scheduled-taskgraph-prepare-receipt.v2"')).toBe(true)
    expect(scheduledPipelinePrepareReceiptKeyMaterial(binding('scheduled-taskgraph:v2:sha256:invalid'))).toBeNull()
  })
})
