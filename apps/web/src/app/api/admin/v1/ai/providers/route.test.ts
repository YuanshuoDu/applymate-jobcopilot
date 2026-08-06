import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), requireAdmin: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { aiProviderConfig: { findMany: mocks.findMany } } }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))

describe('GET /api/admin/v1/ai/providers', () => {
  beforeEach(() => { vi.resetModules(); mocks.findMany.mockReset(); mocks.requireAdmin.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'platform_admin' }) })
  it('returns provider metadata and never returns credential values', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'provider_1', key: 'minimax', displayName: 'MiniMax', apiBase: 'https://api.minimax.io/v1', secretRef: 'MINIMAX_API_KEY', credentialConfigured: true, enabled: true, version: 1, models: [{ id: 'model_1', model: 'MiniMax-M3', label: 'MiniMax M3', tier: 'standard', priceIn: 0.6, priceOut: 2.4, contextK: 512, active: true }], apiKey: 'must-not-leak' }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ai/providers') as never)
    const body = await response.json()
    expect(body.items[0]).toMatchObject({ key: 'minimax', credentialConfigured: true })
    expect(JSON.stringify(body)).not.toContain('must-not-leak')
  })
})
