import { afterEach, describe, expect, it, vi } from 'vitest'

const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)))
const recordAiUsage = vi.hoisted(() => vi.fn())
vi.mock('@jobcopilot/shared/pinned-outbound', () => ({ pinnedFetch }))
vi.mock('@/lib/ai-usage', () => ({ aiUsageErrorCode: () => 'provider_error', recordAiUsage }))

vi.mock('@/lib/db', () => ({ db: {} }))

import {
  APPLYMATE_BACKING,
  DEFAULT_AI_CONFIG,
  MODEL_CATALOGUE,
  modelChat,
  modelChatStream,
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
})
