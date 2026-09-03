import { describe, expect, it } from 'vitest'

import { contentParts } from './harness-item-types'

describe('Harness content parts', () => {
  it('normalizes only the supported tagged union and keeps unknown parts safe', () => {
    expect(contentParts({ parts: [
      { type: 'text', text: 'Hello' },
      { type: 'suggested_action', command: 'review_jobs', arguments: { count: 3 } },
      { type: 'future_part', html: '<script>alert(1)</script>' },
    ] })).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'suggested_action', command: 'review_jobs', arguments: { count: 3 } },
      { type: 'unknown', rawType: 'future_part' },
    ])
  })

  it('supports the timeline snapshot text shape', () => {
    expect(contentParts({ text: 'snapshot text' })).toEqual([{ type: 'text', text: 'snapshot text' }])
  })
})
