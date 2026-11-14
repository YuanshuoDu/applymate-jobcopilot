import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pinnedFetch: vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)),
  recordAiUsage: vi.fn(),
}))
vi.mock('@jobcopilot/shared/pinned-outbound', () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock('@/lib/ai-usage', () => ({ aiUsageErrorCode: () => 'provider_error', recordAiUsage: mocks.recordAiUsage }))
vi.mock('@/lib/db', () => ({ db: {} }))

import { modelChat, prepareReservedModelTransport } from './model-router'

const messages = [{ role: 'user' as const, content: 'Return a short JSON object.' }]
const routes = [
  { provider: 'openai' as const, model: 'gpt-5.5' },
  { provider: 'deepseek' as const, model: 'deepseek-v4-pro' },
  { provider: 'qwen' as const, model: 'qwen3.7-plus' },
  { provider: 'zhipu' as const, model: 'glm-5.1' },
  { provider: 'kimi' as const, model: 'kimi-k2.5' },
]

beforeEach(() => { mocks.pinnedFetch.mockClear(); mocks.recordAiUsage.mockClear() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('reserved OpenAI-compatible transport', () => {
  it.each(routes)('supports $provider BYOK with the actual requested output cap', async route => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 9, completion_tokens: 4 },
    })))
    const transport = prepareReservedModelTransport({ ...route, apiKey: 'user-secret' })

    await expect(transport.chat(messages, 64)).resolves.toMatchObject({ provider: route.provider, model: route.model, outputTokens: 4 })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: route.model, max_tokens: 64 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(transport.credentialSource).toBe('user')
  })

  it('does not retry a provider error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporarily unavailable', { status: 503 }))
    const transport = prepareReservedModelTransport({ provider: 'openai', model: 'gpt-5.5', apiKey: 'user-secret' })

    await expect(transport.chat(messages, 64)).rejects.toThrow('openai API error 503')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps the Gate abort listener through body parsing after headers arrive', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), { once: true })
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const controller = new AbortController()
    const transport = prepareReservedModelTransport({ provider: 'openai', model: 'gpt-5.5', apiKey: 'user-secret' })
    const pending = transport.chat(messages, 64, controller.signal)
    const rejected = expect(pending).rejects.toThrow('body cancelled')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort(new Error('body cancelled'))

    await rejected
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps the Gate timeout through body parsing and sends only once', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('timed out')), { once: true })
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const transport = prepareReservedModelTransport({ provider: 'openai', model: 'gpt-5.5', apiKey: 'user-secret' })
    const pending = transport.chat(messages, 64)
    const rejected = expect(pending).rejects.toBeTruthy()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(120_000)

    await rejected
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves the ordinary legacy model call path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'legacy response' } }], usage: { prompt_tokens: 3, completion_tokens: 2 },
    })))

    await expect(modelChat(messages, { provider: 'openai', model: 'gpt-5.5', apiKey: 'user-secret' }))
      .resolves.toMatchObject({ text: 'legacy response', provider: 'openai' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
