import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { scheduledTaskGraphContinuationKeyVersion, scheduledTaskGraphStableKey } from './scheduled-pipeline-continuation-key.js'
import type { ScheduledTaskGraphContinuationBinding } from './scheduled-taskgraph-continuation-receipt.js'

function binding(key: string): ScheduledTaskGraphContinuationBinding {
  return { owner: { userId: 'u', sessionId: 's', turnId: 't', rootTaskId: 'r', rootAttemptCount: 2, turnLeaseOwnerId: 'lease',
    turnLeaseVersion: 8, executionId: 'exec', executionAttemptCount: 1 }, continuationKey: key, snapshotDigest: `sha256:${'a'.repeat(64)}`,
    evidenceDigest: 'b'.repeat(64), checkpointDigest: 'c'.repeat(64), analyzeGraphRevision: 4, prepareScheduleRevision: 5 }
}

describe('scheduled continuation key versions', () => {
  it('parses only the exact supported key prefixes', () => {
    expect(scheduledTaskGraphContinuationKeyVersion(`scheduled-taskgraph:sha256:${'a'.repeat(64)}`)).toBe('v1')
    expect(scheduledTaskGraphContinuationKeyVersion(`scheduled-taskgraph:v2:sha256:${'a'.repeat(64)}`)).toBe('v2')
    expect(scheduledTaskGraphContinuationKeyVersion(`scheduled-taskgraph:v3:sha256:${'a'.repeat(64)}`)).toBeNull()
    expect(scheduledTaskGraphContinuationKeyVersion('scheduled-taskgraph:v2:sha256:bad')).toBeNull()
  })

  it('preserves v1 stable-key bytes while versioning v2 and excluding volatile Turn leases', () => {
    const v1 = binding(`scheduled-taskgraph:sha256:${'d'.repeat(64)}`), v2 = binding(`scheduled-taskgraph:v2:sha256:${'e'.repeat(64)}`)
    const projection = ['u', 's', 't', 'r', 2, 'exec', 1, v1.snapshotDigest, v1.evidenceDigest, v1.checkpointDigest, 4, 5]
    const expected = `scheduled-taskgraph:sha256:${createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex')}`
    expect(scheduledTaskGraphStableKey(v1)).toBe(expected)
    expect(scheduledTaskGraphStableKey(v2)?.startsWith('scheduled-taskgraph:v2:sha256:')).toBe(true)
    const reLeased = { ...v2, owner: { ...v2.owner, turnLeaseOwnerId: 'new-lease', turnLeaseVersion: 99 } }
    expect(scheduledTaskGraphStableKey(reLeased)).toBe(scheduledTaskGraphStableKey(v2))
  })
})
