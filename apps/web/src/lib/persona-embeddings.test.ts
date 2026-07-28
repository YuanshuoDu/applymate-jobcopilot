import { afterEach, describe, expect, it, vi } from 'vitest'

describe('embedPersonaText', () => {
  const originalKey = process.env.OPENAI_API_KEY
  afterEach(() => { process.env.OPENAI_API_KEY = originalKey; vi.unstubAllGlobals() })

  it('does not transmit Persona content when no embedding key is configured', async () => {
    delete process.env.OPENAI_API_KEY
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { embedPersonaText } = await import('./persona-embeddings')

    await expect(embedPersonaText('private resume evidence')).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
