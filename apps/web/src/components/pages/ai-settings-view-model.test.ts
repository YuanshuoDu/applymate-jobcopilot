import { describe, expect, it } from 'vitest'

import { customConfigError, hasIncompleteCustomConfig } from './ai-settings-view-model'

describe('AI settings custom provider model', () => {
  it('accepts a non-empty model and HTTPS endpoint', () => {
    expect(customConfigError({ provider: 'custom', model: 'llama-3.3', apiBase: 'https://llm.example.test/v1' })).toBeNull()
  })

  it('rejects missing, insecure, or malformed endpoints', () => {
    expect(customConfigError({ provider: 'custom', model: 'llama-3.3', apiBase: '' })).toContain('endpoint')
    expect(customConfigError({ provider: 'custom', model: 'llama-3.3', apiBase: 'http://llm.example.test/v1' })).toContain('HTTPS')
    expect(customConfigError({ provider: 'custom', model: '', apiBase: 'https://llm.example.test/v1' })).toContain('model ID')
  })

  it('flags only incomplete custom feature configurations', () => {
    expect(hasIncompleteCustomConfig({ scoring: { provider: 'openai', model: 'gpt-5.5' } })).toBe(false)
    expect(hasIncompleteCustomConfig({ agent: { provider: 'custom', model: 'llama-3.3', apiBase: '' } })).toBe(true)
    expect(hasIncompleteCustomConfig({ agent: null })).toBe(false)
  })
})
