import { describe, expect, it } from 'vitest'
import {
  LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA,
  SCHEDULED_PIPELINE_CANDIDATE_SCHEMA,
  SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BYTES,
  parseScheduledPipelineCandidatePayload,
  parseScheduledPipelineSourceReceipt,
} from './scheduled-pipeline-candidate.js'

const digest = `sha256:${'a'.repeat(64)}`
const scope = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', taskId: 'root-1', stepId: 'step-1' }
const receipt = { schemaVersion: 1, scope, bindings: [
  { key: 'E-job-a', observationId: 'tool-result:call-1', toolCallId: 'call-1', toolName: 'jobs.search', sourceRef: 'jobs/0', inputDigest: digest, resultDigest: digest },
  { key: 'E-job-b', observationId: 'tool-result:call-1', toolCallId: 'call-1', toolName: 'jobs.search', sourceRef: 'jobs/1', inputDigest: digest, resultDigest: digest },
] }
const legacyPayload = { schemaVersion: LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA, sessionId: 'session-1', turnId: 'turn-1',
  rootTaskId: 'root-1', rootAttemptCount: 2, finalStepId: 'step-1', finalStepOrdinal: 1, stepAttempt: 1,
  candidateText: 'Exact final answer.', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.02 } }
const receiptPayload = { ...legacyPayload, schemaVersion: SCHEDULED_PIPELINE_CANDIDATE_SCHEMA, sourceReceipt: receipt }

describe('scheduled pipeline candidate protocol', () => {
  it('accepts strict v2 payloads and v3 receipts, copying validated values', () => {
    expect(parseScheduledPipelineCandidatePayload(legacyPayload)).toEqual({ ...legacyPayload, sourceReceipt: null })
    expect(parseScheduledPipelineCandidatePayload(receiptPayload)).toEqual(receiptPayload)
    expect(parseScheduledPipelineCandidatePayload({ ...legacyPayload, schemaVersion: SCHEDULED_PIPELINE_CANDIDATE_SCHEMA }))
      .toMatchObject({ schemaVersion: SCHEDULED_PIPELINE_CANDIDATE_SCHEMA, sourceReceipt: null })

    const parsed = parseScheduledPipelineCandidatePayload(receiptPayload)!
    expect(parsed).not.toBe(receiptPayload)
    expect(parsed.usage).not.toBe(receiptPayload.usage)
    expect(parsed.sourceReceipt).not.toBe(receiptPayload.sourceReceipt)
    expect(parsed.sourceReceipt?.bindings[0]).not.toBe(receiptPayload.sourceReceipt.bindings[0])
  })

  it('drops legacy unscoped receipts while preserving candidate text and rejects envelope scope mismatches', () => {
    const { scope: _scope, ...legacyReceipt } = receipt
    const legacyScopedPayload = { ...receiptPayload, sourceReceipt: legacyReceipt }
    expect(parseScheduledPipelineCandidatePayload(legacyScopedPayload)).toMatchObject({
      candidateText: 'Exact final answer.', sourceReceipt: null,
    })
    expect(parseScheduledPipelineSourceReceipt(legacyReceipt)).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload,
      sourceReceipt: { ...receipt, scope: { ...scope, stepId: 'other-step' } } })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload,
      sourceReceipt: { ...receipt, scope: { ...scope, private: 'unexpected' } } })).toBeNull()
  })

  it('rejects unknown top-level and nested fields, and malformed v3 receipts', () => {
    expect(parseScheduledPipelineCandidatePayload({ ...legacyPayload, sourceReceipt: receipt })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload, debug: 'private' })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload, sourceReceipt: { ...receipt, extra: true } })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload, sourceReceipt: { ...receipt, bindings: [{ ...receipt.bindings[0], extra: true }] } })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload, usage: { ...legacyPayload.usage, extra: 1 } })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...receiptPayload, sourceReceipt: null })).toMatchObject({ sourceReceipt: null })
  })

  it('rejects accessor, symbol, exotic-prototype, sparse-array, and proxy input', () => {
    const getter = { ...legacyPayload }
    Object.defineProperty(getter, 'candidateText', { enumerable: true, get: () => 'must not execute' })
    expect(parseScheduledPipelineCandidatePayload(getter)).toBeNull()
    expect(parseScheduledPipelineCandidatePayload(Object.assign(Object.create({ inherited: true }), legacyPayload))).toBeNull()
    expect(parseScheduledPipelineCandidatePayload({ ...legacyPayload, [Symbol('extra')]: true })).toBeNull()
    expect(parseScheduledPipelineCandidatePayload(new Proxy(legacyPayload, { ownKeys: () => { throw new Error('proxy') } }))).toBeNull()

    const sparse = new Array(1)
    sparse[1] = receipt.bindings[0]
    expect(parseScheduledPipelineSourceReceipt({ schemaVersion: 1, scope, bindings: sparse })).toBeNull()
  })

  it('permits multiple references from one call but rejects conflicting or oversized receipts', () => {
    expect(parseScheduledPipelineSourceReceipt(receipt)).toEqual(receipt)
    expect(parseScheduledPipelineSourceReceipt({ ...receipt, bindings: [receipt.bindings[0],
      { ...receipt.bindings[1], key: receipt.bindings[0]!.key }] })).toBeNull()
    expect(parseScheduledPipelineSourceReceipt({ ...receipt, bindings: [receipt.bindings[0],
      { ...receipt.bindings[1], resultDigest: `sha256:${'b'.repeat(64)}` }] })).toBeNull()
    expect(parseScheduledPipelineSourceReceipt({ ...receipt, bindings: [receipt.bindings[0],
      { ...receipt.bindings[1], toolName: 'agent.apply' }] })).toBeNull()

    const oversized = { schemaVersion: 1, scope, bindings: Array.from({ length: 8 }, (_, index) => ({
      ...receipt.bindings[0], key: `E-${String(index).padEnd(126, 'k')}`, observationId: `observation-${index}`.padEnd(256, 'o'),
      toolCallId: `call-${index}`.padEnd(256, 'c'), sourceRef: 'a/'.repeat(64),
    })) }
    expect(JSON.stringify(oversized).length).toBeGreaterThan(SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BYTES)
    expect(parseScheduledPipelineSourceReceipt(oversized)).toBeNull()
  })
})
