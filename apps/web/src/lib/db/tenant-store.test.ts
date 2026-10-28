import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn(), executeRawUnsafe: vi.fn() }))
const nodeRequire = createRequire(import.meta.url)

describe('tenant store', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.executeRaw.mockReset()
    mocks.executeRawUnsafe.mockReset()
    vi.unstubAllEnvs()
    vi.stubGlobal('require', nodeRequire)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('activates a tenant inside an isolated request scope and restores the caller scope', async () => {
    const { activateTenantContext, currentTenantUserId, runWithTenantContext } = await import('./tenant-store')
    expect(currentTenantUserId()).toBeNull()
    await runWithTenantContext('request_user', async () => {
      expect(currentTenantUserId()).toBe('request_user')
      activateTenantContext('user_123')
      await Promise.resolve()
      expect(currentTenantUserId()).toBe('user_123')
    })
    expect(currentTenantUserId()).toBeNull()
  })

  it('keeps concurrent tenant request scopes isolated across async work', async () => {
    const { currentTenantUserId, runWithTenantContext } = await import('./tenant-store')
    const users = await Promise.all([
      runWithTenantContext('user_alpha', async () => {
        expect(currentTenantUserId()).toBe('user_alpha')
        await new Promise(resolve => setTimeout(resolve, 5))
        return currentTenantUserId()
      }),
      runWithTenantContext('user_beta', async () => {
        expect(currentTenantUserId()).toBe('user_beta')
        await Promise.resolve()
        return currentTenantUserId()
      }),
    ])
    expect(users).toEqual(['user_alpha', 'user_beta'])
    expect(currentTenantUserId()).toBeNull()
  })

  it('sets the tenant and candidate role inside an RLS transaction', async () => {
    vi.stubEnv('RLS_RUNTIME_MODE', 'on')
    vi.stubEnv('RLS_CANDIDATE_ROLE', 'applymate_candidate')
    const { configureTenantTransaction } = await import('./tenant-store')
    const tx = { $executeRaw: mocks.executeRaw, $executeRawUnsafe: mocks.executeRawUnsafe }
    await configureTenantTransaction(tx as never, 'user_123')
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE "applymate_candidate"')
  })
})
