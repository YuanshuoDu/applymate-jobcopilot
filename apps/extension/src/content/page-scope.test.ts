import { describe, expect, it } from 'vitest'
import { isPublicReviewJobPage } from './page-scope'

describe('public extension review job page', () => {
  it.each([
    'https://applymate.site/extension-review',
    'https://applymate.site/extension-review/',
    'https://applymate.site/extension-review?source=store#form',
  ])('allows only the main public fixture: %s', url => {
    expect(isPublicReviewJobPage(url)).toBe(true)
  })

  it.each([
    'https://applymate.site/extension-review/frame',
    'https://applymate.site/extension-review/frame/',
    'https://applymate.site/extension-review-other',
    'https://applymate.site/dashboard',
    'https://applymate.site/privacy',
    'https://applymate.site/',
    'https://applymate.site.attacker.test/extension-review',
    'http://applymate.site/extension-review',
    'https://applymate.site:8443/extension-review',
    'not a URL',
  ])('keeps dashboard and embedded routes outside job scraping: %s', url => {
    expect(isPublicReviewJobPage(url)).toBe(false)
  })
})
