import { afterEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import type { Queryable } from "./pg-store-persistence.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./task-graph-command-port.js"
import { taskGraphResultDigest, TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import { loadScopedTaskGraphDependencyContext, loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"

const locationRepairMocks = vi.hoisted(() => ({ failed: vi.fn(), completed: vi.fn(), projections: [] as unknown[] }))
vi.mock("./task-graph-repair-evidence-projection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-repair-evidence-projection.js")>()
  return { ...actual, reverifyFailedScoutLocationPartial: locationRepairMocks.failed,
    reverifyCompletedScoutLocationRepair: locationRepairMocks.completed }
})
vi.mock("./task-graph-pg-completed-dependency-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-completed-dependency-verification.js")>()
  return { ...actual, verifyRepairedTaskGraphFindings: vi.fn(async (...args: Parameters<typeof actual.verifyRepairedTaskGraphFindings>) => {
    locationRepairMocks.projections.push(args[4])
    return actual.verifyRepairedTaskGraphFindings(...args)
  }) }
})

afterEach(() => { vi.clearAllMocks(); locationRepairMocks.projections.length = 0 })

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

  it("does not complete a location repair when the failed target partial has no persisted role result", async () => {
    const location = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout" as const,
      criteria: [{ id: "location", check: { kind: "candidate_location_in" as const, locations: ["Dublin"] } }] }
    const nodes = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "source", taskId: "source-task", templateId: "scout", goal: "Find in Dublin", successCriteria: ["verified location"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: location },
      { key: "consumer", taskId: "child-task", templateId: "analyst", goal: "Analyze", successCriteria: ["analyze"], dependsOn: ["source"], depth: 2 },
      { key: "source-repair", taskId: "repair-task", templateId: "scout", goal: "Repair source", successCriteria: ["verified location"], dependsOn: [], depth: 2,
        verificationDisposition: "typed", verification: location,
        repairOf: { graphRootTaskId: scope.rootTaskId, nodeKey: "source", taskId: "source-task", criterionIds: ["location"] } },
    ] }).nodes
    const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId: "location", status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null }
    const rows: Array<Record<string, unknown>> = [
      { id: "child-task", status: "waiting", context: {}, ...scope },
      { id: "source-task", status: "failed", role: "scout", failureReason: "task_graph_verification_unverified", expectedOutputSchema: { role: "scout" },
        result: { taskGraphVerificationReport: report }, context: {}, ...scope },
    ]
    await expect(loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as Queryable,
      scope, "child-task", ["source"], nodes,
    )).rejects.toThrow("task_graph_dependency_repair_original_partial_unavailable")
  })

  it("filters only reverified out-of-location originals and verifies the exact merged candidate set", async () => {
    const fixture = locationRepairFixture([
      { jobId: "job-1", source: "greenhouse", location: "dublin" },
      { jobId: "job-2", source: "lever", location: "paris" },
    ], [{ jobId: "job-3", source: "greenhouse", location: "dublin" }])
    locationRepairMocks.failed.mockResolvedValue(fixture.originalPiece)
    locationRepairMocks.completed.mockResolvedValue(fixture.repairPiece)
    const loaded = await loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )
    const result = (loaded.dependencies[0]?.result as { structuredResult: { candidates: Array<{ jobId: string }>; evidence: Array<{ id: string }> } }).structuredResult
    const projection = locationRepairMocks.projections[0] as { candidates: Array<{ jobId: string; locationEvidenceStatus: string }>; evidenceIds: string[] }
    expect(result.candidates.map(item => item.jobId)).toEqual(["job-1", "job-3"])
    expect(projection.candidates.map(item => item.jobId)).toEqual(["job-1", "job-3"])
    expect(projection.candidates.every(item => item.locationEvidenceStatus === "verified")).toBe(true)
    expect(result.evidence.map(item => item.id)).toContain("read:job:job-2")
    expect(projection.evidenceIds).toContain("read:job:job-2")
  })

  it("keeps a repeated job identity conflicting across changed source/location instead of overwriting it", async () => {
    const fixture = locationRepairFixture(
      [{ jobId: "job-1", source: "greenhouse", location: "paris" }],
      [{ jobId: "job-1", source: "lever", location: "dublin" }],
    )
    locationRepairMocks.failed.mockResolvedValue(fixture.originalPiece)
    locationRepairMocks.completed.mockResolvedValue(fixture.repairPiece)
    await expect(loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )).rejects.toThrow("task_graph_dependency_repair_composite_unverified")
    expect(locationRepairMocks.projections[0]).toMatchObject({ candidates: [
      { jobId: "job-1", observedLocation: null, locationEvidenceStatus: "conflicting" },
    ] })
  })

  it("does not pass the location criterion when every verified mismatching candidate is filtered", async () => {
    const fixture = locationRepairFixture([{ jobId: "job-1", source: "greenhouse", location: "paris" }], [], true)
    locationRepairMocks.failed.mockResolvedValue(fixture.originalPiece)
    locationRepairMocks.completed.mockResolvedValue(fixture.repairPiece)
    await expect(loadScopedTaskGraphDependencyContext(
      { query: vi.fn(async () => ({ rows: fixture.rows, rowCount: fixture.rows.length })) } as unknown as Queryable,
      fixture.scope, "child-task", ["source"], fixture.nodes,
    )).rejects.toThrow("task_graph_dependency_repair_composite_unverified")
    expect(locationRepairMocks.projections[0]).toMatchObject({ candidates: [], evidenceIds: ["read:job:job-1", "read:job:unrelated"] })
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

describe("direct dependencies on a persisted location repair", () => {
  it("exposes the repair result only with a passed inherited location guard and its exact receipt", async () => {
    const fixture = directLocationGuardRepairFixture()
    const query = vi.fn(async () => ({ rows: [fixture.repairRow], rowCount: 1 }))
    const dependencies = await loadTaskGraphDependencyResults(
      { query } as unknown as Queryable, fixture.scope, ["source-repair"], fixture.nodes,
    )

    expect(fixture.nodes.find(node => node.key === "consumer")?.dependsOn).toEqual(["source-repair"])
    expect(dependencies).toMatchObject([{
      key: "source-repair", taskId: "repair-task", status: "completed", repairOf: fixture.relation,
    }])
    const projected = materializeTaskGraphDependencyContext({}, fixture.scope, ["source-repair"], dependencies) as {
      taskGraphDependencyResults: { items: Array<{ dependencyKey: string; result: { availability: string; candidateCount?: number }; verification?: { status: string; criteria: unknown[] } }> }
    }
    expect(projected.taskGraphDependencyResults.items).toHaveLength(1)
    expect(projected.taskGraphDependencyResults.items[0]).toMatchObject({
      dependencyKey: "source-repair",
      result: { availability: "available", role: "scout", status: "completed", candidateCount: 1 },
      verification: { status: "passed", criteria: [
        { criterionId: "candidate-count", status: "passed" },
        { criterionId: "candidate-location", status: "passed" },
      ] },
    })
    expect(fixture.relation.criterionIds).toEqual(["candidate-count"])
    const parameters = (query.mock.calls[0] as unknown as [string, unknown[]])[1]
    expect(parameters).toEqual([["repair-task"], fixture.scope.sessionId, fixture.scope.turnId,
      fixture.scope.rootTaskId, fixture.scope.parentTaskId, fixture.scope.userId])
  })

  it.each([
    ["a missing report", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      delete envelope.taskGraphVerificationReport
    }],
    ["a report that omits the inherited location criterion", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      const report = envelope.taskGraphVerificationReport as Record<string, unknown>
      report.criteria = (report.criteria as Array<Record<string, unknown>>).filter(item => item.criterionId !== "candidate-location")
    }],
    ["a report with a mismatched inherited location criterion ID", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      const report = envelope.taskGraphVerificationReport as Record<string, unknown>
      report.criteria = (report.criteria as Array<Record<string, unknown>>).map(item => item.criterionId === "candidate-location"
        ? { ...item, criterionId: "foreign-location" } : item)
    }],
    ["a report where the inherited location guard failed", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      const report = envelope.taskGraphVerificationReport as Record<string, unknown>
      report.status = "failed"
      report.reasonCode = "criterion_not_met"
      report.criteria = (report.criteria as Array<Record<string, unknown>>).map(item => item.criterionId === "candidate-location"
        ? { ...item, status: "failed", reasonCode: "criterion_not_met" } : item)
    }],
    ["a report with conflicting location evidence", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      const report = envelope.taskGraphVerificationReport as Record<string, unknown>
      report.status = "unverified"
      report.reasonCode = "canonical_evidence_ambiguous"
      report.criteria = (report.criteria as Array<Record<string, unknown>>).map(item => item.criterionId === "candidate-location"
        ? { ...item, status: "unverified", reasonCode: "canonical_evidence_ambiguous" } : item)
    }],
    ["a missing receipt", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      delete (fixture.repairRow.result as Record<string, unknown>).taskGraphRepairReceipt
    }],
    ["a receipt for a foreign root", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), graphRootTaskId: "foreign-root" }
    }],
    ["a receipt for a foreign target task", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), targetTaskId: "foreign-target" }
    }],
    ["a receipt for a foreign repair task", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), repairTaskId: "foreign-repair" }
    }],
    ["a receipt with mismatched criterion IDs", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), criterionIds: ["candidate-location"] }
    }],
    ["a receipt that incorrectly adds the inherited guard to the repaired criteria", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphRepairReceipt = { ...(envelope.taskGraphRepairReceipt as Record<string, unknown>), criterionIds: ["candidate-count", "candidate-location"] }
    }],
    ["a report whose result digest does not bind the exposed result", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      const envelope = fixture.repairRow.result as Record<string, unknown>
      envelope.taskGraphVerificationReport = { ...(envelope.taskGraphVerificationReport as Record<string, unknown>), resultDigest: "f".repeat(64) }
    }],
    ["a repair row from another session", (fixture: ReturnType<typeof directLocationGuardRepairFixture>) => {
      fixture.repairRow.sessionId = "foreign-session"
    }],
  ] as const)("does not expose the direct repair result with %s", async (_name, corrupt) => {
    const fixture = directLocationGuardRepairFixture()
    corrupt(fixture)
    const dependencies = await loadTaskGraphDependencyResults(
      { query: vi.fn(async () => ({ rows: [fixture.repairRow], rowCount: 1 })) } as unknown as Queryable,
      fixture.scope, ["source-repair"], fixture.nodes,
    )

    expect(() => materializeTaskGraphDependencyContext({}, fixture.scope, ["source-repair"], dependencies))
      .toThrow(_name === "a repair row from another session"
        ? "task_graph_dependency_scope_mismatch" : "task_graph_dependency_result_invalid")
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

function locationRepairFixture(
  originalCandidates: Array<{ jobId: string; source: string; location: string }>,
  repairCandidates: Array<{ jobId: string; source: string; location: string }>,
  repairHasUnrelatedEvidence = false,
) {
  const locationVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout" as const,
    criteria: [{ id: "location", check: { kind: "candidate_location_in" as const, locations: ["Dublin"] } }] }
  const nodes = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: "source", taskId: "source-task", templateId: "scout", goal: "find jobs in Dublin", successCriteria: ["verified locations"], dependsOn: [], depth: 1,
      verificationDisposition: "typed", verification: locationVerification },
    { key: "consumer", taskId: "child-task", templateId: "analyst", goal: "analyze", successCriteria: ["analyze"], dependsOn: ["source"], depth: 2 },
    { key: "source-repair", taskId: "repair-task", templateId: "scout", goal: "repair Dublin results", successCriteria: ["verified locations"], dependsOn: [], depth: 2,
      verificationDisposition: "typed", verification: locationVerification,
      repairOf: { graphRootTaskId: scope.rootTaskId, nodeKey: "source", taskId: "source-task", criterionIds: ["location"] } },
  ] }).nodes
  const makeResult = (candidates: Array<{ jobId: string; source: string; location: string }>, unrelated = false) => {
    const evidence = candidates.map(item => ({ id: `read:job:${item.jobId}`, kind: "job", ref: item.jobId, source: item.source }))
    if (unrelated) evidence.push({ id: "read:job:unrelated", kind: "job", ref: "unrelated", source: "fixture" })
    return validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: candidates.map(item => ({ jobId: item.jobId, source: item.source, url: null, evidenceIds: [`read:job:${item.jobId}`] })),
      evidence, summary: "Reverified candidates." }, "scout")
  }
  const originalResult = makeResult(originalCandidates), repairResult = makeResult(repairCandidates, repairHasUnrelatedEvidence)
  const makePiece = (result: typeof originalResult, candidates: Array<{ jobId: string; location: string }>) => ({
    structuredResult: result,
    projection: { schemaVersion: "agent-harness.v2.task-graph-verification-evidence.v2", role: "scout",
      candidates: candidates.map(item => ({ jobId: item.jobId, evidenceIds: [`read:job:${item.jobId}`], observedLocation: item.location, locationEvidenceStatus: "verified" })),
      evidenceIds: result.evidence.map(item => item.id) },
  })
  const originalPiece = makePiece(originalResult, originalCandidates), repairPiece = makePiece(repairResult, repairCandidates)
  const makeReport = (result: typeof originalResult, status: "failed" | "passed") => ({
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode: status === "failed" ? "criterion_not_met" : "criteria_met",
    criteria: [{ criterionId: "location", status, reasonCode: status === "failed" ? "criterion_not_met" : "criteria_met" }],
    evidenceDigest: "e".repeat(64), resultDigest: taskGraphResultDigest(result),
  })
  const report = makeReport(originalResult, "failed"), repairReport = makeReport(repairResult, "passed")
  const receipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: scope.rootTaskId,
    targetNodeKey: "source", targetTaskId: "source-task", criterionIds: ["location"], repairNodeKey: "source-repair",
    repairTaskId: "repair-task", verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: repairReport.evidenceDigest }
  const envelope = (result: typeof originalResult, taskGraphVerificationReport: typeof report, taskGraphRepairReceipt?: typeof receipt) => ({
    finalItemId: "final-item", finalText: "fixture", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: result, taskGraphVerificationReport, ...(taskGraphRepairReceipt ? { taskGraphRepairReceipt } : {}),
  })
  const rows: Array<Record<string, unknown>> = [
    { id: "child-task", status: "waiting", context: {}, ...scope },
    { id: "source-task", status: "failed", role: "scout", failureReason: "task_graph_verification_failed", attemptCount: 1,
      taskType: TASK_GRAPH_TEMPLATES.scout.taskType, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
      expectedOutputSchema: { ...TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema }, result: envelope(originalResult, report), context: {}, ...scope },
    { id: "repair-task", status: "completed", role: "scout", failureReason: null, attemptCount: 1,
      taskType: TASK_GRAPH_TEMPLATES.scout.taskType, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
      expectedOutputSchema: { ...TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema }, result: envelope(repairResult, repairReport, receipt), context: {}, ...scope },
  ]
  return { scope, nodes, rows, originalPiece, repairPiece }
}

