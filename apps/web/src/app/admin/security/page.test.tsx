import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdminMembership: vi.fn(), redirect: vi.fn() }))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdminMembership: mocks.requireAdminMembership,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/components/admin/AdminSecurityPage', () => ({
  AdminSecurityPage: (props: Record<string, unknown>) => React.createElement('div', props),
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

import SecurityAdminPage from './page'

describe('SecurityAdminPage', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.requireAdminMembership.mockReset()
    mocks.redirect.mockReset()
  })

  it('allows a platform administrator to reach self-service WebAuthn without break-glass controls', async () => {
    mocks.requireAdminMembership.mockResolvedValue({
      userId: 'admin-1',
      roleKey: 'platform_admin',
      permissions: ['feature_flags.approve'],
      requestId: 'request-1',
    })

    const result = await SecurityAdminPage()

    expect(result.props).toEqual({ canRequest: false, canApprove: false })
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('passes break-glass capabilities only when the membership holds them', async () => {
    mocks.requireAdminMembership.mockResolvedValue({
      userId: 'admin-2',
      roleKey: 'security_admin',
      permissions: ['break_glass.request', 'break_glass.approve'],
      requestId: 'request-2',
    })

    const result = await SecurityAdminPage()

    expect(result.props).toEqual({ canRequest: true, canApprove: true })
  })
})
