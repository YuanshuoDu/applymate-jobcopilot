import { describe, expect, it } from 'vitest'

import { hasAllTimelineTargetItems, sortTimelineTailEvents } from './timeline-hydration-order'

describe('timeline hydration ordering', () => {
  it('sorts sequenced tail facts numerically, then by id, before unsequenced facts', () => {
    const values = [
      { id: 'b', sequence: '9' }, { id: 'z', sequence: '10' }, { id: 'a', sequence: '9' },
      { id: 'unsequenced' }, { id: 'invalid-sequence', sequence: '01' },
    ]

    expect(values.sort(sortTimelineTailEvents).map(value => value.id)).toEqual(['a', 'b', 'z', 'invalid-sequence', 'unsequenced'])
  })

  it('requires every target item id and ignores malformed or duplicate rows', () => {
    const targets = new Set(['item-a', 'item-b'])

    expect(hasAllTimelineTargetItems([{ id: 'item-a' }, null, { id: 'item-a' }], targets)).toBe(false)
    expect(hasAllTimelineTargetItems([{ id: 'item-a' }, { id: 'item-b' }, { id: 'other' }], targets)).toBe(true)
  })
})
