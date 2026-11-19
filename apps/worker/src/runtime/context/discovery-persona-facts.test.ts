import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  DISCOVERY_PERSONA_BYTE_LIMIT, DISCOVERY_PERSONA_FACT_LIMIT, canonicalDiscoveryPersonaProjection,
  parseDiscoveryPersonaSnapshotPayload, projectDiscoveryPersonaFacts, type DiscoveryPersonaFactRow,
} from "./discovery-persona-facts.js"

function row(id: string, key = id, value = `value-${id}`): DiscoveryPersonaFactRow {
  return { id, key, category: "experience", value, normalizedValue: value.toLowerCase(), source: "manual",
    evidence: { label: `Label ${key}` }, updatedAt: new Date("2026-10-24T12:00:00.000Z") }
}

describe("discovery persona projection", () => {
  it("accepts an empty snapshot and sorts facts deterministically by key, normalized value, then fact id", () => {
    const empty = projectDiscoveryPersonaFacts([])
    expect(empty.kind).toBe("accepted")
    if (empty.kind !== "accepted") return
    expect(empty.payload.projection.facts).toEqual([])

    const result = projectDiscoveryPersonaFacts([row("z", "skill", "Rust"), row("b", "city", "Dublin"), row("a", "skill", "Go")])
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") return
    expect(result.payload.projection.facts.map(fact => fact.factId)).toEqual(["b", "a", "z"])
    const expectedCanonical = '{"schemaVersion":"applymate.discovery-persona-projection.v1","purpose":"discovery","facts":[' +
      '{"factId":"b","key":"city","label":"Label city","category":"experience","source":"manual","value":"Dublin","normalizedValue":"dublin","updatedAt":"2026-10-24T12:00:00.000Z"},' +
      '{"factId":"a","key":"skill","label":"Label skill","category":"experience","source":"manual","value":"Go","normalizedValue":"go","updatedAt":"2026-10-24T12:00:00.000Z"},' +
      '{"factId":"z","key":"skill","label":"Label skill","category":"experience","source":"manual","value":"Rust","normalizedValue":"rust","updatedAt":"2026-10-24T12:00:00.000Z"}]}'
    expect(canonicalDiscoveryPersonaProjection(result.payload.projection)).toBe(expectedCanonical)
    expect(result.payload.canonicalUtf8Bytes).toBe(607)
    expect(result.payload.canonicalUtf8Bytes).toBe(Buffer.byteLength(expectedCanonical, "utf8"))
    expect(result.payload.digest).toBe("9674b94bf04564e334b3d82dd53f68244afaefff7ccbe2276a4876bc7f52225a")
  })

  it("accepts exactly 32 facts and refuses a 33rd without retaining a partial projection", () => {
    const accepted = projectDiscoveryPersonaFacts(Array.from({ length: DISCOVERY_PERSONA_FACT_LIMIT }, (_, i) => row(`f-${i}`)))
    expect(accepted.kind).toBe("accepted")
    if (accepted.kind === "accepted") expect(accepted.payload.factCount).toBe(32)

    const overflow = projectDiscoveryPersonaFacts(Array.from({ length: DISCOVERY_PERSONA_FACT_LIMIT + 1 }, (_, i) => row(`f-${i}`)))
    expect(overflow).toEqual({ kind: "overflow", payload: {
      schemaVersion: "applymate.discovery-persona.v1", status: "overflow", purpose: "discovery", reason: "fact_limit",
      observedFactCount: 33, factLimit: 32, byteLimit: DISCOVERY_PERSONA_BYTE_LIMIT, canonicalUtf8Bytes: null,
    } })
    expect(JSON.stringify(overflow)).not.toContain("value-f-")
  })

  it("measures UTF-8 projection bytes and accepts the exact cap but overflows above it", () => {
    const value = 'x 😀\n"quoted" \\ value'
    const baseline = projectDiscoveryPersonaFacts([row("fact", "skill", value)])
    expect(baseline.kind).toBe("accepted")
    if (baseline.kind !== "accepted") return
    const baselineBytes = baseline.payload.canonicalUtf8Bytes
    const exactLabel = "Label skill" + "p".repeat(DISCOVERY_PERSONA_BYTE_LIMIT - baselineBytes)
    const exactRow = { ...row("fact", "skill", value), evidence: { label: exactLabel } }
    const exact = projectDiscoveryPersonaFacts([exactRow])
    expect(exact.kind).toBe("accepted")
    if (exact.kind === "accepted") expect(exact.payload.canonicalUtf8Bytes).toBe(DISCOVERY_PERSONA_BYTE_LIMIT)

    const over = projectDiscoveryPersonaFacts([{ ...exactRow, evidence: { label: `${exactLabel}p` } }])
    expect(over.kind).toBe("overflow")
    if (over.kind === "overflow") {
      expect(over.payload.reason).toBe("byte_limit")
      expect(over.payload.canonicalUtf8Bytes).toBe(DISCOVERY_PERSONA_BYTE_LIMIT + 1)
    }

    const unicode = projectDiscoveryPersonaFacts([row("fact", "skill", "😀".repeat(DISCOVERY_PERSONA_BYTE_LIMIT))])
    expect(unicode.kind).toBe("overflow")
    if (unicode.kind === "overflow") {
      expect(unicode.payload.reason).toBe("byte_limit")
      expect(unicode.payload.canonicalUtf8Bytes).toBeGreaterThan(DISCOVERY_PERSONA_BYTE_LIMIT)
      expect(Object.keys(unicode.payload).sort()).toEqual(["byteLimit", "canonicalUtf8Bytes", "factLimit", "observedFactCount", "purpose", "reason", "schemaVersion", "status"])
    }
  })

  it("uses the evidence label with a key fallback and validates immutable snapshot digest and shape", () => {
    const result = projectDiscoveryPersonaFacts([{ ...row("f"), evidence: null }])
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") return
    expect(result.payload.projection.facts[0]?.label).toBe("f")
    expect(parseDiscoveryPersonaSnapshotPayload(result.payload)).toEqual(result.payload)
    expect(parseDiscoveryPersonaSnapshotPayload({ ...result.payload, digest: "0".repeat(64) })).toBeNull()
    expect(parseDiscoveryPersonaSnapshotPayload({ ...result.payload, unexpected: true })).toBeNull()
    const two = projectDiscoveryPersonaFacts([row("b", "z"), row("a", "a")])
    expect(two.kind).toBe("accepted")
    if (two.kind !== "accepted") return
    const reversedProjection = { ...two.payload.projection, facts: [...two.payload.projection.facts].reverse() }
    const reversedJson = canonicalDiscoveryPersonaProjection(reversedProjection)
    const unsorted = { ...two.payload, projection: reversedProjection, canonicalUtf8Bytes: Buffer.byteLength(reversedJson, "utf8"),
      digest: createHash("sha256").update(reversedJson, "utf8").digest("hex") }
    expect(parseDiscoveryPersonaSnapshotPayload(unsorted)).toBeNull()
  })

  it("fails closed for malformed source rows and duplicate identities", () => {
    expect(() => projectDiscoveryPersonaFacts([{ ...row("f"), updatedAt: "not-a-date" }])).toThrow("malformed")
    expect(() => projectDiscoveryPersonaFacts([{ ...row("f"), normalizedValue: "stale" }])).toThrow("malformed")
    expect(() => projectDiscoveryPersonaFacts([row("f"), row("f")])).toThrow("not unique")
  })
})
