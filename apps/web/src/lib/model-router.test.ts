import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))
const recordAiUsage = vi.hoisted(() => vi.fn())
const anthropicClient = vi.hoisted(() => ({ constructor: vi.fn(), create: vi.fn() }))
vi.mock('@jobcopilot/shared/pinned-outbound', () => ({ pinnedFetch }))
vi.mock('@/lib/ai-usage', () => ({ aiUsageErrorCode: () => 'provider_error', recordAiUsage }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { create: anthropicClient.create }
  constructor(options: unknown) { anthropicClient.constructor(options) }
} }))

vi.mock('@/lib/db', () => ({ db: {} }))

import {
  APPLYMATE_BACKING,
  DEFAULT_AI_CONFIG,
  MODEL_CATALOGUE,
  estimateAiCostUsd,
  modelChat,
  modelChatStream,
  prepareReservedModelTransport,
  resolveConfig,
} from './model-router'

describe('model catalogue and MiniMax compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uses MiniMax M3 completion tokens and adaptive reasoning for the current default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"pass"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    })))

    const result = await modelChat([{ role: 'user', content: 'Return JSON.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    }, 2048)

    expect(result.text).toBe('{"verdict":"pass"}')
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'MiniMax-M3', max_completion_tokens: 2048, reasoning_split: true,
    })
    expect(JSON.parse(String(request.body))).not.toHaveProperty('max_tokens')
    expect(JSON.parse(String(request.body))).toMatchObject({ thinking: { type: 'adaptive' } })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/chat/completions')
  })

  it.each(['success', 'error'] as const)('preserves an explicit no-credit owner context for a fallback %s', async status => {
    recordAiUsage.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(status === 'success'
      ? new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }))
      : new Response('provider unavailable', { status: 503 }))
    const call = modelChat([{ role: 'user', content: 'Ping' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    }, 100, { userId: 'owner-1', featureKey: 'coverLetter', runtime: 'web', chargeBudget: false })
    if (status === 'success') await expect(call).resolves.toMatchObject({ text: 'ok' })
    else await expect(call).rejects.toThrow('minimax API error 503')
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1', featureKey: 'coverLetter', runtime: 'web', chargeBudget: false, status,
    }))
  })

  it('requests and records usage for OpenAI-compatible streams', async () => {
    recordAiUsage.mockClear()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      'data: [DONE]',
      '',
    ].join('\n')))

    const chunks: string[] = []
    for await (const chunk of modelChatStream([{ role: 'user', content: 'Say hello.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    })) chunks.push(chunk)

    expect(chunks.join('')).toBe('hello')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(recordAiUsage).toHaveBeenLastCalledWith(expect.objectContaining({ inputTokens: 11, outputTokens: 7 }))
    expect(recordAiUsage.mock.calls[0][0]).not.toHaveProperty('chargeBudget')
  })

  it('records an early consumer return exactly once without charging credits or fabricating tokens', async () => {
    recordAiUsage.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"a sufficiently long first response"}}],"usage":{"prompt_tokens":11}}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      'data: [DONE]', '',
    ].join('\n')))
    const stream = modelChatStream([{ role: 'user', content: 'Say hello.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
      usageUserId: 'owner-1', usageFeatureKey: 'scoring', usageRuntime: 'web',
    })
    expect((await stream.next()).done).toBe(false)
    await stream.return(undefined)
    await stream.return(undefined)

    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1', featureKey: 'scoring', runtime: 'web', provider: 'minimax', model: 'MiniMax-M3',
      status: 'error', inputTokens: 11, outputTokens: undefined, chargeBudget: false,
    }))
  })

  it('preserves ordinary custom modelChat zero-cost telemetry outside Gate', async () => {
    recordAiUsage.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })))

    await expect(modelChat([{ role: 'user', content: 'Ping' }], {
      provider: 'custom', model: 'custom', apiBase: 'https://api.openai.com/v1', apiKey: 'test-key',
    }, 100)).resolves.toMatchObject({ text: 'ok', inputTokens: 11, outputTokens: 7, provider: 'custom', model: 'custom' })

    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom', model: 'custom', inputTokens: 11, outputTokens: 7, estimatedCostUsd: 0, status: 'success',
    }))
  })

  it('records a failed stream only once with the existing credit behavior', async () => {
    recordAiUsage.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('provider unavailable', { status: 503 }))
    const stream = modelChatStream([{ role: 'user', content: 'Say hello.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', usageUserId: 'owner-1',
    })
    await expect(stream.next()).rejects.toThrow('minimax API error 503')
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', status: 'error' }))
    expect(recordAiUsage.mock.calls[0][0]).not.toHaveProperty('chargeBudget')
  })

  it('keeps observed partial usage when a running stream throws', async () => {
    recordAiUsage.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"a sufficiently long first response"}}],"usage":{"prompt_tokens":11}}',
      'data: [DONE]', '',
    ].join('\n')))
    const stream = modelChatStream([{ role: 'user', content: 'Say hello.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', usageUserId: 'owner-1',
    })
    expect((await stream.next()).done).toBe(false)
    await expect(stream.throw(new Error('interrupted'))).rejects.toThrow('interrupted')
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1', status: 'error', inputTokens: 11, outputTokens: undefined,
    }))
    expect(recordAiUsage.mock.calls[0][0]).not.toHaveProperty('chargeBudget')
  })

  it('does not record or charge a stream closed before it is started', async () => {
    recordAiUsage.mockClear()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const stream = modelChatStream([{ role: 'user', content: 'Say hello.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', usageUserId: 'owner-1',
    })
    await stream.return(undefined)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(recordAiUsage).not.toHaveBeenCalled()
  })

  it('reports an empty final answer with the provider finish reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '' } }],
    })))

    await expect(modelChat([{ role: 'user', content: 'Return JSON.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    })).rejects.toThrow('minimax returned no final content (finish reason: length)')
  })

  it('does not propagate an upstream response body into the thrown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"private response body"}', { status: 429 }))

    const error = await modelChat([{ role: 'user', content: 'Ping' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    }).catch(value => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('minimax API error 429')
    expect((error as Error).message).not.toContain('private response body')
  })

  it('uses M3 as both platform defaults', () => {
    expect(DEFAULT_AI_CONFIG).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3' })
    expect(APPLYMATE_BACKING).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' })
  })

  it('keeps the curated provider catalogue compact, with four OpenAI options', () => {
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'openai')).toHaveLength(4)
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'anthropic')).toHaveLength(2)
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'deepseek')).toHaveLength(2)
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'minimax')).toHaveLength(2)
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'qwen')).toHaveLength(2)
    expect(MODEL_CATALOGUE.filter(m => m.provider === 'zhipu')).toHaveLength(2)
    expect(MODEL_CATALOGUE.some(m => m.provider === 'kimi' && m.defaultBase === 'https://api.moonshot.ai/v1')).toBe(true)
  })

  it('calls Kimi through Moonshot’s OpenAI-compatible endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    })))

    await expect(modelChat([{ role: 'user', content: 'Ping' }], {
      provider: 'kimi', model: 'kimi-k2.5', apiKey: 'test-key',
    })).resolves.toMatchObject({ provider: 'kimi', model: 'kimi-k2.5', text: 'ok' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.moonshot.ai/v1/chat/completions')
  })

  it('normalizes a retired saved model to its provider current model', () => {
    expect(resolveConfig({ provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' })).toMatchObject({
      provider: 'openai', model: 'gpt-5.5', apiKey: 'test-key',
    })
  })

  it('uses the curated endpoint for an internal provider even when legacy settings contain an override', () => {
    const minimaxBase = MODEL_CATALOGUE.find(option => option.provider === 'minimax' && option.model === 'MiniMax-M3')?.defaultBase

    expect(resolveConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: 'platform-key',
      apiBase: 'https://attacker.example/v1',
    })).toMatchObject({ apiBase: minimaxBase })
  })

  it('resolves MiniMax CN for the platform while ignoring a stale saved international endpoint', () => {
    vi.stubEnv('MINIMAX_REGION', 'cn')
    expect(resolveConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: 'platform-key',
      apiBase: 'https://api.minimax.io/v1',
    })).toMatchObject({ apiBase: 'https://api.minimaxi.com/v1' })
  })

  it('lets an explicit MiniMax deployment base URL win over the region selector', () => {
    vi.stubEnv('MINIMAX_BASE_URL', 'https://api.minimaxi.com/v1/')
    vi.stubEnv('MINIMAX_REGION', 'international')
    expect(resolveConfig({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'platform-key' }))
      .toMatchObject({ apiBase: 'https://api.minimaxi.com/v1' })
  })

  it('resolves MiniMax CN from a China Token Plan platform key without a region setting', () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-platform-key')
    expect(resolveConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiBase: 'https://api.minimax.io/v1',
    })).toMatchObject({ apiBase: 'https://api.minimaxi.com/v1', resolvedKey: 'sk-cp-platform-key' })
  })

  it('sends Web model calls to the China endpoint for the platform Token Plan key', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-platform-key')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    })))

    await modelChat([{ role: 'user', content: 'Ping' }], { provider: 'minimax', model: 'MiniMax-M3' })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimaxi.com/v1/chat/completions')
  })

  it('does not use a server API key for a user-controlled custom endpoint', () => {
    process.env.CUSTOM_API_KEY = 'platform-custom-secret'

    expect(resolveConfig({
      provider: 'custom',
      model: 'llama-3.3',
      apiBase: 'https://llm.example.test/v1',
    })).toMatchObject({ resolvedKey: '' })
  })

  it('keeps local custom endpoints usable in development', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    })))

    await expect(modelChat([{ role: 'user', content: 'Ping' }], {
      provider: 'custom', model: 'llama-3.3', apiBase: 'http://localhost:1234/v1', apiKey: 'test-key',
    })).resolves.toMatchObject({ provider: 'custom', model: 'llama-3.3', text: 'ok' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:1234/v1/chat/completions')
  })

  describe('reserved model transport', () => {
    const messages = [{ role: 'user' as const, content: 'Return a short JSON object.' }]

    beforeEach(() => {
      recordAiUsage.mockClear()
      anthropicClient.constructor.mockClear()
      anthropicClient.create.mockReset()
    })

    it('preflights credentials and custom endpoints before a usage reservation can start', () => {
      expect(() => prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3' })).toThrow(/unavailable|No API key/)
      expect(prepareReservedModelTransport({ provider: 'openai', model: 'gpt-5.5', apiKey: 'user-key' }))
        .toMatchObject({ provider: 'openai', model: 'gpt-5.5', credentialSource: 'user' })
      expect(() => prepareReservedModelTransport({ provider: 'custom', model: 'llama-3.3', apiBase: 'http://example.test/v1', apiKey: 'user-key' }))
        .toThrow(/endpoint/)
      expect(vi.spyOn(globalThis, 'fetch')).not.toHaveBeenCalled()
    })

    it('returns resolved provider metadata without returning the key or endpoint', async () => {
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      expect(transport).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', credentialSource: 'user' })
      expect(JSON.stringify(transport)).not.toContain('user-secret')
      expect(JSON.stringify(transport)).not.toContain('api.minimax')
    })

    it('returns actual usage without writing a legacy usage event', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 9, completion_tokens: 4 },
      })))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      await expect(transport.chat(messages, 300)).resolves.toMatchObject({ text: '{"ok":true}', inputTokens: 9, outputTokens: 4 })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ max_completion_tokens: 300 })
      expect(recordAiUsage).not.toHaveBeenCalled()
    })

    it('sends the admitted Root output allowance unchanged in the provider request body', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 4 },
      })))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      await transport.chat(messages, 64)

      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ max_completion_tokens: 64 })
      expect(recordAiUsage).not.toHaveBeenCalled()
    })

    it('preserves unknown usage and sends only once when the provider returns a retryable error', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporarily unavailable', { status: 503 }))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      await expect(transport.chat(messages, 300)).rejects.toThrow('minimax API error 503')
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(recordAiUsage).not.toHaveBeenCalled()
      expect(estimateAiCostUsd('custom', 'llama-3.3', 9, 4)).toBeNull()
    })

    it('sends once when the network fails before a response is received', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network interrupted'))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      await expect(transport.chat(messages, 300)).rejects.toThrow('network interrupted')
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(recordAiUsage).not.toHaveBeenCalled()
    })

    it('does not record unknown tokens as zero when a successful response omits usage', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })

      const result = await transport.chat(messages, 300)
      expect(result.inputTokens).toBeUndefined()
      expect(result.outputTokens).toBeUndefined()
      expect(recordAiUsage).not.toHaveBeenCalled()
    })

    it('propagates cancellation to the underlying request and stops after one send', async () => {
      const controller = new AbortController()
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
      }))
      const transport = prepareReservedModelTransport({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'user-secret' })
      const pending = transport.chat(messages, 300, controller.signal)
      controller.abort()

      await expect(pending).rejects.toBeTruthy()
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(recordAiUsage).not.toHaveBeenCalled()
    })

    it('disables Anthropic SDK retries only for reserved calls', async () => {
      anthropicClient.create.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 2 } })
      const controller = new AbortController()
      const transport = prepareReservedModelTransport({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'user-secret' })

      await expect(transport.chat(messages, 300, controller.signal)).resolves.toMatchObject({ inputTokens: 5, outputTokens: 2 })
      expect(anthropicClient.constructor).toHaveBeenCalledWith({ apiKey: 'user-secret', maxRetries: 0 })
      expect(anthropicClient.create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal })
      expect(anthropicClient.create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 300 })
      expect(anthropicClient.create).toHaveBeenCalledOnce()
      expect(recordAiUsage).not.toHaveBeenCalled()

      await modelChat(messages, { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'user-secret' })
      expect(anthropicClient.constructor).toHaveBeenLastCalledWith({ apiKey: 'user-secret' })
      expect(recordAiUsage).toHaveBeenCalledOnce()
    })

    it('keeps Anthropic reserved failures single-send while preserving legacy retry defaults', async () => {
      anthropicClient.create.mockRejectedValue(new Error('503 unavailable'))
      const transport = prepareReservedModelTransport({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'user-secret' })

      await expect(transport.chat(messages, 300)).rejects.toThrow('503 unavailable')
      expect(anthropicClient.constructor).toHaveBeenCalledWith({ apiKey: 'user-secret', maxRetries: 0 })
      expect(anthropicClient.create).toHaveBeenCalledOnce()
      expect(recordAiUsage).not.toHaveBeenCalled()
    })
  })
})
