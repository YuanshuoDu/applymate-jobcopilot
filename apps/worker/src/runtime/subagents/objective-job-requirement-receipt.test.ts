import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ROLE_RESULT_SCHEMA, type AnalystResult } from "./role-result-job-evidence.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { taskGraphEvidenceDigest } from "./task-graph-pg-verification-receipt-validation.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { objectiveJobRequirementMaterialDigest } from "@jobcopilot/shared/objective-job-requirement-evidence"
import { readObjectiveJobRequirementEvidence, readObjectiveTailorJobRequirementEvidence } from "./objective-job-requirement-receipt.js"

const mocks = vi.hoisted(() => ({ load: vi.fn(), getJob: vi.fn(), scheduledProof: vi.fn() }))
vi.mock("./task-graph-pg-verification-receipts.js", () => ({ loadTaskGraphVerificationReceipts: mocks.load }))
vi.mock("../tools/read-data-source.js", () => ({ createPostgresReadToolDataSource: () => ({ getJob: mocks.getJob }) }))
vi.mock("./scheduled-draft-candidate-analyst-proof.js", () => ({ readScheduledDraftAnalystProof: mocks.scheduledProof }))

const jobId = "123e4567-e89b-42d3-a456-426614174000"
const scope = { userId: "owner-1", sessionId: "session-1", turnId: "source-turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", taskId: "analyst-1", attemptCount: 2 }
function job(overrides: Record<string, unknown> = {}) {
  return { id: jobId, company: "Example", role: "Engineer", location: null, status: "saved", score: 8,
    url: "https://example.test/job", source: "greenhouse", salary: null, description: "🙂 Required: Rust. More details.",
    keywords: "generated metadata", ...overrides }
}
function result(quote = "Required: Rust."): AnalystResult {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", summary: "Scored one job.",
    evidence: [{ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }],
    findings: [{ jobId, score: 8, evidenceIds: [`read:job:${jobId}`],
      requirementCitations: [{ evidenceId: `read:job:${jobId}`, quote }] }] }
}
function call(id = "call-1", requestJobId = jobId, attemptCount = 2) {
  return { id: `call-item-${id}`, type: "tool_call", taskId: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId,
    stepId: `step-${id}`, attempt: attemptCount, ordinal: 0, revision: 1,
    content: { toolCallId: id, toolName: "jobs.get", toolVersion: "1", input: { jobId: requestJobId }, status: "completed", errorCode: null } }
}
function toolResult(id = "call-1", outputJob = job(), attemptCount = 2) {
  return { id: `result-item-${id}`, type: "tool_result", taskId: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId,
    stepId: `step-${id}`, attempt: attemptCount, ordinal: 0, revision: 1,
    content: { toolCallId: id, status: "completed", output: { job: outputJob }, errorCode: null } }
}
function setup(options: { inputJobId?: string; outputJob?: ReturnType<typeof job>; attemptCount?: number;
  duplicate?: boolean; replay?: boolean; currentJob?: ReturnType<typeof job>; quote?: string; description?: string } = {}) {
  const inputJobId = options.inputJobId ?? jobId, attemptCount = options.attemptCount ?? 2
  const outputJob = options.outputJob ?? job(options.description ? { description: options.description } : {})
  const items = [call("call-1", inputJobId, attemptCount), toolResult("call-1", outputJob, attemptCount)]
  const replayReceipts: Array<{ currentCallId: string; sourceCallItem: readonly [string, number]; sourceResultItem: readonly [string, number] }> = []
  const outcomes = new Map<string, "completed" | "failed">([["call-1", "completed"]])
  if (options.duplicate) {
    items.push(call("call-2", inputJobId, attemptCount), toolResult("call-2", outputJob, attemptCount))
    outcomes.set("call-2", "completed")
    if (options.replay) replayReceipts.push({ currentCallId: "call-2", sourceCallItem: ["call-item-call-1", 1], sourceResultItem: ["result-item-call-1", 1] })
  }
  const receipts = { items, outcomes, replayReceipts, evidenceObservations: [] }
  const evidence = result(options.quote), resultDigest = taskGraphResultDigest(evidence), evidenceIds = evidence.evidence.map(item => item.id)
  mocks.load.mockResolvedValue(receipts)
  mocks.getJob.mockResolvedValue(options.currentJob ?? (options.description ? job({ description: options.description }) : job()))
  return { evidence, client: { query: vi.fn() } as never, proof: { evidenceIds, resultDigest,
    evidenceDigest: taskGraphEvidenceDigest(items, outcomes, evidenceIds, resultDigest, replayReceipts) } }
}
function input(analystResult: AnalystResult, proof?: ReturnType<typeof setup>["proof"]) {
  const resultDigest = taskGraphResultDigest(analystResult), evidenceIds = analystResult.evidence.map(item => item.id)
  return { scope, graphItemId: "task-graph-root-1", graphRevision: 4, analystNodeKey: "analyst-source-1", result: analystResult,
    resultDigest, evidenceDigest: proof?.evidenceDigest ?? "", evidenceIds: proof?.evidenceIds ?? evidenceIds, jobIds: [jobId] }
}

