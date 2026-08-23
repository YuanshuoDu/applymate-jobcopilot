import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findRole: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    adminRole: { findUnique: mocks.findRole },
  },
}))

import type { PlatformIntegrationStatus } from './integration-status'
import { EXPECTED_MIGRATIONS, getDeploymentReadiness } from './deployment-readiness'

function integrations(overrides: Partial<PlatformIntegrationStatus['infrastructure']> = {}): PlatformIntegrationStatus {
  return {
    ai: { providers: {} as PlatformIntegrationStatus['ai']['providers'] },
    discovery: { adzuna: false, rapidapi: false, cleanjobdata: false },
    oauth: { google: false, github: false },
    messaging: { resend: false },
    infrastructure: {
      database: true,
      redis: true,
      workerControl: true,
      workerControlUrl: true,
      workerControlSecret: true,
      ...overrides,
    },
    privacy: { usageAnalytics: true, aiTraining: false, coverLetterRetention: true },
  }
}

const readyProbes = {
  database: async () => 'ready' as const,
  redis: async () => 'ready' as const,
  worker: async () => ({ state: 'ready' as const, workerState: 'running' as const }),
  rls: async () => ({ state: 'ready' as const, runtimeConfigured: true, candidateRole: 'applymate_candidate', missingTables: [] }),
  audit: async () => ({ state: 'ready' as const, hashTrigger: true, checkpointTable: true, secretConfigured: true }),
}

describe('deployment readiness', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://readiness.test/db')
    mocks.queryRaw.mockReset()
    mocks.findRole.mockReset()
  })

  it('reports ready when required migrations, role permission, actor permission, and worker control are ready', async () => {
    mocks.queryRaw.mockResolvedValue(EXPECTED_MIGRATIONS.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null })))
    mocks.findRole.mockResolvedValue({ permissions: ['users.read', 'users.update_preferences'] })

    const readiness = await getDeploymentReadiness({ permissions: ['users.update_preferences'] }, integrations(), readyProbes)

    expect(readiness).toMatchObject({
      candidateSettings: {
        migrations: { state: 'ready', missing: [], pending: [], rolledBack: [] },
        superAdminPermission: 'ready',
        currentActorPermission: 'ready',
      },
      infrastructure: { database: 'ready', redis: 'ready' },
      workerControl: { state: 'ready', reachability: 'ready', urlConfigured: true, secretConfigured: true, redisConfigured: true, workerState: 'running' },
      security: { rls: { state: 'ready' }, webauthn: { state: 'missing' }, audit: { state: 'ready' } },
    })
  })

  it('identifies missing migrations and explicit permissions without returning secrets', async () => {
    mocks.queryRaw.mockResolvedValue([
      { migration_name: '20260603170000_add_ai_budget', finished_at: new Date(), rolled_back_at: null },
    ])
    mocks.findRole.mockResolvedValue({ permissions: ['users.read'] })

    const readiness = await getDeploymentReadiness({ permissions: ['users.read'] }, integrations({ workerControl: false, workerControlUrl: false, workerControlSecret: false }), readyProbes)

    expect(readiness.candidateSettings).toMatchObject({
      migrations: { state: 'missing', missing: expect.arrayContaining(['20260807110000_add_user_preferences_admin_permission']) },
      superAdminPermission: 'missing',
      currentActorPermission: 'missing',
    })
    expect(readiness.workerControl).toMatchObject({ state: 'missing', reachability: 'missing', urlConfigured: false, secretConfigured: false, redisConfigured: true })
    expect(JSON.stringify(readiness)).not.toContain('worker-secret')
  })

  it('fails closed to unavailable status when migration or role checks cannot be read', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('database password leaked'))
    mocks.findRole.mockRejectedValue(new Error('database password leaked'))

    const readiness = await getDeploymentReadiness({ permissions: ['users.update_preferences'] }, integrations(), readyProbes)

    expect(readiness.candidateSettings).toMatchObject({
      migrations: { state: 'unavailable', missing: [], pending: [], rolledBack: [] },
      superAdminPermission: 'unavailable',
      currentActorPermission: 'ready',
    })
    expect(JSON.stringify(readiness)).not.toContain('password')
  })
})
