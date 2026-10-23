import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { completeScheduledPipelineBeforeTerminal } from "./scheduled-pipeline-completion.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"

const owner: ScheduledAutomationPipelineBridgeScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 5,
}
const attestation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner } as ScheduledAutomationPipelineAttestation
const ready: ScheduledAutomationPipelineBridgeResult = { status: "ready", attestation }
const executionOwner: TurnExecutionOwnerFence = { kind: "turn", userId: owner.userId, sessionId: owner.sessionId,
  turnId: owner.turnId, taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, ownerId: owner.turnLeaseOwnerId,
  leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date("2026-10-20T12:00:00.000Z") }
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const analyzeAttestation: ScheduledAutomationPipelineAttestation = {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner,
  snapshotDigest: `sha256:${"1".repeat(64)}`, graphRevision: 3,
  scout: { taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: `sha256:${"2".repeat(64)}`,
    candidateJobIds: ["job-1"], discoveryReceipt: { status: "complete", taskId: "scout-1", attemptCount: 1,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: `sha256:${"3".repeat(64)}` } },
  analyst: { taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed",
    resultDigest: `sha256:${"4".repeat(64)}`, dependsOnTaskIds: ["scout-1"], jobIds: ["job-1"] },
  evidenceDigest: "5".repeat(64),
}
const analyzeProof = () => {
  const executionId = "execution-1", executionAttemptCount = 4
  return { status: "analyze_checkpointed", continuationKey: scheduledTaskGraphContinuationKey(owner, analyzeAttestation, executionId, executionAttemptCount),
    checkpointDigest: "b".repeat(64), claimTokenDigest: `sha256:${"c".repeat(64)}`, executionId, executionAttemptCount }
}
const readyPrepare = (choiceRequired = true) => {
  const handoff = analyzeProof()
  const baseReceipt = { schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA,
    owner: { ...owner, executionId: handoff.executionId, executionAttemptCount: handoff.executionAttemptCount },
    continuationKey: handoff.continuationKey, snapshotDigest: analyzeAttestation.snapshotDigest,
    evidenceDigest: analyzeAttestation.evidenceDigest, checkpointDigest: handoff.checkpointDigest,
    analyzeGraphRevision: analyzeAttestation.graphRevision, prepareScheduleRevision: analyzeAttestation.graphRevision + 1 }
  const receipt = { ...baseReceipt, continuationKey: scheduledTaskGraphStableContinuationKey(baseReceipt)! }
  const scheduledWaitId = scheduledPrepareChoiceWaitId({ receipt, finalStepId: "step-final", finalStepOrdinal: 3 })!
  const nodes = [
    { taskId: "scout-1", role: "scout", status: "completed" },
    { taskId: "analyst-1", role: "analyst", status: "completed" },
    { taskId: "prepare-1", role: "prepare", status: "completed" },
  ]
  return { status: "ready" as const, choice: choiceRequired ? { required: true as const, status: "answered" as const, scheduledWaitId } : { required: false as const }, prepareProof: { receipt,
    completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 4, nodes,
      wait: { status: "ready", mode: "all", waitId: "graph-wait-1", targetTaskIds: ["prepare-1"], matchedTaskIds: ["prepare-1"] } },
    result: { role: "prepare", status: "completed" } } }
}
const base = () => ({ executionOwner, rootAttemptCount: owner.rootAttemptCount,
  finalStepId: "step-final", finalStepOrdinal: 3, stageCandidate: vi.fn(async () => undefined) })

beforeEach(() => {
  vi.stubEnv("AGENT_WEB_URL", "https://applymate.example")
  vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
})
afterEach(() => vi.unstubAllEnvs())

