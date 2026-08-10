import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({ default: { lookup } }))

describe('safe outbound URL fetches', () => {
  beforeEach(() => {
    lookup.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/admin',
    'http://localhost/admin',
    'http://user:pass@example.com/private',
  ])('rejects private or credential-bearing URL %s', async rawUrl => {
    const { validateExternalUrl } = await import('./safe-outbound-url')
    await expect(validateExternalUrl(rawUrl)).resolves.toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects a public hostname that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }])
    const { validateExternalUrl } = await import('./safe-outbound-url')

    await expect(validateExternalUrl('https://jobs.example.test/posting')).resolves.toBeNull()
  })

  it('caps response size and disables redirects', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const fetchMock = vi.fn().mockResolvedValue(new Response('0123456789'))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchExternalText } = await import('./safe-outbound-url')

    await expect(fetchExternalText('https://jobs.example.test/posting', {}, 5)).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
  })
})
