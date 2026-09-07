import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }))

describe('verifyAdminAuditChain', () => {
  beforeEach(() => mocks.queryRaw.mockReset())

  it('accepts a continuous chain', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'a', previousHash: null, recordHash: 'hash-a', computedRecordHash: 'hash-a' }, { id: 'b', previousHash: 'hash-a', recordHash: 'hash-b', computedRecordHash: 'hash-b' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: true, recordCount: 2, lastRecordHash: 'hash-b' })
  })

  it('accepts a valid chain when database row order differs from insertion order', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'b', previousHash: 'hash-a', recordHash: 'hash-b', computedRecordHash: 'hash-b' }, { id: 'a', previousHash: null, recordHash: 'hash-a', computedRecordHash: 'hash-a' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: true, recordCount: 2, firstRecordHash: 'hash-a', lastRecordHash: 'hash-b' })
  })

  it('reports a missing link or record hash', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'a', previousHash: null, recordHash: 'hash-a', computedRecordHash: 'hash-a' }, { id: 'b', previousHash: 'wrong', recordHash: 'hash-b', computedRecordHash: 'hash-b' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: false, brokenAt: 'b' })
  })

  it('rejects a fork even when both branches are individually linked', async () => {
    mocks.queryRaw.mockResolvedValue([
      { id: 'a', previousHash: null, recordHash: 'hash-a', computedRecordHash: 'hash-a' },
      { id: 'b', previousHash: 'hash-a', recordHash: 'hash-b', computedRecordHash: 'hash-b' },
      { id: 'c', previousHash: 'hash-a', recordHash: 'hash-c', computedRecordHash: 'hash-c' },
    ])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: false, brokenAt: 'c' })
  })

  it('rejects a row whose fields no longer match its stored hash', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'a', previousHash: null, recordHash: 'hash-a', computedRecordHash: 'different-hash' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: false, brokenAt: 'a' })
  })
})
