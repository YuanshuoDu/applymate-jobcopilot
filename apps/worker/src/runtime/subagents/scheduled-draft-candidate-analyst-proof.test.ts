import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationCheck, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { hasScheduledDraftMembershipRequirement } from "./scheduled-draft-candidate-analyst-proof.js"

const contract = (check: TaskGraphVerificationCheck): TaskGraphVerificationContract => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "eligibility", check }],
})

describe("scheduled draft Analyst membership proof", () => {
  it("qualifies existing scalar and explicit union membership checks", () => {
    expect(hasScheduledDraftMembershipRequirement(contract({ kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" }))).toBe(true)
    expect(hasScheduledDraftMembershipRequirement(contract({ kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"] }))).toBe(true)
  })

  it("does not qualify coverage or count checks without a membership criterion", () => {
    expect(hasScheduledDraftMembershipRequirement(contract({ kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout", minimumPercent: 100 }))).toBe(false)
    expect(hasScheduledDraftMembershipRequirement(contract({ kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 100 }))).toBe(false)
    expect(hasScheduledDraftMembershipRequirement(contract({ kind: "finding_count_gte", minimum: 1 }))).toBe(false)
    expect(hasScheduledDraftMembershipRequirement(undefined)).toBe(false)
  })
})
