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
    expect(result.payload.canonicalUtf8Bytes).toBe(Buffer.byteLength(canonicalDiscoveryPersonaProjection(result.payload.projection), "utf8"))
    expect(result.payload.digest).toMatch(/^[a-f0-9]{64}$/)
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
    const baseline = projectDiscoveryPersonaFacts([row("fact", "skill", "x")])
    expect(baseline.kind).toBe("accepted")
    if (baseline.kind !== "accepted") return
    const baselineBytes = baseline.payload.canonicalUtf8Bytes
    const exactRow = { ...row("fact", "skill", "x"), evidence: { label: "Label skill" + "p".repeat(DISCOVERY_PERSONA_BYTE_LIMIT - baselineBytes) } }
    const exact = projectDiscoveryPersonaFacts([exactRow])
    expect(exact.kind).toBe("accepted")
    if (exact.kind === "accepted") expect(exact.payload.canonicalUtf8Bytes).toBe(DISCOVERY_PERSONA_BYTE_LIMIT)

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