describe("scheduled pipeline pre-terminal completion", () => {
  it("posts the verified owner before returning the exact completed candidate", async () => {
    const order: string[] = [], stageCandidate = vi.fn(async (input: { candidateText: string }) => { order.push("stage"); expect(input.candidateText).toBe("  Exact final candidate.  ") })
    const bridge = vi.fn(async () => { order.push("bridge"); return ready })
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      order.push("continuation")
      expect(JSON.parse(String(init?.body))).toEqual({ owner, attestation })
      return response(200, { status: "completed", report: { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 1 } })
    })
    const candidateText = "  Exact final candidate.  "

    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText, signal: new AbortController().signal, bridge, fetcher }))
      .resolves.toEqual({ status: "completed", candidateText })
    expect(order).toEqual(["bridge", "stage", "continuation"])
    expect(stageCandidate).toHaveBeenCalledOnce()
  })

  it("returns only an exact durable user wait", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(202, { status: "waiting_for_user", waitId: "wait-123" }))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ready, fetcher })).resolves.toEqual({ status: "waiting_for_external_user", externalWaitId: "wait-123", candidateText: "Final." })
  })

  it("continues an Analyze checkpoint into the exact durable dependency wait", async () => {
    const proof = analyzeProof(), candidateText = "Final candidate"
    const signal = new AbortController().signal
    const continueAfterAnalyze = vi.fn(async input => {
      expect(input).toMatchObject({ owner, executionOwner, attestation: analyzeAttestation, proof, candidateText,
        finalStepId: "step-final", finalStepOrdinal: 3, signal })
      return { status: "waiting_for_dependency" as const, waitId: "agent-wait:prepare:exact" }
    })
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText, signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }),
      fetcher: vi.fn<typeof fetch>(async () => response(200, proof)), continueAfterAnalyze }))
      .resolves.toEqual({ status: "waiting_for_dependency", waitId: "agent-wait:prepare:exact", candidateText })
    expect(continueAfterAnalyze).toHaveBeenCalledOnce()
  })

  it("waits for the first Worker-owned choice before handing Prepare to Web", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(200, analyzeProof()))
    const continueAfterAnalyze = vi.fn(async () => ({ status: "waiting_for_choice" as const, waitId: "worker-choice-1" }))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher, continueAfterAnalyze }))
      .resolves.toEqual({ status: "waiting_for_user", waitId: "worker-choice-1", candidateText: "Final." })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ owner, attestation: analyzeAttestation })
  })

  it("replays the exact Analyze binding and dependency wait without rewriting the wait id", async () => {
    const proof = analyzeProof(), candidateText = "Final candidate", signal = new AbortController().signal
    const continueAfterAnalyze = vi.fn(async (_input: Parameters<NonNullable<Parameters<typeof completeScheduledPipelineBeforeTerminal>[0]["continueAfterAnalyze"]>>[0]) => ({ status: "waiting_for_dependency" as const, waitId: "agent-wait:prepare:replayed" }))
    const input = { ...base(), owner, candidateText, signal, bridge: async () => ({ status: "ready" as const, attestation: analyzeAttestation }),
      fetcher: vi.fn<typeof fetch>(async () => response(200, proof)), continueAfterAnalyze }
    const first = await completeScheduledPipelineBeforeTerminal(input)
    const replay = await completeScheduledPipelineBeforeTerminal(input)
    expect(first).toEqual({ status: "waiting_for_dependency", waitId: "agent-wait:prepare:replayed", candidateText })
    expect(replay).toEqual(first)
    expect(continueAfterAnalyze).toHaveBeenCalledTimes(2)
    expect(continueAfterAnalyze.mock.calls[1]?.[0]).toEqual(continueAfterAnalyze.mock.calls[0]?.[0])
  })

  it("routes the persisted Gate checkpoint through the Worker wait and keeps the Prepare choice ID separate", async () => {
    const prepared = readyPrepare(), candidateText = "Final candidate", signal = new AbortController().signal
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "gate_checkpointed" })
      : response(200, analyzeProof()))
    const continueAfterGate = vi.fn(async input => {
      expect(input).toMatchObject({ owner, executionOwner, attestation: analyzeAttestation, handoff: analyzeProof(),
        prepareProof: prepared.prepareProof, scheduledWaitId: prepared.choice.required ? prepared.choice.scheduledWaitId : undefined,
        finalStepId: "step-final", signal })
      return { status: "waiting_for_dependency" as const, waitId: "agent-wait:gate:exact" }
    })
    const result = await completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText, signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared, continueAfterGate })
    expect(result).toEqual({ status: "waiting_for_dependency", waitId: "agent-wait:gate:exact", candidateText })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      owner, attestation: analyzeAttestation, prepareProof: prepared.prepareProof,
      ...(prepared.choice.required ? { scheduledWaitId: prepared.choice.scheduledWaitId } : {}),
    })
    expect(continueAfterGate).toHaveBeenCalledOnce()
  })

  it("continues approval-disabled snapshots through the fixed Gate without a Prepare choice ID", async () => {
    const prepared = readyPrepare(false), candidateText = "Final candidate", signal = new AbortController().signal
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "gate_checkpointed" }) : response(200, analyzeProof()))
    const result = await completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText, signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared, continueAfterGate: async () => ({ status: "completed" }) })
    expect(result).toEqual({ status: "completed", candidateText })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ owner, attestation: analyzeAttestation, prepareProof: prepared.prepareProof })
  })

  it("rejects the legacy completed response instead of skipping the fixed Gate", async () => {
    const prepared = readyPrepare()
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "completed", report: { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 1 } })
      : response(200, analyzeProof()))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_missing" })
  })

  it("persists a Gate question disposition for the existing final-candidate store", async () => {
    const prepared = readyPrepare(false), binding = {} as TurnQuestionGateChoiceBinding
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "gate_checkpointed" }) : response(200, analyzeProof()))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared,
      continueAfterGate: async () => ({ status: "waiting_for_choice", waitId: "gate-question-wait", question: "Choose a fixed option.", binding }) }))
      .resolves.toEqual({ status: "waiting_for_scheduled_gate_choice", waitId: "gate-question-wait", candidateText: "Final.",
        question: "Choose a fixed option.", binding })
  })

  it("fails closed when an Analyze checkpoint has no Prepare continuation", async () => {
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }),
      fetcher: vi.fn<typeof fetch>(async () => response(200, analyzeProof())) }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_prepare_continuation_unavailable" })
  })

  it("does not call Prepare for an invalid Analyze checkpoint proof", async () => {
    const continueAfterAnalyze = vi.fn(async () => ({ status: "waiting_for_dependency" as const, waitId: "wait-1" }))
    const proof = { ...analyzeProof(), continuationKey: `scheduled-taskgraph:sha256:${"c".repeat(64)}` }
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }),
      fetcher: vi.fn<typeof fetch>(async () => response(200, proof)), continueAfterAnalyze }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_analyze_checkpoint_invalid" })
    expect(continueAfterAnalyze).not.toHaveBeenCalled()
  })

  it("blocks an invalid dependency wait returned by the injected continuation", async () => {
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }),
      fetcher: vi.fn<typeof fetch>(async () => response(200, analyzeProof())),
      continueAfterAnalyze: async () => ({ status: "waiting_for_dependency", waitId: "bad", extra: true } as never) }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_prepare_proof_invalid" })
  })

  it("keeps a local bridge blocker distinct and does not call Web without an attestation", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const stageCandidate = vi.fn()
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "blocked", reasonCode: "task_graph_incomplete" }), fetcher }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_task_graph_incomplete" })
    expect(fetcher).not.toHaveBeenCalled()
    expect(stageCandidate).not.toHaveBeenCalled()
  })

  it("keeps a typed Web blocker nonterminal without converting it to a retry", async () => {
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ready, fetcher: vi.fn<typeof fetch>(async () => response(403, { status: "blocked", errorCode: "scheduled_pipeline_entitlement_required" })) }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_entitlement_required" })
  })

  it("maps transient continuation failures to a nonterminal refresh retry", async () => {
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ready, fetcher: vi.fn<typeof fetch>(async () => response(500, {})) }))
      .rejects.toBeInstanceOf(TurnStateRefreshRetryError)
  })

  it("preserves an existing Turn state refresh retry error by identity", async () => {
    const retry = new TurnStateRefreshRetryError()
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => { throw retry }, fetcher: vi.fn<typeof fetch>() })).rejects.toBe(retry)
  })
})
