import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireSettingsAdmin: vi.fn(), redirect: vi.fn() }))

vi.mock('@/lib/admin/settings-access', () => ({ requireSettingsAdmin: mocks.requireSettingsAdmin }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

import AdminLayout from './layout'

describe('AdminLayout', () => {
  beforeEach(() => {
    mocks.requireSettingsAdmin.mockReset()
    mocks.redirect.mockReset()
  })

  it('redirects a signed-in user who is not on the admin allowlist', async () => {
    mocks.requireSettingsAdmin.mockResolvedValue(Response.json({ error: 'Admin access denied' }, { status: 403 }))

    await AdminLayout({ children: React.createElement('main', null, 'Admin content') })

    expect(mocks.redirect).toHaveBeenCalledWith('/')
  })

  it('renders the admin route content for an allow-listed administrator', async () => {
    const children = React.createElement('main', null, 'Admin content')
    mocks.requireSettingsAdmin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })

    expect(await AdminLayout({ children })).toBe(children)
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
