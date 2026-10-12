import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import {
  classifyTaskGraphStructuredOutputFailure,
  projectTaskGraphStructuredFailureCategory,
  taskGraphStructuredFailureCategoryBytes,
  type TaskGraphStructuredOutputFailureCategory,
} from "./task-graph-structured-failure-category.js"

const CATEGORIES: readonly TaskGraphStructuredOutputFailureCategory[] = [
  "missing_final_output", "result_too_large", "result_shape_invalid", "evidence_binding_invalid",
]

function eligible(category = "result_shape_invalid", role = "scout") {
  const criterionId = role === "scout" ? "candidate-count" : "finding-count"
  const check = role === "scout" ? { kind: "candidate_count_gte", minimum: 1 } : { kind: "finding_count_gte", minimum: 1 }
  const criteria = [{ id: criterionId, check }]
  return {
    snapshotNode: {
      key: "child-a", taskId: "task-a", templateId: role, depth: 1, goal: "Inspect candidates",
      successCriteria: ["Return typed evidence"], dependsOn: [], verificationDisposition: "typed",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria },
    },
    task: {
      id: "task-a", status: "failed", role, taskType: "research",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role },
      failureReason: "task_graph_verification_unverified",
      result: { status: "failed", structuredOutputFailureCategory: category, finalText: "private result" },
    },
    verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId, status: "unverified", reasonCode: "result_invalid" }],
      evidenceDigest: null, resultDigest: null,
    },
    hasRepairReceipt: false,
  }
}

function parsedProjection(role = "scout") {
  const source = eligible("result_shape_invalid", role)
  return {
    status: "failed",
    templateId: role,
    verification: source.snapshotNode.verification,
    verificationReport: source.verificationReport,
  }
}

function projectedRaw(category = "result_shape_invalid", role = "scout") {
  return { status: "failed", templateId: role, structuredOutputFailureCategory: category }
}

describe("classifyTaskGraphStructuredOutputFailure", () => {
  it.each(CATEGORIES)("returns only the closed %s literal for an eligible current failure", category => {
    expect(classifyTaskGraphStructuredOutputFailure(eligible(category))).toBe(category)
  })

  it("supports either exact ordinary role with the matching output marker", () => {
    expect(classifyTaskGraphStructuredOutputFailure(eligible("evidence_binding_invalid", "analyst")))
      .toBe("evidence_binding_invalid")
  })

  it("omits categories when any identity, role, marker, status, reason, or report binding differs", () => {
    const valid = eligible()
    const wrongReport = { ...valid.verificationReport, status: "failed" }
    const wrongCriterion = { ...valid.verificationReport, criteria: [{ criterionId: "other", status: "unverified", reasonCode: "result_invalid" }] }
    const invalidCases = [
      { ...valid, snapshotNode: { ...valid.snapshotNode, taskId: "other-task" } },
      { ...valid, task: { ...valid.task, id: "other-task" } },
      { ...valid, task: { ...valid.task, role: "analyst" } },
      { ...valid, snapshotNode: { ...valid.snapshotNode, templateId: "native" } },
      { ...valid, task: { ...valid.task, expectedOutputSchema: { role: "scout", schemaVersion: "other" } } },
      { ...valid, task: { ...valid.task, expectedOutputSchema: { role: "scout", schemaVersion: ROLE_RESULT_SCHEMA, extra: true } } },
      { ...valid, task: { ...valid.task, status: "completed" } },
      { ...valid, task: { ...valid.task, failureReason: "invalid_structured_result" } },
      { ...valid, task: { ...valid.task, result: { ...valid.task.result, status: "completed" } } },
      { ...valid, verificationReport: wrongReport },
      { ...valid, verificationReport: { ...valid.verificationReport, evidenceDigest: "a".repeat(64) } },
      { ...valid, verificationReport: { ...valid.verificationReport, resultDigest: "b".repeat(64) } },
      { ...valid, verificationReport: wrongCriterion },
      { ...valid, verificationReport: undefined },
      { ...valid, snapshotNode: { ...valid.snapshotNode, verificationDisposition: "legacy_unverified" } },
      { ...valid, hasRepairReceipt: true },
      { ...valid, snapshotNode: { ...valid.snapshotNode, repairOf: { taskId: "target" } } },
      { ...valid, snapshotNode: { ...valid.snapshotNode, nativeDelegation: {} } },
      { ...valid, task: { ...valid.task, result: { ...valid.task.result, taskGraphRepairReceipt: {} } } },
      { ...valid, task: { ...valid.task, result: { ...valid.task.result, nativeResult: {} } } },
      { ...valid, task: { ...valid.task, result: { ...valid.task.result, structuredOutputFailureCategory: "invalid_structured_result" } } },
    ]
    for (const candidate of invalidCases) expect(classifyTaskGraphStructuredOutputFailure(candidate)).toBeUndefined()
  })

  it("rejects inherited, accessor, non-enumerable, and extra input fields without invoking getters", () => {
    const base = eligible()
    let getterCalls = 0
    const accessorResult = { status: "failed" }
    Object.defineProperty(accessorResult, "structuredOutputFailureCategory", {
      enumerable: true, get() { getterCalls += 1; return "result_shape_invalid" },
    })
    const inheritedResult = Object.assign(Object.create({ structuredOutputFailureCategory: "result_shape_invalid" }) as object, { status: "failed" })
    const hiddenResult = { status: "failed" }
    Object.defineProperty(hiddenResult, "structuredOutputFailureCategory", { value: "result_shape_invalid", enumerable: false })
    const invalidCases = [
      { ...base, task: { ...base.task, result: accessorResult } },
      { ...base, task: { ...base.task, result: inheritedResult } },
      { ...base, task: { ...base.task, result: hiddenResult } },
      { ...base, unexpected: true },
      Object.assign(Object.create({ hasRepairReceipt: false }) as object, base),
    ]
    for (const candidate of invalidCases) expect(classifyTaskGraphStructuredOutputFailure(candidate)).toBeUndefined()
    expect(getterCalls).toBe(0)
  })
})

