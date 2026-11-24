import { describe, expect, it } from "vitest"
import { appendObjectiveTailorWaveCandidateCatalog, OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID } from "./canonical-turn-objective-tailor-wave-context.js"
import { OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA } from "./subagents/objective-tailor-candidate-v2.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"

const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], taskGraphRevision: 3, toolObservations: [
  { id: OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID, content: { stale: true } },
  { id: "other", content: { retained: true } },
] }
const catalog = { schemaVersion: OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, graphRevision: 3,
  candidates: [{ candidateRef: `otc2_${"a".repeat(64)}`, title: "Engineer", company: "Example", score: 8 }] }

describe("Objective Tailor wave context projection", () => {
  it("replaces only the current wave catalog with the exact bounded public shape", () => {
    const projected = appendObjectiveTailorWaveCandidateCatalog(snapshot, catalog, 3)
    expect(projected.toolObservations).toEqual([
      { id: "other", content: { retained: true } },
      { id: OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID, content: { kind: "objective_tailor_wave_candidate_catalog", catalog } },
    ])
    expect(appendObjectiveTailorWaveCandidateCatalog(projected, undefined, 3).toolObservations).toEqual([{ id: "other", content: { retained: true } }])
  })

  it("fails closed on stale, malformed, duplicate, oversized, or accessor-backed catalog rows", () => {
    expect(appendObjectiveTailorWaveCandidateCatalog(snapshot, catalog, 2).toolObservations).toEqual([{ id: "other", content: { retained: true } }])
    expect(appendObjectiveTailorWaveCandidateCatalog(snapshot, { ...catalog, candidates: [{ ...catalog.candidates[0], candidateRef: `otc1_${"a".repeat(64)}` }] }, 3)
      .toolObservations).toEqual([{ id: "other", content: { retained: true } }])
    expect(appendObjectiveTailorWaveCandidateCatalog(snapshot, { ...catalog, candidates: [catalog.candidates[0], catalog.candidates[0]] }, 3)
      .toolObservations).toEqual([{ id: "other", content: { retained: true } }])
    expect(appendObjectiveTailorWaveCandidateCatalog(snapshot, { ...catalog, extra: true }, 3)
      .toolObservations).toEqual([{ id: "other", content: { retained: true } }])
    const accessor = Object.defineProperty({}, "schemaVersion", { enumerable: true, get: () => OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA })
    expect(appendObjectiveTailorWaveCandidateCatalog(snapshot, accessor, 3).toolObservations).toEqual([{ id: "other", content: { retained: true } }])
    const hostileCandidates = new Proxy([], { getPrototypeOf() { throw new Error("untrusted_proxy") } })
    expect(() => appendObjectiveTailorWaveCandidateCatalog(snapshot, {
      schemaVersion: OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, graphRevision: 3, candidates: hostileCandidates,
    }, 3)).not.toThrow()
  })
})
