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
import { getDeploymentReadiness } from './deployment-readiness'

function integrations(overrides: Partial<PlatformIntegrationStatus['infrastructure']> = {}): PlatformIntegrationStatus {
  return {
    ai: { providers: {} as PlatformIntegrationStatus['ai']['providers'] },
    discovery: { adzuna: false, rapidapi: false },
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

describe('deployment readiness', () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset()
    mocks.findRole.mockReset()
  })

  it('reports ready when required migrations, role permission, actor permission, and worker control are ready', async () => {
    mocks.queryRaw.mockResolvedValue([
      { migration_name: '20260603170000_add_ai_budget', finished_at: new Date(), rolled_back_at: null },
      { migration_name: '20260807110000_add_user_preferences_admin_permission', finished_at: new Date(), rolled_back_at: null },
    ])
    mocks.findRole.mockResolvedValue({ permissions: ['users.read', 'users.update_preferences'] })

    const readiness = await getDeploymentReadiness({ permissions: ['users.update_preferences'] }, integrations())

    expect(readiness).toEqual({
      candidateSettings: {
        migrations: { state: 'ready', missing: [] },
        superAdminPermission: 'ready',
        currentActorPermission: 'ready',
      },
      workerControl: { state: 'ready', urlConfigured: true, secretConfigured: true, redisConfigured: true },
    })
  })

  it('identifies missing migrations and explicit permissions without returning secrets', async () => {
    mocks.queryRaw.mockResolvedValue([
      { migration_name: '20260603170000_add_ai_budget', finished_at: new Date(), rolled_back_at: null },
    ])
    mocks.findRole.mockResolvedValue({ permissions: ['users.read'] })

    const readiness = await getDeploymentReadiness({ permissions: ['users.read'] }, integrations({ workerControl: false, workerControlUrl: false, workerControlSecret: false }))

    expect(readiness.candidateSettings).toEqual({
      migrations: { state: 'missing', missing: ['20260807110000_add_user_preferences_admin_permission'] },
      superAdminPermission: 'missing',
      currentActorPermission: 'missing',
    })
    expect(readiness.workerControl).toEqual({ state: 'missing', urlConfigured: false, secretConfigured: false, redisConfigured: true })
    expect(JSON.stringify(readiness)).not.toContain('worker-secret')
  })

  it('fails closed to unavailable status when migration or role checks cannot be read', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('database password leaked'))
    mocks.findRole.mockRejectedValue(new Error('database password leaked'))

    const readiness = await getDeploymentReadiness({ permissions: ['users.update_preferences'] }, integrations())

    expect(readiness.candidateSettings).toEqual({
      migrations: { state: 'unavailable', missing: [] },
      superAdminPermission: 'unavailable',
      currentActorPermission: 'ready',
    })
    expect(JSON.stringify(readiness)).not.toContain('password')
  })
})
