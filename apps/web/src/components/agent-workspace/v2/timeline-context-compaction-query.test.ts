import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { agentEvent: { findMany: mocks.findMany } } }))

import { recentTimelineContextCompactionEvents } from './timeline-context-compaction-query'

function row(sequence: bigint, overrides: Record<string, unknown> = {}) {
  return {
    id: `compaction-${sequence}`, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1', sequence,
    type: 'context.compaction', actor: 'orchestrator', correlationId: 'step-1', causationId: null, idempotencyKey: 'turn:turn-1:event:context-compaction:step-1',
    payload: {
      kind: 'context_compacted', observationId: 'context-compacted:step-1', status: 'compacted', stepId: 'step-1', idempotencyKey: 'context-compaction:step-1',
      beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32, snapshotRef: 'private-ref',
    }, ...overrides,
  }
}

describe('timeline context compaction query', () => {
  beforeEach(() => mocks.findMany.mockReset())

  it('reads a bounded first-page tail, orders it by sequence, and redacts invalid or foreign rows', async () => {
    mocks.findMany.mockResolvedValue([
      row(BigInt(3)),
      row(BigInt(2)),
      row(BigInt(1), { sessionId: 'session-2' }),
      row(BigInt(4), { payload: { ...row(BigInt(4)).payload, extra: 'reject' } }),
    ])

    const events = await recentTimelineContextCompactionEvents('session-1')

    expect(events.map(event => event.id)).toEqual(['compaction-2', 'compaction-3'])
    expect(events[0]?.payload).toEqual({ kind: 'context_compacted', status: 'compacted', beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 })
    expect(JSON.stringify(events)).not.toContain('private-ref')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 'session-1', type: 'context.compaction' }, orderBy: { sequence: 'desc' }, take: 16,
    }))
  })
})
