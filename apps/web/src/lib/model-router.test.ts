import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import {
  APPLYMATE_BACKING,
  DEFAULT_AI_CONFIG,
  MODEL_CATALOGUE,
  modelChat,
  resolveConfig,
} from './model-router'

describe('model catalogue and MiniMax compatibility', () => {
  afterEach(() => vi.restoreAllMocks())

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
  })

  it('reports an empty final answer with the provider finish reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '' } }],
    })))

    await expect(modelChat([{ role: 'user', content: 'Return JSON.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key',
    })).rejects.toThrow('minimax returned no final content (finish reason: length)')
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
})
