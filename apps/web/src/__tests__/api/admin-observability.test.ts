import { describe, expect, it } from 'vitest'

describe('GET /api/admin/observability', () => {
  it('retires the legacy unauthenticated endpoint', async () => {
    const { GET } = await import('@/app/api/admin/observability/route')
    const response = GET()
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
  })
})
