import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_PERSONA_BYTE_LIMIT,
  DISCOVERY_PERSONA_FACT_LIMIT,
  buildDiscoveryPersonaProjection,
  type DiscoveryPersonaFactRow,
} from '@jobcopilot/shared'
import type { DiscoveryPersonaFact } from '@/lib/persona-facts'
import { estimatePersonaDiscoveryCapacity } from './persona-discovery-capacity'

function fact(index: number, overrides: Partial<DiscoveryPersonaFact> = {}): DiscoveryPersonaFact {
  const value = `value ${index}`
  return {
    id: `fact-${index}`, key: `key-${index}`, category: 'profile', label: `Label ${index}`,
    value, normalizedValue: value.toLowerCase(), source: 'manual', allowedUses: ['discovery'],
    updatedAt: '2026-10-24T12:00:00.000Z', expiresAt: null, ...overrides,
  }
}

function row(value: DiscoveryPersonaFact): DiscoveryPersonaFactRow {
  return {
    id: value.id, key: value.key, category: value.category, value: value.value,
    normalizedValue: value.normalizedValue, source: value.source,
    evidence: { label: value.label }, updatedAt: value.updatedAt,
  }
}

function expectedBytes(facts: readonly DiscoveryPersonaFact[]): number {
  const result = buildDiscoveryPersonaProjection(facts.map(row))
  if (result.canonicalUtf8Bytes === null) throw new Error('Test fixture exceeds the fact limit')
  return result.canonicalUtf8Bytes
}

function factAtByteSize(targetBytes: number): DiscoveryPersonaFact {
  const value = 'Dublin "Dock"\\remote\n🙂'
  const base = fact(0, { value, normalizedValue: value.trim().toLowerCase() })
  const padding = targetBytes - expectedBytes([base])
  if (padding < 0) throw new Error('Test fixture base exceeds target size')
  return { ...base, source: `${base.source}${'x'.repeat(padding)}` }
}

describe('estimatePersonaDiscoveryCapacity', () => {
  it('counts only discovery-enabled facts and uses the shared canonical projection size', () => {
    const enabled = fact(1)
    const disabled = fact(2, { allowedUses: ['form_fill'] })
    const estimate = estimatePersonaDiscoveryCapacity([enabled, disabled])

    expect(estimate).toEqual({
      status: 'available', factCount: 1, factLimit: DISCOVERY_PERSONA_FACT_LIMIT,
      canonicalUtf8Bytes: expectedBytes([enabled]), byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT,
    })
  })

  it('reports 32 facts with bytes and 33 with only the fact-limit overflow', () => {
    const withinLimit = Array.from({ length: 32 }, (_, index) => fact(index))
    const overLimit = [...withinLimit, fact(32)]

    expect(estimatePersonaDiscoveryCapacity(withinLimit)).toMatchObject({
      status: 'available', factCount: 32, canonicalUtf8Bytes: expectedBytes(withinLimit),
    })
    expect(estimatePersonaDiscoveryCapacity(overLimit)).toEqual({
      status: 'overflow', factCount: 33, factLimit: 32, canonicalUtf8Bytes: null,
      byteLimit: 8192, overflowReason: 'fact_limit',
    })
  })

  it('matches 8192 and 8193 canonical UTF-8 bytes including Unicode and JSON escapes', () => {
    const atLimit = factAtByteSize(DISCOVERY_PERSONA_BYTE_LIMIT)
    const overLimit = factAtByteSize(DISCOVERY_PERSONA_BYTE_LIMIT + 1)

    expect(expectedBytes([atLimit])).toBe(8192)
    expect(estimatePersonaDiscoveryCapacity([atLimit])).toMatchObject({
      status: 'available', factCount: 1, canonicalUtf8Bytes: 8192,
    })
    expect(expectedBytes([overLimit])).toBe(8193)
    expect(estimatePersonaDiscoveryCapacity([overLimit])).toMatchObject({
      status: 'overflow', factCount: 1, canonicalUtf8Bytes: 8193, overflowReason: 'byte_limit',
    })
  })

  it('mirrors Worker whitespace-only label fallback and canonical ordering', () => {
    const fallback = fact(1, { key: 'current_location', label: ' \t ' })
    const explicit = { ...fallback, label: fallback.key }
    const other = fact(2)

    expect(estimatePersonaDiscoveryCapacity([fallback, other])).toEqual(
      estimatePersonaDiscoveryCapacity([other, explicit]),
    )
  })

  it('returns unknown without bytes for malformed, duplicated, or unavailable input', () => {
    const valid = fact(1)
    const duplicateId = fact(2, { id: valid.id })
    const malformed = fact(3, { normalizedValue: 'not-canonical' })
    const privateValue = 'must not appear in diagnostics'
    const badValue = fact(4, { value: privateValue, normalizedValue: 'wrong' })

    for (const input of [[valid, duplicateId], [malformed], [badValue], null, {}]) {
      const result = estimatePersonaDiscoveryCapacity(input)
      expect(result.status).toBe('unknown')
      expect(result.canonicalUtf8Bytes).toBeNull()
      expect(JSON.stringify(result)).not.toContain(privateValue)
    }
  })
})
