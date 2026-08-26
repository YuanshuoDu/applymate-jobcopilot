import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminAtsRegistry } from './AdminAtsRegistry'

vi.mock('@/lib/hooks', () => ({ useApi: () => ({
  data: { items: [{ id: 7, atsType: 'lever', slug: 'tradeRepublic', name: 'Trade Republic', country: 'de', enabled: true, version: 2, jobCount: 12, lastSeen: null }], nextCursor: null },
  loading: false, error: null, refetch: vi.fn(),
}) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./AdminPromptDialog', () => ({ useAdminPrompt: () => ({ request: vi.fn(), dialog: null }) }))

describe('AdminAtsRegistry', () => {
  it('renders real registry metadata and management actions', () => {
    const html = renderToStaticMarkup(<AdminAtsRegistry canManage />)

    expect(html).toContain('Trade Republic')
    expect(html).toContain('tradeRepublic')
    expect(html).toContain('adminAts.neverSeen')
    expect(html).toContain('adminAts.disableEmployer')
  })
})
