import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), transaction: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { personaFact: { findMany: mocks.findMany, updateMany: mocks.updateMany }, $transaction: mocks.transaction } }))

import { confirmPersonaFacts, listConfirmedPersonaFacts, revokePersonaFact } from './persona-facts'

describe('persona facts', () => {
  beforeEach(() => {
    mocks.findMany.mockReset(); mocks.transaction.mockReset(); mocks.updateMany.mockReset(); mocks.upsert.mockReset()
    mocks.findMany.mockResolvedValue([])
    mocks.transaction.mockImplementation(async (callback: (tx: { personaFact: { updateMany: typeof mocks.updateMany; upsert: typeof mocks.upsert } }) => unknown) => callback({ personaFact: { updateMany: mocks.updateMany, upsert: mocks.upsert } }))
  })

  it('reads only confirmed, unexpired facts allowed for the requested task', async () => {
    await listConfirmedPersonaFacts('user_1', 'tailor')

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user_1', status: 'confirmed', revokedAt: null, allowedUses: { has: 'tailor' } }),
    }))
  })

  it('supersedes an old value and confirms the replacement with consent', async () => {
    await confirmPersonaFacts('user_1', [{ key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'manual', updatedAt: '' }])

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'superseded' } }))
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_key_normalizedValue: { userId: 'user_1', key: 'notice_period', normalizedValue: 'one month' } },
      create: expect.objectContaining({ status: 'confirmed', consentAt: expect.any(Date) }),
    }))
  })

  it('revokes a confirmed key instead of hard deleting it', async () => {
    await revokePersonaFact('user_1', 'notice_period')

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user_1', key: 'notice_period', status: 'confirmed' },
      data: expect.objectContaining({ status: 'revoked', revokedAt: expect.any(Date) }),
    }))
  })
})
