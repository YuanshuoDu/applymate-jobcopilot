import { describe, expect, it } from "vitest"
import { createDiscoveryQueryFootprint, DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, type DiscoveryQueryFootprint } from "../subagents/child-discovery-query-footprint.js"
import { projectRootTaskHistoryDiscoveryFootprint, projectRootTaskHistoryGraph } from "./root-task-history-discovery-footprint.js"

const criteria = { targetRoles: ["Backend Engineer"], targetLocations: ["Dublin"], source: "lever" as const, pageSize: 20, hasCursor: false }
function footprint(): DiscoveryQueryFootprint {
  return createDiscoveryQueryFootprint([{ criteria, outcome: "completed", requestCount: 1, observedCandidateCount: 0,
    providerFailures: 0, materializationFailures: 0, hasMore: false }])
}
function scout(overrides: Record<string, unknown> = {}) {
  return { templateId: "scout", status: "failed", verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1",
    role: "scout", criteria: [{ id: "scout-count", check: { kind: "candidate_count_gte", minimum: 1 } }] },
    discoveryQueryFootprint: footprint(), ...overrides }
}

describe("Root history Scout query-footprint projection", () => {
  it("keeps only an exact valid footprint and the ordinary eligibility marker", () => {
    const source = { revision: 3, discoveryTurnEligibility: "ordinary" as const, nodes: [scout()] } as never
    const projected = projectRootTaskHistoryGraph(source, false)
    expect(projected).toEqual({ revision: 3, nodes: [{ ...scout(), discoveryQueryFootprint: footprint() }], discoveryTurnEligibility: "ordinary" })
  })

  it("refuses scheduled, cross-session, non-Scout, untyped, repaired and native graph nodes", () => {
    const valid = scout(), typed = valid.verification
    const cases = [
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "scheduled", nodes: [valid] } as never, false),
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "ordinary", nodes: [valid] } as never, true),
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "ordinary", nodes: [scout({ templateId: "analyst" })] } as never, false),
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "ordinary", nodes: [scout({ verification: undefined })] } as never, false),
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "ordinary", nodes: [scout({ repairOf: {} })] } as never, false),
      projectRootTaskHistoryGraph({ revision: 1, discoveryTurnEligibility: "ordinary", nodes: [scout({ nativeResult: {} })] } as never, false),
    ]
    expect(cases.every(graph => !Object.hasOwn(graph.nodes[0]!, "discoveryQueryFootprint"))).toBe(true)
    expect(projectRootTaskHistoryDiscoveryFootprint({ ...valid, verification: typed })).toEqual(footprint())
  })

  it("rejects augmented, malformed, oversized and accessor-backed footprints without reading accessors", () => {
    const valid = footprint(), base = scout()
    let reads = 0
    const accessor = { ...base }
    Object.defineProperty(accessor, "discoveryQueryFootprint", { enumerable: true, get() { reads++; return valid } })
    const absent: Record<string, unknown> = { ...base }
    delete absent.discoveryQueryFootprint
    const oversized = { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available",
      calls: Array.from({ length: 8 }, () => ({ criteria: { ...criteria, targetRoles: Array(8).fill("x".repeat(160)),
        targetLocations: Array(8).fill("y".repeat(160)) }, outcome: "completed",
        requestCount: 1, observedCandidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false })) }
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: { ...valid, private: true } }))).toBeUndefined()
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: { ...valid, calls: [] } }))).toBeUndefined()
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: oversized }))).toBeUndefined()
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: { ...valid, schemaVersion: "legacy" } }))).toBeUndefined()
    expect(projectRootTaskHistoryDiscoveryFootprint(absent)).toBeUndefined()
    expect(projectRootTaskHistoryDiscoveryFootprint(accessor)).toBeUndefined()
    expect(reads).toBe(0)
  })

  it("preserves explicit unknown receipt fields and valid omission state without inventing completeness", () => {
    const unknown = createDiscoveryQueryFootprint([{ criteria, outcome: "unresolved", requestCount: null,
      observedCandidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null }])
    const omitted: DiscoveryQueryFootprint = { schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION,
      availability: "omitted", omissionReason: "capture_unavailable" }
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: unknown }))).toEqual(unknown)
    expect(projectRootTaskHistoryDiscoveryFootprint(scout({ discoveryQueryFootprint: omitted }))).toEqual(omitted)
    expect(JSON.stringify(unknown)).not.toContain("complete")
  })
})
