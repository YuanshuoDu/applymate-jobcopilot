import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, buildScheduledTaskGraphPrepareCheckpoint } from "./scheduled-taskgraph-pipeline-checkpoint"
import { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphAnalyzeCheckpointDigest, scheduledTaskGraphPrepareResultDigest } from "./scheduled-taskgraph-gate-checkpoint"
import { runScheduledTaskGraphAnalyzeOnly } from "./scheduled-taskgraph-run-service"
import type { PipelineCtx } from "./pipeline-context"
import type { Job } from "@prisma/client"

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), scoreOwner: vi.fn(), ownerCurrent: vi.fn(), save: vi.fn(), gateInput: vi.fn(), gateCheckpoint: vi.fn(),
  gateMaterials: vi.fn(), taskRows: vi.fn(), useActualGateInput: false, useActualGateCheckpoint: false, events: vi.fn(), steps: vi.fn(), items: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentEvent: { findMany: mocks.events }, agentStep: { findFirst: mocks.steps }, agentItem: { findFirst: mocks.items },
  subAgentTask: { findMany: mocks.taskRows } } }))
vi.mock("./scheduled-taskgraph-analysis-journal", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-analysis-journal")>()
  return { ...actual, runScheduledTaskGraphAnalyze: mocks.analyze, scheduledTaskGraphScoreOwnerIsCurrent: mocks.scoreOwner }
})
vi.mock("./scheduled-taskgraph-pipeline-fence", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-pipeline-fence")>()
  return { ...actual, isScheduledTaskGraphOwnerCurrent: mocks.ownerCurrent, saveScheduledTaskGraphCheckpoint: mocks.save }
})
vi.mock("./scheduled-taskgraph-gate-input", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-gate-input")>()
  return { ...actual, loadScheduledTaskGraphGateInput: (...args: Parameters<typeof actual.loadScheduledTaskGraphGateInput>) => {
    if (mocks.useActualGateInput) { mocks.gateInput(...args); return actual.loadScheduledTaskGraphGateInput(...args) }
    return mocks.gateInput(...args)
  } }
})
vi.mock("./scheduled-taskgraph-gate-checkpoint", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-gate-checkpoint")>()
  return { ...actual, buildScheduledTaskGraphGateCheckpoint: (...args: Parameters<typeof actual.buildScheduledTaskGraphGateCheckpoint>) => {
    if (mocks.useActualGateCheckpoint) { mocks.gateCheckpoint(...args); return actual.buildScheduledTaskGraphGateCheckpoint(...args) }
    return mocks.gateCheckpoint(...args)
  } }
})
vi.mock("./scheduled-taskgraph-gate-materials", () => ({ loadScheduledTaskGraphGateMaterials: mocks.gateMaterials }))

const owner = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1",
  rootAttemptCount: 2, turnLeaseOwnerId: "worker_1", turnLeaseVersion: 4, executionId: "execution_1", executionAttemptCount: 0 }
const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 80, dailyCap: 5, requireApproval: false, autoApply: false }
const job = { id: "job_1", userId: owner.userId } as Job
const score = { job, score: 0, matchedKeywords: [], missingKeywords: ["TypeScript"], recommendation: "Potential fit", analysisFenceAt: "2026-10-20T10:00:00.000Z" }
const baseAttestation = {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1",
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
  scout: { taskId: "scout_1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "a".repeat(64),
    candidateJobIds: [job.id], discoveryReceipt: { status: "complete", taskId: "scout_1", attemptCount: 1,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: "c".repeat(64) } },
  analyst: { taskId: "analyst_1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "d".repeat(64),
    dependsOnTaskIds: ["scout_1"], jobIds: [job.id] }, evidenceDigest: "b".repeat(64),
}
const key = scheduledTaskGraphContinuationKey(owner, baseAttestation)
const claimToken = "claim-token-1"
const initialState = { nextStage: "scout", scheduledTaskGraphClaim: {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner,
} }
const analysis = { stage: "analyze" as const, ok: true as const, data: { scoredJobs: [score], failed: 0 }, metrics: { durationMs: 5, count: 1 } }
const persistedState = { ...initialState, scoutedJobs: [job], scoredJobs: [score], analysisFailed: 0,
  scheduledTaskGraphAnalyzeJournal: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1",
    key, owner, attemptsByJob: { [job.id]: 1 }, failedJobIds: [] } }
const finalStepId = "step_final_1", finalStepOrdinal = 1
const prepareReceipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", owner, continuationKey: key,
  snapshotDigest: baseAttestation.snapshotDigest, evidenceDigest: baseAttestation.evidenceDigest, checkpointDigest: "e".repeat(64),
  analyzeGraphRevision: 9, prepareScheduleRevision: 10 }
