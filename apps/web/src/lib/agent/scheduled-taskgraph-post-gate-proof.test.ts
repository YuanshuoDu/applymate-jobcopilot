import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseScheduledPostGateExecuteEnvelope, parseScheduledPostGateHandoff } from './scheduled-taskgraph-post-gate-proof'

const owner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 1,
  turnLeaseOwnerId: 'turn-owner-1', turnLeaseVersion: 2, executionId: 'execution-1', executionAttemptCount: 3 }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? ''
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(stable(value), 'utf8').digest('hex')}` }
function handoff(overrides: Record<string, unknown> = {}) {
  const packageRefs = ['job-1']
  const gateProof = { schemaVersion: 'test.gate-proof' }
  return { schemaVersion: 'agent-harness.v2.scheduled-post-gate-handoff.v1', owner, snapshotDigest: digest('snapshot'),
    continuationKey: 'continuation-1', gateTaskId: 'gate-1', gateAttemptCount: 2, gateCompletedEventRevision: 8,
    gateProofDigest: digest(gateProof), gateProof, gateResultDigest: digest('gate-result'), packageRefs,
    packageDigest: digest(packageRefs), proposalDigest: digest('proposal'), gateGraphRevision: 8, graphRevision: 9,
    executeNodes: [{ key: 'execute-1', taskId: 'execute-task-1', packageRefs }], auditTaskId: 'audit-task-1', ...overrides }
}

describe('scheduled post-Gate immutable proof parsing', () => {
  it('accepts a handoff with exact owner, Gate digest, and disjoint Execute partitions', () => {
    expect(parseScheduledPostGateHandoff(handoff())).toMatchObject({ owner, packageRefs: ['job-1'],
      executeNodes: [{ key: 'execute-1', taskId: 'execute-task-1', packageRefs: ['job-1'] }] })
  })

  it.each([
    ['changed Gate proof', handoff({ gateProof: { schemaVersion: 'changed' } })],
    ['repeated package across partitions', handoff({ executeNodes: [
      { key: 'execute-1', taskId: 'execute-task-1', packageRefs: ['job-1'] },
      { key: 'execute-2', taskId: 'execute-task-2', packageRefs: ['job-1'] },
    ] })],
    ['changed graph revision', handoff({ graphRevision: 10 })],
    ['extra owner field', handoff({ owner: { ...owner, foreign: true } })],
  ])('rejects a handoff with %s', (_name, value) => {
    expect(parseScheduledPostGateHandoff(value)).toBeNull()
  })

  it('accepts only the exact bounded non-submitting Execute result envelope', () => {
    const result = { finalItemId: null, finalText: '', status: 'completed', stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: { queued: [], failed: [] } }
    expect(parseScheduledPostGateExecuteEnvelope(result)).toEqual({ queued: [], failed: [] })
    expect(parseScheduledPostGateExecuteEnvelope({ ...result, submissionId: 'unexpected' })).toBeNull()
    expect(parseScheduledPostGateExecuteEnvelope({ ...result, structuredResult: { queued: ['job-1'], failed: ['job-1'] } })).toBeNull()
  })
})
