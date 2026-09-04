import { describe, expect, it } from 'vitest'
import { supportCategoryLabel, supportStatusLabel } from './ContactUsPage'

describe('candidate Contact us labels', () => {
  it('uses translated labels when available and safe fallbacks otherwise', () => {
    const t = (key: string) => ({
      'contact.status.in_progress': '处理中',
      'contact.category.technical': '技术问题',
    }[key] ?? key)
    expect(supportStatusLabel('in_progress', t)).toBe('处理中')
    expect(supportCategoryLabel('technical', t)).toBe('技术问题')
    expect(supportStatusLabel('unknown')).toBe('unknown')
    expect(supportCategoryLabel('other')).toBe('Other')
  })
})
