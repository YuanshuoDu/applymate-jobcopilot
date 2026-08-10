import { describe, expect, it } from 'vitest'

import { pageFromSearch } from './page-routing'

describe('pageFromSearch', () => {
  it('keeps the settings page when a deep link includes a settings tab', () => {
    expect(pageFromSearch('?page=settings&tab=apiKeys')).toBe('settings')
  })

  it('falls back to the dashboard for an unknown page', () => {
    expect(pageFromSearch('?page=not-a-page')).toBe('dashboard')
  })
})
