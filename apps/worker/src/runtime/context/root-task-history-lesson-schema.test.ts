import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "../subagents/task-graph-snapshot.js"
import { describeValidatedRootTaskHistoryChecks, filterRootTaskHistoryLessonsForEmittedNodes,
  parseRootTaskHistoryNodeLesson } from "./root-task-history-lesson-schema.js"

const scoutChecks = [
  { id: "scout-count", check: { kind: "candidate_count_gte", minimum: 50 } },
  { id: "scout-evidence", check: { kind: "evidence_count_gte", minimum: 1 } },
  { id: "scout-complete", check: { kind: "all_candidates_have_evidence", minimumItems: 2 } },
] as const
const analystChecks = [
  { id: "analyst-count", check: { kind: "finding_count_gte", minimum: 49 } },
  { id: "analyst-evidence", check: { kind: "evidence_count_gte", minimum: 3 } },
  { id: "analyst-complete", check: { kind: "all_findings_have_evidence", minimumItems: 4 } },
  { id: "analyst-score", check: { kind: "reported_score_gte", minimumScore: 10, minimumFindings: 5, aggregation: "all" } },
  { id: "analyst-source", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-key" } },
] as const

function snapshot(withDirectDependency = true, analystChecksOverride: readonly unknown[] = analystChecks) {
  return {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [
      { key: "scout-key", templateId: "scout", goal: "scout", successCriteria: ["find"], dependsOn: [], depth: 1,
        taskId: "scout-task", verificationDisposition: "typed",
        verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: scoutChecks } },
      { key: "analyst-key", templateId: "analyst", goal: "analyze", successCriteria: ["score"],
        dependsOn: withDirectDependency ? ["scout-key"] : [], depth: 2, taskId: "analyst-task", verificationDisposition: "typed",
        verification: { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst", criteria: analystChecksOverride } },
    ],
  }
}

describe("root history check descriptor schema", () => {
  it("projects all seven typed checks with bounded operands and canonical dependency ordinal", () => {
    const facts = describeValidatedRootTaskHistoryChecks(snapshot())
    expect(facts).toEqual([
      [
        { role: "scout", kind: "candidate_count_gte", minimum: 50 },
        { role: "scout", kind: "evidence_count_gte", minimum: 1 },
        { role: "scout", kind: "all_candidates_have_evidence", minimumItems: 2 },
      ],
      [
        { role: "analyst", kind: "finding_count_gte", minimum: 49 },
        { role: "analyst", kind: "evidence_count_gte", minimum: 3 },
        { role: "analyst", kind: "all_findings_have_evidence", minimumItems: 4 },
        { role: "analyst", kind: "reported_score_gte", minimumScore: 10, minimumFindings: 5, aggregation: "all" },
        { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 },
      ],
    ])
    const serialized = JSON.stringify(facts)
    for (const privateValue of ["scout-key", "analyst-key", "scout-task", "analyst-task", "analyst-source"]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it("fails closed for invalid whole-graph role, dependency, or numeric contracts", () => {
    expect(describeValidatedRootTaskHistoryChecks(snapshot(false))).toBeUndefined()
    const wrongRole = [{ ...analystChecks[0]!, check: { kind: "candidate_count_gte", minimum: 1 } }]
    expect(describeValidatedRootTaskHistoryChecks(snapshot(true, wrongRole))).toBeUndefined()
    const outOfBounds = [{ ...analystChecks[0]!, check: { kind: "finding_count_gte", minimum: 51 } }]
    expect(describeValidatedRootTaskHistoryChecks(snapshot(true, outOfBounds))).toBeUndefined()
  })

  it("accepts only exact check shapes and the current bounded ranges", () => {
    const base = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] }
    const rejects = (check: unknown, role: string) => parseRootTaskHistoryNodeLesson({ ...base,
      criterionFailures: [{ ...base.criterionFailures[0], check }] }, role)
    expect(rejects({ role: "scout", kind: "candidate_count_gte", minimum: 0 }, "scout")).toBeUndefined()
    expect(rejects({ role: "scout", kind: "candidate_count_gte", minimum: 51 }, "scout")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "reported_score_gte", minimumScore: Number.NaN,
      minimumFindings: 1, aggregation: "any" }, "analyst")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "reported_score_gte", minimumScore: 10.1,
      minimumFindings: 1, aggregation: "any" }, "analyst")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "reported_score_gte", minimumScore: 10,
      minimumFindings: 1, aggregation: "sometimes" }, "analyst")).toBeUndefined()
    expect(rejects({ role: "scout", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 }, "scout")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 9 }, "analyst")).toBeUndefined()
    expect(rejects({ role: "scout", kind: "candidate_count_gte", minimum: 1, criterionId: "private" }, "scout")).toBeUndefined()
  })

  it("keeps legacy lessons and strips a dependency descriptor when its source node is pruned", () => {
    const legacy = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] }
    expect(parseRootTaskHistoryNodeLesson(legacy)).toEqual(legacy)
    const dependent = parseRootTaskHistoryNodeLesson({ ordinalScope: "source_graph_local", advisoryOnly: true,
      notCurrentEvidence: true, nodeOrdinal: 2, criterionFailures: [{ criterionOrdinal: 1, status: "unverified",
        reasonCode: "criterion_not_met", check: { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } }] }, "analyst")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [1, 2])).toEqual([undefined, dependent])
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [2])[1]?.criterionFailures).toEqual([
      { criterionOrdinal: 1, status: "unverified", reasonCode: "criterion_not_met" },
    ])
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [1])).toEqual([undefined, undefined])
    const pruned = filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2])
    expect(pruned[1]?.criterionFailures).toEqual([{ criterionOrdinal: 1, status: "unverified", reasonCode: "criterion_not_met" }])
    expect(parseRootTaskHistoryNodeLesson({ ...legacy, criterionFailures: [{ ...legacy.criterionFailures[0],
      check: { role: "scout", kind: "candidate_count_gte", minimum: 1 } }] }, "analyst")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...legacy, criterionFailures: [{ ...legacy.criterionFailures[0],
      check: { role: "scout", kind: "candidate_count_gte", minimum: 1, privateId: "secret" } }] })).toBeUndefined()
  })
})
