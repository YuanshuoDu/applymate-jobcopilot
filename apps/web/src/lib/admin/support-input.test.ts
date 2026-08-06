import { describe, expect, it } from 'vitest'
import { parseSupportCaseCreateInput, parseSupportCasePriority, parseSupportCaseStatus } from './support'

describe('support case input parsing', () => {
  it('returns narrowed values for persistence', () => {
    expect(parseSupportCaseCreateInput({ subject: '  Login issue ', category: 'technical', priority: 'urgent' })).toEqual({
      subject: 'Login issue',
      category: 'technical',
      priority: 'urgent',
    })
  })

  it('rejects missing or unsupported subjects and categories', () => {
    expect(() => parseSupportCaseCreateInput({ subject: '', category: 'technical' })).toThrow('Subject is required')
    expect(() => parseSupportCaseCreateInput({ subject: 'Question', category: 'unknown' })).toThrow('Category is invalid')
  })

  it('narrows lifecycle filters to Prisma enum values', () => {
    expect(parseSupportCaseStatus('resolved')).toBe('resolved')
    expect(parseSupportCaseStatus('deleted')).toBeUndefined()
    expect(parseSupportCasePriority('urgent')).toBe('urgent')
    expect(parseSupportCasePriority('critical')).toBeUndefined()
  })
})
