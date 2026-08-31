import { describe, expect, it } from 'vitest'
import { workerHarnessFeatureHealth } from './harness-health.js'

describe('worker harness health', () => {
  it('reports the shared V2 safe defaults for staging', () => {
    const health = workerHarnessFeatureHealth('staging')

    expect(health).toMatchObject({
      environment: 'staging',
      source: 'safe_defaults',
      allDefaultOff: true,
    })
    expect(Object.values(health.flags)).toHaveLength(11)
    expect(Object.values(health.flags).every((flag) => flag.enabled === false)).toBe(true)
  })
})
