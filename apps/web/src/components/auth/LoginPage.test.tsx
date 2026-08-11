import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({ getProviders: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.PropsWithChildren<{ href: string }>) => React.createElement('a', props, children) }))

import { LoginPage } from './LoginPage'

describe('LoginPage', () => {
  it('does not render OAuth entry points when used for administrator sign-in', () => {
    const html = renderToStaticMarkup(<LoginPage adminLogin />)

    expect(html).toContain('Sign in')
    expect(html).not.toContain('Sign in with Google')
    expect(html).not.toContain('Sign in with GitHub')
    expect(html).not.toContain('Create a free account')
    expect(html).not.toContain('Forgot password?')
    expect(html).toContain('Administrator access is invitation-only.')
  })
})
