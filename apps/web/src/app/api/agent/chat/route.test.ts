import { describe, expect, it } from 'vitest'

describe('retired agent chat route', () => {
  it('returns a typed canonical Session message link without running chat work', async () => {
    const { POST } = await import('./route')
    const response = await POST()
    const body = await response.json()

    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({
      error: {
        code: 'agent_chat_route_retired',
        message: 'Agent chat is now handled by the canonical Session message command.',
      },
      link: {
        rel: 'canonical',
        method: 'POST',
        href: '/api/agent/sessions/:id/messages',
      },
    })
  })
})
