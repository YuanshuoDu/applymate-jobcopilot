import { afterEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION } from "../planning/task-graph-verification-cross-node.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { mergeReverifiedScoutLocationEvidence, reverifyCompletedScoutLocationRepair, reverifyFailedScoutLocationPartial, type ReverifiedScoutEvidencePiece } from "./task-graph-repair-evidence-projection.js"

const verifierMocks = vi.hoisted(() => ({ failed: vi.fn(), completed: vi.fn() }))
vi.mock("./task-graph-pg-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-verification.js")>()
  return { ...actual, reverifyFailedTaskGraphNodeEvidence: verifierMocks.failed, verifyCompletedTaskGraphNodeEvidence: verifierMocks.completed }
})

afterEach(() => vi.clearAllMocks())

function piece(jobId: string, source: string, location: string | null, status: "verified" | "missing" | "conflicting" = location ? "verified" : "missing", evidenceId = `read:job:${jobId}`): ReverifiedScoutEvidencePiece {
  const evidenceIds = [...new Set([`read:job:${jobId}`, evidenceId])]
  return {
    projection: {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION, role: "scout",
      candidates: [{ jobId, evidenceIds, observedLocation: status === "verified" ? location : null, locationEvidenceStatus: status }],
      evidenceIds,
    },
    structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId, source, url: null, evidenceIds }],
      evidence: evidenceIds.map(id => ({ id, kind: "job", ref: id.slice("read:job:".length), source })), summary: "bound result",
    },
  }
}

