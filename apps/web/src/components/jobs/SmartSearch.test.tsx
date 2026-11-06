import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: { data: { user: { id: 'candidate-1' } } as { user: { id: string } } | null, status: 'authenticated' },
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock('next-auth/react', () => ({ useSession: () => mocks.session }))
vi.mock('@/components/ui', () => ({ CompanyLogo: () => null, ScorePill: () => null, useToast: () => mocks.toast }))

import { SmartSearch } from './SmartSearch'

// The interactive search controls, source labels and configuration links are
// verified after effects run in e2e/application-flow.spec.ts.
describe('SmartSearch initial identity boundary', () => {
  beforeEach(() => { mocks.session.data = { user: { id: 'candidate-1' } }; mocks.session.status = 'authenticated' })

  it('does not render a previous search during unresolved authentication', () => {
    mocks.session.data = null; mocks.session.status = 'loading'
    const html = renderToStaticMarkup(React.createElement(SmartSearch))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('aria-label="Search jobs"')
  })

  it('waits for account-scoped state even when authentication is already known', () => {
    const html = renderToStaticMarkup(React.createElement(SmartSearch))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('aria-label="Search jobs"')
  })

  it('offers sign-in when no account is available', () => {
    mocks.session.data = null; mocks.session.status = 'unauthenticated'
    const html = renderToStaticMarkup(React.createElement(SmartSearch))
    expect(html).toContain('href="/login"')
    expect(html).toContain('Sign in again to continue')
  })
})
