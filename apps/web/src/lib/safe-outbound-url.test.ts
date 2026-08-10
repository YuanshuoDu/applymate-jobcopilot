import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
const pinnedFetch = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({ default: { lookup } }))
vi.mock('@jobcopilot/shared', async () => {
  const actual = await vi.importActual<typeof import('@jobcopilot/shared')>('@jobcopilot/shared')
  return { ...actual, pinnedFetch }
})

describe('safe outbound URL fetches', () => {
  beforeEach(() => {
    lookup.mockReset()
    pinnedFetch.mockReset()
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
    pinnedFetch.mockResolvedValue(new Response('0123456789'))
    const { fetchExternalText } = await import('./safe-outbound-url')

    await expect(fetchExternalText('https://jobs.example.test/posting', {}, 5)).resolves.toBeNull()
    expect(pinnedFetch).toHaveBeenCalledWith('https://jobs.example.test/posting', expect.objectContaining({ redirect: 'error' }))
  })
})
