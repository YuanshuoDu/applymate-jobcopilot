import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findFirst: vi.fn(), txFindMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(),
  transaction: vi.fn(), lock: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: {
  personaFact: { findMany: mocks.findMany, findFirst: mocks.findFirst, findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany, upsert: mocks.upsert },
  $transaction: mocks.transaction,
} }))

import { confirmPersonaFacts, listConfirmedPersonaFacts, listDiscoveryPersonaFacts, revokePersonaFact, setDiscoveryPersonaFactConsent } from './persona-facts'

const version = new Date('2026-10-24T12:00:00.000Z')
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fact-1', userId: 'user_1', key: 'notice_period', category: 'work', value: 'One month', normalizedValue: 'one month',
    source: 'manual', evidence: { label: 'Notice period' }, confidence: 1, status: 'confirmed',
    allowedUses: ['form_fill'], consentAt: version, expiresAt: null, revokedAt: null, updatedAt: version,
    ...overrides,
  }
}

describe('persona facts', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(version)
    mocks.findMany.mockReset().mockResolvedValue([]); mocks.findFirst.mockReset(); mocks.txFindMany.mockReset().mockResolvedValue([]); mocks.findUnique.mockReset()
    mocks.update.mockReset().mockResolvedValue({}); mocks.updateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.upsert.mockReset().mockResolvedValue({}); mocks.lock.mockReset().mockResolvedValue([])
    mocks.transaction.mockReset().mockImplementation(async (callback: (tx: never) => unknown) => callback({
      $queryRaw: mocks.lock,
      personaFact: { findMany: mocks.txFindMany, findFirst: mocks.findFirst, findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany, upsert: mocks.upsert },
    } as never))
  })
  afterEach(() => vi.useRealTimers())

  it('reads confirmed task facts using owner, purpose and lifetime constraints', async () => {
    await listConfirmedPersonaFacts('user_1', 'tailor')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user_1', status: 'confirmed', revokedAt: null, allowedUses: { has: 'tailor' } }),
    }))
  })

  it('lists only current, confirmed, same-owner facts for the dedicated consent UI', async () => {
    mocks.findMany.mockResolvedValue([row()])
    const facts = await listDiscoveryPersonaFacts('user_1')
    expect(facts[0]).toMatchObject({ id: 'fact-1', label: 'Notice period', allowedUses: ['form_fill'] })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user_1', status: 'confirmed', revokedAt: null, OR: expect.any(Array) },
      orderBy: [{ key: 'asc' }, { id: 'asc' }],
    }))
    expect(mocks.findMany.mock.calls[0]?.[0].where).not.toHaveProperty('allowedUses')
  })

  it('locks generic fact writes and preserves active same-value discovery consent', async () => {
    mocks.findUnique.mockResolvedValue(row({ allowedUses: ['form_fill', 'discovery'] }))
    await confirmPersonaFacts('user_1', [{ key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'manual', updatedAt: '' }])
    const [query, userId] = mocks.lock.mock.calls[0] as [TemplateStringsArray, string]
    expect(query.join('?')).toContain("pg_advisory_xact_lock(hashtextextended('applymate:persona-facts:' || ?::text, 0))")
    expect(userId).toBe('user_1')
    expect(mocks.upsert.mock.calls[0]?.[0].update.allowedUses).toEqual(['form_fill', 'discovery'])
  })

  it('does not resurrect revoked discovery on a same-millisecond generic save and advances the version', async () => {
    mocks.findUnique.mockResolvedValue(row({ status: 'revoked', revokedAt: version, allowedUses: ['form_fill', 'discovery'] }))
    await confirmPersonaFacts('user_1', [{ key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'manual', updatedAt: '' }])
    const update = mocks.upsert.mock.calls[0]?.[0].update
    expect(update.allowedUses).toEqual(['form_fill'])
    expect(update.updatedAt.getTime()).toBe(version.getTime() + 1)
  })

  it('does not carry consent onto a replacement value with the same normalized key', async () => {
    mocks.findUnique.mockResolvedValue(row({ value: 'one month', allowedUses: ['form_fill', 'discovery'] }))
    await confirmPersonaFacts('user_1', [{ key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'manual', updatedAt: '' }])
    expect(mocks.upsert.mock.calls[0]?.[0].update.allowedUses).toEqual(['form_fill'])
  })

  it('CAS-grants only an exact current fact and preserves other purposes', async () => {
    mocks.findFirst.mockResolvedValue(row({ allowedUses: ['form_fill', 'tailor'] }))
    const result = await setDiscoveryPersonaFactConsent('user_1', {
      factId: 'fact-1', key: 'notice_period', expectedValue: 'One month', expectedNormalizedValue: 'one month',
      expectedUpdatedAt: version.toISOString(), enabled: true,
    })
    expect(result.kind).toBe('updated')
    if (result.kind === 'updated') expect(result.fact.allowedUses).toEqual(['form_fill', 'tailor', 'discovery'])
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'fact-1', userId: 'user_1', value: 'One month', updatedAt: version }),
      data: { allowedUses: ['form_fill', 'tailor', 'discovery'], updatedAt: new Date(version.getTime() + 1) },
    }))
  })

  it('purpose-only revoke removes discovery while preserving other allowed uses', async () => {
    mocks.findFirst.mockResolvedValue(row({ allowedUses: ['form_fill', 'tailor', 'discovery'] }))
    const result = await setDiscoveryPersonaFactConsent('user_1', {
      factId: 'fact-1', key: 'notice_period', expectedValue: 'One month', expectedNormalizedValue: 'one month',
      expectedUpdatedAt: version.toISOString(), enabled: false,
    })
    expect(result.kind).toBe('updated')
    if (result.kind === 'updated') expect(result.fact.allowedUses).toEqual(['form_fill', 'tailor'])
    expect(mocks.updateMany.mock.calls[0]?.[0].data).toEqual({
      allowedUses: ['form_fill', 'tailor'], updatedAt: new Date(version.getTime() + 1),
    })
  })

  it('rejects expired or revoked rows even when their value version matches', async () => {
    for (const changed of [
      { expiresAt: new Date(version.getTime() - 1) },
      { status: 'revoked', revokedAt: version },
    ]) {
      mocks.findFirst.mockResolvedValueOnce(row(changed))
      const result = await setDiscoveryPersonaFactConsent('user_1', {
        factId: 'fact-1', key: 'notice_period', expectedValue: 'One month', expectedNormalizedValue: 'one month',
        expectedUpdatedAt: version.toISOString(), enabled: true,
      })
      expect(result).toEqual({ kind: 'stale' })
    }
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale grant after a same-millisecond revoke/version change', async () => {
    mocks.findFirst.mockResolvedValue(row({ updatedAt: new Date(version.getTime() + 1), allowedUses: ['form_fill'] }))
    const result = await setDiscoveryPersonaFactConsent('user_1', {
      factId: 'fact-1', key: 'notice_period', expectedValue: 'One month', expectedNormalizedValue: 'one month',
      expectedUpdatedAt: version.toISOString(), enabled: true,
    })
    expect(result).toEqual({ kind: 'stale' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('returns not-found for a missing or foreign owner fact', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const result = await setDiscoveryPersonaFactConsent('user_1', {
      factId: 'foreign-fact', key: 'notice_period', expectedValue: 'One month', expectedNormalizedValue: 'one month',
      expectedUpdatedAt: version.toISOString(), enabled: true,
    })
    expect(result).toEqual({ kind: 'not_found' })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign-fact', userId: 'user_1' } }))
  })

  it('full key revocation clears discovery, preserves the other-purpose audit, and advances version', async () => {
    mocks.txFindMany.mockResolvedValue([row({ allowedUses: ['form_fill', 'discovery'] })])
    await revokePersonaFact('user_1', 'notice_period')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'revoked', allowedUses: ['form_fill'], updatedAt: new Date(version.getTime() + 1) }),
    }))
  })
})