describe("projectTaskGraphStructuredFailureCategory", () => {
  it.each(CATEGORIES)("retains only the parsed failed %s scalar", category => {
    expect(projectTaskGraphStructuredFailureCategory(projectedRaw(category), parsedProjection())).toBe(category)
  })

  it("supports the matching typed Analyst role and counts only the safe serialized field", () => {
    const category = "evidence_binding_invalid"
    expect(projectTaskGraphStructuredFailureCategory(projectedRaw(category, "analyst"), parsedProjection("analyst"))).toBe(category)
    expect(taskGraphStructuredFailureCategoryBytes(category)).toBe(Buffer.byteLength(JSON.stringify({ structuredOutputFailureCategory: category }), "utf8"))
    expect(taskGraphStructuredFailureCategoryBytes(undefined)).toBe(0)
    expect(taskGraphStructuredFailureCategoryBytes("private failure text")).toBe(0)
  })

  it("rejects category data unless it matches a failed typed node and its exact unverified report", () => {
    const raw = projectedRaw(), parsed = parsedProjection()
    const report = parsed.verificationReport
    const badCases = [
      [projectedRaw("unknown"), parsed],
      [{ ...raw, status: "completed" }, parsed],
      [{ ...raw, templateId: "writer" }, parsed],
      [raw, { ...parsed, status: "completed" }],
      [raw, { ...parsed, templateId: "analyst" }],
      [raw, { ...parsed, verification: undefined }],
      [raw, { ...parsed, verification: { ...parsed.verification, role: "analyst" } }],
      [raw, { ...parsed, verification: { ...parsed.verification, extra: true } }],
      [raw, { ...parsed, verificationReport: { ...report, status: "failed" } }],
      [raw, { ...parsed, verificationReport: { ...report, reasonCode: "criterion_not_met" } }],
      [raw, { ...parsed, verificationReport: { ...report, evidenceDigest: "a".repeat(64) } }],
      [raw, { ...parsed, verificationReport: { ...report, criteria: [{ ...report.criteria[0], criterionId: "other" }] } }],
      [raw, { ...parsed, verificationReport: { ...report, extra: true } }],
      [raw, { ...parsed, repairOf: undefined }],
      [raw, { ...parsed, repairReceipt: {} }],
      [raw, { ...parsed, native: undefined }],
      [raw, { ...parsed, nativeResult: {} }],
      [raw, { ...parsed, unexpected: true }],
      [{ status: "failed", templateId: "scout" }, parsed],
    ] as const
    for (const [rawNode, parsedNode] of badCases) {
      expect(projectTaskGraphStructuredFailureCategory(rawNode, parsedNode)).toBeUndefined()
    }
  })

  it("rejects inherited, accessor, non-enumerable, and malformed parsed records without invoking getters", () => {
    const parsed = parsedProjection()
    let getterCalls = 0
    const accessor = { status: "failed", templateId: "scout" }
    Object.defineProperty(accessor, "structuredOutputFailureCategory", {
      enumerable: true, get() { getterCalls += 1; return "result_shape_invalid" },
    })
    const inherited = Object.assign(Object.create({ structuredOutputFailureCategory: "result_shape_invalid" }) as object, {
      status: "failed", templateId: "scout",
    })
    const hidden = { status: "failed", templateId: "scout" }
    Object.defineProperty(hidden, "structuredOutputFailureCategory", { value: "result_shape_invalid", enumerable: false })
    const parsedAccessor = { templateId: "scout", verification: parsed.verification, verificationReport: parsed.verificationReport }
    Object.defineProperty(parsedAccessor, "status", { enumerable: true, get() { getterCalls += 1; return "failed" } })
    const invalidCases = [
      [accessor, parsed], [inherited, parsed], [hidden, parsed],
      [projectedRaw(), Object.assign(Object.create({ status: "failed" }) as object, parsed)],
      [projectedRaw(), parsedAccessor],
    ] as const
    for (const [rawNode, parsedNode] of invalidCases) {
      expect(projectTaskGraphStructuredFailureCategory(rawNode, parsedNode)).toBeUndefined()
    }
    expect(getterCalls).toBe(0)
  })
})
