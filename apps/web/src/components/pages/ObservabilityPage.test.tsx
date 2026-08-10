import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), links: [] as string[] }))

vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi }))
vi.mock('@/components/layout/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: React.ReactNode }) => React.createElement('header', null, title, children),
}))
vi.mock('@/components/ui', () => ({
  Btn: ({ children }: { children?: React.ReactNode }) => React.createElement('button', null, children),
  Card: ({ children }: { children?: React.ReactNode }) => React.createElement('section', null, children),
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => { mocks.links.push(href); return React.createElement('a', { href }, children) } }))
vi.mock('lucide-react', () => ({ ExternalLink: () => null, RefreshCw: () => null }))

import { ObservabilityPage } from './ObservabilityPage'

describe('ObservabilityPage', () => {
  beforeEach(() => {
    mocks.useApi.mockReset()
    mocks.links.length = 0
  })

  it('reports the MiniMax default separately from optional provider health', () => {
    mocks.useApi
      .mockReturnValueOnce({ data: null, loading: false, error: null, refetch: vi.fn() })
      .mockReturnValueOnce({
        data: {
          users: { total: 1, byPlan: { free: 1, pro: 0, enterprise: 0 } },
          applies: { total: 0 },
          deletionRequests: { requested: 0, processing: 0 },
          integrations: {
            ai: { providers: { minimax: false, openai: true } },
            discovery: { adzuna: false, rapidapi: false },
            oauth: { google: false, github: false },
            messaging: { resend: false },
            infrastructure: { database: true, redis: false },
          },
          readiness: {
            candidateSettings: {
              migrations: { state: 'unavailable', missing: [] },
              superAdminPermission: 'unavailable',
              currentActorPermission: 'ready',
            },
            workerControl: { state: 'missing', urlConfigured: false, secretConfigured: false, redisConfigured: true },
          },
        },
        loading: false,
        error: null,
        refetch: vi.fn(),
      })

    const html = renderToStaticMarkup(React.createElement(ObservabilityPage))
    expect(html).toContain('ApplyMate AI · MiniMax · not configured')
    expect(html).not.toContain('ApplyMate AI · MiniMax · ready')
    expect(html).toContain('Operational applies')
    expect(html).toContain('All users · operational count')
    expect(html).toContain('Deployment readiness')
    expect(html).toContain('Settings migrations: Unavailable')
    expect(html).toContain('Database readiness checks are unavailable.')
    expect(html).toContain('Worker controls need: URL and shared secret')
    expect(mocks.links).toContain('/admin/users')
  })
})
