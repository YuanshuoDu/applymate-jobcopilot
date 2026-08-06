import { describe, expect, it } from 'vitest'
import { providerHealthLabel, routeLabel } from './AIPage'

describe('admin AI view model', () => {
  it('summarizes credential status without exposing a key', () => {
    expect(providerHealthLabel({ credentialConfigured: true, enabled: true })).toBe('Ready')
    expect(providerHealthLabel({ credentialConfigured: false, enabled: true })).toBe('Credential missing')
  })
  it('formats route defaults and fallback', () => {
    expect(routeLabel({ defaultProvider: 'minimax', defaultModel: 'MiniMax-M3', fallbackProvider: 'deepseek', fallbackModel: 'deepseek-v4-pro' })).toBe('minimax/MiniMax-M3 → deepseek/deepseek-v4-pro')
  })
})
