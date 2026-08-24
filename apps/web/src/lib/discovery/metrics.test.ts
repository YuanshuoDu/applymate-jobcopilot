import { describe, expect, it, vi } from 'vitest'

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { discoveryOptimizationEvent: { create } } }))

import { recordDiscoveryOptimization } from './metrics'

describe('discovery optimization metrics', () => {
  it('does not persist in test mode', async () => {
    await recordDiscoveryOptimization({ eventType: 'cache_hit', credentialScope: 'platform', requestsAvoided: 1 })
    expect(create).not.toHaveBeenCalled()
  })
})
