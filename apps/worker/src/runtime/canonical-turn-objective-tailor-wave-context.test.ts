import { describe, expect, it } from "vitest"
import { appendObjectiveTailorWaveCandidateCatalog, appendObjectiveTailorWaveOutcomeObservation,
  objectiveTailorWaveSlotsFromCurrentGraph, OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID,
  OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID, parseObjectiveTailorWaveOutcomeObservation } from "./canonical-turn-objective-tailor-wave-context.js"
import { OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA } from "./subagents/objective-tailor-candidate-v2.js"
import { OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA } from "./objective-tailor-wave-outcome-projection.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"

const snapshot: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], taskGraphRevision: 3, toolObservations: [
  { id: OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID, content: { stale: true } },
  { id: "other", content: { retained: true } },
] }
const catalog = { schemaVersion: OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, graphRevision: 3,
  candidates: [{ candidateRef: `otc2_${"a".repeat(64)}`, title: "Engineer", company: "Example", score: 8 }] }
const pair = (prefix: string) => ({ writer: { taskId: `${prefix}-writer`, status: "completed", readiness: "terminal" },
  reviewer: { taskId: `${prefix}-reviewer`, status: "completed", readiness: "terminal" } })
const graphSlots = [{ slotId: "tailor-1", effectivePair: "initial" as const }]
const currentGraph = { kind: "task_graph_current", revision: 3, objectiveTailorWave: {
  schemaVersion: "agent-harness.v2.objective-tailor-wave-view.v1", graphRevision: 3, sourceNodeCount: 2, ordinaryPlanAppend: "closed",
  slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst-source", effectivePair: "initial", initial: pair("initial") }],
} }
const outcome = { schemaVersion: OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA, graphRevision: 3,
  slots: [{ slotId: "tailor-1", effectivePair: "initial", status: "ready" }] }

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

  it("appends only the exact current ordered slot projection and strips prior or caller outcomes", () => {
    const base = { ...snapshot, toolObservations: [
      ...snapshot.toolObservations, { id: OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID, content: { private: "spoofed" } },
    ] }
    const current = objectiveTailorWaveSlotsFromCurrentGraph(currentGraph)
    expect(current).toEqual({ graphRevision: 3, slots: graphSlots })
    const projected = appendObjectiveTailorWaveOutcomeObservation(base, outcome, 3, current?.slots)
    expect(projected.toolObservations).toEqual([
      { id: OBJECTIVE_TAILOR_WAVE_CATALOG_OBSERVATION_ID, content: { stale: true } },
      { id: "other", content: { retained: true } },
      { id: OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID, content: { kind: "objective_tailor_wave_outcomes", ...outcome } },
    ])
    expect(appendObjectiveTailorWaveOutcomeObservation(base, outcome, 3).toolObservations.some(item =>
      item.id === OBJECTIVE_TAILOR_WAVE_OUTCOME_OBSERVATION_ID)).toBe(false)
  })

  it("rejects stale revisions, malformed slot identity or order, missing rows, extras, and hostile arrays", () => {
    const twoSlots = [{ slotId: "tailor-1", effectivePair: "initial" as const }, { slotId: "tailor-2", effectivePair: "correction" as const }]
    const twoOutcomes = { ...outcome, slots: [outcome.slots[0], { slotId: "tailor-2", effectivePair: "correction", status: "pending" }] }
    for (const candidate of [
      { ...outcome, graphRevision: 2 }, { ...outcome, slots: [] },
      { ...twoOutcomes, slots: [twoOutcomes.slots[0], { ...twoOutcomes.slots[1], slotId: "tailor-1" }] },
      { ...twoOutcomes, slots: [...twoOutcomes.slots].reverse() },
      { ...outcome, slots: [{ ...outcome.slots[0], slotId: "bad-slot" }] },
      { ...outcome, slots: [{ ...outcome.slots[0], status: "approved" }] },
      { ...outcome, slots: [{ ...outcome.slots[0], taskId: "private" }] },
    ]) expect(parseObjectiveTailorWaveOutcomeObservation(candidate, 3)).toBeUndefined()
    expect(parseObjectiveTailorWaveOutcomeObservation(twoOutcomes, 3, twoSlots)).toMatchObject({ slots: twoSlots })
    expect(parseObjectiveTailorWaveOutcomeObservation(twoOutcomes, 3, graphSlots)).toBeUndefined()
    const sparse = new Array(1)
    expect(parseObjectiveTailorWaveOutcomeObservation({ ...outcome, slots: sparse }, 3)).toBeUndefined()
    const accessorSlot = Object.defineProperty({ slotId: "tailor-1", effectivePair: "initial" }, "status",
      { enumerable: true, get: () => "ready" })
    expect(parseObjectiveTailorWaveOutcomeObservation({ ...outcome, slots: [accessorSlot] }, 3)).toBeUndefined()
    expect(objectiveTailorWaveSlotsFromCurrentGraph({ ...currentGraph, objectiveTailorWave: {
      ...currentGraph.objectiveTailorWave, slots: [{ ...currentGraph.objectiveTailorWave.slots[0], effectivePair: "correction" }],
    } })).toBeUndefined()
  })
})
