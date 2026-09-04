import { describe, expect, it } from 'vitest'

import { createReadOnlySessionProjection, projectTimelineItems } from './session-projection'
import type { TimelineItem } from './timeline-reducer'

function timelineItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1',
    stepId: null, taskId: null, type: 'agent_message', status: 'completed', phase: 'commentary',
    revision: 1, content: { text: 'Canonical response' }, startedAt: null, completedAt: null,
    createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', source: 'replay', sequence: '1',
    ...overrides,
  }
}

describe('read-only session projection', () => {
  it('copies canonical items and never marks the renderer projection writable', () => {
    const item = timelineItem()
    const items = [item]
    const projection = createReadOnlySessionProjection('session-1', items)

    expect(projection).toEqual({ sessionId: 'session-1', writable: false, items: [item] })
    expect(projection.items).not.toBe(items)
    expect(projectTimelineItems(projection)[0]).toMatchObject({ type: 'agent_message', data: item })
  })

  it('keeps legacy approval payloads on the read-only renderer path', () => {
    const approval = { approval: { id: 'approval-1', body: 'Review this action.' } }
    const projection = createReadOnlySessionProjection('session-1', [timelineItem({
      id: 'approval-item', type: 'approval_request', content: { body: 'Review this action.', data: approval },
    })])

    expect(projectTimelineItems(projection)[0]).toMatchObject({ type: 'approval_request', data: approval })
  })
})
