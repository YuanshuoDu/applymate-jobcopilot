import { describe, expect, it } from 'vitest'
import { toAiProviderDto, validateAiModel, validateAiProvider, validateAiRoute } from './ai'

describe('admin AI configuration validation', () => {
  it('returns provider metadata without a secret value', () => {
    expect(toAiProviderDto({ id: 'provider_1', key: 'minimax', displayName: 'MiniMax', apiBase: 'https://api.minimax.io/v1', secretRef: 'MINIMAX_API_KEY', credentialConfigured: true, enabled: true, version: 2, models: [] })).toEqual({ id: 'provider_1', key: 'minimax', displayName: 'MiniMax', apiBase: 'https://api.minimax.io/v1', secretRef: 'MINIMAX_API_KEY', credentialConfigured: true, enabled: true, version: 2, models: [] })
  })

  it('rejects unsafe provider and model metadata', () => {
    expect(() => validateAiProvider({ key: 'bad key', displayName: 'x', apiBase: 'not-url' })).toThrow()
    expect(() => validateAiModel({ model: '', label: 'Model', tier: 'standard', priceIn: 0, priceOut: 0, contextK: 128 })).toThrow()
  })

  it('requires active-compatible route targets and allows an explicit fallback', () => {
    const available = new Set(['minimax/MiniMax-M3', 'deepseek/deepseek-v4-pro'])
    expect(validateAiRoute({ featureKey: 'jobScoring', defaultProvider: 'minimax', defaultModel: 'MiniMax-M3', fallbackProvider: 'deepseek', fallbackModel: 'deepseek-v4-pro' }, available)).toMatchObject({ featureKey: 'jobScoring', fallbackProvider: 'deepseek' })
    expect(() => validateAiRoute({ featureKey: 'jobScoring', defaultProvider: 'openai', defaultModel: 'gpt-5.5' }, available)).toThrow('active model')
  })
})
