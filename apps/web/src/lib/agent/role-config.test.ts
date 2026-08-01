import { describe, expect, it, vi } from 'vitest'
import type { RoleConfigMap } from './types'

vi.mock('@/lib/db', () => ({ db: {} }))

import { ROLE_DEFAULTS, roleAiConfig } from './role-config'

const fallback = { provider: 'minimax' as const, model: 'MiniMax-M3', apiKey: 'platform-key' }

function role(config: Partial<RoleConfigMap['analyst']> = {}): RoleConfigMap['analyst'] {
  return {
    provider: 'minimax', model: 'MiniMax-M3', enabled: true, systemPrompt: null,
    ...config,
  }
}

describe('Agent role model resolution', () => {
  it('uses the platform MiniMax configuration for every newly-created role', () => {
    expect(Object.values(ROLE_DEFAULTS)).toEqual(Array(6).fill({ provider: 'minimax', model: 'MiniMax-M3' }))
  })

  it('keeps a feature-level AI configuration for a keyless platform role', () => {
    const userChoice = { provider: 'openai' as const, model: 'gpt-5-mini', apiKey: 'user-key' }
    expect(roleAiConfig('analyst', role(), userChoice)).toEqual(userChoice)
  })

  it('falls back from legacy keyless Claude role defaults instead of requiring an Anthropic key', () => {
    const legacy = role({ provider: 'anthropic', model: 'claude-haiku-4-5' })
    expect(roleAiConfig('analyst', legacy, fallback)).toEqual(fallback)
  })

  it('honors a role-level model override and preserves a same-provider fallback key', () => {
    const custom = role({ model: 'MiniMax-M2.7' })
    expect(roleAiConfig('analyst', custom, fallback)).toEqual({
      provider: 'minimax', model: 'MiniMax-M2.7', apiKey: 'platform-key',
    })
  })
})
