import { describe, expect, it } from 'vitest'

import { buildEventIndexes, buildIndexes, isAfter, mergeContent } from './timeline-reducer-utils'
import type { TimelineItem } from './timeline-reducer'

const item = (id: string, taskId: string | null): TimelineItem => ({
  schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId,
  type: 'artifact', status: 'completed', phase: 'commentary', revision: 1, content: null,
  startedAt: null, completedAt: null, createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
  source: 'replay', sequence: null,
})

describe('timeline reducer utilities', () => {
  it('builds deterministic turn and task indexes', () => {
    const indexes = buildIndexes({ b: item('b', 'task-1'), a: item('a', 'task-1') })
    expect(indexes).toEqual({ itemIdsByTurnId: { 'turn-1': ['a', 'b'] }, itemIdsByTaskId: { 'task-1': ['a', 'b'] } })
  })

  it('indexes events by id, turn, and nested tool call id in stable order', () => {
    const makeEvent = (id: string, sequence: string, toolCallId?: string) => ({
      schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', itemId: null,
      taskId: null, type: 'tool_call.started', actor: 'orchestrator', sequence, payload: toolCallId ? { toolCallId } : null,
    })
    const indexes = buildEventIndexes([makeEvent('b', '2', 'tool-1'), makeEvent('a', '1', 'tool-1')])
    expect(indexes.events.map(event => event.id)).toEqual(['a', 'b'])
    expect([...indexes.byId.keys()]).toEqual(['a', 'b'])
    expect(indexes.byTurnId.get('turn-1')?.map(event => event.id)).toEqual(['a', 'b'])
    expect(indexes.byToolCallId.get('tool-1')?.map(event => event.id)).toEqual(['a', 'b'])
  })

  it('merges object deltas and compares arbitrary-length cursors', () => {
    expect(mergeContent({ text: 'hello', status: 'streaming' }, { status: 'done' })).toEqual({ text: 'hello', status: 'done' })
    expect(isAfter('100000000000000000000', '99999999999999999999')).toBe(true)
  })
})
