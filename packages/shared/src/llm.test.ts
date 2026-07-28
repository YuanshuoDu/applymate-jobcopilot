/**
 * Smoke tests to ensure LLM exports are present in shared package.
 * These tests exist to prevent the exports from being accidentally removed.
 * If they fail, check packages/shared/src/index.ts — the re-exports may have been dropped.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { callLlm, loadWorkerAiConfig, callLlmText, closeSharedPool } from './index.js'

describe('shared/llm exports — existence guards', () => {
  afterEach(() => vi.restoreAllMocks())

  it('callLlm is a function', () => {
    expect(typeof callLlm).toBe('function')
  })

  it('loadWorkerAiConfig is a function', () => {
    expect(typeof loadWorkerAiConfig).toBe('function')
  })

  it('callLlmText is a function', () => {
    expect(typeof callLlmText).toBe('function')
  })

  it('closeSharedPool is a function', () => {
    expect(typeof closeSharedPool).toBe('function')
  })

  it('calls MiniMax M3 with the current completion-token API and preserves adaptive thinking', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"done"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    })))

    await callLlm([{ role: 'user', content: 'Return one JSON action.' }], {
      provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', thinking: 'adaptive',
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'MiniMax-M3', max_completion_tokens: 4096, thinking: { type: 'adaptive' },
    })
    expect(JSON.parse(String(request.body))).not.toHaveProperty('max_tokens')
    expect(JSON.parse(String(request.body))).not.toHaveProperty('reasoning_split')
  })
})
