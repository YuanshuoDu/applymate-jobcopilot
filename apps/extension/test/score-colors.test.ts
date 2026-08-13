import { describe, expect, it } from 'vitest'
import { scoreColorsFor, scoreToneFor } from '../src/lib/score-colors'

describe('score color scale', () => {
  it('uses the web strong-match threshold at 80', () => {
    expect(scoreToneFor(80)).toBe('strong')
    expect(scoreColorsFor(86).color).toBe('#059669')
  })

  it('uses amber for scores from 60 through 79', () => {
    expect(scoreToneFor(60)).toBe('normal')
    expect(scoreToneFor(79)).toBe('normal')
    expect(scoreColorsFor(62).color).toBe('#D97706')
  })

  it('uses red below 60', () => {
    expect(scoreToneFor(59)).toBe('weak')
    expect(scoreColorsFor(35).color).toBe('#DC2626')
  })
})