function workerPrepareProof(receipt: typeof prepareReceipt = prepareReceipt) {
  const result = { schemaVersion: "agent-harness.v2.subagent.result", role: "prepare", status: "completed", taskId: "prepare_1", attemptCount: 1,
    snapshotDigest: receipt.snapshotDigest, checkpointDigest: receipt.checkpointDigest, jobs: [], materials: [] }
  const resultDigest = scheduledTaskGraphPrepareResultDigest(result)
  return { receipt, completion: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-prepare-completion.v1", graphRevision: 11,
    nodes: [
      { taskId: "scout_1", attemptCount: 1, role: "scout", taskType: "job_discovery", status: "completed", verification: "passed", dependsOnTaskIds: [] },
      { taskId: "analyst_1", attemptCount: 1, role: "analyst", taskType: "job_analysis", status: "completed", verification: "passed", dependsOnTaskIds: ["scout_1"] },
      { taskId: "prepare_1", attemptCount: 1, role: "prepare", taskType: "scheduled_application_prepare", status: "completed", verification: "passed",
        dependsOnTaskIds: ["analyst_1"], tool: "scheduled.application.prepare@1", resultDigest },
    ], wait: { waitId: "wait_prepare_1", status: "ready", mode: "all", targetTaskIds: ["prepare_1"], matchedTaskIds: ["prepare_1"] } }, result }
}
const approvalSnapshot = { ...snapshot, requireApproval: true }
const approvalAttestation = { ...baseAttestation, snapshotDigest: scheduledAutomationSnapshotDigest(approvalSnapshot) }
const approvalKey = scheduledTaskGraphContinuationKey(owner, approvalAttestation)
const approvalReceipt = { ...prepareReceipt, continuationKey: approvalKey, snapshotDigest: approvalAttestation.snapshotDigest }
const approvalWaitProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
  owner.executionId, owner.executionAttemptCount, approvalKey, approvalReceipt.snapshotDigest, approvalReceipt.evidenceDigest,
  approvalReceipt.checkpointDigest, approvalReceipt.analyzeGraphRevision, approvalReceipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, 1]
const approvalWaitId = `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(approvalWaitProjection), "utf8").digest("hex")}`
const v2ApprovalReceipt = { ...approvalReceipt, continuationKey: `scheduled-taskgraph:v2:sha256:${'f'.repeat(64)}` }
const v2ApprovalWaitProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
  owner.executionId, owner.executionAttemptCount, v2ApprovalReceipt.continuationKey, v2ApprovalReceipt.snapshotDigest,
  v2ApprovalReceipt.evidenceDigest, v2ApprovalReceipt.checkpointDigest, v2ApprovalReceipt.analyzeGraphRevision,
  v2ApprovalReceipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, 1]
const v2ApprovalWaitId = `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(v2ApprovalWaitProjection), "utf8").digest("hex")}`
const candidatePayload = { schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v3", sessionId: owner.sessionId,
  turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, finalStepId, finalStepOrdinal,
  stepAttempt: 1, candidateText: "candidate", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 },
  sourceReceipt: { schemaVersion: 1, bindings: [{ key: "E-job-1", observationId: "tool-result:call-1", toolCallId: "call-1",
    toolName: "jobs.search", sourceRef: "jobs/0", inputDigest: `sha256:${"a".repeat(64)}`, resultDigest: `sha256:${"b".repeat(64)}` }] } }
const scheduledWaitProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
  owner.executionId, owner.executionAttemptCount, key, prepareReceipt.snapshotDigest, prepareReceipt.evidenceDigest,
  prepareReceipt.checkpointDigest, prepareReceipt.analyzeGraphRevision, prepareReceipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, 1]
