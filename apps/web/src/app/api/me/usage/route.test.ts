import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), queryRaw: vi.fn(), transaction: vi.fn(), tenantContext: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.tenantContext }))
import { GET } from './route'

describe('GET /api/me/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
    mocks.requireAuth.mockResolvedValue({ userId: 'signed-in-user' })
    mocks.queryRaw.mockResolvedValue([])
    mocks.transaction.mockImplementation((work: (tx: { $queryRaw: typeof mocks.queryRaw }) => Promise<unknown>) => work({ $queryRaw: mocks.queryRaw }))
    mocks.tenantContext.mockImplementation((_userId: string, work: () => Promise<unknown>) => work())
  })
  afterEach(() => vi.useRealTimers())

  it('rejects unauthenticated requests without reading usage', async () => {
    mocks.requireAuth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await GET(new NextRequest('http://localhost/api/me/usage'))
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('ignores client owner selectors and binds the authenticated tenant and time window', async () => {
    const response = await GET(new NextRequest('http://localhost/api/me/usage?days=7&userId=other-user'))
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(mocks.tenantContext).toHaveBeenCalledWith('signed-in-user', expect.any(Function))
    const statement = mocks.queryRaw.mock.calls[0][0]
    expect(statement.values).toEqual(['signed-in-user', new Date('2026-10-22T00:00:00Z'), new Date('2026-10-28T12:00:00Z')])
    expect(statement.text).toMatch(/WHERE user_id = \$1/)
    expect(statement.text).toMatch(/created_at >= \(\$2::timestamptz AT TIME ZONE 'UTC'\)/)
    expect(statement.text).toMatch(/created_at < \(\$3::timestamptz AT TIME ZONE 'UTC'\)/)
    expect(statement.text).toContain("feature_key <> 'providerTest'")
    expect(statement.text).toContain("status IN ('success', 'error')")
    expect(JSON.stringify(payload)).not.toContain('other-user')
    expect(payload.ownerId).toBe('signed-in-user')
    expect(payload.daily).toHaveLength(7)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('defaults to 30 days and returns only aggregate usage fields', async () => {
    mocks.queryRaw.mockResolvedValue([{ date: '2026-10-28', provider: 'minimax', model: 'MiniMax-M3', calls: BigInt('2'), inputTokens: BigInt('90'), outputTokens: BigInt('10') }])
    const response = await GET(new NextRequest('http://localhost/api/me/usage'))
    const payload = await response.json()
    expect(payload.days).toBe(30)
    expect(payload.from).toBe('2026-09-29T00:00:00.000Z')
    expect(payload.summary).toEqual({ calls: 2, inputTokens: 90, outputTokens: 10, totalTokens: 100 })
    expect(Object.keys(payload).sort()).toEqual(['daily', 'days', 'from', 'models', 'ownerId', 'summary', 'timezone', 'to'])
    expect(JSON.stringify(payload)).not.toMatch(/cost|quality|successRate|userId|featureKey|errorCode/)
  })

  it.each(['0', '365', '-7', 'foo', '', '7&days=30'])('rejects invalid days=%s before querying storage', async days => {
    const response = await GET(new NextRequest(`http://localhost/api/me/usage?days=${days}`))
    expect(response.status).toBe(400)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it('returns a private 503 when storage fails, with no fake empty metrics or internal error', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('private database URL and SQL'))
    const response = await GET(new NextRequest('http://localhost/api/me/usage?days=7'))
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'Usage data is temporarily unavailable' })
  })
})