describe("reverified Scout repair evidence projection", () => {
  it("reverifies the persisted failed partial at its exact current attempt", async () => {
    const fixture = locationRepairFixture("failed")
    verifierMocks.failed.mockResolvedValue({ verified: false, report: fixture.report, projection: fixture.projection, structuredResult: fixture.result })
    await expect(reverifyFailedScoutLocationPartial({
      client: {} as never, scope: fixture.scope, snapshot: fixture.snapshot, node: fixture.node, row: fixture.row,
      report: fixture.report, structuredResult: fixture.result,
    })).resolves.toEqual({ projection: fixture.projection, structuredResult: fixture.result })
    expect(verifierMocks.failed).toHaveBeenCalledWith({}, expect.objectContaining({
      scope: { ...fixture.scope, taskId: fixture.node.taskId, attemptCount: 4 },
      node: fixture.node, structuredResult: fixture.result, includeObservedLocation: true,
    }))
  })

  it("rejects failed partials without exact persisted results or a matching report", async () => {
    const fixture = locationRepairFixture("failed")
    const reportMismatch = { ...fixture.report, evidenceDigest: "d".repeat(64) }
    verifierMocks.failed.mockResolvedValue({ verified: false, report: reportMismatch, projection: fixture.projection, structuredResult: fixture.result })
    await expect(reverifyFailedScoutLocationPartial({
      client: {} as never, scope: fixture.scope, snapshot: fixture.snapshot, node: fixture.node, row: fixture.row,
      report: fixture.report, structuredResult: fixture.result,
    })).resolves.toBeUndefined()
    const reportOnly = { ...fixture.row, result: { status: "completed", taskGraphVerificationReport: fixture.report } }
    await expect(reverifyFailedScoutLocationPartial({
      client: {} as never, scope: fixture.scope, snapshot: fixture.snapshot, node: fixture.node, row: reportOnly,
      report: fixture.report, structuredResult: fixture.result,
    })).resolves.toBeUndefined()
    expect(verifierMocks.failed).toHaveBeenCalledOnce()
  })

  it("reverifies a repair's exact completed attempt and rejects a stale envelope", async () => {
    const fixture = locationRepairFixture("completed")
    const passedReport = { ...fixture.report, status: "passed" as const, reasonCode: "criteria_met" as const,
      criteria: [{ criterionId: "location", status: "passed" as const, reasonCode: "criteria_met" as const }] }
    const row = { ...fixture.row, status: "completed", failureReason: null, result: { status: "completed", structuredResult: fixture.result, taskGraphVerificationReport: passedReport } }
    verifierMocks.completed.mockResolvedValue({ verified: true, report: passedReport, projection: fixture.projection, structuredResult: fixture.result })
    await expect(reverifyCompletedScoutLocationRepair({ client: {} as never, scope: fixture.scope, snapshot: fixture.snapshot, node: fixture.node, row, report: passedReport, structuredResult: fixture.result }))
      .resolves.toEqual({ projection: fixture.projection, structuredResult: fixture.result })
    expect(verifierMocks.completed).toHaveBeenCalledWith({}, expect.objectContaining({ scope: { ...fixture.scope, taskId: fixture.node.taskId, attemptCount: 4 }, includeObservedLocation: true }))
    await expect(reverifyCompletedScoutLocationRepair({ client: {} as never, scope: fixture.scope, snapshot: fixture.snapshot, node: fixture.node, row: { ...row, attemptCount: 0 }, report: passedReport, structuredResult: fixture.result }))
      .resolves.toBeUndefined()
    expect(verifierMocks.completed).toHaveBeenCalledOnce()
  })

  it("merges only receipt-bound duplicate candidates and evidence IDs", () => {
    const first = piece("job-1", "greenhouse", "dublin")
    const second = piece("job-1", "greenhouse", "dublin", "verified", "read:job:job-1-second")
    const merged = mergeReverifiedScoutLocationEvidence([first, second])
    expect(merged).toEqual({
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION, role: "scout",
      candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1", "read:job:job-1-second"], observedLocation: "dublin", locationEvidenceStatus: "verified" }],
      evidenceIds: ["read:job:job-1", "read:job:job-1-second"],
    })
  })

  it.each([
    ["source", piece("job-1", "greenhouse", "dublin"), piece("job-1", "lever", "dublin")],
    ["location", piece("job-1", "greenhouse", "dublin"), piece("job-1", "greenhouse", "cork")],
    ["missing versus present", piece("job-1", "greenhouse", null), piece("job-1", "greenhouse", "dublin")],
  ] as const)("marks conflicting repeated %s as unverified", (_label, first, second) => {
    const merged = mergeReverifiedScoutLocationEvidence([first, second])
    expect(merged?.candidates).toEqual([{ jobId: "job-1", evidenceIds: ["read:job:job-1"], observedLocation: null, locationEvidenceStatus: "conflicting" }])
  })

  it("keeps an observed conflicting status null", () => {
    expect(mergeReverifiedScoutLocationEvidence([piece("job-1", "greenhouse", null, "conflicting")] )?.candidates)
      .toEqual([{ jobId: "job-1", evidenceIds: ["read:job:job-1"], observedLocation: null, locationEvidenceStatus: "conflicting" }])
  })

  it("rejects v1 receipts, model/result identity mismatches, and empty composites", () => {
    const valid = piece("job-1", "greenhouse", "dublin")
    const v1 = { ...valid, projection: {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout",
      candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }], evidenceIds: ["read:job:job-1"],
    } }
    const mismatched = { ...valid, structuredResult: { ...(valid.structuredResult as Record<string, unknown>), candidates: [] } }
    expect(mergeReverifiedScoutLocationEvidence([v1])).toBeUndefined()
    expect(mergeReverifiedScoutLocationEvidence([mismatched])).toBeUndefined()
    expect(mergeReverifiedScoutLocationEvidence([])).toBeUndefined()
    expect(mergeReverifiedScoutLocationEvidence([{
      projection: { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION, role: "scout", candidates: [], evidenceIds: [], emptyDiscoveryReceipt: { digest: "a".repeat(64) } },
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "empty" },
    }])).toBeUndefined()
  })
})

function locationRepairFixture(status: "failed" | "completed") {
  const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "location-source", taskId: "location-task", templateId: "scout", goal: "find jobs in Dublin", successCriteria: ["verified location"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
      criteria: [{ id: "location", check: { kind: "candidate_location_in", locations: ["Dublin"] } }] },
  }] })
  const node = snapshot.nodes[0]!
  const result = validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Observed candidate." }, "scout")
  const projection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION, role: "scout",
    candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"], observedLocation: "dublin", locationEvidenceStatus: "verified" }], evidenceIds: ["read:job:job-1"] }
  const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: status === "failed" ? "failed" as const : "passed" as const,
    reasonCode: status === "failed" ? "criterion_not_met" as const : "criteria_met" as const,
    criteria: [{ criterionId: "location", status: status === "failed" ? "failed" as const : "passed" as const,
      reasonCode: status === "failed" ? "criterion_not_met" as const : "criteria_met" as const }],
    evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(result) }
  const row = { status, failureReason: status === "failed" ? "task_graph_verification_failed" : null, attemptCount: 4,
    taskType: TASK_GRAPH_TEMPLATES.scout.taskType, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
    expectedOutputSchema: { ...TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema },
    result: { status: "completed", structuredResult: result, taskGraphVerificationReport: report } }
  return { scope, snapshot, node, result, projection, report, row }
}
