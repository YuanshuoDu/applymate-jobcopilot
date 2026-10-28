import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique }, $transaction: mocks.transaction } }))

import { getAgentTaskHistoryMemoryConsent, setAgentTaskHistoryMemoryConsent } from './agent-task-history-memory-consent'

function consentRow(enabled = false, version = 0) {
  return { agentTaskHistoryMemoryEnabled: enabled, agentTaskHistoryMemoryConsentVersion: version }
}

describe('agent task history memory consent storage', () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(consentRow())
    mocks.updateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.lock.mockReset().mockResolvedValue([{ lock_acquired: '' }])
    mocks.transaction.mockReset().mockImplementation(async (callback: (tx: never) => unknown) => callback({
      $queryRaw: mocks.lock,
      user: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
    } as never))
  })

  it('reads only the dedicated consent fields for the requested user', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 4))
    await expect(getAgentTaskHistoryMemoryConsent('user-1')).resolves.toEqual({ enabled: true, version: 4 })
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { agentTaskHistoryMemoryEnabled: true, agentTaskHistoryMemoryConsentVersion: true },
    })
  })

  it('takes the dedicated user advisory lock before compare-and-swap', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, 2))
    await setAgentTaskHistoryMemoryConsent('user-1', { enabled: true, expectedVersion: 2 })

    const [query, userId] = mocks.lock.mock.calls[0] as [TemplateStringsArray, string]
    expect(query.join('?')).toContain("pg_advisory_xact_lock(hashtextextended('applymate:agent-task-history-memory:' || ?::text, 0))::text AS lock_acquired")
    expect(userId).toBe('user-1')
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', agentTaskHistoryMemoryConsentVersion: 2 },
      data: {
        agentTaskHistoryMemoryEnabled: true,
        agentTaskHistoryMemoryConsentVersion: { increment: 1 },
      },
    })
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'ReadCommitted' })
  })

  it('increments the version on an accepted mutation and returns the new durable choice', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, 0))
    await expect(setAgentTaskHistoryMemoryConsent('user-1', { enabled: true, expectedVersion: 0 }))
      .resolves.toEqual({ kind: 'updated', consent: { enabled: true, version: 1 } })
  })

  it('returns the current durable value on a stale version without writing', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 3))
    await expect(setAgentTaskHistoryMemoryConsent('user-1', { enabled: false, expectedVersion: 2 }))
      .resolves.toEqual({ kind: 'stale', consent: { enabled: true, version: 3 } })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('re-reads and reports conflict if the guarded update loses a concurrent race', async () => {
    mocks.findUnique.mockResolvedValueOnce(consentRow(false, 5)).mockResolvedValueOnce(consentRow(true, 6))
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(setAgentTaskHistoryMemoryConsent('user-1', { enabled: false, expectedVersion: 5 }))
      .resolves.toEqual({ kind: 'stale', consent: { enabled: true, version: 6 } })
  })

  it('does not create state for a missing user or overflow the monotonic Int version', async () => {
    mocks.findUnique.mockResolvedValueOnce(null)
    await expect(setAgentTaskHistoryMemoryConsent('missing-user', { enabled: true, expectedVersion: 0 }))
      .resolves.toEqual({ kind: 'not_found' })
    expect(mocks.updateMany).not.toHaveBeenCalled()

    mocks.findUnique.mockResolvedValueOnce(consentRow(true, 2_147_483_647))
    await expect(setAgentTaskHistoryMemoryConsent('user-1', { enabled: false, expectedVersion: 2_147_483_647 }))
      .resolves.toEqual({ kind: 'version_exhausted', consent: { enabled: true, version: 2_147_483_647 } })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})