function directLocationGuardRepairFixture() {
  const verification = {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout" as const,
    criteria: [
      { id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
      { id: "candidate-location", check: { kind: "candidate_location_in" as const, locations: ["Dublin"] } },
    ],
  }
  const relation = { graphRootTaskId: scope.rootTaskId, nodeKey: "source", taskId: "source-task", criterionIds: ["candidate-count"] }
  const nodes = parseTaskGraphSnapshot(JSON.stringify({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [
      { key: "source", taskId: "source-task", templateId: "scout", goal: "Find Dublin roles", successCriteria: ["Find a verified candidate"],
        dependsOn: [], depth: 1, verificationDisposition: "typed", verification },
      { key: "source-repair", taskId: "repair-task", templateId: "scout", goal: "Repair the candidate count", successCriteria: ["Find a verified candidate"],
        dependsOn: [], depth: 2, verificationDisposition: "typed", verification, repairOf: relation },
      { key: "consumer", taskId: "child-task", templateId: "analyst", goal: "Analyze repaired candidates", successCriteria: ["Analyze the candidate"],
        dependsOn: ["source-repair"], depth: 3, verificationDisposition: "typed", verification: {
          schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
          criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
        } },
    ],
  })).nodes
  const repairResult = validateRoleResult({
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }],
    summary: "One verified Dublin candidate.",
  }, "scout")
  const report = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [
      { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "candidate-location", status: "passed", reasonCode: "criteria_met" },
    ],
    evidenceDigest: "d".repeat(64), resultDigest: taskGraphResultDigest(repairResult),
  }
  const receipt = {
    schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: scope.rootTaskId,
    targetNodeKey: "source", targetTaskId: "source-task", criterionIds: ["candidate-count"],
    repairNodeKey: "source-repair", repairTaskId: "repair-task", verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    evidenceDigest: report.evidenceDigest,
  }
  const repairRow: Record<string, unknown> = {
    id: "repair-task", status: "completed", role: "scout", failureReason: null,
    expectedOutputSchema: { ...TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema },
    result: { finalItemId: "repair-final", finalText: "fixture", status: "completed", stepCount: 1, toolCallCount: 1,
      structuredResult: repairResult, taskGraphVerificationReport: report, taskGraphRepairReceipt: receipt },
    ...scope,
  }
  return { scope, nodes, relation, repairRow }
}