describe("completed Objective Job requirement receipts", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("binds a unique exact posting quote to the owned same-attempt jobs.get receipt and material digest", async () => {
    const value = setup()
    expect(objectiveJobRequirementMaterialDigest(job())).toBe(scheduledDraftJobMaterialDigest(job()))
    const privateTextJob = job({ description: "Email recruiter@example.com or call +1 (555) 123-4567" })
    expect(objectiveJobRequirementMaterialDigest(privateTextJob)).toBe(scheduledDraftJobMaterialDigest(privateTextJob))
    const output = await readObjectiveJobRequirementEvidence(value.client, input(value.evidence, value.proof))

    expect(output).toMatchObject({ status: "verified", proposedCount: 1, receipts: [{ userId: scope.userId, sessionId: scope.sessionId,
      sourceTurnId: scope.turnId, graphItemId: "task-graph-root-1", graphRevision: 4, analystNodeKey: "analyst-source-1",
      analystTaskId: scope.taskId, attemptCount: 2, jobId, inputJobId: jobId, outputJobId: jobId, evidenceId: `read:job:${jobId}`,
      startUtf16: 3, endUtf16: 18, quote: "Required: Rust.", quoteDigest: expect.any(String), inputDigest: expect.any(String),
      outputDigest: expect.any(String), jobMaterialDigest: expect.any(String), deliveries: [{ toolCallId: "call-1" }] }] })
    expect(mocks.load).toHaveBeenCalledWith(value.client, scope)
    expect(JSON.stringify(output)).not.toContain("More details")
  })

  it.each([
    ["requested/output mismatch", { inputJobId: "123e4567-e89b-42d3-a456-426614174001" }],
    ["other attempt", { attemptCount: 1 }],
    ["changed saved description", { currentJob: job({ description: "Changed posting text" }) }],
    ["missing quote", { quote: "Not in saved posting" }],
    ["repeated quote", { description: "Required: Rust. Again: Required: Rust." }],
  ])("returns no trusted citation for %s", async (_name, options) => {
    const value = setup(options)
    await expect(readObjectiveJobRequirementEvidence(value.client, input(value.evidence, value.proof)))
      .resolves.toMatchObject({ status: "unavailable", proposedCount: 1, receipts: [] })
  })

  it("rejects distinct competing reads but deduplicates an exact receipt replay", async () => {
    const competing = setup({ duplicate: true })
    await expect(readObjectiveJobRequirementEvidence(competing.client, input(competing.evidence, competing.proof)))
      .resolves.toMatchObject({ status: "unavailable", receipts: [] })
    const replayed = setup({ duplicate: true, replay: true })
    await expect(readObjectiveJobRequirementEvidence(replayed.client, input(replayed.evidence, replayed.proof)))
      .resolves.toMatchObject({ status: "verified", receipts: [{ deliveries: [{ toolCallId: "call-1" }, { toolCallId: "call-2",
        replaySourceCallItemId: "call-item-call-1", replaySourceResultItemId: "result-item-call-1" }] }] })
  })

  it("distinguishes no proposed citations from unavailable proof", async () => {
    const noProposal = { ...result(), findings: [{ jobId, score: 8, evidenceIds: [`read:job:${jobId}`] }] }
    await expect(readObjectiveJobRequirementEvidence({ query: vi.fn() } as never, input(noProposal)))
      .resolves.toEqual({ status: "absent", proposedCount: 0, receipts: [] })
    const invalidProof = setup()
    const withWrongDigest = { ...input(invalidProof.evidence, invalidProof.proof), resultDigest: "c".repeat(64) }
    await expect(readObjectiveJobRequirementEvidence(invalidProof.client, withWrongDigest))
      .resolves.toMatchObject({ status: "unavailable", proposedCount: 1, receipts: [] })
    const withWrongEvidenceDigest = { ...input(invalidProof.evidence, invalidProof.proof), evidenceDigest: "d".repeat(64) }
    await expect(readObjectiveJobRequirementEvidence(invalidProof.client, withWrongEvidenceDigest))
      .resolves.toMatchObject({ status: "unavailable", proposedCount: 1, receipts: [] })
  })

  it("rechecks the selected slot against its exact current Analyst binding and material digest", async () => {
    const value = setup(), materialDigest = scheduledDraftJobMaterialDigest(job())!
    const binding = { nodeKey: "analyst-source-1", taskId: scope.taskId, attemptCount: scope.attemptCount,
      resultDigest: value.proof.resultDigest, evidenceDigest: value.proof.evidenceDigest, reportDigest: "c".repeat(64), scouts: [] }
    const witness = { analystProofDigest: createHash("sha256").update(canonicalTaskGraphJson(binding)).digest("hex"),
      candidate: { jobId, materialDigest }, sourceAnalystKeys: ["analyst-source-1"] }
    mocks.scheduledProof.mockResolvedValue({ result: value.evidence, materialDigests: new Map([[jobId, materialDigest]]),
      evidenceIds: value.proof.evidenceIds, binding })
    const request = { scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId }, graphItemId: "task-graph-root-1", graphRevision: 4,
      snapshot: { nodes: [{ key: "analyst-source-1" }] }, outcomes: [{ status: "ready", jobId, candidateWitness: witness }] }

    await expect(readObjectiveTailorJobRequirementEvidence(value.client, request as never))
      .resolves.toMatchObject({ status: "verified", proposedCount: 1, receipts: [{ analystTaskId: scope.taskId, jobId }] })
    expect(mocks.scheduledProof).toHaveBeenCalledWith(value.client, request.scope, request.snapshot, request.snapshot.nodes[0])
  })
})
