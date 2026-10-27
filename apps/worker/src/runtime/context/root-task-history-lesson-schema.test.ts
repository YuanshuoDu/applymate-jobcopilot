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
  { id: "analyst-coverage", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-key", minimumPercent: 75 } },
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
  it("projects typed checks with bounded operands and canonical dependency ordinals", () => {
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
        { role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75 },
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
    expect(rejects({ role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 0 }, "analyst")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 101 }, "analyst")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75.5 }, "analyst")).toBeUndefined()
    expect(rejects({ role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 9, minimumPercent: 75 }, "analyst")).toBeUndefined()
    expect(rejects({ role: "scout", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75 }, "scout")).toBeUndefined()
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
    const coverageDependent = parseRootTaskHistoryNodeLesson({ ordinalScope: "source_graph_local", advisoryOnly: true,
      notCurrentEvidence: true, nodeOrdinal: 2, criterionFailures: [{ criterionOrdinal: 2, status: "failed",
        reasonCode: "criterion_not_met", check: { role: "analyst", kind: "findings_cover_scout_candidates_gte", dependencyNodeOrdinal: 1, minimumPercent: 75 } }] }, "analyst")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, coverageDependent], [2], [1, 2])[1]?.criterionFailures)
      .toEqual(coverageDependent.criterionFailures)
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, coverageDependent], [2], [2])[1]?.criterionFailures).toEqual([
      { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" },
    ])
    expect(parseRootTaskHistoryNodeLesson({ ...legacy, criterionFailures: [{ ...legacy.criterionFailures[0],
      check: { role: "scout", kind: "candidate_count_gte", minimum: 1 } }] }, "analyst")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...legacy, criterionFailures: [{ ...legacy.criterionFailures[0],
      check: { role: "scout", kind: "candidate_count_gte", minimum: 1, privateId: "secret" } }] })).toBeUndefined()
  })
})

describe("ordinary passed criteria lesson schema", () => {
  const scoutCheck = { role: "scout", kind: "candidate_count_gte", minimum: 2 } as const
  const analystDependencyCheck = { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } as const
  const lesson = (passedCriteria: unknown) => ({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
    nodeOrdinal: 2, criterionFailures: [], passedCriteria })

  it("accepts only the positive-only completed lesson and rebuilds known role-bound descriptors", () => {
    const value = lesson([{ criterionOrdinal: 1, status: "passed", check: scoutCheck }])
    expect(parseRootTaskHistoryNodeLesson(value, "scout", "completed")).toEqual(value)
    expect(parseRootTaskHistoryNodeLesson(value, "scout", "failed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(value, "analyst", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, criterionFailures: [{ criterionOrdinal: 1,
      status: "failed", reasonCode: "criterion_not_met" }] }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, successfulRepairs: [] }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, failedRepairOf: { targetNodeOrdinal: 1,
      targetCriterionOrdinals: [1], outcome: "verified_failed" } }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, executionFailureCategory: "execution_setup_unavailable" },
      "scout", "completed")).toBeUndefined()
  })

  it("rejects empty, unordered, duplicated, augmented, and mixed-role pass facts", () => {
    const valid = lesson([{ criterionOrdinal: 1, status: "passed", check: scoutCheck }])
    for (const passedCriteria of [
      [], [{ criterionOrdinal: 1, status: "failed", check: scoutCheck }],
      [{ criterionOrdinal: 0, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 9, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 2, status: "passed", check: scoutCheck }, { criterionOrdinal: 1, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: scoutCheck }, { criterionOrdinal: 1, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: { ...scoutCheck, privateId: "secret" } }],
      [{ criterionOrdinal: 1, status: "passed", check: scoutCheck }, { criterionOrdinal: 2, status: "passed", check: analystDependencyCheck }],
    ]) expect(parseRootTaskHistoryNodeLesson({ ...valid, passedCriteria }, "scout", "completed")).toBeUndefined()
  })

  it("drops dependency pass facts when their referenced source is absent from emitted history", () => {
    const dependent = parseRootTaskHistoryNodeLesson(lesson([
      { criterionOrdinal: 1, status: "passed", check: analystDependencyCheck },
    ]), "analyst", "completed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [1, 2])[1]).toEqual(dependent)
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [2])).toEqual([undefined, undefined])
    const independent = parseRootTaskHistoryNodeLesson(lesson([
      { criterionOrdinal: 1, status: "passed", check: { role: "analyst", kind: "finding_count_gte", minimum: 1 } },
    ]), "analyst", "completed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, independent], [2], [2])[1]?.passedCriteria).toEqual(independent.passedCriteria)
  })
})

