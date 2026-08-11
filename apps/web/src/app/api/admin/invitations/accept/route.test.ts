import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ safeAuth: vi.fn() }))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: vi.fn() }))

describe('POST /api/admin/invitations/accept', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.safeAuth.mockReset()
  })

  it('rejects invitation acceptance on the public application host before reading a session', async () => {
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('https://applymate.site/api/admin/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'a'.repeat(20) }),
    }))

    expect(response.status).toBe(404)
    expect(mocks.safeAuth).not.toHaveBeenCalled()
  })
})
