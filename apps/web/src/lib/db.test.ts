import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  }
  const base = {
    $extends: vi.fn((extension: unknown) => ({ ...base, extension })),
    $transaction: vi.fn(async (input: unknown) => typeof input === 'function' ? input(tx) : input),
  }
  return { base, tx }
})

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mocks.base) }))

describe('tenant-aware Prisma runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('RLS_RUNTIME_MODE', 'on')
    vi.stubEnv('RLS_CANDIDATE_ROLE', 'applymate_candidate')
  })

  it('rejects array transactions while a candidate RLS context is active', async () => {
    const { activateTenantContext } = await import('./db/tenant-store')
    const { db } = await import('./db')
    activateTenantContext('user_123')

    expect(() => db.$transaction([Promise.resolve('unsafe') as never])).toThrow('interactive callback')
    expect(mocks.base.$transaction).not.toHaveBeenCalled()
  })

  it('configures the candidate role before an interactive transaction callback', async () => {
    const { activateTenantContext } = await import('./db/tenant-store')
    const { db } = await import('./db')
    activateTenantContext('user_123')

    await expect(db.$transaction(async () => 'safe')).resolves.toBe('safe')
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE "applymate_candidate"')
  })
})
