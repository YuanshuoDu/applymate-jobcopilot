import { describe, expect, it } from "vitest"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA } from "@jobcopilot/agent-protocol"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA } from "./objective-tailor-final-summary-binding.js"
import { objectiveTailorFinalOutcomeSidecarMatches, readObjectiveTailorFinalOutcomeSidecar } from "./objective-tailor-final-sidecar.js"

const privateOutcome = {
  schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA, graphRevision: 7, rootAttemptCount: 2,
  graphDigest: "a".repeat(64), sourceNodeCount: 2, sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64),
  slots: [{ ordinal: 1, status: "ready", evidenceDigest: "d".repeat(64) }, { ordinal: 2, status: "needs_revision", evidenceDigest: "e".repeat(64) }],
}

function binding(outcome: unknown = privateOutcome): TaskGraphFinalSummaryBinding {
  return {
    rootTaskId: "root-private", graphItemId: taskGraphItemId("root-private"), graphRevision: 7,
    members: ["scout", "analyst"].map((role, nodeIndex) => ({ nodeIndex, nodeKey: `source-${nodeIndex}`, templateId: role,
      role, taskType: role, taskId: `task-private-${nodeIndex}`, taskStatus: "completed", kind: "business" as const })),
    summary: {
      graphRevision: 7,
      taskOutcomes: ["scout", "analyst"].map((role, index) => ({ taskId: `task-private-${index}`, role,
        taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" })),
      discoveredJobs: [], analyzedJobs: [], prepareResults: [], artifactReferences: [], reviewOutcomes: [],
      counts: {
        discoveredJobs: { coverage: "complete", knownCount: 0 }, analyzedJobs: { coverage: "complete", knownCount: 0 },
        prepareJobs: { coverage: "not_requested", knownCount: null }, artifactReferences: { coverage: "not_requested", knownCount: null },
        reviewOutcomes: { coverage: "not_requested", knownCount: null },
      },
    }, objectiveTailorFinalOutcome: outcome,
  } as unknown as TaskGraphFinalSummaryBinding
}
function ordinaryBinding(): TaskGraphFinalSummaryBinding {
  const { objectiveTailorFinalOutcome: _private, ...ordinary } = binding()
  return ordinary
}

describe("objective-tailor-final-sidecar", () => {
  it("projects only exact slot ordinals and settled statuses from the private binding", () => {
    const read = readObjectiveTailorFinalOutcomeSidecar(binding())
    expect(read).toEqual({ status: "ready", sidecar: { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
      slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }] } })
    expect(JSON.stringify(read)).not.toMatch(/root-private|task-private|graphDigest|evidenceDigest|sha256|sourceStatusDigest/)
  })

  it("distinguishes ordinary absence from a malformed marked proof", () => {
    expect(readObjectiveTailorFinalOutcomeSidecar(undefined)).toEqual({ status: "absent" })
    expect(readObjectiveTailorFinalOutcomeSidecar(binding({ ...privateOutcome, unknown: true }))).toEqual({ status: "invalid" })
  })

  it("rejects incomplete summaries and forged retired Scout proof", () => {
    const source = binding()
    expect(readObjectiveTailorFinalOutcomeSidecar({ ...source, summary: { graphRevision: 7 } })).toEqual({ status: "invalid" })
    const retired = {
      ...source,
      members: source.members!.map((member, index) => index === 0 ? { ...member, taskType: "job_discovery",
        taskStatus: "interrupted", kind: "retired", retirement: { attempt: 1, interruptRequestedAt: "2026-11-19T10:00:00.000Z",
          receiptEventId: "receipt", lifecycleEventId: "lifecycle" } } : member),
      summary: { ...source.summary, taskOutcomes: source.summary.taskOutcomes.slice(1), counts: { ...source.summary.counts,
        discoveredJobs: { coverage: "not_requested", knownCount: null } } },
    }
    expect(readObjectiveTailorFinalOutcomeSidecar(retired).status).toBe("ready")
    const forged = { ...retired, members: retired.members.map((member, index) => index === 0
      ? { ...member, retirement: { attempt: 0, interruptRequestedAt: "2026-11-19T10:00:00.000Z", receiptEventId: "receipt", lifecycleEventId: "lifecycle" } }
      : member) }
    expect(readObjectiveTailorFinalOutcomeSidecar(forged)).toEqual({ status: "invalid" })
  })

  it("matches only the exact public projection and fails closed on an injected sidecar", () => {
    const exact = { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
      slots: [{ ordinal: 1, status: "ready" }, { ordinal: 2, status: "needs_revision" }] }
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), exact)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact, slots: [{ ordinal: 1, status: "ready" }] })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), { ...exact, taskId: "injected" })).toBe(false)
    expect(objectiveTailorFinalOutcomeSidecarMatches(binding(), exact)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(ordinaryBinding(), undefined)).toBe(true)
    expect(objectiveTailorFinalOutcomeSidecarMatches(ordinaryBinding(), exact)).toBe(false)
  })
})
