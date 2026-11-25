import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { objectiveJobRequirementMaterialDigest } from "@jobcopilot/shared/objective-job-requirement-evidence"
import { canonicalTaskGraphReceiptJson, type TaskGraphReplayReceipt } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import { taskGraphEvidenceDigest, taskGraphResultDigest } from "@jobcopilot/shared/task-graph-verification-digest"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"
import type { ObjectiveJourneyRequirementRead } from "./objective-journey-report-requirement-receipts"
import { objectiveJourneyAnalystGraphRequirements, verifyObjectiveJourneyRequirementProof } from "./objective-journey-report-requirement-proof"

const jobId = "123e4567-e89b-42d3-a456-426614174000", userId = "owner-1", sessionId = "session-1"
const job = { id: jobId, company: "Example", description: "Must know Rust. Apply with care.", keywords: "Rust", location: "Dublin",
  role: "Engineer", salary: null, score: 8, source: "greenhouse", status: "saved", url: "https://jobs.example/1" }

describe("verifyObjectiveJourneyRequirementProof", () => {
  it("collects every Worker Scout selector in parser order", () => {
    const proof = objectiveJourneyAnalystGraphRequirements({ role: "analyst", criteria: [
      { id: "member-z", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-z" } },
      { id: "cover-a", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-a", minimumPercent: 90 } },
      { id: "union", check: { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-d", "scout-c"] } },
      { id: "union-cover", check: { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["scout-f", "scout-e"], minimumPercent: 80 } },
      { id: "each-cover", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-h", "scout-g"], minimumPercent: 70 } },
    ] })
    expect(proof).toEqual({ criteriaIds: ["member-z", "cover-a", "union", "union-cover", "each-cover"],
      dependencyNodeKeys: ["scout-a", "scout-c", "scout-d", "scout-e", "scout-f", "scout-g", "scout-h", "scout-z"],
      hasScoutMembership: true })
  })

  it("counts a quote only when result, report, receipt, candidate and current Job bindings agree", () => {
    const value = fixture(true)
    expect(verifyObjectiveJourneyRequirementProof(value.source, value.slot, value.read)).toEqual({ checked: true, hasVerifiedRequirements: true })
  })

  it("counts a valid Analyst with no proposals as checked but not positive", () => {
    const value = fixture(false)
    expect(verifyObjectiveJourneyRequirementProof(value.source, value.slot, value.read)).toEqual({ checked: true, hasVerifiedRequirements: false })
  })

  it("matches multiple out-of-order Scout bindings using the Worker's byte ordering", () => {
    const value = fixture(true, ["scout-z", "scout-a"])
    expect(verifyObjectiveJourneyRequirementProof(value.source, value.slot, value.read)).toEqual({ checked: true, hasVerifiedRequirements: true })
  })

  it.each(["evidence", "candidate", "current job"] as const)("does not count a changed %s binding", kind => {
    const value = fixture(true)
    if (kind === "evidence") value.read = { ...value.read, evidenceObservations: [] }
    if (kind === "candidate") value.slot = { ...value.slot, requirementAnalyst: { ...value.slot.requirementAnalyst!, proofDigest: "f".repeat(64) } }
    if (kind === "current job") value.read = { ...value.read, currentJob: { ...value.read.currentJob, description: "Changed description." } }
    expect(verifyObjectiveJourneyRequirementProof(value.source, value.slot, value.read).checked).toBe(false)
  })
})

function fixture(citation: boolean, dependencyKeys = ["scout-1"]) {
  const scope = { userId, sessionId, turnId: "source-turn", rootTaskId: "source-root", parentTaskId: "source-root", taskId: "analyst-1", attemptCount: 2 }
  const callContent = { toolCallId: "call-1", toolName: "jobs.get", toolVersion: "1", input: { jobId }, status: "completed", errorCode: null }
  const resultContent = { toolCallId: "call-1", output: { job }, status: "completed", errorCode: null }
  const items = [
    { id: "call-item", sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", type: "tool_call", status: "completed", revision: 0,
      content: callContent, joinedStepId: "step-1", stepStatus: "completed", attempt: 2, ordinal: 0, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId },
    { id: "result-item", sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", type: "tool_result", status: "completed", revision: 0,
      content: resultContent, joinedStepId: "step-1", stepStatus: "completed", attempt: 2, ordinal: 0, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId },
  ]
  const outcomes = new Map<string, "completed" | "failed">([["call-1", "completed"]])
  const result = { schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed",
    findings: [{ jobId, score: 8, evidenceIds: [`read:job:${jobId}`], ...(citation ? { requirementCitations: [{ evidenceId: `read:job:${jobId}`, quote: "Must know Rust." }] } : {}) }],
    evidence: [{ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }], summary: "One verified finding." }
  const resultDigest = taskGraphResultDigest(result), replayReceipts: readonly TaskGraphReplayReceipt[] = []
  const evidenceDigest = taskGraphEvidenceDigest(items, outcomes, [`read:job:${jobId}`], resultDigest, replayReceipts)
  const dependencyNodeKeys = [...dependencyKeys].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
  const dependencyBindings = dependencyNodeKeys.map((nodeKey, index) => ({ nodeKey, taskId: `scout-task-${index}`,
    attemptCount: 1, nodeDigest: String(index + 1).repeat(64), resultDigest: String(index + 2).repeat(64),
    evidenceDigest: String(index + 3).repeat(64), reportDigest: String(index + 4).repeat(64) }))
  const report = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "scout-membership", status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest, resultDigest, dependencyBindings }
  const reportDigest = hash(report)
  const proofDigest = hash({ nodeKey: "analyst-1", taskId: scope.taskId, attemptCount: scope.attemptCount, resultDigest, evidenceDigest,
    reportDigest, scouts: dependencyBindings })
  const materialDigest = objectiveJobRequirementMaterialDigest(job)
  const requirementAnalyst = { nodeKey: "analyst-1", taskId: scope.taskId, attemptCount: scope.attemptCount, proofDigest,
    jobMaterialDigest: materialDigest!, criteriaIds: ["finding-count", "scout-membership"], dependencyNodeKeys,
    dependencies: dependencyBindings.map(({ nodeKey, taskId }) => ({ nodeKey, taskId })) }
  const slot = { ordinal: 1, tailoringStatus: "ready" as const, sourceReady: true, jobId, job: { company: job.company, role: job.role },
    writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", requirementAnalyst }
  const source = { userId, sessionId, sourceTurnId: scope.turnId, rootTaskId: scope.rootTaskId, finalItemId: "final-item", graphRevision: 9,
    sourceCounts: { discoveredJobs: { knownCount: 1, coverage: "complete" as const }, analyzedJobs: { knownCount: 1, coverage: "complete" as const } }, slots: [slot] } as ObjectiveJourneySource
  const read = { scope, taskResult: { finalItemId: null, finalText: "done", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: result, taskGraphVerificationReport: report }, currentJob: { ...job, userId }, items, outcomes, replayReceipts,
    evidenceObservations: [{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.get", input: {}, status: "completed",
      output: { job: { id: jobId, source: "greenhouse", observedSource: "greenhouse", location: "Dublin" } }, errorCode: null } }] } as ObjectiveJourneyRequirementRead
  return { source, slot, read }
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalTaskGraphReceiptJson(value)).digest("hex")
}
