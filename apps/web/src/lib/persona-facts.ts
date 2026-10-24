import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type { PersonaField } from '@/lib/persona'

export type PersonaAllowedUse = 'form_fill' | 'tailor' | 'cover_letter'
export type DiscoveryPersonaFact = {
  id: string
  key: string
  category: string
  label: string
  value: string
  normalizedValue: string
  source: string
  allowedUses: string[]
  updatedAt: string
  expiresAt: string | null
}
export type DiscoveryPersonaFactConsentInput = {
  factId: string; key: string; expectedValue: string; expectedNormalizedValue: string
  expectedUpdatedAt: string; enabled: boolean
}
export type DiscoveryPersonaFactConsentResult =
  | { kind: 'updated'; fact: DiscoveryPersonaFact }
  | { kind: 'stale' }
  | { kind: 'not_found' }

type FactTransaction = Prisma.TransactionClient

export function isPersonaAllowedUse(value: string | null): value is PersonaAllowedUse {
  return value === 'form_fill' || value === 'tailor' || value === 'cover_letter'
}

function normalized(value: string) { return value.trim().toLowerCase() }

function nextVersion(previous: Date | null, now = new Date()): Date {
  return previous && previous.getTime() >= now.getTime() ? new Date(previous.getTime() + 1) : now
}

