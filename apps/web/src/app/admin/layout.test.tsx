import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdminMembership: vi.fn(), redirect: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdminMembership: mocks.requireAdminMembership,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/components/admin/AdminShell', () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement('section', { 'data-admin-shell': true }, children),
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

import AdminLayout from './layout'

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.requireAdminMembership.mockReset()
    mocks.redirect.mockReset()
  })

  it('redirects callers without an active admin membership to login', async () => {
    mocks.requireAdminMembership.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))

    await AdminLayout({ children: React.createElement('main', null, 'Admin content') })

    expect(mocks.redirect).toHaveBeenCalledWith('/login?callbackUrl=%2Fadmin&error=not_admin')
  })

  it('renders the RBAC shell for an active admin membership', async () => {
    const children = React.createElement('main', null, 'Admin content')
    mocks.requireAdminMembership.mockResolvedValue({ userId: 'admin_1', roleKey: 'support', permissions: ['users.read'], requestId: 'request_1' })

    const result = await AdminLayout({ children })

    expect(result).toEqual(expect.objectContaining({ type: expect.anything() }))
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
