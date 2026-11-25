import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA, OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA,
  parseObjectiveTailorFinalOutcomeSidecar } from "@jobcopilot/agent-protocol"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA } from "./objective-tailor-final-summary-binding.js"
import { objectiveTailorFinalOutcomeSidecarMatches, readObjectiveTailorFinalOutcomeSidecar } from "./objective-tailor-final-sidecar.js"

const privateOutcome = {
  schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA, graphRevision: 7, rootAttemptCount: 2,
  graphDigest: "a".repeat(64), sourceNodeCount: 2, sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64),
  slots: [{ ordinal: 1, status: "ready", evidenceDigest: "d".repeat(64) }, { ordinal: 2, status: "needs_revision", evidenceDigest: "e".repeat(64) }],
}

const sourceSummary = {
  graphRevision: 7,
  counts: { discoveredJobs: { knownCount: 1, coverage: "complete" }, analyzedJobs: { knownCount: 1, coverage: "complete" } },
  discoveredJobs: [{ jobId: "job-private", taskIds: ["task-private-0"] }],
  analyzedJobs: [{ jobId: "job-private", findings: [{ taskId: "task-private-1", score: 8 }] }],
  taskOutcomes: ["scout", "analyst"].map((role, index) => ({ taskId: `task-private-${index}`, role,
    taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" })),
}

function binding(outcome: unknown = privateOutcome, summary: unknown = sourceSummary): TaskGraphFinalSummaryBinding {
  return {
    rootTaskId: "root-private", graphItemId: taskGraphItemId("root-private"), graphRevision: 7,
    members: ["scout", "analyst"].map((role, nodeIndex) => ({ nodeIndex, nodeKey: `source-${nodeIndex}`, templateId: role,
      role, taskType: role, taskId: `task-private-${nodeIndex}`, taskStatus: "completed", kind: "business" as const })),
    summary, objectiveTailorFinalOutcome: outcome,
  } as unknown as TaskGraphFinalSummaryBinding
}
function ordinaryBinding(): TaskGraphFinalSummaryBinding {
  const { objectiveTailorFinalOutcome: _private, ...ordinary } = binding()
  return ordinary
}

describe("objective-tailor-final-sidecar", () => {
  it("projects only exact slot ordinals and settled statuses from the private binding", () => {
    const read = readObjectiveTailorFinalOutcomeSidecar(binding())
    expect(read).toEqual({ status: "ready", sidecar: { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA,
      graphRevision: 7, slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }],
      sourceCounts: { discoveredJobs: { knownCount: 1, coverage: "complete" }, analyzedJobs: { knownCount: 1, coverage: "complete" } } } })
    expect(JSON.stringify(read)).not.toMatch(/root-private|task-private|graphDigest|evidenceDigest|sha256|sourceStatusDigest/)
  })

  it("distinguishes ordinary absence from a malformed marked proof", () => {
    expect(readObjectiveTailorFinalOutcomeSidecar(undefined)).toEqual({ status: "absent" })
    expect(readObjectiveTailorFinalOutcomeSidecar(binding({ ...privateOutcome, unknown: true }))).toEqual({ status: "invalid" })
  })

  it("matches only the exact public projection and fails closed on an injected sidecar", () => {
    const exact = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA, graphRevision: 7,
      slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }],
      sourceCounts: { discoveredJobs: { knownCount: 1, coverage: "complete" }, analyzedJobs: { knownCount: 1, coverage: "complete" } } }
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), exact)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact, slots: [{ ordinal: 1, status: "ready" }] })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact, taskId: "injected" })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact, graphRevision: 8 })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact,
      sourceCounts: { ...exact.sourceCounts, discoveredJobs: { knownCount: 2, coverage: "complete" } } })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact,
      sourceCounts: { ...exact.sourceCounts, analyzedJobs: { knownCount: 1, coverage: "partial" } } })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
      slots: exact.slots })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), exact)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(ordinaryBinding(), undefined)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(ordinaryBinding(), exact)).toBe(false)
  })

  it("rejects a summary whose graph revision differs from the private Objective proof", () => {
    expect(readObjectiveTailorFinalOutcomeSidecar(binding(privateOutcome, { ...sourceSummary, graphRevision: 8 }))).toEqual({ status: "invalid" })
  })

  it("keeps the protocol's historical V1 sidecar parser available", () => {
    const legacy = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
      slots: [{ ordinal: 1, status: "ready" }] }
    expect(parseObjectiveTailorFinalOutcomeSidecar(legacy)).toEqual(legacy)
  })
})