async function lockPersonaFacts(tx: FactTransaction, userId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('applymate:persona-facts:' || ${userId}::text, 0))`
}

function toField(fact: {
  key: string; category: string; value: string; confidence: number; source: string; updatedAt: Date; consentAt: Date | null; evidence: unknown
}): PersonaField {
  const evidence = fact.evidence && typeof fact.evidence === 'object' ? fact.evidence as { label?: unknown } : null
  return {
    key: fact.key, category: fact.category, value: fact.value, confidence: fact.confidence,
    source: fact.source, label: typeof evidence?.label === 'string' ? evidence.label : fact.key,
    updatedAt: fact.updatedAt.toISOString(), consentAt: fact.consentAt?.toISOString(),
  }
}

function toDiscoveryFact(fact: {
  id: string; key: string; category: string; value: string; normalizedValue: string; source: string
  evidence: unknown; allowedUses: string[]; updatedAt: Date; expiresAt: Date | null
}): DiscoveryPersonaFact {
  const evidence = fact.evidence && typeof fact.evidence === 'object' ? fact.evidence as { label?: unknown } : null
  return {
    id: fact.id, key: fact.key, category: fact.category,
    label: typeof evidence?.label === 'string' ? evidence.label : fact.key,
    value: fact.value, normalizedValue: fact.normalizedValue, source: fact.source,
    allowedUses: [...fact.allowedUses], updatedAt: fact.updatedAt.toISOString(),
    expiresAt: fact.expiresAt?.toISOString() ?? null,
  }
}

/** Fast exact-lookup source: confirmed, unexpired and non-revoked facts only. */
export async function listConfirmedPersonaFacts(userId: string, allowedUse?: PersonaAllowedUse, client: typeof db = db): Promise<PersonaField[]> {
  const now = new Date()
  const facts = await client.personaFact.findMany({
    where: {
      userId, status: 'confirmed', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(allowedUse ? { allowedUses: { has: allowedUse } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  })
  return facts.map(toField)
}

/** Consent UI source; never merges legacy profile fields or non-current facts. */
export async function listDiscoveryPersonaFacts(userId: string, client: typeof db = db): Promise<DiscoveryPersonaFact[]> {
  const facts = await client.personaFact.findMany({
    where: { userId, status: 'confirmed', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: [{ key: 'asc' }, { id: 'asc' }],
    select: { id: true, key: true, category: true, value: true, normalizedValue: true, source: true, evidence: true, allowedUses: true, updatedAt: true, expiresAt: true },
  })
  return facts.map(toDiscoveryFact)
}

export async function confirmPersonaFacts(userId: string, fields: PersonaField[], client: typeof db = db): Promise<PersonaField[]> {
  await client.$transaction(async tx => {
    await lockPersonaFacts(tx, userId)
    for (const field of fields) {
      const normalizedValue = normalized(field.value)
      const now = new Date()
      const superseded = await tx.personaFact.findMany({
        where: { userId, key: field.key, status: 'confirmed', normalizedValue: { not: normalizedValue } },
        select: { id: true, updatedAt: true },
      })
      for (const old of superseded) await tx.personaFact.update({
        where: { id: old.id }, data: { status: 'superseded', updatedAt: nextVersion(old.updatedAt, now) },
      })

      const where = { userId_key_normalizedValue: { userId, key: field.key, normalizedValue } }
      const previous = await tx.personaFact.findUnique({
        where, select: { value: true, normalizedValue: true, status: true, revokedAt: true, expiresAt: true, allowedUses: true, updatedAt: true },
      })
      const previousIsActive = previous?.status === 'confirmed' && previous.revokedAt === null &&
        previous.value === field.value.trim() && previous.normalizedValue === normalizedValue &&
        (!previous.expiresAt || previous.expiresAt > now)
      const allowedUses = previous
        ? previous.allowedUses.filter(use => use !== 'discovery' || previousIsActive)
        : undefined
      await tx.personaFact.upsert({
        where,
        update: {
          category: field.category, value: field.value.trim(), source: field.source || 'manual',
          evidence: { label: field.label }, confidence: Number.isFinite(field.confidence) ? field.confidence : 1,
          status: 'confirmed', consentAt: now, revokedAt: null,
          allowedUses, updatedAt: nextVersion(previous?.updatedAt ?? null, now),
        },
        create: {
          userId, key: field.key, category: field.category, value: field.value.trim(), normalizedValue,
          source: field.source || 'manual', evidence: { label: field.label },
          confidence: Number.isFinite(field.confidence) ? field.confidence : 1,
          status: 'confirmed', consentAt: now,
        },
      })
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
  return listConfirmedPersonaFacts(userId, undefined, client)
}

export async function setDiscoveryPersonaFactConsent(
  userId: string, input: DiscoveryPersonaFactConsentInput,
  client: typeof db = db,
): Promise<DiscoveryPersonaFactConsentResult> {
  return client.$transaction(async tx => {
    await lockPersonaFacts(tx, userId)
    const row = await tx.personaFact.findFirst({
      where: { id: input.factId, userId },
      select: { id: true, key: true, category: true, value: true, normalizedValue: true, source: true, evidence: true, allowedUses: true, updatedAt: true, expiresAt: true, status: true, revokedAt: true },
    })
    if (!row) return { kind: 'not_found' }
    const now = new Date()
    const expectedVersion = new Date(input.expectedUpdatedAt)
    const active = row.status === 'confirmed' && row.revokedAt === null && (!row.expiresAt || row.expiresAt > now)
    if (!Number.isFinite(expectedVersion.getTime()) || expectedVersion.toISOString() !== input.expectedUpdatedAt ||
      row.key !== input.key || row.value !== input.expectedValue || row.normalizedValue !== input.expectedNormalizedValue ||
      normalized(row.value) !== row.normalizedValue || row.updatedAt.toISOString() !== input.expectedUpdatedAt || !active) {
      return { kind: 'stale' }
    }
    const allowedUses = input.enabled
      ? [...new Set([...row.allowedUses, 'discovery'])]
      : row.allowedUses.filter(use => use !== 'discovery')
    if (allowedUses.length === row.allowedUses.length && allowedUses.every((use, index) => use === row.allowedUses[index])) {
      return { kind: 'updated', fact: toDiscoveryFact(row) }
    }
    const updatedAt = nextVersion(row.updatedAt, now)
    const result = await tx.personaFact.updateMany({
      where: {
        id: input.factId, userId, key: input.key, value: input.expectedValue,
        normalizedValue: input.expectedNormalizedValue, updatedAt: row.updatedAt,
        status: 'confirmed', revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { allowedUses, updatedAt },
    })
    if (result.count !== 1) return { kind: 'stale' }
    return { kind: 'updated', fact: toDiscoveryFact({ ...row, allowedUses, updatedAt }) }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}

export async function revokePersonaFact(userId: string, key: string, client: typeof db = db) {
  await client.$transaction(async tx => {
    await lockPersonaFacts(tx, userId)
    const now = new Date()
    const rows = await tx.personaFact.findMany({
      where: { userId, key, status: 'confirmed' }, select: { id: true, updatedAt: true, allowedUses: true },
    })
    for (const row of rows) await tx.personaFact.updateMany({
      where: { id: row.id, userId, key, status: 'confirmed', updatedAt: row.updatedAt },
      data: {
        status: 'revoked', revokedAt: now, allowedUses: row.allowedUses.filter(use => use !== 'discovery'),
        updatedAt: nextVersion(row.updatedAt, now),
      },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}
