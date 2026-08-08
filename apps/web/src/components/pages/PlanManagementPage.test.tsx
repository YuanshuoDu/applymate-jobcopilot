import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useApi: vi.fn() }))

vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi, apiMutate: vi.fn() }))
vi.mock('@/components/layout/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: React.ReactNode }) => React.createElement('header', null, title, children),
}))
vi.mock('@/components/ui', () => ({
  Btn: ({ children }: { children?: React.ReactNode }) => React.createElement('button', null, children),
  Card: ({ children }: { children?: React.ReactNode }) => React.createElement('section', null, children),
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => React.createElement('a', { href }, children) }))
vi.mock('lucide-react', () => ({ Save: () => null, ShieldAlert: () => null }))

import { PlanManagementPage } from './PlanManagementPage'

describe('PlanManagementPage', () => {
  beforeEach(() => mocks.useApi.mockReset())

  it('lets administrators maintain a plan currency and display order', () => {
    mocks.useApi.mockReturnValue({
      data: {
        plans: [{
          key: 'free', name: 'Free', priceMinor: 0, currency: 'USD', interval: 'year', description: 'Free tier',
          features: ['Tracker'], badge: null, cta: 'Start', trialDays: 0, active: true, sortOrder: 42,
        }],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    const html = renderToStaticMarkup(React.createElement(PlanManagementPage))

    expect(html).toContain('Price (USD per year)')
    expect(html).toContain('Currency')
    expect(html).toContain('Display order')
    expect(html).toContain('value="42"')
  })

  it('hides observability navigation from administrators without that permission', () => {
    mocks.useApi.mockReturnValue({
      data: { plans: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    const html = renderToStaticMarkup(React.createElement(PlanManagementPage, { canViewObservability: false }))

    expect(html).not.toContain('href="/admin/observability"')
  })
})
