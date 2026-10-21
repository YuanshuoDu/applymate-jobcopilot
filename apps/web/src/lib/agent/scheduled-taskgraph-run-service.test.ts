import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, buildScheduledTaskGraphPrepareCheckpoint } from "./scheduled-taskgraph-pipeline-checkpoint"
import { scheduledTaskGraphAnalyzeCheckpointDigest } from "./scheduled-taskgraph-gate-checkpoint"
import { runScheduledTaskGraphAnalyzeOnly } from "./scheduled-taskgraph-run-service"
import type { PipelineCtx } from "./pipeline-context"
import type { Job } from "@prisma/client"

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), scoreOwner: vi.fn(), ownerCurrent: vi.fn(), save: vi.fn(), gateInput: vi.fn(), gateCheckpoint: vi.fn(), events: vi.fn(), steps: vi.fn(), items: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentEvent: { findMany: mocks.events }, agentStep: { findFirst: mocks.steps }, agentItem: { findFirst: mocks.items } } }))
vi.mock("./scheduled-taskgraph-analysis-journal", () => ({
  runScheduledTaskGraphAnalyze: mocks.analyze,
  scheduledTaskGraphScoreOwnerIsCurrent: mocks.scoreOwner,
}))
vi.mock("./scheduled-taskgraph-pipeline-fence", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-pipeline-fence")>()
  return { ...actual, isScheduledTaskGraphOwnerCurrent: mocks.ownerCurrent, saveScheduledTaskGraphCheckpoint: mocks.save }
})
vi.mock("./scheduled-taskgraph-gate-input", () => ({ loadScheduledTaskGraphGateInput: mocks.gateInput }))
vi.mock("./scheduled-taskgraph-gate-checkpoint", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-gate-checkpoint")>()
  return { ...actual, buildScheduledTaskGraphGateCheckpoint: mocks.gateCheckpoint }
})

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
const approvalSnapshot = { ...snapshot, requireApproval: true }
const approvalAttestation = { ...baseAttestation, snapshotDigest: scheduledAutomationSnapshotDigest(approvalSnapshot) }
const approvalKey = scheduledTaskGraphContinuationKey(owner, approvalAttestation)
const approvalReceipt = { ...prepareReceipt, continuationKey: approvalKey, snapshotDigest: approvalAttestation.snapshotDigest }
const approvalWaitProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
  owner.executionId, owner.executionAttemptCount, approvalKey, approvalReceipt.snapshotDigest, approvalReceipt.evidenceDigest,
  approvalReceipt.checkpointDigest, approvalReceipt.analyzeGraphRevision, approvalReceipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, 1]
const approvalWaitId = `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(approvalWaitProjection), "utf8").digest("hex")}`
const candidatePayload = { schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v2", sessionId: owner.sessionId,
  turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, finalStepId, finalStepOrdinal,
  stepAttempt: 1, candidateText: "candidate", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 } }
const scheduledWaitProjection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
  owner.executionId, owner.executionAttemptCount, key, prepareReceipt.snapshotDigest, prepareReceipt.evidenceDigest,
  prepareReceipt.checkpointDigest, prepareReceipt.analyzeGraphRevision, prepareReceipt.prepareScheduleRevision, finalStepId, finalStepOrdinal, 1]
const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(scheduledWaitProjection), "utf8").digest("hex")}`
function scheduledChoiceItem(answer: string | null = null, waitId = scheduledWaitId, receipt = prepareReceipt) {
  return { id: `agent-wait:question:${waitId}`, stepId: finalStepId, taskId: owner.rootTaskId, type: "question",
    status: answer === null ? "started" : "completed", content: { waitKind: "question", questionId: waitId,
      toolCallId: null, stage: "scheduled_prepare", question: "How should ApplyMate tailor your resume for this role?",
      options: [{ label: "Apply AI changes", value: "apply_ai_changes" }, { label: "Keep my current resume", value: "keep_resume" }],
      answer, answerAvailable: answer !== null, scheduledPrepareChoiceBinding: { schemaVersion: "agent-harness.v2.scheduled-prepare-choice-wait.v1",
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
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.ownerCurrent.mockResolvedValue(true)
    mocks.scoreOwner.mockResolvedValue(true)
    mocks.save.mockResolvedValue(true)
    mocks.gateInput.mockReset()
    mocks.gateCheckpoint.mockReset()
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
    mocks.items.mockResolvedValue(null)
    const persisted = { ...buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: baseAttestation,
      ownedJobs: [job], analyzeResult: analysis, existingCheckpoint: initialState }).checkpoint,
      scheduledTaskGraphClaim: initialState.scheduledTaskGraphClaim }
    const prepareProof = { receipt: prepareReceipt, completion: {}, result: { taskId: "prepare_1" } }
    const resume = await (await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({
      owner, snapshot, attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job],
      persistedCheckpoint: persisted, prepareProof,
    })
    expect(mocks.gateInput).toHaveBeenCalledWith(expect.objectContaining({ owner, snapshot,
      analyzeCheckpoint: persisted, analyzeAttestation: baseAttestation, prepareProof }))
    expect(mocks.gateInput.mock.invocationCallOrder[0]).toBeLessThan(mocks.gateCheckpoint.mock.invocationCallOrder[0]!)
    expect(resume.preparedPackages?.[0]?.coverLetter).toBe("private-letter-body")
    expect(resume.scheduledTaskGraphPreparedArtifacts).toHaveLength(1)
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
    mocks.items.mockResolvedValueOnce(scheduledChoiceItem(null, approvalWaitId, approvalReceipt))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(false)
    mocks.steps.mockResolvedValueOnce({ id: "newer_step" }).mockResolvedValueOnce({ id: finalStepId, status: "streaming" })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot: approvalSnapshot, proof, scheduledWaitId: approvalWaitId })).resolves.toBe(false)
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

  it("restores persisted Gate decisions against the exact reloaded package set", async () => {
    mocks.items.mockResolvedValue(null)
    const checkpoint = { nextStage: "execute", scheduledTaskGraphPreparedArtifacts: [
      { jobId: job.id, kind: "resume", artifactRef: { artifactId: "artifact_1", version: 3, contentHash: "sha256:" + "1".repeat(64), sourceDigest: "sha256:" + "2".repeat(64) } },
    ], scheduledTaskGraphGateDecisions: { approvedJobIds: [job.id], pendingJobIds: [], skippedJobIds: [] } }
    const resume = await (await import("./scheduled-taskgraph-run-service")).buildScheduledTaskGraphGateResumeState({
      owner, snapshot, attestation: baseAttestation, continuationKey: key, claimToken, ownedJobs: [job],
      persistedCheckpoint: checkpoint, prepareProof: { receipt: prepareReceipt, completion: {}, result: { taskId: "prepare_1" } },
    })
    expect(resume.nextStage).toBe("execute")
    expect(resume.gateOutput?.approved).toHaveLength(1)
    expect(resume.gateOutput?.approved[0]?.job.id).toBe(job.id)
  })
})
