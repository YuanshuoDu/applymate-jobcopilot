import { describe, expect, it } from "vitest"
import {
  parseTaskGraphCurrentVerificationMetadata,
  taskGraphCurrentVerificationMetadataBytes,
  validateTaskGraphCurrentVerificationGraph,
} from "./canonical-turn-task-graph-verification-context.js"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "./planning/task-graph-verification.js"

const scoutVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
    { id: "candidate-floor", check: { kind: "candidate_count_gte", minimum: 2 } },
    { id: "evidence-floor", check: { kind: "evidence_count_gte", minimum: 3 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 2 } },
  ],
}
const analystVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
    { id: "finding-floor", check: { kind: "finding_count_gte", minimum: 1 } },
    { id: "analyst-evidence-floor", check: { kind: "evidence_count_gte", minimum: 2 } },
    { id: "finding-evidence", check: { kind: "all_findings_have_evidence", minimumItems: 1 } },
    { id: "reported-score", check: { kind: "reported_score_gte", minimumScore: 7.5, minimumFindings: 1, aggregation: "all" } },
    { id: "scout-source", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
  ],
}

function node(value: Partial<TaskGraphCurrentNode> & Pick<TaskGraphCurrentNode, "key" | "taskId" | "templateId">): TaskGraphCurrentNode {
  return {
    key: value.key, taskId: value.taskId, templateId: value.templateId,
    goal: value.goal ?? "Current bounded work", successCriteria: value.successCriteria ?? ["Return evidence"],
    dependsOn: value.dependsOn ?? [], status: value.status ?? "queued", readiness: value.readiness ?? "ready",
    resultSummary: null, failureReason: null,
    ...(value.verificationCriterionIds ? { verificationCriterionIds: value.verificationCriterionIds } : {}),
    ...(value.verification ? { verification: value.verification } : {}),
    ...(value.repairOf ? { repairOf: value.repairOf } : {}),
  }
}

function row(verification: TaskGraphVerificationContract, ids = verification.criteria.map(item => item.id)) {
  return { verification, verificationCriterionIds: ids }
}

