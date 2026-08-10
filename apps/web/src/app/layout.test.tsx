import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getUsageAnalyticsConsent: vi.fn() }))

vi.mock('next/font/google', () => ({ Inter: () => ({ className: 'inter' }) }))
vi.mock('@vercel/speed-insights/next', () => ({
  SpeedInsights: () => React.createElement('span', { 'data-speed-insights': true }),
}))
vi.mock('@/components/Providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}))
vi.mock('@/lib/usage-analytics', () => ({
  getUsageAnalyticsConsent: mocks.getUsageAnalyticsConsent,
}))

import RootLayout from './layout'

describe('RootLayout', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.getUsageAnalyticsConsent.mockReset()
  })

  it('does not render analytics when consent is unavailable', async () => {
    mocks.getUsageAnalyticsConsent.mockResolvedValue(false)

    const layout = await RootLayout({ children: React.createElement('main', null, 'content') })
    const html = renderToStaticMarkup(layout)

    expect(html).not.toContain('data-speed-insights')
  })

  it('renders analytics only when consent is granted', async () => {
    mocks.getUsageAnalyticsConsent.mockResolvedValue(true)

    const layout = await RootLayout({ children: React.createElement('main', null, 'content') })
    const html = renderToStaticMarkup(layout)

    expect(html).toContain('data-speed-insights')
  })
})
