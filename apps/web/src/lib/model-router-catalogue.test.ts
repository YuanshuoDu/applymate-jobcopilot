import { describe, expect, it } from 'vitest'
import { APPLYMATE_BACKING, DEFAULT_AI_CONFIG, MODEL_CATALOGUE, PROVIDER_LABELS, catalogueByProvider,
  withMiniMaxThinking } from './model-router-catalogue'

describe('model-router catalogue', () => {
  it('keeps all curated providers and the OpenAI model set available', () => {
    expect(new Set(MODEL_CATALOGUE.map(option => option.provider))).toEqual(new Set(Object.keys(PROVIDER_LABELS)))
    expect(catalogueByProvider().openai.map(option => option.model)).toEqual([
      'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    ])
  })

  it('preserves the platform default and limits thinking changes to MiniMax M3', () => {
    expect(DEFAULT_AI_CONFIG).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3' })
    expect(APPLYMATE_BACKING.thinking).toBe('adaptive')
    expect(withMiniMaxThinking(APPLYMATE_BACKING, 'disabled')).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', thinking: 'disabled' })
    const other = { provider: 'openai' as const, model: 'gpt-5.5' }
    expect(withMiniMaxThinking(other, 'disabled')).toBe(other)
  })
})
