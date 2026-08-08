import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('GET /api/admin/observability', () => {
  beforeEach(() => vi.resetModules())

  it('returns not found because the legacy endpoint is retired', async () => {
    const { GET } = await import('./route')
    const response = GET()
    expect(response.status).toBe(404)
  })

  it('does not expose a cacheable legacy response', async () => {
    const { GET } = await import('./route')
    const response = GET()
    expect(response.headers.get('Cache-Control')).not.toBe('public')
  })
})