const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(scheduledWaitProjection), "utf8").digest("hex")}`
function scheduledChoiceItem(answer: string | null = null, waitId = scheduledWaitId, receipt = prepareReceipt) {
  return { id: `agent-wait:question:${waitId}`, stepId: finalStepId, taskId: owner.rootTaskId, type: "question",
    status: answer === null ? "started" : "completed", content: { waitKind: "question", questionId: waitId,
      toolCallId: null, stage: "scheduled_prepare", question: "How should ApplyMate tailor your resume for this role?",
      options: [{ label: "Apply AI changes", value: "apply_ai_changes" }, { label: "Keep my current resume", value: "keep_resume" }],
      answer, answerAvailable: answer !== null, ...(answer !== null ? { answeredAt: "2026-10-21T10:00:00.000Z" } : {}),
      scheduledPrepareChoiceBinding: { schemaVersion: "agent-harness.v2.scheduled-prepare-choice-wait.v1",
        owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
          rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
        continuationKey: receipt.continuationKey, snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest,
        checkpointDigest: receipt.checkpointDigest, analyzeGraphRevision: receipt.analyzeGraphRevision,
        prepareScheduleRevision: receipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, finalStepAttempt: 1 } } }
}

function context(): PipelineCtx {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    questionProjectionMode: "canonical", agentCfg: { requireApproval: false } as PipelineCtx["agentCfg"],
    roleConfigs: {} as PipelineCtx["roleConfigs"], resumeText: "", resumeContent: {} as PipelineCtx["resumeContent"],
    defaultResume: { id: "resume_1", name: "CV", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: "minimax", model: "MiniMax-M3" }, autonomous: false, emit: vi.fn(),
    executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount } } as PipelineCtx
}

describe("runScheduledTaskGraphAnalyzeOnly", () => {
  beforeEach(() => {
    ;[mocks.analyze, mocks.scoreOwner, mocks.ownerCurrent, mocks.save, mocks.gateInput, mocks.gateCheckpoint, mocks.gateMaterials,
      mocks.taskRows, mocks.events, mocks.steps, mocks.items].forEach(mock => mock.mockReset())
    mocks.ownerCurrent.mockResolvedValue(true)
    mocks.scoreOwner.mockResolvedValue(true)
    mocks.save.mockResolvedValue(true)
    mocks.gateInput.mockReset()
    mocks.gateCheckpoint.mockReset()
    mocks.gateMaterials.mockReset().mockResolvedValue({ packages: [], materials: [] })
    mocks.taskRows.mockReset()
    mocks.useActualGateInput = false
    mocks.useActualGateCheckpoint = false
    mocks.gateInput.mockResolvedValue({ packages: [{ userId: owner.userId, sessionId: owner.sessionId, jobId: job.id,
      package: { job: { id: job.id }, coverLetter: "private-letter-body" } as never }],
      materials: [{ userId: owner.userId, sessionId: owner.sessionId, jobId: job.id, kind: "resume",
        artifactRef: { artifactId: "artifact_1", version: 3, contentHash: "sha256:" + "1".repeat(64), sourceDigest: "sha256:" + "2".repeat(64) } }] })
    mocks.gateCheckpoint.mockImplementation(({ analyze }: { analyze: { persistedCheckpoint: Record<string, unknown> } }) => ({
      checkpoint: { ...analyze.persistedCheckpoint, nextStage: "gate" },
      packages: [{ job: { id: job.id }, coverLetter: "private-letter-body" } as never],
    }))
    mocks.events.mockImplementation((args: { where: { type: string } }) => Promise.resolve(args.where.type === "agent.plan.scheduled_prepare_binding"
      ? [{ payload: prepareReceipt }]
      : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload: candidatePayload }]))
    mocks.steps.mockImplementation((args: { where: { id?: string } }) => Promise.resolve(args.where.id
      ? { id: finalStepId, status: "streaming" } : { id: finalStepId }))
    mocks.items.mockResolvedValue(null)
  })

  it("persists the authoritative 0-100 Analyze checkpoint and returns only its opaque proof", async () => {
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint
    mocks.analyze.mockResolvedValue({ analysis, checkpoint, persistedState })
    const onStateChange = vi.fn()
    await expect(runScheduledTaskGraphAnalyzeOnly({ owner, snapshot, attestation: baseAttestation, continuationKey: key,
      claimToken, ownedJobs: [job], context: context(), state: initialState, onStateChange })).resolves.toEqual({
      status: "analyze_checkpointed", continuationKey: key,
      checkpointDigest: scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint),
      claimTokenDigest: `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`,
      executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount,
    })
    expect(mocks.analyze).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [{ ...job, coverLetter: null }], owner, key, claimToken,
    }))
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedState: persistedState, state: checkpoint }))
    expect(checkpoint.scoredJobs?.[0]?.score).toBe(0)
    expect(onStateChange).toHaveBeenCalledWith(checkpoint)
  }, 30_000)

  it("strips a legacy Job cover letter before Analyze journal and final checkpoint writes", async () => {
    const sentinel = "legacy-cover-letter-journal-body-must-not-persist"
    const jobWithLegacyLetter = { ...job, coverLetter: sentinel } as Job
    const safeJob = { ...job, coverLetter: null } as Job
    const safeScore = { ...score, job: safeJob }
    const safeAnalysis = { ...analysis, data: { ...analysis.data, scoredJobs: [safeScore] } }
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [jobWithLegacyLetter], analyzeResult: { ...safeAnalysis, data: { ...safeAnalysis.data, scoredJobs: [{ ...safeScore, job: jobWithLegacyLetter }] } },
      existingCheckpoint: initialState }).checkpoint
    const safePersistedState = { ...initialState, scoutedJobs: [safeJob], scoredJobs: [safeScore], analysisFailed: 0,
      scheduledTaskGraphAnalyzeJournal: persistedState.scheduledTaskGraphAnalyzeJournal }
    mocks.analyze.mockResolvedValue({ analysis: safeAnalysis, checkpoint, persistedState: safePersistedState })

    await runScheduledTaskGraphAnalyzeOnly({ owner, snapshot, attestation: baseAttestation, continuationKey: key,
      claimToken, ownedJobs: [jobWithLegacyLetter], context: context(), state: initialState, onStateChange: vi.fn() })

    expect(mocks.analyze).toHaveBeenCalledWith(expect.objectContaining({ jobs: [safeJob] }))
    expect(JSON.stringify(mocks.analyze.mock.calls)).not.toContain(sentinel)
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain(sentinel)
  }, 30_000)

  it("returns only a fixed-format digest that changes with the active claim token", async () => {
    const stateChanges: unknown[] = []
    const run = async (activeClaimToken: string) => {
      const state = { ...initialState,
        scheduledTaskGraphClaim: { ...initialState.scheduledTaskGraphClaim, claimToken: activeClaimToken } }
      const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
        ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: state }).checkpoint
      mocks.analyze.mockResolvedValueOnce({ analysis, checkpoint, persistedState: state })
      return runScheduledTaskGraphAnalyzeOnly({ owner, snapshot, attestation: baseAttestation, continuationKey: key,
        claimToken: activeClaimToken, ownedJobs: [job], context: context(), state,
        onStateChange: value => stateChanges.push(value) })
    }
    const first = await run(claimToken)
    const second = await run("claim-token-2")

    expect(first.claimTokenDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(second.claimTokenDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.claimTokenDigest).not.toBe(second.claimTokenDigest)
    expect(first).not.toHaveProperty("claimToken")
    expect(second).not.toHaveProperty("claimToken")
    expect(JSON.stringify(stateChanges)).not.toContain(first.claimTokenDigest)
    expect(JSON.stringify(stateChanges)).not.toContain(second.claimTokenDigest)
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain(first.claimTokenDigest)
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain(second.claimTokenDigest)
  }, 30_000)

  it("replays a persisted Prepare checkpoint without rescoring or mutating execution state", async () => {
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint
    const result = await runScheduledTaskGraphAnalyzeOnly({ owner, snapshot, attestation: baseAttestation, continuationKey: key,
      claimToken, ownedJobs: [job], context: context(), state: checkpoint, onStateChange: vi.fn() })

    expect(result.status).toBe("analyze_checkpointed")
    expect(result.checkpointDigest).toBe(scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint))
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  }, 30_000)

  it("rejects an out-of-range persisted score before returning proof", async () => {
    const invalid = { ...buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint,
      scoredJobs: [{ ...score, score: 101 }] }
    mocks.analyze.mockResolvedValue({ analysis, checkpoint: invalid, persistedState })
    mocks.save.mockResolvedValue(true)
    await expect(runScheduledTaskGraphAnalyzeOnly({ owner, snapshot, attestation: baseAttestation, continuationKey: key,
      claimToken, ownedJobs: [job], context: context(), state: initialState, onStateChange: vi.fn() }))
      .rejects.toBeInstanceOf(Error)
    expect(mocks.save).not.toHaveBeenCalled()
  }, 30_000)

  it("continues to Gate without a scheduled-choice checkpoint when approval is disabled", async () => {
    const analyzeCheckpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint
    const activeClaim = { ...initialState.scheduledTaskGraphClaim, claimedAt: "2026-10-20T10:00:00.000Z", leaseExpiresAt: "2099-10-20T10:10:00.000Z" }
    const persisted = { ...analyzeCheckpoint, nextStage: "gate", scheduledTaskGraphClaim: activeClaim }
    const continuation = persisted.scheduledTaskGraphContinuation as Record<string, unknown>
    const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(analyzeCheckpoint)!
    const prepareScheduleRevision = Number(continuation.graphRevision) + 1
    const receiptProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
      owner.executionId, owner.executionAttemptCount, continuation.snapshotDigest, continuation.evidenceDigest, checkpointDigest,
      continuation.graphRevision, prepareScheduleRevision]
    const receipt: typeof prepareReceipt = { ...prepareReceipt,
      continuationKey: `scheduled-taskgraph:sha256:${createHash("sha256").update(JSON.stringify(receiptProjection), "utf8").digest("hex")}`,
      snapshotDigest: String(continuation.snapshotDigest), evidenceDigest: String(continuation.evidenceDigest), checkpointDigest,
      analyzeGraphRevision: Number(continuation.graphRevision), prepareScheduleRevision }
    const prepareProof = workerPrepareProof(receipt)
    const graphNodes = [
      { key: "scout", taskId: "scout_1", templateId: "scout", depth: 1, dependsOn: [], verificationDisposition: "typed", verification: { role: "scout", criteria: [{ id: "candidate-count" }] } },
      { key: "analyst", taskId: "analyst_1", templateId: "analyst", depth: 2, dependsOn: ["scout"], verificationDisposition: "typed", verification: { role: "analyst", criteria: [{ id: "source-match" }] } },
      { key: "prepare", taskId: "prepare_1", templateId: "prepare", depth: 3, dependsOn: ["analyst"], verificationDisposition: "specialized" },
    ]
    const report = (resultDigest: string, criterionId: string) => ({ verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed",
      reasonCode: "criteria_met", resultDigest, evidenceDigest: "f".repeat(64), criteria: [{ criterionId, status: "passed", reasonCode: "criteria_met" }] })
    const graphId = `task-graph-${createHash("sha256").update(owner.rootTaskId).digest("hex")}`
    const graph = { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, type: "task_graph", revision: 11,
      content: { schemaVersion: "agent-harness.v2.task-graph", nodes: graphNodes } }
    const completionFacts = { schemaVersion: prepareProof.completion.schemaVersion, graphRevision: prepareProof.completion.graphRevision, nodes: prepareProof.completion.nodes }
    mocks.useActualGateInput = true
    mocks.useActualGateCheckpoint = true
    mocks.gateInput.mockImplementation((args: { prepareProof: unknown }) => expect(parseScheduledTaskGraphPrepareProof(args.prepareProof)).not.toBeNull())
    mocks.gateCheckpoint.mockImplementation((args: { proof: unknown }) => expect(parseScheduledTaskGraphPrepareProof(args.proof)).not.toBeNull())
    mocks.gateMaterials.mockResolvedValue({ packages: [], materials: [] })
    mocks.items.mockImplementation((args: { where: { id?: string } }) => Promise.resolve(args.where.id === graphId ? graph : null))
    mocks.taskRows.mockResolvedValue([
      { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: null,
        attemptCount: owner.rootAttemptCount, status: "running", failureReason: null },
      { id: "scout_1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
        attemptCount: 1, status: "completed", role: "scout", taskType: "job_discovery", failureReason: null,
        result: { status: "completed", taskGraphVerificationReport: report("a".repeat(64), "candidate-count") } },
      { id: "analyst_1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
        attemptCount: 1, status: "completed", role: "analyst", taskType: "job_analysis", failureReason: null,
        result: { status: "completed", taskGraphVerificationReport: report("d".repeat(64), "source-match") } },
      { id: "prepare_1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
        attemptCount: 1, status: "completed", role: "prepare", taskType: "scheduled_application_prepare", failureReason: null,
        result: { status: "completed", structuredResult: prepareProof.result, taskGraphScheduledPrepareProofFacts: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-prepare-proof-facts.v1",
          receipt, completion: completionFacts, result: prepareProof.result } } },
    ])
    mocks.events.mockImplementation((args: { where: { type: string } }) => Promise.resolve(args.where.type === "agent.plan.scheduled_prepare_binding"
      ? [{ payload: receipt }]
      : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload: candidatePayload }]))
    const resume = await (await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({
      owner, snapshot, attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job],
      persistedCheckpoint: persisted, prepareProof,
    })
    expect(mocks.gateInput).toHaveBeenCalledWith(expect.objectContaining({ owner, snapshot,
      analyzeCheckpoint: { ...persisted, nextStage: "prepare" }, analyzeAttestation: baseAttestation, prepareProof }))
    expect(mocks.gateInput.mock.calls[0]?.[0].prepareProof).toBe(prepareProof)
    expect(mocks.gateCheckpoint.mock.calls[0]?.[0].proof).toBe(prepareProof)
    expect(mocks.gateInput.mock.invocationCallOrder[0]).toBeLessThan(mocks.gateCheckpoint.mock.invocationCallOrder[0]!)
    expect(resume.preparedPackages).toEqual([])
    expect(resume.scheduledTaskGraphPreparedArtifacts).toEqual([])
    expect(resume).not.toHaveProperty("scheduledTaskGraphScheduledWaitId")
    const full = { ...resume, nextStage: "execute" as const, gateOutput: {
      approved: [{ job: { id: job.id }, coverLetter: "private-letter-body" }], pending: [], skipped: [],
    } as never }
    const serialized = (await import("./scheduled-taskgraph-run-service")).serializeScheduledTaskGraphCheckpoint(full)
    expect(serialized).not.toHaveProperty("preparedPackages")
    expect(serialized).not.toHaveProperty("gateOutput")
    expect(serialized?.scheduledTaskGraphGateDecisions).toEqual({ approvedJobIds: [job.id], pendingJobIds: [], skippedJobIds: [] })
    expect(serialized).not.toHaveProperty("scheduledTaskGraphScheduledWaitId")
    expect(JSON.stringify(serialized)).not.toContain("private-letter-body")
    await expect((await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({ owner, snapshot,
      attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job],
      persistedCheckpoint: { ...persisted, scheduledTaskGraphScheduledWaitId: scheduledWaitId },
      prepareProof: { receipt: prepareReceipt, completion: {}, result: { taskId: "prepare_1" } },
    })).rejects.toBeInstanceOf(Error)
  })

  it("requires the exact Worker choice ID and an answered persisted item when approval is enabled", async () => {
    const { validateScheduledPrepareWaitIdentity } = await import("./scheduled-taskgraph-run-service")
    const proof = { receipt: approvalReceipt, completion: {}, result: {} }
    mocks.events.mockImplementation((args: { where: { type: string } }) => Promise.resolve(args.where.type === "agent.plan.scheduled_prepare_binding"
      ? [{ payload: approvalReceipt }]
      : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload: candidatePayload }]))
    mocks.items.mockResolvedValue(scheduledChoiceItem("apply_ai_changes", approvalWaitId, approvalReceipt))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(true)
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: `${approvalWaitId}-other` })).resolves.toBe(false)
    mocks.items.mockResolvedValueOnce({ ...scheduledChoiceItem("apply_ai_changes", approvalWaitId, approvalReceipt),
      content: { ...scheduledChoiceItem("apply_ai_changes", approvalWaitId, approvalReceipt).content, answeredAt: "invalid" } })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(false)
    mocks.items.mockResolvedValueOnce(scheduledChoiceItem(null, approvalWaitId, approvalReceipt))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(false)
    mocks.steps.mockResolvedValueOnce({ id: "newer_step" }).mockResolvedValueOnce({ id: finalStepId, status: "streaming" })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(false)
  })

  it("reads v2 Prepare choice receipts without accepting trailing key data", async () => {
    const { validateScheduledPrepareWaitIdentity } = await import("./scheduled-taskgraph-run-service")
    mocks.events.mockImplementation((args: { where: { type: string } }) => Promise.resolve(args.where.type === "agent.plan.scheduled_prepare_binding"
      ? [{ payload: v2ApprovalReceipt }]
      : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload: candidatePayload }]))
    mocks.items.mockResolvedValue(scheduledChoiceItem("apply_ai_changes", v2ApprovalWaitId, v2ApprovalReceipt))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot,
      proof: { receipt: v2ApprovalReceipt, completion: {}, result: {} }, scheduledWaitId: v2ApprovalWaitId })).resolves.toBe(true)

    const malformed = { ...v2ApprovalReceipt, continuationKey: `${v2ApprovalReceipt.continuationKey}\n` }
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot,
      proof: { receipt: malformed, completion: {}, result: {} }, scheduledWaitId: v2ApprovalWaitId })).resolves.toBe(false)
  })

  it("requires absence of the Worker choice ID and item when approval is disabled", async () => {
    const { validateScheduledPrepareWaitIdentity } = await import("./scheduled-taskgraph-run-service")
    mocks.items.mockResolvedValue(null)
    const proof = { receipt: prepareReceipt, completion: {}, result: {} }
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof, scheduledWaitId })).resolves.toBe(false)
    mocks.items.mockResolvedValue(scheduledChoiceItem("apply_ai_changes"))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(false)
  })

  it("accepts legacy v2 and receipt-bearing v3 candidates but rejects malformed or widened payloads", async () => {
    const { validateScheduledPrepareWaitIdentity } = await import("./scheduled-taskgraph-run-service")
    const proof = { receipt: prepareReceipt, completion: {}, result: {} }
    mocks.items.mockResolvedValue(null)
    const useCandidate = (payload: unknown) => mocks.events.mockImplementation((args: { where: { type: string } }) => Promise.resolve(
      args.where.type === "agent.plan.scheduled_prepare_binding" ? [{ payload: prepareReceipt }]
        : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload }]))

    useCandidate(candidatePayload)
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)

    const scopedCandidate = (userId: string) => ({ ...candidatePayload, sourceReceipt: { ...candidatePayload.sourceReceipt,
      scope: { userId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, stepId: finalStepId } } })
    useCandidate(scopedCandidate(owner.userId))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)
    useCandidate(scopedCandidate("other_user"))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(false)

    const { sourceReceipt: _privateReceipt, ...legacyCandidate } = candidatePayload
    useCandidate({ ...legacyCandidate, schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v2" })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)

    useCandidate({ ...candidatePayload, sourceReceipt: { ...candidatePayload.sourceReceipt, extra: true } })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(false)
    useCandidate({ ...candidatePayload, internalDigest: "must-not-be-accepted" })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(false)
  })

  it("still validates TaskGraph completion before Gate when approval is disabled", async () => {
    const persisted = { ...buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint,
      scheduledTaskGraphClaim: initialState.scheduledTaskGraphClaim }
    mocks.items.mockResolvedValue(null)
    mocks.gateCheckpoint.mockReturnValueOnce(null)
    await expect((await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({ owner, snapshot,
      attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job], persistedCheckpoint: persisted,
      prepareProof: { receipt: prepareReceipt, completion: {}, result: { taskId: "prepare_1" } },
    })).rejects.toBeInstanceOf(Error)
    expect(mocks.gateCheckpoint).toHaveBeenCalled()
  })

  it("requires a persisted Worker Gate completion proof before Execute and keeps checkpoint decisions bounded", async () => {
    mocks.items.mockResolvedValue(null)
    const checkpoint = { nextStage: "execute" as const, scheduledTaskGraphPreparedArtifacts: [
      { jobId: job.id, kind: "resume" as const, artifactRef: { artifactId: "artifact_1", version: 3, contentHash: "sha256:" + "1".repeat(64), sourceDigest: "sha256:" + "2".repeat(64) } },
    ], scheduledTaskGraphGateDecisions: { approvedJobIds: [], pendingJobIds: [job.id], skippedJobIds: [] } }
    await expect((await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({
      owner, snapshot, attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job],
      persistedCheckpoint: checkpoint, prepareProof: workerPrepareProof(),
    })).rejects.toBeInstanceOf(Error)
    expect(mocks.gateInput).not.toHaveBeenCalled()
    const serialized = (await import("./scheduled-taskgraph-run-service")).serializeScheduledTaskGraphCheckpoint({
      ...checkpoint, gateOutput: { approved: [], pending: [{ job: { id: job.id }, coverLetter: "private-letter-body" }], skipped: [] } as never,
    })
    expect(serialized?.scheduledTaskGraphGateDecisions).toEqual({ approvedJobIds: [], pendingJobIds: [job.id], skippedJobIds: [] })
    expect(JSON.stringify(serialized)).not.toContain("private-letter-body")
  })

  it("compares persisted prepared artifacts canonically while preserving content and array order", async () => {
    const { buildScheduledTaskGraphGateResumeState } = await import("./scheduled-taskgraph-run-service")
    const artifactRefs = [
      { jobId: job.id, kind: "resume" as const, artifactRef: { artifactId: "artifact_1", version: 3,
        contentHash: "sha256:" + "1".repeat(64), sourceDigest: "sha256:" + "2".repeat(64) } },
      { jobId: job.id, kind: "cover_letter" as const, artifactRef: { artifactId: "artifact_2", version: 4,
        contentHash: "sha256:" + "3".repeat(64), sourceDigest: "sha256:" + "4".repeat(64) } },
    ]
    mocks.gateInput.mockResolvedValue({
      packages: [{ userId: owner.userId, sessionId: owner.sessionId, jobId: job.id, package: { job: { id: job.id } } as never }],
      materials: artifactRefs.map(row => ({ userId: owner.userId, sessionId: owner.sessionId, ...row })),
    })
    const persisted = { ...buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint,
      scheduledTaskGraphClaim: initialState.scheduledTaskGraphClaim,
      scheduledTaskGraphPreparedArtifacts: [
        { artifactRef: { sourceDigest: artifactRefs[0]!.artifactRef.sourceDigest, version: 3, artifactId: "artifact_1",
          contentHash: artifactRefs[0]!.artifactRef.contentHash }, kind: "resume", jobId: job.id },
        { artifactRef: { version: 4, sourceDigest: artifactRefs[1]!.artifactRef.sourceDigest, contentHash: artifactRefs[1]!.artifactRef.contentHash,
          artifactId: "artifact_2" }, jobId: job.id, kind: "cover_letter" },
      ],
    }
    const resume = (persistedCheckpoint: unknown) => buildScheduledTaskGraphGateResumeState({ owner, snapshot,
      attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job], persistedCheckpoint,
      prepareProof: workerPrepareProof() })

    await expect(resume(persisted)).resolves.toMatchObject({ scheduledTaskGraphPreparedArtifacts: artifactRefs })
    await expect(resume({ ...persisted, scheduledTaskGraphPreparedArtifacts: artifactRefs.map((row, index) => index === 0
      ? { ...row, artifactRef: { ...row.artifactRef, contentHash: "sha256:" + "9".repeat(64) } } : row) }))
      .rejects.toBeInstanceOf(Error)
    await expect(resume({ ...persisted, scheduledTaskGraphPreparedArtifacts: artifactRefs.map((row, index) => index === 0
      ? { ...row, jobId: "other_job" } : row) })).rejects.toBeInstanceOf(Error)
    await expect(resume({ ...persisted, scheduledTaskGraphPreparedArtifacts: [...artifactRefs].reverse() })).rejects.toBeInstanceOf(Error)
  })

  it("compares persisted Gate decisions canonically in resume and serialization", async () => {
    const { buildScheduledTaskGraphGateResumeState, serializeScheduledTaskGraphCheckpoint } = await import("./scheduled-taskgraph-run-service")
    const secondJob = { id: "job_2", userId: owner.userId } as Job
    const secondScore = { ...score, job: secondJob }
    const attestation = { ...baseAttestation,
      scout: { ...baseAttestation.scout, candidateJobIds: [job.id, secondJob.id],
        discoveryReceipt: { ...baseAttestation.scout.discoveryReceipt, candidateCount: 2 } },
      analyst: { ...baseAttestation.analyst, jobIds: [job.id, secondJob.id] },
    }
    const continuationKey = scheduledTaskGraphContinuationKey(owner, attestation)
    const analysisForJobs = { ...analysis, data: { ...analysis.data, scoredJobs: [score, secondScore] },
      metrics: { ...analysis.metrics, count: 2 } }
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation, ownedJobs: [job, secondJob],
      analyzeResult: analysisForJobs, existingCheckpoint: { ...initialState,
        scheduledTaskGraphClaim: { ...initialState.scheduledTaskGraphClaim, key: continuationKey } } }).checkpoint
    const jobIds = [job.id, secondJob.id]
    const packages = [job, secondJob].map(row => ({ userId: owner.userId, sessionId: owner.sessionId, jobId: row.id,
      package: { job: { id: row.id }, coverLetter: null } as never }))
    const materials = jobIds.map((jobId, index) => ({ userId: owner.userId, sessionId: owner.sessionId, jobId, kind: "resume" as const,
      artifactRef: { artifactId: `artifact_${index + 1}`, version: index + 1, contentHash: `sha256:${String(index + 1).repeat(64)}`,
        sourceDigest: `sha256:${String(index + 3).repeat(64)}` } }))
    const expectedDecisions = { approvedJobIds: jobIds, pendingJobIds: [] as string[], skippedJobIds: [] as string[] }
    const reorderedKeys = { skippedJobIds: [], approvedJobIds: jobIds, pendingJobIds: [] }
    mocks.gateInput.mockResolvedValue({ packages, materials, gateResult: { status: "completed", ...expectedDecisions } })
    mocks.gateCheckpoint.mockImplementation(({ analyze }: { analyze: { persistedCheckpoint: Record<string, unknown> } }) => ({
      checkpoint: { ...analyze.persistedCheckpoint, nextStage: "gate" }, packages: packages.map(row => row.package),
    }))
    const prepareProof = workerPrepareProof()
    const gateCompletionProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 12,
      prepareProof, gate: { taskId: "gate_1", attemptCount: 1, resultDigest: "sha256:" + "5".repeat(64), completedEventRevision: 12 } }
    const persisted = { ...checkpoint, nextStage: "gate" as const, scheduledTaskGraphClaim: { ...initialState.scheduledTaskGraphClaim, key: continuationKey },
      scheduledTaskGraphPreparedArtifacts: materials.map(({ jobId, kind, artifactRef }) => ({ jobId, kind, artifactRef })),
      scheduledTaskGraphGateDecisions: reorderedKeys }
    const resume = (scheduledTaskGraphGateDecisions: unknown) => buildScheduledTaskGraphGateResumeState({ owner, snapshot, attestation,
      continuationKey, claimToken, ownedJobs: [job, secondJob], persistedCheckpoint: { ...persisted, scheduledTaskGraphGateDecisions },
      prepareProof, gateCompletionProof })

    const resumed = await resume(reorderedKeys)
    expect(resumed.scheduledTaskGraphGateDecisions).toEqual(expectedDecisions)
    expect(resumed.gateOutput?.approved.map(pkg => pkg.job.id)).toEqual(jobIds)
    await expect(resume({ ...reorderedKeys, approvedJobIds: [job.id, "different_job"] })).rejects.toBeInstanceOf(Error)
    await expect(resume({ ...reorderedKeys, approvedJobIds: [...jobIds].reverse() })).rejects.toBeInstanceOf(Error)

    const serializerInput = { nextStage: "execute", scheduledTaskGraphGateDecisions: reorderedKeys,
      gateOutput: { approved: packages.map(row => row.package), pending: [], skipped: [] } }
    expect(serializeScheduledTaskGraphCheckpoint(serializerInput as never)?.scheduledTaskGraphGateDecisions).toEqual(expectedDecisions)
    expect(serializeScheduledTaskGraphCheckpoint({ ...serializerInput,
      scheduledTaskGraphGateDecisions: { ...reorderedKeys, approvedJobIds: [job.id, "different_job"] } } as never)).toBeNull()
    expect(serializeScheduledTaskGraphCheckpoint({ ...serializerInput,
      scheduledTaskGraphGateDecisions: { ...reorderedKeys, approvedJobIds: [...jobIds].reverse() } } as never)).toBeNull()
  })
})
