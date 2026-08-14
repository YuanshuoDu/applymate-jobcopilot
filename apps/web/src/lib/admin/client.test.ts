import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminMutationHeaders } from './client'

describe('adminMutationHeaders', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('includes same-origin and idempotency headers', () => {
    vi.stubGlobal('window', { location: { origin: 'https://admin.applymate.site' } })
    const headers = adminMutationHeaders() as Record<string, string>
    expect(headers.Origin).toBe('https://admin.applymate.site')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('omits JSON content type for bodyless mutations', () => {
    vi.stubGlobal('window', { location: { origin: 'https://admin.applymate.site' } })
    expect((adminMutationHeaders({ json: false }) as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})
