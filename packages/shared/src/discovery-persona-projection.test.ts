import { describe, expect, it } from "vitest"
import {
  DISCOVERY_PERSONA_BYTE_LIMIT, DISCOVERY_PERSONA_FACT_LIMIT, buildDiscoveryPersonaProjection,
  canonicalDiscoveryPersonaProjection, normalizeDiscoveryPersonaValue, utf8ByteLength,
  type DiscoveryPersonaFactRow,
} from "./discovery-persona-projection.js"

function row(id: string, key = id, value = `value-${id}`): DiscoveryPersonaFactRow {
  return { id, key, category: "experience", value, normalizedValue: normalizeDiscoveryPersonaValue(value), source: "manual",
    evidence: { label: `Label ${key}` }, updatedAt: new Date("2026-10-24T12:00:00.000Z") }
}

describe("shared discovery persona projection", () => {
  it("keeps the Worker canonical JSON field order and sort order", () => {
    const result = buildDiscoveryPersonaProjection([row("z", "skill", "Rust"), row("b", "city", "Dublin"), row("a", "skill", "Go")])
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") return
    const expected = '{"schemaVersion":"applymate.discovery-persona-projection.v1","purpose":"discovery","facts":[' +
      '{"factId":"b","key":"city","label":"Label city","category":"experience","source":"manual","value":"Dublin","normalizedValue":"dublin","updatedAt":"2026-10-24T12:00:00.000Z"},' +
      '{"factId":"a","key":"skill","label":"Label skill","category":"experience","source":"manual","value":"Go","normalizedValue":"go","updatedAt":"2026-10-24T12:00:00.000Z"},' +
      '{"factId":"z","key":"skill","label":"Label skill","category":"experience","source":"manual","value":"Rust","normalizedValue":"rust","updatedAt":"2026-10-24T12:00:00.000Z"}]}'
    expect(result.canonicalJson).toBe(expected)
    expect(result.canonicalJson).toBe(canonicalDiscoveryPersonaProjection(result.projection))
    expect(result.canonicalUtf8Bytes).toBe(607)
    expect(result.canonicalUtf8Bytes).toBe(utf8ByteLength(expected))
  })

  it("accepts 32 facts and refuses 33 before producing any projection or bytes", () => {
    const accepted = buildDiscoveryPersonaProjection(Array.from({ length: DISCOVERY_PERSONA_FACT_LIMIT }, (_, i) => row(`f-${i}`)))
    expect(accepted.kind).toBe("accepted")
    if (accepted.kind === "accepted") expect(accepted.factCount).toBe(32)

    const overflow = buildDiscoveryPersonaProjection(Array.from({ length: DISCOVERY_PERSONA_FACT_LIMIT + 1 }, (_, i) => row(`f-${i}`)))
    expect(overflow).toEqual({ kind: "overflow", reason: "fact_limit", observedFactCount: 33, canonicalUtf8Bytes: null })
    expect(JSON.stringify(overflow)).not.toContain("value-f-")
  })

  it("uses canonical JSON UTF-8 bytes at the exact cap and one byte above", () => {
    const value = 'x 😀\n"quoted" \\ value'
    const base = { ...row("fact", "skill", value), normalizedValue: normalizeDiscoveryPersonaValue(value) }
    const baseline = buildDiscoveryPersonaProjection([base])
    expect(baseline.kind).toBe("accepted")
    if (baseline.kind !== "accepted") return
    const label = `Label skill${"p".repeat(DISCOVERY_PERSONA_BYTE_LIMIT - baseline.canonicalUtf8Bytes)}`
    const exact = buildDiscoveryPersonaProjection([{ ...base, evidence: { label } }])
    expect(exact.kind).toBe("accepted")
    if (exact.kind === "accepted") expect(exact.canonicalUtf8Bytes).toBe(DISCOVERY_PERSONA_BYTE_LIMIT)

    const overflow = buildDiscoveryPersonaProjection([{ ...base, evidence: { label: `${label}p` } }])
    expect(overflow).toEqual({ kind: "overflow", reason: "byte_limit", observedFactCount: 1, canonicalUtf8Bytes: 8193 })
  })

  it("counts escaped and multibyte values from canonical JSON, not raw input", () => {
    const value = 'line\nwith "quotes" and \\ slash 😀'
    const label = 'label\twith "quotes" 😀'
    const result = buildDiscoveryPersonaProjection([{ ...row("escaped", "details", value), normalizedValue: normalizeDiscoveryPersonaValue(value), evidence: { label } }])
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") return
    expect(result.canonicalJson).toContain('line\\nwith \\"quotes\\" and \\\\ slash 😀')
    expect(result.canonicalUtf8Bytes).toBe(utf8ByteLength(result.canonicalJson))
    expect(result.canonicalUtf8Bytes).toBe(359)
  })

  it("falls back from whitespace-only labels and rejects malformed or duplicate facts", () => {
    const fallback = buildDiscoveryPersonaProjection([{ ...row("f", "target_city", "Dublin"), evidence: { label: " \t " } }])
    expect(fallback.kind).toBe("accepted")
    if (fallback.kind === "accepted") expect(fallback.projection.facts[0]?.label).toBe("target_city")

    expect(() => buildDiscoveryPersonaProjection([{ ...row("f"), normalizedValue: "stale" }])).toThrow("Confirmed discovery fact is malformed")
    expect(() => buildDiscoveryPersonaProjection([row("f"), row("f")])).toThrow("Confirmed discovery facts are not unique")
    expect(() => buildDiscoveryPersonaProjection([row("one", "skill", "Rust"), row("two", "skill", "rust")]))
      .toThrow("Confirmed discovery facts are not unique")
  })
})
