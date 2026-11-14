import { describe, expect, it } from 'vitest'
import { mayUpdateAnalysisCache } from './application-analysis-cache'

describe('versioned analysis cache updates', () => {
  it('allows first and same-revision results, and accepts a newer saved revision', () => {
    expect(mayUpdateAnalysisCache(null, '2026-10-30T10:00:00.000Z')).toBe(true)
    expect(mayUpdateAnalysisCache('2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z')).toBe(true)
    expect(mayUpdateAnalysisCache('2026-10-30T10:00:00.000Z', '2026-10-30T10:01:00.000Z')).toBe(true)
  })
  it('rejects late older results and cannot replace an unorderable version', () => {
    expect(mayUpdateAnalysisCache('2026-10-30T10:01:00.000Z', '2026-10-30T10:00:00.000Z')).toBe(false)
    expect(mayUpdateAnalysisCache('unknown', '2026-10-30T10:00:00.000Z')).toBe(false)
    expect(mayUpdateAnalysisCache('2026-10-30T10:00:00.000Z', 'unknown')).toBe(false)
  })
})
