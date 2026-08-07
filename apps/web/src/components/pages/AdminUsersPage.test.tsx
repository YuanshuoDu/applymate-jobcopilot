import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), useToast: vi.fn() }))

vi.mock('@/lib/hooks', () => ({
  useApi: mocks.useApi,
  apiMutate: vi.fn(),
}))
vi.mock('@/components/layout/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: React.ReactNode }) => React.createElement('header', null, title, children),
}))
vi.mock('@/components/ui', () => ({
  Btn: ({ children }: { children?: React.ReactNode }) => React.createElement('button', null, children),
  Card: ({ children }: { children?: React.ReactNode }) => React.createElement('section', null, children),
  useToast: mocks.useToast,
}))

import { AdminUsersPage } from './AdminUsersPage'

describe('AdminUsersPage', () => {
  beforeEach(() => {
    mocks.useApi.mockReset()
    mocks.useToast.mockReturnValue({ success: vi.fn(), error: vi.fn() })
  })

  it('renders a clear administrator-only state for denied access', () => {
    mocks.useApi.mockReturnValue({ data: null, loading: false, error: 'Admin access denied', refetch: vi.fn() })
    const html = renderToStaticMarkup(React.createElement(AdminUsersPage))
    expect(html).toContain('explicitly allow-listed administrators')
    expect(html).toContain('Admin · User settings')
  })
})
