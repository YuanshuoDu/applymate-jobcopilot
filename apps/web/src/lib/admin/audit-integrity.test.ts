import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { adminAuditLog: { findMany: mocks.findMany } } }))

describe('verifyAdminAuditChain', () => {
  beforeEach(() => mocks.findMany.mockReset())

  it('accepts a continuous chain', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'a', previousHash: null, recordHash: 'hash-a' }, { id: 'b', previousHash: 'hash-a', recordHash: 'hash-b' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: true, recordCount: 2, lastRecordHash: 'hash-b' })
  })

  it('accepts a valid chain when database row order differs from insertion order', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'b', previousHash: 'hash-a', recordHash: 'hash-b' }, { id: 'a', previousHash: null, recordHash: 'hash-a' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: true, recordCount: 2, firstRecordHash: 'hash-a', lastRecordHash: 'hash-b' })
  })

  it('reports a missing link or record hash', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'a', previousHash: null, recordHash: 'hash-a' }, { id: 'b', previousHash: 'wrong', recordHash: 'hash-b' }])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: false, brokenAt: 'b' })
  })

  it('rejects a fork even when both branches are individually linked', async () => {
    mocks.findMany.mockResolvedValue([
      { id: 'a', previousHash: null, recordHash: 'hash-a' },
      { id: 'b', previousHash: 'hash-a', recordHash: 'hash-b' },
      { id: 'c', previousHash: 'hash-a', recordHash: 'hash-c' },
    ])
    const { verifyAdminAuditChain } = await import('./audit-integrity')
    await expect(verifyAdminAuditChain()).resolves.toMatchObject({ verified: false, brokenAt: 'c' })
  })
})
