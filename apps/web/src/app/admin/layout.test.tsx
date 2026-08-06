import { describe, expect, it, vi } from 'vitest'

const requireAdmin = vi.hoisted(() => vi.fn())
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin }))
vi.mock('@/components/admin/AdminShell', () => ({ AdminShell: ({ children }: { children: unknown }) => children }))

describe('admin layout', () => {
  it('renders an access-denied state when the admin session is not authorized', async () => {
    requireAdmin.mockRejectedValueOnce(new Error('denied'))
    const { default: AdminLayout } = await import('./layout')
    const result = await AdminLayout({ children: 'content' })
    expect(result).toBeTruthy()
    expect(JSON.stringify(result)).toContain('Access denied')
  })
})
