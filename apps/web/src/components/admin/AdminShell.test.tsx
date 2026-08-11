import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./AdminShell.tsx', import.meta.url)), 'utf8')

describe('admin shell account controls', () => {
  it('provides an explicit Auth.js logout action that returns to admin login', () => {
    expect(source).toContain("import { signOut } from 'next-auth/react'")
    expect(source).toContain("signOut({ callbackUrl: '/login?callbackUrl=%2Fadmin' })")
    expect(source).toContain('aria-label="Sign out"')
  })

  it('does not prefetch admin routes from the persistent shell', () => {
    expect(source).toContain('<Link prefetch={false} href="/admin"')
    expect(source).toContain('<a key={item.href} href={item.href}')
    expect(source).toContain("aria-current={active ? 'page' : undefined}")
    expect(source).toContain('<Link prefetch={false} key={item.id}')
  })
})
