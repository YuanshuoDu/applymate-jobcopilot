import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { Queryable } from "./pg-store-persistence.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./task-graph-command-port.js"
import { taskGraphResultDigest, TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { loadScopedTaskGraphDependencyContext } from "./task-graph-pg-dependency-context-loader.js"

describe("loadScopedTaskGraphDependencyContext", () => {
  it("loads the child and projects direct dependencies under the full graph identity scope", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const resultRows = [
      { id: "dependency-2", status: "completed", role: "analyst", expectedOutputSchema: { role: "analyst" }, result: { result: 2 }, context: {}, ...scope },
      { id: "child-1", status: "waiting", context: { prompt: "analyze these" }, ...scope },
      { id: "dependency-1", status: "completed", role: "scout", expectedOutputSchema: { role: "scout" }, result: { result: 1 }, context: {}, ...scope },
    ]
    const query = vi.fn(async () => ({ rows: resultRows, rowCount: resultRows.length }))
    const loaded = await loadScopedTaskGraphDependencyContext(
      { query } as unknown as Queryable,
      scope,
      "child-1",
      ["first", "second"],
      [
        { key: "first", taskId: "dependency-1", templateId: "scout", goal: "find jobs", successCriteria: ["done"], dependsOn: [], depth: 1 },
        { key: "second", taskId: "dependency-2", templateId: "analyst", goal: "score jobs", successCriteria: ["done"], dependsOn: [], depth: 1 },
      ],
    )

    expect(loaded).toEqual({
      childContext: { prompt: "analyze these" },
      dependencies: [
        {
          key: "first", taskId: "dependency-1", status: "completed", role: "scout",
          expectedOutputSchema: { role: "scout" }, result: { result: 1 },
          userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        },
        {
          key: "second", taskId: "dependency-2", status: "completed", role: "analyst",
          expectedOutputSchema: { role: "analyst" }, result: { result: 2 },
          userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        },
      ],
    })
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('task."sessionId" = $2 AND task."turnId" = $3')
    expect(sql).toContain('task."rootTaskId" = $4 AND task."parentTaskId" = $5')
    expect(sql).toContain('session."userId" = $6 AND turn."userId" = $6')
    expect(parameters).toEqual([["child-1", "dependency-1", "dependency-2"], "session-1", "turn-1", "root-1", "root-1", "user-1"])
  })

  it("fails closed when the child row is absent or no longer waiting", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }

    await expect(loadScopedTaskGraphDependencyContext(
      client as unknown as Queryable, scope, "child-1", [], [],
    )).rejects.toThrow("task_graph_dependency_child_scope_invalid")
  })

  it.each([
    ["the JSON-persisted report-only hard failure", (report: Record<string, unknown>) => ({ taskGraphVerificationReport: report })],
    ["the recovered report plus explicit null worker result", (report: Record<string, unknown>) => ({ workerResult: null, taskGraphVerificationReport: report })],
  ])("composes %s only with an exact successful repair receipt", async (_name, originalResult) => {
    const fixture = repairFixture(originalResult(unverifiedReport()))
    const loaded = await loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )

    expect(loaded.dependencies).toHaveLength(1)
    expect(loaded.dependencies[0]).toMatchObject({
      key: "source", taskId: "source-task", status: "completed", role: "scout", repairComposite: true,
      verificationReport: unverifiedReport(), repairLineage: [{ criterionIds: ["candidate-count"], verifierVersion: TASK_GRAPH_VERIFIER_VERSION }],
    })
    expect((loaded.dependencies[0]?.result as { structuredResult: unknown }).structuredResult)
      .toEqual({ ...fixture.repairResult, summary: "Verified repair results." })
  })

  it.each([
    ["the JSON-persisted report-only hard failure", (report: Record<string, unknown>) => ({ taskGraphVerificationReport: report })],
    ["the recovered report plus explicit null worker result", (report: Record<string, unknown>) => ({ workerResult: null, taskGraphVerificationReport: report })],
  ])("still requires a matching repair receipt for %s", async (_name, originalResult) => {
    for (const receiptCase of ["missing", "foreign"] as const) {
      const fixture = repairFixture(originalResult(unverifiedReport()))
      const repairRow = fixture.rows.find(row => row.id === "repair-task")!
      const envelope = { ...(repairRow.result as Record<string, unknown>) }
      if (receiptCase === "missing") delete envelope.taskGraphRepairReceipt
      else envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), targetTaskId: "foreign-task" }
      repairRow.result = envelope
      await expect(loadScopedTaskGraphDependencyContext(
        { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
        fixture.scope, "child-task", ["source"], fixture.nodes,
      )).rejects.toThrow("task_graph_dependency_repair_incomplete")
    }
  })

  it("rechecks the original merged predicate when a recovered original has no role result", async () => {
    const fixture = repairFixture({ workerResult: null, taskGraphVerificationReport: unverifiedReport() }, "task_graph_verification_unverified", 1)
    await expect(loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )).rejects.toThrow("task_graph_dependency_repair_composite_unverified")
  })

  it.each([
    ["an unknown envelope key", { ...hardFailureEnvelope(), forged: true }, "task_graph_verification_unverified", "task_graph_dependency_repair_original_invalid"],
    ["a non-null worker result", { workerResult: { status: "completed" }, taskGraphVerificationReport: unverifiedReport() }, "task_graph_verification_unverified", "task_graph_dependency_repair_original_invalid"],
    ["evidence-bound digests", { taskGraphVerificationReport: unverifiedReport("canonical_evidence_missing", "a".repeat(64), "b".repeat(64)) }, "task_graph_verification_unverified", "task_graph_dependency_repair_original_invalid"],
    ["a failed report status", { taskGraphVerificationReport: failedReport() }, "task_graph_verification_failed", "task_graph_dependency_repair_original_invalid"],
    ["a non-result-invalid null-digest reason", { taskGraphVerificationReport: unverifiedReport("result_ambiguous") }, "task_graph_verification_unverified", "task_graph_dependency_repair_original_invalid"],
    ["a mismatched criterion report", { taskGraphVerificationReport: { ...unverifiedReport(), criteria: [{ criterionId: "foreign-criterion", status: "unverified", reasonCode: "result_invalid" }] } }, "task_graph_verification_unverified", "task_graph_dependency_repair_source_invalid"],
  ])("rejects %s as a repairable original result", async (_name, originalResult, failureReason, error) => {
    const fixture = repairFixture(originalResult, failureReason)
    await expect(loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )).rejects.toThrow(error)
  })
})

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
} as const

