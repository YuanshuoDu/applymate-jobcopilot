import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useApi: vi.fn() }))

vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi }))
vi.mock('lucide-react', () => ({ AlertTriangle: () => null, CalendarDays: () => null, ShieldCheck: () => null }))

import { AdminOverview } from './AdminOverview'

describe('AdminOverview', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.useApi.mockClear()
    mocks.useApi.mockImplementation((url: string) => {
      if (url.endsWith('/platform')) return {
        data: {
          integrations: {
            ai: { providers: { minimax: true, openai: false } },
            discovery: { adzuna: true, rapidapi: false },
            oauth: { google: true, github: false },
            messaging: { resend: true },
            infrastructure: { database: true, redis: false, workerControl: true },
          },
        },
        loading: false,
        error: null,
      }
      if (url.endsWith('/queues')) return { data: { queues: [] }, loading: false, error: null }
      return {
        data: {
          overall: { total: 1, successRate: 100, avgDurationMs: 10, captchaRate: 0, last24h: { count: 1, successRate: 100 } },
          platform: { registeredUsers: 1, registrationsLast7d: 1, plans: { free: 1 }, sources: { employers: 1, jobs: 1 }, overdueSupportCases: 0 },
        },
        loading: false,
        error: null,
      }
    })
  })

  it('shows platform integration health in the operational overview', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOverview, { permissions: ['observability.read', 'queues.read'] }))

    expect(html).toContain('Platform integrations')
    expect(html).toContain('MiniMax')
    expect(html).toContain('Worker control')
    expect(html).toContain('Ready')
    expect(html).toContain('Missing')
    expect(mocks.useApi).toHaveBeenCalledWith('/api/admin/v1/queues', { enabled: true })
  })

  it('does not request queue data for roles without queues.read', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOverview, { permissions: ['observability.read'] }))

    expect(mocks.useApi).toHaveBeenCalledWith('/api/admin/v1/queues', { enabled: false })
    expect(html).toContain('Not available for this role')
  })
})
