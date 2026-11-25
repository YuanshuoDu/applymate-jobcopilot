import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA,
  parseObjectiveTailorFinalOutcomeSidecar,
} from "./objective-tailor-final-outcome-sidecar.js"

const validV1 = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
  slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }] }
const validV2 = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA, graphRevision: 7,
  slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "rejected" }], sourceCounts: {
    discoveredJobs: { knownCount: 0, coverage: "complete" }, analyzedJobs: { knownCount: null, coverage: "unavailable" },
  } }

describe("parseObjectiveTailorFinalOutcomeSidecar", () => {
  it("preserves the historical V1 slot-only representation", () => {
    expect(parseObjectiveTailorFinalOutcomeSidecar(validV1)).toEqual(validV1)
  })

  it("accepts V2 exact source counts and clones the normalized projection", () => {
    const parsed = parseObjectiveTailorFinalOutcomeSidecar(validV2)
    expect(parsed).toEqual(validV2)
    expect(parsed).not.toBe(validV2)
    expect(parsed?.slots).not.toBe(validV2.slots)
  })

  it("distinguishes complete zero, partial evidence, and unavailable counts", () => {
    const value = { ...validV2, sourceCounts: {
      discoveredJobs: { knownCount: 0, coverage: "complete" },
      analyzedJobs: { knownCount: 3, coverage: "partial" },
    } }
    expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toEqual(value)
    const notRequested = { ...validV2, sourceCounts: { discoveredJobs: { knownCount: null, coverage: "not_requested" },
      analyzedJobs: { knownCount: Number.MAX_SAFE_INTEGER, coverage: "complete" } } }
    expect(parseObjectiveTailorFinalOutcomeSidecar(notRequested)).toEqual(notRequested)
    for (const count of [
      { knownCount: null, coverage: "complete" }, { knownCount: 0, coverage: "not_requested" },
      { knownCount: -1, coverage: "partial" }, { knownCount: Number.MAX_SAFE_INTEGER + 1, coverage: "complete" },
    ]) expect(parseObjectiveTailorFinalOutcomeSidecar({ ...validV2, sourceCounts: { discoveredJobs: count, analyzedJobs: validV2.sourceCounts.analyzedJobs } })).toBeUndefined()
  })

  it("rejects invalid V2 revision, extras, malformed slots, and coverage", () => {
    const bad = [
      { ...validV2, graphRevision: 0 }, { ...validV2, graphRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...validV2, privateProof: "private" }, { ...validV2, slots: [{ ordinal: 2, status: "ready" }] },
      { ...validV2, slots: [{ ordinal: 1, status: "pending" }] },
      { ...validV2, sourceCounts: { ...validV2.sourceCounts, privateHash: "private" } },
      { ...validV2, sourceCounts: { ...validV2.sourceCounts, discoveredJobs: { knownCount: null, coverage: "partial" } } },
    ]
    for (const value of bad) expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toBeUndefined()
  })

  it("rejects malformed historical V1 fields without changing valid V1 acceptance", () => {
    const extra = { ...validV1, graphDigest: "private" }
    const privateSlot = { schemaVersion: validV1.schemaVersion, slots: [{ ...validV1.slots[0], taskId: "private-task" }] }
    const accessor = { schemaVersion: validV1.schemaVersion, slots: [{ ordinal: 1, get status() { throw new Error("must not run") } }] }
    const duplicateOrdinal = { schemaVersion: validV1.schemaVersion, slots: [{ ordinal: 1, status: "ready" }, { ordinal: 1, status: "failed" }] }
    const unsupported = { schemaVersion: validV1.schemaVersion, slots: [{ ordinal: 1, status: "pending" }] }
    const sparse = { schemaVersion: validV1.schemaVersion, slots: Array(1) }
    for (const value of [extra, privateSlot, accessor, duplicateOrdinal, unsupported, sparse, { ...validV1, unknown: true }]) {
      expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toBeUndefined()
    }
  })

  it("rejects root accessors, symbols, and more than eight slots", () => {
    const accessor = Object.defineProperty({ slots: validV1.slots }, "schemaVersion", { enumerable: true, get: () => validV1.schemaVersion })
    const symbol = { ...validV1, [Symbol("extra")]: true }
    const tooMany = { schemaVersion: validV1.schemaVersion, slots: Array.from({ length: 9 }, (_, index) => ({ ordinal: index + 1, status: "ready" })) }
    for (const value of [accessor, symbol, tooMany]) expect(parseObjectiveTailorFinalOutcomeSidecar(value)).toBeUndefined()
  })
})
