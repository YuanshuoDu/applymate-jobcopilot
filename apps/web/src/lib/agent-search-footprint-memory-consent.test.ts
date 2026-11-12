import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn(), transaction: vi.fn(), lock: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique }, $transaction: mocks.transaction } }))

import { getAgentSearchFootprintMemoryConsent, setAgentSearchFootprintMemoryConsent } from './agent-search-footprint-memory-consent'

function consentRow(enabled = false, version = 0) {
  return { agentSearchFootprintMemoryEnabled: enabled, agentSearchFootprintMemoryConsentVersion: version }
}

describe('agent search footprint memory consent storage', () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(consentRow())
    mocks.updateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.lock.mockReset().mockResolvedValue([{ lock_acquired: '' }])
    mocks.transaction.mockReset().mockImplementation(async (callback: (tx: never) => unknown) => callback({
      $queryRaw: mocks.lock, user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
    } as never))
  })

  it('reads only the separate search-footprint consent pair', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 4))
    await expect(getAgentSearchFootprintMemoryConsent('user-1')).resolves.toEqual({ enabled: true, version: 4 })
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: {
      agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true,
    } })
  })

  it('locks the user before compare-and-swap and increments opt-in and opt-out', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, 2))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: true, expectedVersion: 2 }))
      .resolves.toEqual({ kind: 'updated', consent: { enabled: true, version: 3 } })
    const [query, userId] = mocks.lock.mock.calls[0] as [TemplateStringsArray, string]
    expect(query.join('?')).toContain("applymate:agent-search-footprint-memory:' || ?::text")
    expect(userId).toBe('user-1')
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'user-1', agentSearchFootprintMemoryConsentVersion: 2 }, data: {
      agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: { increment: 1 },
    } })

    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 3))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: false, expectedVersion: 3 }))
      .resolves.toEqual({ kind: 'updated', consent: { enabled: false, version: 4 } })
  })

  it('does not change the version when the requested choice is already current', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 7))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: true, expectedVersion: 7 }))
      .resolves.toEqual({ kind: 'unchanged', consent: { enabled: true, version: 7 } })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('keeps unchanged choices idempotent at version exhaustion', async () => {
    const maxVersion = 2_147_483_647
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, maxVersion))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: true, expectedVersion: maxVersion }))
      .resolves.toEqual({ kind: 'unchanged', consent: { enabled: true, version: maxVersion } })
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, maxVersion))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: false, expectedVersion: maxVersion }))
      .resolves.toEqual({ kind: 'unchanged', consent: { enabled: false, version: maxVersion } })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('handles stale, raced, missing-user, terminal opt-out, and exhausted re-enable mutations', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 5))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: false, expectedVersion: 4 }))
      .resolves.toEqual({ kind: 'stale', consent: { enabled: true, version: 5 } })
    expect(mocks.updateMany).not.toHaveBeenCalled()

    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 5)).mockResolvedValueOnce(consentRow(true, 6))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: false, expectedVersion: 5 }))
      .resolves.toEqual({ kind: 'stale', consent: { enabled: true, version: 6 } })

    mocks.findUnique.mockResolvedValueOnce(null)
    await expect(setAgentSearchFootprintMemoryConsent('missing', { enabled: true, expectedVersion: 0 }))
      .resolves.toEqual({ kind: 'not_found' })
    const maxVersion = 2_147_483_647
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, maxVersion))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: false, expectedVersion: 2_147_483_647 }))
      .resolves.toEqual({ kind: 'updated', consent: { enabled: false, version: maxVersion } })
    expect(mocks.updateMany).toHaveBeenLastCalledWith({ where: { id: 'user-1', agentSearchFootprintMemoryConsentVersion: maxVersion }, data: {
      agentSearchFootprintMemoryEnabled: false,
    } })

    const updatesAfterRevocation = mocks.updateMany.mock.calls.length
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, maxVersion))
    await expect(setAgentSearchFootprintMemoryConsent('user-1', { enabled: true, expectedVersion: maxVersion }))
      .resolves.toEqual({ kind: 'version_exhausted', consent: { enabled: false, version: maxVersion } })
    expect(mocks.updateMany).toHaveBeenCalledTimes(updatesAfterRevocation)
  })
})
