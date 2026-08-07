import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), userFindUnique: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

import {
  canTransitionDeletionRequest,
  parseAdminSettingsPatch,
  requireSettingsAdmin,
  toAdminSettingsDto,
} from './settings-access'

describe('admin settings access', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.userFindUnique.mockReset()
    process.env.ADMIN_EMAILS = 'admin@example.com'
    delete process.env.ADMIN_USER_IDS
    mocks.requireAuth.mockResolvedValue({ userId: 'admin_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'admin_1', email: 'ADMIN@example.com' })
  })

  it('requires an explicitly allow-listed administrator', async () => {
    await expect(requireSettingsAdmin(new Request('http://localhost/admin') as never)).resolves.toEqual({
      userId: 'admin_1',
      email: 'ADMIN@example.com',
    })

    mocks.userFindUnique.mockResolvedValue({ id: 'admin_1', email: 'other@example.com' })
    await expect(requireSettingsAdmin(new Request('http://localhost/admin') as never)).resolves.toBeInstanceOf(Response)
  })

  it('returns only masked settings metadata and never serializes secret fields', () => {
    const dto = toAdminSettingsDto({
      id: 'user_1', email: 'candidate@example.com', name: 'Candidate Name', plan: 'pro',
      phone: '+353123456', location: 'Dublin', linkedin: 'linkedin.com/in/candidate', github: 'github.com/candidate',
      preferences: {
        targetRoles: 'Engineer', targetLocations: 'Dublin', salaryExpectation: '€70k',
        workAuthorization: 'EU', openToRelocation: true,
        notificationPreferences: { apply: false }, privacyPreferences: { allowAiTraining: true },
        dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
        dataDeletionRequestStatus: 'requested',
        aiSettings: { keys: { openai: 'do-not-return' } },
      },
      password: 'hash', personaFields: [{ value: 'private' }],
    })

    expect(dto).toMatchObject({
      id: 'user_1',
      plan: 'pro',
      preferences: {
        targetRoles: 'Engineer',
        notificationPreferences: { apply: false, reject: true },
        dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
        dataDeletionRequestStatus: 'requested',
      },
    })
    expect(JSON.stringify(dto)).not.toContain('do-not-return')
    expect(JSON.stringify(dto)).not.toContain('password')
    expect(JSON.stringify(dto)).not.toContain('private')
    expect(dto.email).not.toBe('candidate@example.com')
  })

  it('accepts only bounded notification, privacy, and deletion-status patch fields', () => {
    expect(parseAdminSettingsPatch({ notificationPreferences: { weekly: true } })).toEqual({
      notificationPreferences: { weekly: true },
    })
    expect(parseAdminSettingsPatch({ dataDeletionRequestStatus: 'processing' })).toEqual({
      dataDeletionRequestStatus: 'processing',
    })
    expect(parseAdminSettingsPatch({ aiSettings: { keys: { openai: 'secret' } } })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ privacyPreferences: { allowAiTraining: 'yes' } })).toMatchObject({ error: expect.any(String) })
  })

  it('serializes Prisma Date values in the admin account metadata', () => {
    const dto = toAdminSettingsDto({
      id: 'user_1', email: 'candidate@example.com', name: null, plan: 'free',
      preferences: {}, createdAt: new Date('2026-08-01T12:00:00.000Z'), onboardedAt: null,
    })

    expect(dto.account.createdAt).toBe('2026-08-01T12:00:00.000Z')
  })

  it('permits only valid deletion-request state transitions', () => {
    const requested = {
      dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
      dataDeletionRequestStatus: 'requested',
    }
    const processing = { ...requested, dataDeletionRequestStatus: 'processing' }

    expect(canTransitionDeletionRequest(requested, 'processing')).toBe(true)
    expect(canTransitionDeletionRequest(requested, 'cancelled')).toBe(true)
    expect(canTransitionDeletionRequest(requested, 'completed')).toBe(false)
    expect(canTransitionDeletionRequest(processing, 'completed')).toBe(true)
    expect(canTransitionDeletionRequest({}, 'processing')).toBe(false)
  })

  it('rejects operational fields outside the bounded workflows', () => {
    expect(parseAdminSettingsPatch({ plan: 'pro' })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ dataDeletionRequestStatus: 'purged' })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ jobPreferences: { targetLocations: 'Berlin' } })).toMatchObject({ error: expect.any(String) })
    expect(parseAdminSettingsPatch({ aiSettings: { keys: { openai: 'secret' } } })).toMatchObject({ error: expect.any(String) })
  })
})
