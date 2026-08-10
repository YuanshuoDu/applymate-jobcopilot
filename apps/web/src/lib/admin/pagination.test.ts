import { describe, expect, it } from 'vitest'
import { adminPageLimit, pageResult } from './pagination'

describe('admin pagination', () => {
  it('caps page sizes and returns an opaque next cursor', () => {
    expect(adminPageLimit('500')).toBe(100)
    expect(adminPageLimit('-1')).toBe(1)
    expect(adminPageLimit('invalid')).toBe(25)
    expect(pageResult([{ id: 1 }, { id: 2 }, { id: 3 }], 2)).toEqual({ items: [{ id: 1 }, { id: 2 }], nextCursor: '2' })
  })
})
