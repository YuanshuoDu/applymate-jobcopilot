import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useApi: vi.fn() }))

vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi, apiMutate: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => React.createElement('a', { href }, children) }))
vi.mock('lucide-react', () => ({ ArrowLeft: () => null, CalendarDays: () => null, Save: () => null }))

import { AdminUserDetailPage } from './AdminUserDetailPage'

const detail = {
  user: { name: 'C***', email: 'ca***@example.com', plan: 'pro', location: 'D***', createdAt: '2026-08-07T00:00:00.000Z', jobsCount: 2, resumeExists: true, gmail: { connected: true, hasError: false } },
  applications: { count: 1, recent: [] },
}

const settings = {
  user: {
    preferences: {
      targetRoles: 'Engineer',
      targetLocations: 'Dublin',
      salaryExpectation: '€70k',
      workAuthorization: 'EU',
      openToRelocation: true,
      notificationPreferences: { apply: true, reject: true, interview: true, offer: true, weekly: false, followUp: true },
      privacyPreferences: { shareUsageData: true, allowAiTraining: false, storeCoverLetters: true },
    },
    integrations: {
      accounts: { gmail: true, github: false },
      ai: { providers: { minimax: { userConfigured: false, platformConfigured: true, effective: true } }, featureOverrides: 0, customConfigured: false },
      discovery: { hasAdzuna: false, hasRapidapi: true, userHasAdzuna: false, userHasRapidapi: true, adzunaSource: 'none', rapidapiSource: 'user', needsAdzunaPair: false },
    },
  },
}

describe('AdminUserDetailPage', () => {
  beforeEach(() => {
    mocks.useApi.mockReset()
    mocks.useApi.mockImplementation((url: string) => url.endsWith('/settings')
      ? { data: settings, loading: false, error: null, refetch: vi.fn() }
      : { data: detail, loading: false, error: null, refetch: vi.fn() })
  })

  it('shows bounded candidate preferences and an editor to authorized administrators', () => {
    const html = renderToStaticMarkup(React.createElement(AdminUserDetailPage, { userId: 'user_1', canUpdatePreferences: true }))

    expect(html).toContain('Candidate settings')
    expect(html).toContain('Notification preferences')
    expect(html).toContain('Integration status')
    expect(html).toContain('Gmail: Connected')
    expect(html).toContain('RapidAPI: Ready')
    expect(html).toContain('Save settings')
    expect(html).not.toContain('apiKey')
  })

  it('keeps the settings view read-only without the update permission', () => {
    const html = renderToStaticMarkup(React.createElement(AdminUserDetailPage, { userId: 'user_1', canUpdatePreferences: false }))

    expect(html).toContain('You can view settings but do not have permission to edit them.')
    expect(html).not.toContain('Save settings')
  })
})
