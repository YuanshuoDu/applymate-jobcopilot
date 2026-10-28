import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), findMany: vi.fn(), transaction: vi.fn(), tenantContext: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.tenantContext }))
import { GET } from './route'

const request = (query = '') => new NextRequest('http://localhost/api/me/activity' + query)

describe('GET /api/me/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'signed-in-user' })
    mocks.findMany.mockResolvedValue([])
    mocks.transaction.mockImplementation((work: (tx: { activity: { findMany: typeof mocks.findMany } }) => Promise<unknown>) =>
      work({ activity: { findMany: mocks.findMany } }))
    mocks.tenantContext.mockImplementation((_userId: string, work: () => Promise<unknown>) => work())
  })

  it.each([401, 403])('returns the authentication failure %i without reading activity', async status => {
    mocks.requireAuth.mockResolvedValue(NextResponse.json({ error: 'Not authorized' }, { status }))
    const response = await GET(request())
    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.tenantContext).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('binds the authenticated owner in the tenant context and selects only the latest 12 fields', async () => {
    const response = await GET(request('?userId=other-user&limit=100&jobId=foreign-job'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.requireAuth).toHaveBeenCalledWith(expect.any(NextRequest))
    expect(mocks.tenantContext).toHaveBeenCalledWith('signed-in-user', expect.any(Function))
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: 'signed-in-user' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 12,
      select: { id: true, text: true, createdAt: true },
    })
    expect(await response.json()).toEqual({ ownerId: 'signed-in-user', items: [] })
  })

  it('returns only own records and explicitly projects fields, preserving text verbatim', async () => {
    const rows = [
      { id: 'entry-a', userId: 'signed-in-user', text: 'User-authored <text> [Auditor] content', createdAt: new Date('2026-10-28T10:00:00Z'), job: { role: 'PRIVATE ROLE' }, color: '#f00' },
      { id: 'entry-b', userId: 'other-user', text: 'FOREIGN CONTENT', createdAt: new Date('2026-10-28T10:01:00Z'), job: { role: 'FOREIGN ROLE' }, color: '#f00' },
    ]
    // Model the owner predicate; deliberately return extra fields to test the final DTO boundary.
    mocks.findMany.mockImplementation(async ({ where }: { where: { userId: string } }) => rows.filter(row => row.userId === where.userId))
    const response = await GET(request('?userId=other-user'))
    const data = await response.json()
    expect(data).toEqual({ ownerId: 'signed-in-user', items: [{ id: 'entry-a', text: 'User-authored <text> [Auditor] content', createdAt: '2026-10-28T10:00:00.000Z' }] })
    expect(JSON.stringify(data)).not.toMatch(/other-user|FOREIGN|PRIVATE ROLE|color|job/)
  })

  it('preserves distinct rows even if their user-visible text and timestamps match', async () => {
    const createdAt = new Date('2026-10-28T10:00:00Z')
    mocks.findMany.mockResolvedValue([{ id: 'b', text: 'Saved a job', createdAt }, { id: 'a', text: 'Saved a job', createdAt }])
    const response = await GET(request())
    expect((await response.json()).items.map((row: { id: string }) => row.id)).toEqual(['b', 'a'])
  })

  it('returns a private 503 rather than a fabricated empty activity list on storage failure', async () => {
    mocks.findMany.mockRejectedValue(new Error('private database error'))
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'Activity is temporarily unavailable' })
  })

  it('also gives a private 503 if authentication or tenant setup throws', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error('private auth error'))
    const authResponse = await GET(request())
    expect(authResponse.status).toBe(503)
    expect(authResponse.headers.get('Cache-Control')).toBe('no-store')
    expect(await authResponse.json()).toEqual({ error: 'Activity is temporarily unavailable' })
    expect(mocks.findMany).not.toHaveBeenCalled()

    mocks.tenantContext.mockImplementationOnce(() => { throw new Error('private tenant error') })
    const tenantResponse = await GET(request())
    expect(tenantResponse.status).toBe(503)
    expect(tenantResponse.headers.get('Cache-Control')).toBe('no-store')
    expect(await tenantResponse.json()).toEqual({ error: 'Activity is temporarily unavailable' })
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
