import { describe, expect, it } from 'vitest'
import {
  normalizeAllowedLocationDraft,
  ObjectiveStartCommandError,
  parseReportScoreFloorDraft,
  validateObjectiveContextDraft,
} from './agent-objective-start-input'

describe('Objective start input helpers', () => {
  it('keeps a blank floor omitted and parses bounded decimal values including zero', () => {
    expect(parseReportScoreFloorDraft('')).toBeUndefined()
    expect(parseReportScoreFloorDraft('0')).toBe(0)
    expect(parseReportScoreFloorDraft('.25')).toBe(0.25)
    expect(parseReportScoreFloorDraft('4.5')).toBe(4.5)
    expect(parseReportScoreFloorDraft('10')).toBe(10)
  })

  it('rejects malformed or out-of-range floor text without treating it as blank', () => {
    for (const value of [' ', 'abc', '1e2', '-0.1', '10.01']) {
      expect(parseReportScoreFloorDraft(value)).toBeNull()
    }
  })

  it('preserves objective validation errors and location normalization', () => {
    expect(validateObjectiveContextDraft({ objective: ' Find roles ', context: ' exact ' }))
      .toEqual({ objective: 'Find roles', context: ' exact ' })
    expect(() => validateObjectiveContextDraft({ objective: ' ', context: '' }))
      .toThrow(ObjectiveStartCommandError)
    expect(normalizeAllowedLocationDraft('Dublin\nBerlin')).toEqual(['berlin', 'dublin'])
    expect(() => normalizeAllowedLocationDraft('x'.repeat(2_001))).toThrow(ObjectiveStartCommandError)
  })
})
