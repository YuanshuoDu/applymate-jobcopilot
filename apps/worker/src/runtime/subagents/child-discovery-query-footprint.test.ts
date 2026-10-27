import { describe, expect, it } from "vitest"

import {
  captureDiscoveryQueryCriteria,
  createDiscoveryQueryFootprint,
  DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION,
  omittedDiscoveryQueryFootprint,
  parseDiscoveryQueryFootprint,
  type DiscoveryQueryFootprintCall,
} from "./child-discovery-query-footprint.js"

const captured = captureDiscoveryQueryCriteria({
  targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], source: "greenhouse", pageSize: 20, cursor: "opaque-secret",
})
if (captured.availability !== "captured") throw new Error("query fixture invalid")
const capturedCriteria = captured.criteria

function call(overrides: Partial<DiscoveryQueryFootprintCall> = {}): DiscoveryQueryFootprintCall {
  return {
    criteria: capturedCriteria, outcome: "completed", requestCount: 1, observedCandidateCount: 0,
    providerFailures: 0, materializationFailures: 0, hasMore: false, ...overrides,
  }
}

describe("bounded Scout discovery query footprint", () => {
  it("copies only bounded criteria and exposes cursor presence, never its value", () => {
    const input = { targetRoles: ["Engineer"], targetLocations: [], cursor: "cursor-private", pageSize: 5 }
    const result = captureDiscoveryQueryCriteria(input)
    expect(result).toEqual({ availability: "captured", criteria: {
      targetRoles: ["Engineer"], targetLocations: [], pageSize: 5, hasCursor: true,
    } })
    expect(JSON.stringify(result)).not.toContain("cursor-private")
    input.targetRoles[0] = "mutated"
    if (result.availability === "captured") expect(result.criteria.targetRoles).toEqual(["Engineer"])
  })

  it("omits unsupported sources, unsafe free text, malformed values and extra fields", () => {
    expect(captureDiscoveryQueryCriteria({ targetRoles: ["Engineer"], targetLocations: [], source: "unknown-provider" }))
      .toMatchObject({ availability: "omitted" })
    expect(captureDiscoveryQueryCriteria({ targetRoles: ["person@example.com"], targetLocations: [] }))
      .toEqual({ availability: "omitted", omissionReason: "unsafe_criteria" })
    expect(captureDiscoveryQueryCriteria({ targetRoles: ["Engineer"], targetLocations: [], cursor: "" }))
      .toEqual({ availability: "omitted", omissionReason: "invalid_criteria" })
    expect(captureDiscoveryQueryCriteria({ targetRoles: ["Engineer"], targetLocations: [], raw: "private" }))
      .toEqual({ availability: "omitted", omissionReason: "invalid_criteria" })
  })

  it("round trips an exact bounded receipt projection and rejects identifiers or raw cursors", () => {
    const footprint = createDiscoveryQueryFootprint([call()])
    expect(parseDiscoveryQueryFootprint(footprint)).toEqual(footprint)
    expect(JSON.stringify(footprint)).not.toContain("opaque-secret")
    expect(parseDiscoveryQueryFootprint({ ...footprint, taskId: "private-task" })).toBeNull()
    expect(parseDiscoveryQueryFootprint({
      schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available",
      calls: [{ ...call(), criteria: { ...captured.criteria, cursor: "private-cursor" } }],
    })).toBeNull()
  })

  it("rejects accessor-backed payloads without reading them", () => {
    let reads = 0
    const hostile = { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available" }
    Object.defineProperty(hostile, "calls", { enumerable: true, get: () => { reads += 1; throw new Error("must not read") } })
    expect(parseDiscoveryQueryFootprint(hostile)).toBeNull()
    expect(reads).toBe(0)
  })

  it("requires unknown counts for failed or unresolved calls and validates omission markers", () => {
    expect(parseDiscoveryQueryFootprint(createDiscoveryQueryFootprint([call({
      outcome: "failed", requestCount: null, observedCandidateCount: null, providerFailures: null,
      materializationFailures: null, hasMore: null,
    })]))).not.toBeNull()
    const unresolvedWithKnownRequestCount = {
      schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available" as const,
      calls: [call({ outcome: "unresolved", requestCount: 1, observedCandidateCount: null, providerFailures: null,
        materializationFailures: null, hasMore: null })],
    }
    expect(parseDiscoveryQueryFootprint(unresolvedWithKnownRequestCount)).toBeNull()
    expect(parseDiscoveryQueryFootprint(omittedDiscoveryQueryFootprint("capture_unavailable"))).toMatchObject({ availability: "omitted" })
    expect(parseDiscoveryQueryFootprint({ schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION,
      availability: "omitted", omissionReason: "invented" })).toBeNull()
  })

  it("omits the whole footprint on call or byte caps instead of truncating", () => {
    const tooMany = createDiscoveryQueryFootprint(Array.from({ length: 9 }, () => call()))
    expect(tooMany).toMatchObject({ availability: "omitted", omissionReason: "call_limit" })
    const longCall = call({ criteria: {
      targetRoles: Array(8).fill("r".repeat(160)), targetLocations: Array(8).fill("l".repeat(160)), hasCursor: false,
    } })
    expect(createDiscoveryQueryFootprint(Array(8).fill(longCall)))
      .toMatchObject({ availability: "omitted", omissionReason: "byte_limit" })
  })
})