describe("ordinary passed criteria lesson schema", () => {
  const scoutCheck = { role: "scout", kind: "candidate_count_gte", minimum: 2 } as const
  const analystDependencyCheck = { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } as const
  const lesson = (passedCriteria: unknown) => ({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
    nodeOrdinal: 2, criterionFailures: [], passedCriteria })

  it("accepts only the positive-only completed lesson and rebuilds known role-bound descriptors", () => {
    const value = lesson([{ criterionOrdinal: 1, status: "passed", check: scoutCheck }])
    expect(parseRootTaskHistoryNodeLesson(value, "scout", "completed")).toEqual(value)
    expect(parseRootTaskHistoryNodeLesson(value, "scout", "failed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(value, "analyst", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, criterionFailures: [{ criterionOrdinal: 1,
      status: "failed", reasonCode: "criterion_not_met" }] }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, successfulRepairs: [] }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, failedRepairOf: { targetNodeOrdinal: 1,
      targetCriterionOrdinals: [1], outcome: "verified_failed" } }, "scout", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...value, executionFailureCategory: "execution_setup_unavailable" },
      "scout", "completed")).toBeUndefined()
  })

  it("rejects empty, unordered, duplicated, augmented, and mixed-role pass facts", () => {
    const valid = lesson([{ criterionOrdinal: 1, status: "passed", check: scoutCheck }])
    for (const passedCriteria of [
      [], [{ criterionOrdinal: 1, status: "failed", check: scoutCheck }],
      [{ criterionOrdinal: 0, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 9, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 2, status: "passed", check: scoutCheck }, { criterionOrdinal: 1, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: scoutCheck }, { criterionOrdinal: 1, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: { ...scoutCheck, privateId: "secret" } }],
      [{ criterionOrdinal: 1, status: "passed", check: scoutCheck }, { criterionOrdinal: 2, status: "passed", check: analystDependencyCheck }],
    ]) expect(parseRootTaskHistoryNodeLesson({ ...valid, passedCriteria }, "scout", "completed")).toBeUndefined()
  })

  it("drops dependency pass facts when their referenced source is absent from emitted history", () => {
    const dependent = parseRootTaskHistoryNodeLesson(lesson([
      { criterionOrdinal: 1, status: "passed", check: analystDependencyCheck },
    ]), "analyst", "completed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [1, 2])[1]).toEqual(dependent)
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, dependent], [2], [2])).toEqual([undefined, undefined])
    const independent = parseRootTaskHistoryNodeLesson(lesson([
      { criterionOrdinal: 1, status: "passed", check: { role: "analyst", kind: "finding_count_gte", minimum: 1 } },
    ]), "analyst", "completed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([undefined, independent], [2], [2])[1]?.passedCriteria).toEqual(independent.passedCriteria)
  })
})

