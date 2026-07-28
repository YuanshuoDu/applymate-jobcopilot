import { db } from '@/lib/db'
import type { PersonaField } from '@/lib/persona'

export type PersonaAllowedUse = 'form_fill' | 'tailor' | 'cover_letter'

export function isPersonaAllowedUse(value: string | null): value is PersonaAllowedUse {
  return value === 'form_fill' || value === 'tailor' || value === 'cover_letter'
}

function normalized(value: string) {
  return value.trim().toLowerCase()
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

/** Fast exact-lookup source: confirmed, unexpired and non-revoked facts only. */
export async function listConfirmedPersonaFacts(userId: string, allowedUse?: PersonaAllowedUse): Promise<PersonaField[]> {
  const now = new Date()
  const facts = await db.personaFact.findMany({
    where: {
      userId, status: 'confirmed', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(allowedUse ? { allowedUses: { has: allowedUse } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  })
  return facts.map(toField)
}

export async function confirmPersonaFacts(userId: string, fields: PersonaField[]): Promise<PersonaField[]> {
  const now = new Date()
  await db.$transaction(async tx => {
    for (const field of fields) {
      const normalizedValue = normalized(field.value)
      await tx.personaFact.updateMany({
        where: { userId, key: field.key, status: 'confirmed', normalizedValue: { not: normalizedValue } },
        data: { status: 'superseded' },
      })
      await tx.personaFact.upsert({
        where: { userId_key_normalizedValue: { userId, key: field.key, normalizedValue } },
        update: {
          category: field.category, value: field.value.trim(), source: field.source || 'manual',
          evidence: { label: field.label }, confidence: Number.isFinite(field.confidence) ? field.confidence : 1, status: 'confirmed',
          consentAt: now, revokedAt: null,
        },
        create: {
          userId, key: field.key, category: field.category, value: field.value.trim(), normalizedValue,
          source: field.source || 'manual', evidence: { label: field.label }, confidence: Number.isFinite(field.confidence) ? field.confidence : 1,
          status: 'confirmed', consentAt: now,
        },
      })
    }
  })
  return listConfirmedPersonaFacts(userId)
}

export async function revokePersonaFact(userId: string, key: string) {
  await db.personaFact.updateMany({
    where: { userId, key, status: 'confirmed' },
    data: { status: 'revoked', revokedAt: new Date() },
  })
}
