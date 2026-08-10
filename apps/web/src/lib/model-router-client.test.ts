import { describe, expect, it } from 'vitest'
import { APPLYMATE_BACKING, MODEL_CATALOGUE, PROVIDER_LABELS } from './model-router-client'

describe('browser-safe model router catalogue', () => {
  it('exposes the platform default and all configured provider labels', () => {
    expect(APPLYMATE_BACKING).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3' })
    expect(MODEL_CATALOGUE).toHaveLength(16)
    expect(Object.keys(PROVIDER_LABELS)).toHaveLength(8)
  })
})