function unverifiedReport(reasonCode = "result_invalid", evidenceDigest: string | null = null, resultDigest: string | null = null) {
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode,
    criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode }], evidenceDigest, resultDigest,
  }
}

function hardFailureEnvelope() { return { taskGraphVerificationReport: unverifiedReport() } }

function failedReport() {
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
    criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }],
    evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
  }
}

function repairFixture(originalResult: unknown, failureReason = "task_graph_verification_unverified", candidateCount = 2) {
  const nodes = parseTaskGraphSnapshot({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [
      { key: "source", taskId: "source-task", templateId: "scout", goal: "find candidates", successCriteria: ["find two"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification },
      { key: "consumer", taskId: "child-task", templateId: "analyst", goal: "score candidates", successCriteria: ["score candidates"], dependsOn: ["source"], depth: 2, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
      { key: "source-repair", taskId: "repair-task", templateId: "scout", goal: "repair source", successCriteria: ["find two"], dependsOn: [], depth: 2, verificationDisposition: "typed", verification: scoutVerification,
        repairOf: { graphRootTaskId: scope.rootTaskId, nodeKey: "source", taskId: "source-task", criterionIds: ["candidate-count"] } },
    ],
  }).nodes
  const evidence = Array.from({ length: candidateCount }, (_, index) => `job-${index + 1}`)
    .map(jobId => ({ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "fixture" }))
  const repairResult = validateRoleResult({
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: evidence.map(item => ({ jobId: item.ref, source: "fixture", url: null, evidenceIds: [item.id] })),
    evidence, summary: "Two verified candidates.",
  }, "scout")
  const report = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest: "c".repeat(64), resultDigest: taskGraphResultDigest(repairResult),
  }
  const receipt = {
    schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: scope.rootTaskId,
    targetNodeKey: "source", targetTaskId: "source-task", criterionIds: ["candidate-count"],
    repairNodeKey: "source-repair", repairTaskId: "repair-task", verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    evidenceDigest: report.evidenceDigest,
  }
  const rows: Array<Record<string, unknown>> = [
    { id: "child-task", status: "waiting", context: { prompt: "score" }, ...scope },
    { id: "source-task", status: "failed", role: "scout", failureReason, expectedOutputSchema: { role: "scout" }, result: originalResult, context: {}, ...scope },
    { id: "repair-task", status: "completed", role: "scout", failureReason: null, expectedOutputSchema: { role: "scout" },
      result: { finalItemId: "repair-final", finalText: "repaired", status: "completed", stepCount: 1, toolCallCount: 1, structuredResult: repairResult, taskGraphVerificationReport: report, taskGraphRepairReceipt: receipt }, context: {}, ...scope },
  ]
  return { scope, nodes, rows, repairResult }
}
