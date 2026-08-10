import { describe, expect, it } from 'vitest'
import type { DeploymentReadiness } from './deployment-readiness'
import { readinessFailures } from './production-readiness-report'

const baseReadiness: DeploymentReadiness = {
  candidateSettings: {
    migrations: { state: 'ready', missing: [] },
    superAdminPermission: 'ready',
    currentActorPermission: 'ready',
  },
  infrastructure: { database: 'ready', redis: 'ready' },
  workerControl: { state: 'ready', urlConfigured: true, secretConfigured: true, redisConfigured: true },
  security: {
    webauthn: { state: 'ready', originConfigured: true, rpIdConfigured: true, adminAppUrlConfigured: true },
    rls: { state: 'ready', runtimeConfigured: true, candidateRole: 'applymate_candidate', missingTables: [] },
    audit: { state: 'ready', hashTrigger: true, checkpointTable: true, secretConfigured: true },
  },
}

describe('production readiness report', () => {
  it('returns no failures for a complete deployment', () => {
    expect(readinessFailures(baseReadiness)).toEqual([])
  })

  it('returns stable safe keys for blocked checks', () => {
    expect(readinessFailures({
      ...baseReadiness,
      infrastructure: { database: 'unavailable', redis: 'missing' },
      workerControl: { ...baseReadiness.workerControl, state: 'unavailable' },
    })).toEqual(['database', 'redis', 'worker_control'])
  })
})
