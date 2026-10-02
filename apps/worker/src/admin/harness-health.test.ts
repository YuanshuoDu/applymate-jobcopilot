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
    expect(health.flags.AGENT_INTERACTIVE_DISCOVERY_TASK_GRAPH).toMatchObject({
      enabled: false,
      defaultEnabled: false,
      fallback: 'legacy',
    })
    expect(Object.values(health.flags).every((flag) => flag.enabled === false)).toBe(true)
  })
})
