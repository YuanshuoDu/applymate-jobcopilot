import { describe, expect, it } from 'vitest'
import { classifyGmailMessage, extractRecommendationCards } from './index'

describe('gmail tracking public API', () => {
  it('exposes pure classification and recommendation extraction helpers', () => {
    expect(classifyGmailMessage('Thank you for applying')).toBe('application_received')
    expect(extractRecommendationCards({ text: '' })).toEqual([])
  })
})
