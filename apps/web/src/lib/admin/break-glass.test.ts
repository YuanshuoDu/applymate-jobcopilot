import { describe, expect, it } from 'vitest'
import { parseBreakGlassRequest } from './break-glass'

describe('break-glass validation', () => {
  it('only accepts a known permission for a short-lived grant', () => {
    expect(parseBreakGlassRequest({ permission: 'queues.pause', durationMinutes: 15 })).toEqual({ permission: 'queues.pause', durationMinutes: 15 })
    expect(parseBreakGlassRequest({ permission: 'root.shell', durationMinutes: 15 })).toBeNull()
    expect(parseBreakGlassRequest({ permission: 'queues.pause', durationMinutes: 90 })).toBeNull()
  })
})
