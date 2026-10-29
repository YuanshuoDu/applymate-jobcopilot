import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsUsageActivity } from './SettingsUsageActivity'
import { SETTINGS_USAGE_COPY } from './settings-usage-copy'

const mocks = vi.hoisted(() => ({ api: vi.fn(), lang: 'en', sessionId: 'account-1' as string | null, sessionStatus: 'authenticated' }))
vi.mock('@/lib/hooks', () => ({ useApi: mocks.api }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: mocks.sessionStatus, data: mocks.sessionId ? { user: { id: mocks.sessionId } } : null }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: mocks.lang }) }))

const recorded = {
  ownerId: 'account-1', days: 30, timezone: 'UTC', from: '2026-09-29T00:00:00.000Z', to: '2026-10-28T12:00:00.000Z',
  summary: { calls: 4, inputTokens: 1200, outputTokens: 350, totalTokens: 1550 },
  daily: Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 29 + index)).toISOString().slice(0, 10), calls: index === 29 ? 4 : 0, inputTokens: index === 29 ? 1200 : 0, outputTokens: index === 29 ? 350 : 0, totalTokens: index === 29 ? 1550 : 0 })),
  models: [{ provider: 'example-provider', model: 'example-model', calls: 4, inputTokens: 1200, outputTokens: 350, totalTokens: 1550 }],
}
const activities = { ownerId: 'account-1', items: [{ id: 'activity-1', text: 'Saved a role for review <script>', createdAt: '2026-10-28T10:00:00.000Z' }] }
const noActivities = { ownerId: 'account-1', items: [] }
beforeEach(() => {
  mocks.lang = 'en'
  mocks.sessionId = 'account-1'
  mocks.sessionStatus = 'authenticated'
  mocks.api.mockReset().mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : activities, loading: false, error: null, refetch: vi.fn() }))
})

describe('Personal usage in Settings', () => {
  it('hides private data while checking authentication and after sign out', () => {
    mocks.sessionStatus = 'loading'
    let html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(SETTINGS_USAGE_COPY.en.checkingSession)
    expect(html).not.toContain('example-model')
    expect(mocks.api).not.toHaveBeenCalled()
    mocks.sessionStatus = 'unauthenticated'
    mocks.sessionId = null
    html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(SETTINGS_USAGE_COPY.en.signInRequired)
    expect(html).not.toContain('example-model')
    expect(mocks.api).not.toHaveBeenCalled()
    mocks.sessionStatus = 'authenticated'
    html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(SETTINGS_USAGE_COPY.en.signInRequired)
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('shows an actionable error for malformed usage and keeps valid activity visible', () => {
    for (const invalid of [null, {}, { ...recorded, ownerId: 'other-user' }, { ...recorded, summary: null }, { ...recorded, daily: null }, { ...recorded, to: 'bad-date' }, { ...recorded, models: null }]) {
      mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? invalid : activities, loading: false, error: null, refetch: vi.fn() }))
      const html = renderToStaticMarkup(<SettingsUsageActivity />)
      expect(html).toContain('Usage is unavailable')
      expect(html).toContain('Try again')
      expect(html).not.toContain('No recorded AI requests')
      expect(html).not.toContain('Loading your usage')
      expect(html).toContain('Saved a role for review')
    }
  })

  it('shows an actionable activity error without displaying a fake empty list or internal error', () => {
    for (const invalid of [null, {}, { ownerId: 'account-1', items: [{ id: 'x', text: 'private activity', createdAt: 'bad-date' }] }, { ownerId: 'other-user', items: [{ id: 'x', text: 'private activity', createdAt: '2026-10-28T10:00:00.000Z' }] }]) {
      mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : invalid, loading: false, error: null, refetch: vi.fn() }))
      const html = renderToStaticMarkup(<SettingsUsageActivity />)
      expect(html).toContain('Activity could not be loaded')
      expect(html).not.toContain('No visible activity yet')
      expect(html).not.toContain('private activity')
      expect(html).toContain('example-model')
    }
  })

  it.each([
    ['en', 'Usage & activity'], ['de', 'Nutzung und Aktivitäten'], ['fr', 'Utilisation et activité'],
    ['es', 'Uso y actividad'], ['nl', 'Gebruik en activiteit'], ['zh', '使用量与活动'],
  ] as const)('uses the global %s setting for its menu, page, numbers and dates', async (lang, title) => {
    mocks.lang = lang
    const { translate } = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n')
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(translate(lang, 'settings.usage')).toBe(title)
    expect(html).toContain(title.replaceAll('&', '&amp;'))
    expect(html).toContain(new Intl.NumberFormat(lang).format(1200))
    expect(html).toContain(new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(recorded.from)))
    expect(html).toContain('Saved a role for review &lt;script&gt;')
  })

  it.each(['en', 'de', 'fr', 'es', 'nl', 'zh'] as const)('localizes loading, failure and empty states in %s', (lang) => {
    mocks.lang = lang
    const labels = SETTINGS_USAGE_COPY[lang]
    mocks.api.mockImplementation(() => ({ data: null, loading: true, error: null, refetch: vi.fn() }))
    let html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(labels.loading)
    expect(html).toContain(labels.loadingActivity)

    mocks.api.mockImplementation(() => ({ data: null, loading: false, error: 'unavailable', refetch: vi.fn() }))
    html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(labels.error)
    expect(html).toContain(labels.activityError)
    expect(html).toContain(labels.retry)
    expect(html.match(/role="alert"/g)).toHaveLength(2)

    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? { ...recorded, summary: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, daily: recorded.daily.map(row => ({ ...row, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })), models: [] } : noActivities, loading: false, error: null, refetch: vi.fn() }))
    html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain(labels.empty)
    expect(html).toContain(labels.noActivity)
    expect(html).not.toContain('role="img"')
  })

  it('shows recorded usage and recent activity with distinct period definitions and no quality score', () => {
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(mocks.api).toHaveBeenCalledWith('/api/me/usage?days=30', { cache: false })
    expect(mocks.api).toHaveBeenCalledWith('/api/me/activity', { cache: false })
    expect(html).toContain('1,200')
    expect(html).toContain('example-model')
    expect(html).toContain('Dates use UTC')
    expect(html).toContain(SETTINGS_USAGE_COPY.en.scope)
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
    expect(html).toContain(SETTINGS_USAGE_COPY.zh.scope)
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
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? { ...recorded, summary: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, daily: recorded.daily.map(row => ({ ...row, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })), models: [] } : noActivities, loading: false, error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('No recorded AI requests in this period')
    expect(html).toContain('No visible activity yet')
    expect(html).not.toContain('role="img"')
  })

  it('treats a wrong-window completed response as unavailable, not as old data or indefinite loading', () => {
    // Only the usage payload matters; keep the independent activity request empty.
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? { ...recorded, days: 7 } : noActivities, loading: false, error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).toContain('Usage is unavailable')
    expect(html).not.toContain('Loading your usage')
    expect(html).not.toContain('example-model')
  })

  it('allows accessible time-window changes while preventing a refresh until loading finishes', () => {
    mocks.api.mockImplementation((url: string) => ({ data: url.startsWith('/api/me/usage') ? recorded : activities, loading: url.startsWith('/api/me/usage'), error: null, refetch: vi.fn() }))
    const html = renderToStaticMarkup(<SettingsUsageActivity />)
    expect(html).not.toMatch(/<select[^>]*aria-label="Time range"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*aria-label="Refresh usage"[^>]*disabled=""/)
  })
})