describe("current TaskGraph verification context", () => {
  it("retains all seven canonical check kinds and their exact ordered meanings", () => {
    const scout = parseTaskGraphCurrentVerificationMetadata(row(scoutVerification), "scout", "scout", "task-scout")
    const analyst = parseTaskGraphCurrentVerificationMetadata(row(analystVerification), "analyst", "analyst", "task-analyst")

    expect(scout?.verification).toEqual(scoutVerification)
    expect(analyst?.verification).toEqual(analystVerification)
    expect(new Set([
      ...scoutVerification.criteria.map(item => item.check.kind),
      ...analystVerification.criteria.map(item => item.check.kind),
    ])).toEqual(new Set([
      "candidate_count_gte", "finding_count_gte", "evidence_count_gte", "all_candidates_have_evidence",
      "all_findings_have_evidence", "reported_score_gte", "findings_from_scout_dependency",
    ]))
  })

  it("keeps IDs/report-only adapters compatible and omits contracts for untyped nodes", () => {
    const legacy = parseTaskGraphCurrentVerificationMetadata({ verificationCriterionIds: ["candidate-floor"] }, "scout", "legacy", "task-legacy")
    const untyped = parseTaskGraphCurrentVerificationMetadata({}, "legacy_untyped", "untyped", "task-untyped")

    expect(legacy).toEqual({ verificationCriterionIds: ["candidate-floor"] })
    expect(untyped).toEqual({})
  })

  it.each([
    ["missing IDs", { verification: scoutVerification }],
    ["extra IDs", row(scoutVerification, [...scoutVerification.criteria.map(item => item.id), "extra"])],
    ["reordered IDs", row(scoutVerification, scoutVerification.criteria.map(item => item.id).reverse())],
    ["wrong template role", row(analystVerification)],
    ["unsupported template", row(scoutVerification), "writer"],
    ["unknown contract field", { ...row(scoutVerification), verification: { ...scoutVerification, extra: true } }],
    ["out-of-range count", { ...row(scoutVerification), verification: { ...scoutVerification, criteria: [{ id: "bad-count", check: { kind: "candidate_count_gte", minimum: 0 } }] }, verificationCriterionIds: ["bad-count"] }],
    ["unknown check", { ...row(scoutVerification), verification: { ...scoutVerification, criteria: [{ id: "bad-check", check: { kind: "invented_check" } }] }, verificationCriterionIds: ["bad-check"] }],
  ])("rejects %s instead of hiding supplied contract metadata", (_label, value, templateId = "scout") => {
    expect(parseTaskGraphCurrentVerificationMetadata(value as Record<string, unknown>, templateId, "node", "task-node")).toBeUndefined()
  })

  it("requires dependency checks to resolve to a direct current typed Scout", () => {
    const scout = node({ key: "scout", taskId: "task-scout", templateId: "scout", verification: scoutVerification,
      verificationCriterionIds: scoutVerification.criteria.map(item => item.id) })
    const analyst = node({ key: "analyst", taskId: "task-analyst", templateId: "analyst", dependsOn: ["scout"],
      verification: analystVerification, verificationCriterionIds: analystVerification.criteria.map(item => item.id) })

    expect(validateTaskGraphCurrentVerificationGraph([scout, analyst])).toBe(true)
    expect(validateTaskGraphCurrentVerificationGraph([scout, { ...analyst, dependsOn: [] }])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([analyst])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([node({ ...scout, templateId: "analyst" }), analyst])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([
      { ...scout, verification: undefined, verificationCriterionIds: undefined }, analyst,
    ])).toBe(false)
  })

  it("checks repair targets and identical selected checks when typed contracts are supplied", () => {
    const target = node({ key: "target", taskId: "task-target", templateId: "scout", verification: scoutVerification,
      verificationCriterionIds: scoutVerification.criteria.map(item => item.id) })
    const relation = { graphRootTaskId: "root-current", nodeKey: target.key, taskId: target.taskId,
      criterionIds: scoutVerification.criteria.map(item => item.id) }
    const repair = node({ key: "repair", taskId: "task-repair", templateId: "scout", verification: scoutVerification,
      verificationCriterionIds: scoutVerification.criteria.map(item => item.id), repairOf: relation })

    expect(validateTaskGraphCurrentVerificationGraph([target, repair])).toBe(true)
    expect(validateTaskGraphCurrentVerificationGraph([target, { ...repair, repairOf: { ...relation, taskId: "foreign-task" } }])).toBe(false)
    const changedCheck = { ...scoutVerification, criteria: scoutVerification.criteria.map((item, index) => index === 0
      ? { ...item, check: { kind: "candidate_count_gte" as const, minimum: 3 } } : item) }
    expect(validateTaskGraphCurrentVerificationGraph([target, { ...repair, verification: changedCheck }])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([repair])).toBe(false)
    const oldAdapterRepair = node({ key: "old-repair", taskId: "task-old-repair", templateId: "scout",
      repairOf: { graphRootTaskId: "root-current", nodeKey: "not-loaded", taskId: "task-not-loaded", criterionIds: ["candidate-floor"] } })
    expect(validateTaskGraphCurrentVerificationGraph([oldAdapterRepair])).toBe(true)
  })

  it("rejects duplicate current identities and duplicate dependency selectors", () => {
    const scout = node({ key: "scout", taskId: "same-task", templateId: "scout", verification: scoutVerification })
    expect(validateTaskGraphCurrentVerificationGraph([scout, { ...scout, key: "other" }])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([scout, { ...scout, taskId: "other" }])).toBe(false)
    expect(validateTaskGraphCurrentVerificationGraph([node({ key: "x", taskId: "x-task", templateId: "legacy", dependsOn: ["y", "y"] }),
      node({ key: "y", taskId: "y-task", templateId: "legacy" })])).toBe(false)
  })

  it("charges the full contract inside the bounded verifier-context byte total", () => {
    const legacy = node({ key: "legacy", taskId: "task-legacy", templateId: "scout", verificationCriterionIds: ["candidate-floor"] })
    const typed = node({ key: "typed", taskId: "task-typed", templateId: "scout", verificationCriterionIds: scoutVerification.criteria.map(item => item.id), verification: scoutVerification })

    expect(taskGraphCurrentVerificationMetadataBytes(typed)).toBeGreaterThan(taskGraphCurrentVerificationMetadataBytes(legacy))
  })
})
