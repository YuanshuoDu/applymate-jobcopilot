import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import { APPLYMATE_BACKING, DEFAULT_AI_CONFIG, modelChat } from './model-router'

describe('modelChat MiniMax M3 compatibility', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses M3 completion tokens, reasoning split, and an explicit thinking policy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"pass"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    })))

    const result = await modelChat([{ role: 'user', content: 'Return JSON.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', thinking: 'disabled',
    }, 2048)

    expect(result.text).toBe('{"verdict":"pass"}')
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'MiniMax-M3', max_completion_tokens: 2048, reasoning_split: true,
      thinking: { type: 'disabled' },
    })
    expect(JSON.parse(String(request.body))).not.toHaveProperty('max_tokens')
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
    expect(DEFAULT_AI_CONFIG).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' })
    expect(APPLYMATE_BACKING).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' })
  })
})