describe("historical execution failure category lessons", () => {
  const categories = ["execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid"] as const
  const lesson = (executionFailureCategory: string) => ({ ordinalScope: "source_graph_local", advisoryOnly: true,
    notCurrentEvidence: true, nodeOrdinal: 1, criterionFailures: [], executionFailureCategory })

  it("accepts only the three exact categories in a failed category-only lesson", () => {
    for (const category of categories) {
      expect(parseRootTaskHistoryNodeLesson(lesson(category), undefined, "failed")).toEqual({
        ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
        nodeOrdinal: 1, criterionFailures: [], executionFailureCategory: category,
      })
    }
    expect(parseRootTaskHistoryNodeLesson(lesson("setup_unavailable"), undefined, "failed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(lesson(categories[0]), undefined, "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(lesson(categories[0]), undefined, "running")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(lesson(categories[0]))?.executionFailureCategory).toBe(categories[0])
  })

  it("rejects mixed, augmented, inherited, and accessor category shapes without invoking getters", () => {
    const valid = lesson(categories[0])
    expect(parseRootTaskHistoryNodeLesson({ ...valid, criterionFailures: [{ criterionOrdinal: 1,
      status: "failed", reasonCode: "criterion_not_met" }] })).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...valid, successfulRepairs: [] })).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...valid, privateId: "private" })).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson(Object.assign(Object.create({ executionFailureCategory: categories[0] }), {
      ordinalScope: valid.ordinalScope, advisoryOnly: valid.advisoryOnly, notCurrentEvidence: valid.notCurrentEvidence,
      nodeOrdinal: valid.nodeOrdinal, criterionFailures: valid.criterionFailures,
    }))).toBeUndefined()
    let getterReads = 0
    const accessor = Object.defineProperty({ ordinalScope: valid.ordinalScope, advisoryOnly: valid.advisoryOnly,
      notCurrentEvidence: valid.notCurrentEvidence, nodeOrdinal: valid.nodeOrdinal, criterionFailures: [] },
    "executionFailureCategory", { enumerable: true, get: () => { getterReads += 1; return categories[0] } })
    expect(parseRootTaskHistoryNodeLesson(accessor)).toBeUndefined()
    expect(getterReads).toBe(0)
  })

  it("preserves legacy lesson bytes and retains category-only facts only for emitted source ordinals", () => {
    const legacy = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: 1, criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] }
    const parsedLegacy = parseRootTaskHistoryNodeLesson(legacy, undefined, "completed")
    expect(JSON.stringify(parsedLegacy)).toBe(JSON.stringify(legacy))
    const categoryLesson = parseRootTaskHistoryNodeLesson(lesson(categories[1]), undefined, "failed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([categoryLesson], [1], [1])).toEqual([categoryLesson])
    expect(filterRootTaskHistoryLessonsForEmittedNodes([categoryLesson], [1], [])).toEqual([undefined])
    expect(filterRootTaskHistoryLessonsForEmittedNodes([categoryLesson], [], [1])).toEqual([undefined])
  })

  it("parses only a closed failed-repair ordinal link on a failed lesson", () => {
    const lesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 3,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }],
      failedRepairOf: { targetNodeOrdinal: 2, targetCriterionOrdinals: [1, 3], outcome: "verified_failed" } } as const
    expect(parseRootTaskHistoryNodeLesson(lesson, "analyst", "failed")).toEqual(lesson)
    expect(parseRootTaskHistoryNodeLesson(lesson, "analyst", "completed")).toBeUndefined()
    expect(parseRootTaskHistoryNodeLesson({ ...lesson, criterionFailures: [] }, "analyst", "failed")).toBeUndefined()
    for (const failedRepairOf of [
      { ...lesson.failedRepairOf, outcome: "passed" },
      { ...lesson.failedRepairOf, targetNodeOrdinal: lesson.nodeOrdinal },
      { ...lesson.failedRepairOf, targetNodeOrdinal: 4 },
      { ...lesson.failedRepairOf, targetCriterionOrdinals: [] },
      { ...lesson.failedRepairOf, targetCriterionOrdinals: [1, 1] },
      { ...lesson.failedRepairOf, targetCriterionOrdinals: [3, 1] },
      { ...lesson.failedRepairOf, targetCriterionOrdinals: [1, 9] },
      { ...lesson.failedRepairOf, privateCriterionId: "secret" },
    ]) expect(parseRootTaskHistoryNodeLesson({ ...lesson, failedRepairOf }, "analyst", "failed")).toBeUndefined()
  })

  it("drops failed-repair links when their target lesson or any failed criterion is pruned", () => {
    const base = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true }
    const target = parseRootTaskHistoryNodeLesson({ ...base, nodeOrdinal: 1, criterionFailures: [
      { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
      { criterionOrdinal: 3, status: "failed", reasonCode: "criterion_not_met" },
    ] })!
    const repair = parseRootTaskHistoryNodeLesson({ ...base, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }],
      failedRepairOf: { targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 3], outcome: "verified_failed" } }, "analyst", "failed")!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([target, repair], [1, 2], [1, 2])[1]?.failedRepairOf).toEqual(repair.failedRepairOf)
    expect(filterRootTaskHistoryLessonsForEmittedNodes([target, repair], [2], [1, 2])[1]?.failedRepairOf).toBeUndefined()
    const missingCriterion = parseRootTaskHistoryNodeLesson({ ...base, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] })!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([missingCriterion, repair], [1, 2], [1, 2])[1]?.failedRepairOf).toBeUndefined()
    const unverifiedTarget = parseRootTaskHistoryNodeLesson({ ...base, nodeOrdinal: 1, criterionFailures: [
      { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
      { criterionOrdinal: 3, status: "unverified", reasonCode: "criterion_not_met" },
    ] })!
    expect(filterRootTaskHistoryLessonsForEmittedNodes([unverifiedTarget, repair], [1, 2], [1, 2])[1]?.failedRepairOf).toBeUndefined()
  })
})
