import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiMutate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/lib/hooks', () => ({ apiMutate: mocks.apiMutate }))
vi.mock('@/components/ui', () => ({
  CompanyLogo: () => null,
  ScorePill: () => null,
  useToast: () => mocks.toast,
}))

import { SmartSearch } from './SmartSearch'

function setStoredSearch(meta: Record<string, unknown>) {
  const storage = new Map<string, string>([['applymate_last_search', JSON.stringify({
    q: 'Software Engineer Amsterdam',
    filters: { location: 'Amsterdam', remote: false, jobType: '', datePosted: 'any', experience: '', salaryMin: '', salaryMax: '' },
    results: [],
    meta,
  })]])

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
}

describe('SmartSearch', () => {
  beforeEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('gives search controls distinct accessible names', () => {
    const html = renderToStaticMarkup(React.createElement(SmartSearch))

    expect(html).toContain('aria-label="Search jobs"')
    expect(html).toContain('aria-label="Show search filters"')
    expect(html).toContain('aria-controls="search-filters"')
  })

  it('shows an English configuration path without internal routing diagnostics', () => {
    setStoredSearch({
      sourcesUsed: [],
      routing: 'NL → adzuna + ats + linkedin',
      totalRaw: 0,
      totalDeduped: 0,
      durationMs: 3,
      apiKeys: { rapidapi: false, adzuna: false, reed: false, careerjet: false },
    })

    const html = renderToStaticMarkup(React.createElement(SmartSearch, { onOpenSettings: vi.fn() }))

    expect(html).toContain('Some sources need a connection')
    expect(html).toContain('Open API key settings')
    expect(html).not.toContain('搜索 API 未配置')
    expect(html).not.toContain('路由：')
    expect(html).not.toContain('NL → adzuna + ats + linkedin')
  })
})
