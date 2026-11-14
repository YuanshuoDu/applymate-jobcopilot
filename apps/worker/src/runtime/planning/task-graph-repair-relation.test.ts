import { describe, expect, it } from "vitest"

import { isValidTaskGraphRepairRelation } from "./task-graph-repair-relation.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "./task-graph-verification.js"
import type { TaskGraphNodeProposal } from "./task-graph.js"

const locationCheck = { kind: "candidate_location_in" as const, locations: ["Dublin", "Berlin"] }
const target: TaskGraphNodeProposal & Readonly<{ taskId: string; verificationDisposition: "typed" }> = {
  key: "source", taskId: "source-task", templateId: "scout", goal: "Find candidates", successCriteria: ["Verified"], dependsOn: [],
  verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout", criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
    { id: "candidate-location", check: locationCheck },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ] },
}
const relation = { graphRootTaskId: "root-task", nodeKey: "source", taskId: "source-task", criterionIds: ["candidate-count"] }
type Criterion = NonNullable<TaskGraphNodeProposal["verification"]>["criteria"][number]
const repair = (criteria: readonly Criterion[], repairOf = relation): TaskGraphNodeProposal => ({
  key: "repair", templateId: "scout", goal: "Recheck", successCriteria: ["Verified"], dependsOn: [], repairOf,
  verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout", criteria },
})

describe("TaskGraph repair relation location guards", () => {
  it("requires the exact target location invariant without adding it to repairOf", () => {
    expect(isValidTaskGraphRepairRelation(repair([
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
      { id: "candidate-location", check: { kind: "candidate_location_in", locations: [" berlin ", "DUBLIN"] } },
    ]), target)).toBe(true)
    expect(relation.criterionIds).toEqual(["candidate-count"])
  })

  it("accepts a failed location criterion and a mixed failed count/location relation", () => {
    const locationOnly = repair([{ id: "candidate-location", check: locationCheck }], { ...relation, criterionIds: ["candidate-location"] })
    const mixed = repair([
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
      { id: "candidate-location", check: locationCheck },
    ], { ...relation, criterionIds: ["candidate-count", "candidate-location"] })
    expect(isValidTaskGraphRepairRelation(locationOnly, target)).toBe(true)
    expect(isValidTaskGraphRepairRelation(mixed, target)).toBe(true)
  })

  it("rejects missing, weakened, renamed, or unrelated repair criteria", () => {
    const countOnly = [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }]
    const invalid = [
      repair(countOnly),
      repair([...countOnly, { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin"] } }]),
      repair([...countOnly, { id: "other-location", check: locationCheck }]),
      repair([...countOnly, { id: "candidate-location", check: locationCheck }, { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } }]),
    ]
    for (const node of invalid) expect(isValidTaskGraphRepairRelation(node, target)).toBe(false)
  })

  it("keeps legacy v1 non-location repairs exact and does not invent a location guard", () => {
    const legacyTarget = { ...target, verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }] } }
    const legacyRepair = { ...repair([{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }]), verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }],
    } }
    expect(isValidTaskGraphRepairRelation(legacyRepair, legacyTarget)).toBe(true)
    expect(isValidTaskGraphRepairRelation(repair([
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
      { id: "candidate-location", check: locationCheck },
    ]), legacyTarget)).toBe(false)
  })
})
