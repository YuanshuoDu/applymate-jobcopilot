import {
  DISCOVERY_PERSONA_BYTE_LIMIT,
  DISCOVERY_PERSONA_FACT_LIMIT,
  buildDiscoveryPersonaProjection,
  type DiscoveryPersonaFactRow,
} from '@jobcopilot/shared'

export type PersonaDiscoveryCapacity = {
  status: 'available' | 'overflow' | 'unknown'
  factCount: number
  factLimit: typeof DISCOVERY_PERSONA_FACT_LIMIT
  canonicalUtf8Bytes: number | null
  byteLimit: typeof DISCOVERY_PERSONA_BYTE_LIMIT
  overflowReason?: 'fact_limit' | 'byte_limit'
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknown(factCount = 0): PersonaDiscoveryCapacity {
  return {
    status: 'unknown', factCount, factLimit: DISCOVERY_PERSONA_FACT_LIMIT,
    canonicalUtf8Bytes: null, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function toProjectionRow(fact: RecordValue): DiscoveryPersonaFactRow | null {
  if (typeof fact.id !== 'string' || typeof fact.key !== 'string' || typeof fact.category !== 'string' ||
    typeof fact.value !== 'string' || typeof fact.normalizedValue !== 'string' || typeof fact.source !== 'string' ||
    typeof fact.label !== 'string' || typeof fact.updatedAt !== 'string') return null
  return {
    id: fact.id, key: fact.key, category: fact.category, value: fact.value,
    normalizedValue: fact.normalizedValue, source: fact.source,
    evidence: { label: fact.label }, updatedAt: fact.updatedAt,
  }
}

/** Advisory estimate for the current discovery-enabled selection; never authorizes a Turn. */
export function estimatePersonaDiscoveryCapacity(facts: unknown): PersonaDiscoveryCapacity {
  if (!Array.isArray(facts)) return unknown()
  const selected: RecordValue[] = []
  for (const fact of facts) {
    if (!isRecord(fact) || !isStringArray(fact.allowedUses)) return unknown(selected.length)
    if (fact.allowedUses.includes('discovery')) selected.push(fact)
  }

  if (selected.length > DISCOVERY_PERSONA_FACT_LIMIT) return {
    status: 'overflow', factCount: selected.length, factLimit: DISCOVERY_PERSONA_FACT_LIMIT,
    canonicalUtf8Bytes: null, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT, overflowReason: 'fact_limit',
  }

  const rows = selected.map(toProjectionRow)
  if (rows.some(row => row === null)) return unknown(selected.length)
  try {
    const result = buildDiscoveryPersonaProjection(rows.filter((row): row is DiscoveryPersonaFactRow => row !== null))
    if (result.kind === 'accepted') return {
      status: 'available', factCount: result.factCount, factLimit: DISCOVERY_PERSONA_FACT_LIMIT,
      canonicalUtf8Bytes: result.canonicalUtf8Bytes, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT,
    }
    return {
      status: 'overflow', factCount: result.observedFactCount, factLimit: DISCOVERY_PERSONA_FACT_LIMIT,
      canonicalUtf8Bytes: result.canonicalUtf8Bytes, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT,
      overflowReason: result.reason,
    }
  } catch {
    return unknown(selected.length)
  }
}
