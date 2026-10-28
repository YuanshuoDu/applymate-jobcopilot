import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsUsageActivity } from './SettingsUsageActivity'

const mocks = vi.hoisted(() => ({ api: vi.fn(), lang: 'en' }))
vi.mock('@/lib/hooks', () => ({ useApi: mocks.api }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: mocks.lang }) }))

const recorded = {
  days: 30, timezone: 'UTC', from: '2026-09-29T00:00:00.000Z', to: '2026-10-28T12:00:00.000Z',
  summary: { calls: 4, inputTokens: 1200, outputTokens: 350, totalTokens: 1550 },
  daily: [{ date: '2026-10-28', calls: 4, inputTokens: 1200, outputTokens: 350, totalTokens: 1550 }],
  models: [{ provider: 'example-provider', model: 'example-model', calls: 4, inputTokens: 1200, outputTokens: 350, totalTokens: 1550 }],
}
const activities = [{ id: 'activity-1', text: 'Saved a role for review <script>', createdAt: '2026-10-28T10:00:00.000Z' }]
beforeEach(() => {
  mocks.lang = 'en'
  mocks.api.mockReset().mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : activities, loading: false, error: null, refetch: vi.fn() }))
})

describe('Personal usage in Settings', () => {
  it('shows recorded usage and recent activity with distinct period definitions and no quality score', () => {
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(mocks.api).toHaveBeenCalledWith('/api/me/usage?days=30', { cache: false })
    expect(mocks.api).toHaveBeenCalledWith('/api/activity?limit=12', { cache: false })
    expect(html).toContain('1,200')
    expect(html).toContain('example-model')
    expect(html).toContain('Dates use UTC')
    expect(html).toContain('completed and failed AI requests')
    expect(html).toContain('across all dates')
    expect(html).toContain('Saved a role for review &lt;script&gt;')
    expect(html).not.toContain('Session Quality')
    expect(html).not.toContain('Success rate')
  })

  it('renders Chinese labels without an internal diagnostics panel', () => {
    mocks.lang = 'zh'
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('使用量与活动')
    expect(html).toContain('最近 7 天')
    expect(html).toContain('尚未执行的请求不计入')
    expect(html).not.toContain('Session Quality')
  })

  it('does not present a failed query as zero usage, and still displays available activity', () => {
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : activities, loading: false, error: url.startsWith('/api/me/usage') ? 'unavailable' : null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Usage is unavailable')
    expect(html).not.toContain('No recorded AI requests')
    expect(html).not.toContain('example-model')
    expect(html).toContain('Saved a role for review')
  })

  it('distinguishes successfully loaded empty usage from loading and missing activity', () => {
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? { ...recorded, summary: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, daily: [], models: [] } : [], loading: false, error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('No recorded AI requests in this period')
    expect(html).toContain('No activity recorded yet')
    expect(html).not.toContain('role="img"')
  })

  it('does not show the previous period under a new period selection', () => {
    // Only the usage payload matters; keep the independent activity request empty.
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? { ...recorded, days: 7 } : [], loading: false, error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('Loading your usage')
    expect(html).not.toContain('example-model')
  })

  it('prevents a time-window change while a refresh can still return for the previous window', () => {
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : activities, loading: url.startsWith('/api/me/usage'), error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toMatch(/<select[^>]*aria-label="Time range"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*aria-label="Refresh usage"[^>]*disabled=""/)
  })
})
