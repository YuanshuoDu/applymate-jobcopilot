import { describe, expect, it, vi } from 'vitest'

const requireAdminMembership = vi.hoisted(() => vi.fn())
vi.mock('@/lib/admin/authorization', () => ({ requireAdminMembership, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
vi.mock('@/components/admin/AdminShell', () => ({ AdminShell: ({ children }: { children: unknown }) => children }))

describe('admin layout', () => {
  it('redirects an unauthorized administrator to login', async () => {
    requireAdminMembership.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { default: AdminLayout } = await import('./layout')
    await expect(AdminLayout({ children: 'content' })).rejects.toThrow('redirect:/login?callbackUrl=/admin')
  })
})
