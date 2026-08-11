import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPublicPlans: vi.fn(),
  headers: vi.fn(),
  isAdminHost: vi.fn(),
  redirect: vi.fn(),
  safeAuth: vi.fn(),
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/plan-catalogue', () => ({ getPublicPlans: mocks.getPublicPlans }))
vi.mock('@/lib/host-routing', () => ({ isAdminHost: mocks.isAdminHost }))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/layout/AppShell', () => ({ AppShell: () => React.createElement('main', { 'data-shell': true }) }))
vi.mock('@/components/landing/LandingPage', () => ({ LandingPage: () => React.createElement('main', { 'data-landing': true }) }))
vi.mock('@/components/auth/LoginPage', () => ({ LoginPage: () => React.createElement('main', { 'data-login': true }) }))
vi.mock('@/components/auth/RegisterPage', () => ({ RegisterPage: () => React.createElement('main', { 'data-register': true }) }))
vi.mock('@/components/auth/ForgotPasswordPage', () => ({ ForgotPasswordPage: () => React.createElement('main', { 'data-forgot-password': true }) }))

import Home from './page'
import Login from './login/page'
import Register from './register/page'
import ForgotPassword from './forgot-password/page'

describe('authentication entry pages', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    mocks.getPublicPlans.mockReset().mockResolvedValue([])
    mocks.headers.mockReset().mockResolvedValue(new Headers({ host: 'applymate.site' }))
    mocks.isAdminHost.mockReset().mockReturnValue(false)
    mocks.redirect.mockReset()
    mocks.safeAuth.mockReset().mockResolvedValue(null)
  })

  it.each([{ user: {} }, { user: { id: '   ' } }])('treats an Auth.js invalid user object as signed out across entry pages', async session => {
    mocks.safeAuth.mockResolvedValue(session)

    const home = await Home()
    await Login({ searchParams: Promise.resolve({}) })
    await Register({ searchParams: Promise.resolve({}) })
    await ForgotPassword()

    expect(home.type).toBeTruthy()
    expect(mocks.getPublicPlans).toHaveBeenCalledOnce()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('accepts only a non-empty application user id as an authenticated session', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'candidate-1' } })

    const home = await Home()
    await Login({ searchParams: Promise.resolve({}) })
    await Register({ searchParams: Promise.resolve({}) })
    await ForgotPassword()

    expect(home.type).toBeTruthy()
    expect(mocks.getPublicPlans).not.toHaveBeenCalled()
    expect(mocks.redirect).toHaveBeenCalledTimes(3)
    expect(mocks.redirect).toHaveBeenCalledWith('/')
  })
})
