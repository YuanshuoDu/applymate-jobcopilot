import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { TurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { SCHEDULED_PIPELINE_COMPLETION, type TurnEngineCompletionGate } from "../turns/turn-execution-types.js"
import { attachScheduledPipelineCompletion, completeScheduledPipelineBeforeTerminal } from "./scheduled-pipeline-completion.js"
import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"

const gateContinuationMocks = vi.hoisted(() => ({ selectResume: vi.fn(), readCandidate: vi.fn() }))
vi.mock("./scheduled-gate-resume-wait.js", () => ({ selectScheduledGateResumeWaitAttempt: gateContinuationMocks.selectResume }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ readScheduledGateQuestionCandidate: gateContinuationMocks.readCandidate }))

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
  gateContinuationMocks.selectResume.mockReset()
  gateContinuationMocks.readCandidate.mockReset()
  vi.stubEnv("AGENT_WEB_URL", "https://applymate.example")
  vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
})
afterEach(() => vi.unstubAllEnvs())

describe("scheduled pipeline pre-terminal completion", () => {
  it("recovers an exact Audit completion before Web and stages the resumed candidate", async () => {
    const stageCandidate = vi.fn(async () => undefined), bridge = vi.fn()
    const continueAfterGate = vi.fn(async input => {
      expect(input).toMatchObject({ owner, executionOwner, mode: "resume_audit", finalStepId: "step-final" })
      return { status: "completed" as const }
    })
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText: "Final.",
      signal: new AbortController().signal, bridge, continueAfterGate, fetcher: vi.fn<typeof fetch>() }))
      .resolves.toEqual({ status: "completed", candidateText: "Final." })
    expect(stageCandidate).toHaveBeenCalledWith({ owner: executionOwner, rootAttemptCount: owner.rootAttemptCount,
      finalStepId: "step-final", finalStepOrdinal: 3, candidateText: "Final." })
    expect(bridge).not.toHaveBeenCalled()
  })

  it("stages the exact candidate before returning a recovered Audit dependency wait", async () => {
    const stageCandidate = vi.fn(async () => undefined), bridge = vi.fn()
    const continueAfterGate = vi.fn(async () => ({ status: "waiting_for_dependency" as const, waitId: "audit-wait" }))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText: "Final.",
      signal: new AbortController().signal, bridge, continueAfterGate }))
      .resolves.toEqual({ status: "waiting_for_dependency", waitId: "audit-wait", candidateText: "Final." })
    expect(stageCandidate).toHaveBeenCalledOnce()
    expect(bridge).not.toHaveBeenCalled()
  })

  it("does not call the bridge or Web when Audit resume finds an orphan registration", async () => {
    const bridge = vi.fn(), fetcher = vi.fn<typeof fetch>()
    const readContext = vi.fn(async () => ({ status: "invalid" as const }))
    const continueAfterGate = createScheduledAutomationGateContinuation({
      pool: { connect: vi.fn() } as never,
      commandPort: { readScheduledAuditResumeContext: readContext, verifyScheduledAuditCompletion: vi.fn() } as never,
      waitPort: { wait: vi.fn() } as never, nativeQuestionWaitEnabled: false,
    })
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.",
      signal: new AbortController().signal, bridge, continueAfterGate, fetcher }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_resume_invalid" })
    expect(readContext).toHaveBeenCalledOnce()
    expect(bridge).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not trust a bare Web completed report when Audit registration is absent", async () => {
    const order: string[] = [], stageCandidate = vi.fn(async () => { order.push("stage") })
    const continueAfterGate = vi.fn(async () => { order.push("resume"); return { status: "not_registered" as const } })
    const bridge = vi.fn(async () => { order.push("bridge"); return ready })
    const fetcher = vi.fn<typeof fetch>(async () => { order.push("web"); return response(200,
      { status: "completed", report: { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 1 } }) })
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText: "Final.",
      signal: new AbortController().signal, bridge, continueAfterGate, fetcher }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_not_registered" })
    expect(order).toEqual(["resume", "bridge", "stage", "web", "resume"])
    expect(stageCandidate).toHaveBeenCalledOnce()
  })

  it("rechecks Audit proof after a bare Web completed report before accepting completion", async () => {
    const order: string[] = [], stageCandidate = vi.fn(async () => { order.push("stage") })
    let recoveryCount = 0
    const continueAfterGate = vi.fn(async () => {
      recoveryCount += 1
      order.push("resume")
      return { status: recoveryCount === 1 ? "not_registered" as const : "completed" as const }
    })
    const bridge = vi.fn(async () => { order.push("bridge"); return ready })
    const fetcher = vi.fn<typeof fetch>(async () => { order.push("web"); return response(200,
      { status: "completed", report: { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 1 } }) })
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), stageCandidate, owner, candidateText: "Final.",
      signal: new AbortController().signal, bridge, continueAfterGate, fetcher }))
      .resolves.toEqual({ status: "completed", candidateText: "Final." })
    expect(order).toEqual(["resume", "bridge", "stage", "web", "resume"])
    expect(stageCandidate).toHaveBeenCalledOnce()
  })

  it("does not treat not-registered as a completed normal Gate continuation", async () => {
    const prepared = readyPrepare(), fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "gate_checkpointed" }) : response(200, analyzeProof()))
    await expect(completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText: "Final.", signal: new AbortController().signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared, continueAfterGate: async () => ({ status: "not_registered" }) }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_audit_not_registered" })
  })

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
      if (input.mode === "resume_audit") return { status: "not_registered" as const }
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
    expect(continueAfterGate).toHaveBeenCalledTimes(2)
    expect(continueAfterGate).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "resume_audit" }))
  })

  it("continues approval-disabled snapshots through the fixed Gate without a Prepare choice ID", async () => {
    const prepared = readyPrepare(false), candidateText = "Final candidate", signal = new AbortController().signal
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).prepareProof
      ? response(200, { status: "gate_checkpointed" }) : response(200, analyzeProof()))
    const result = await completeScheduledPipelineBeforeTerminal({ ...base(), owner, candidateText, signal,
      bridge: async () => ({ status: "ready", attestation: analyzeAttestation }), fetcher,
      continueAfterAnalyze: async () => prepared, continueAfterGate: async input => "mode" in input && input.mode === "resume_audit"
        ? { status: "not_registered" as const } : { status: "completed" as const } })
    expect(result).toEqual({ status: "completed", candidateText })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ owner, attestation: analyzeAttestation, prepareProof: prepared.prepareProof })
  })

  it("waits on the exact Audit child after verifying Gate and pauses accepted-Web completion", async () => {
    const prepared = readyPrepare(), auditWaitId = "durable-audit-wait", signal = new AbortController().signal
    const gateProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 9,
      prepareProof: prepared.prepareProof, gate: { taskId: "gate-task", attemptCount: 1,
        resultDigest: `sha256:${"d".repeat(64)}`, completedEventRevision: 9 } }
    const order: string[] = []
    const appendAudit = vi.fn(async () => {
      order.push("append-audit")
      return { status: "accepted" as const, revision: 10,
        nodes: [{ key: "scheduled_audit", taskId: "audit-task", status: "queued" as const }],
        readyTaskIds: ["audit-task"], auditTaskId: "audit-task", expectedAttemptCount: 1 }
    })
    const waitAudit = vi.fn(async () => {
      order.push("wait-audit")
      return { status: "waiting" as const, waitId: auditWaitId,
        deadlineAt: "2026-10-20T12:00:00.000Z", matchedTaskIds: [] }
    })
    const verifyAudit = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.action === "execute") throw new Error("Audit child owns the Execute continuation")
      if (body.prepareProof) return response(200, { status: "gate_checkpointed" })
      return response(200, analyzeProof())
    })
    gateContinuationMocks.selectResume.mockResolvedValue({ status: "initial" })
    gateContinuationMocks.readCandidate.mockResolvedValue(null)
    const gateContinuation = createScheduledAutomationGateContinuation({
      pool: { connect: async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release: () => undefined }) } as never,
      commandPort: {
        readScheduledAuditResumeContext: vi.fn(async () => ({ status: "not_registered" as const })),
        appendScheduledGate: vi.fn(async () => {
          order.push("append-gate")
          return { status: "accepted" as const, revision: 5, nodes: [{ key: "gate", taskId: "gate-task" }], readyTaskIds: ["gate-task"] }
        }),
        resumeScheduledGateChoice: vi.fn(async () => ({ status: "accepted" as const, taskId: "gate-task", requestAttemptCount: 1,
          resumedAttemptCount: 2, revision: 6, readyTaskIds: ["gate-task"] })),
        verifyScheduledGateCompletion: vi.fn(async () => {
          order.push("verify-gate")
          return gateProof
        }),
        appendScheduledAudit: appendAudit,
        verifyScheduledAuditCompletion: verifyAudit,
      } as never,
      waitPort: {
        waitScheduledGate: vi.fn(async () => {
          order.push("wait-gate")
          return { status: "ready" as const, waitId: "gate-ready", matchedTaskIds: ["gate-task"] }
        }),
        wait: waitAudit,
      } as never,
      nativeQuestionWaitEnabled: true,
    })
    const gate = (async () => ({ ok: true as const })) as unknown as TurnEngineCompletionGate
    const accepted = vi.fn(), stageCandidate = vi.fn(async () => undefined)
    const attached = attachScheduledPipelineCompletion({ gate, owner, bridge: async () => ({ status: "ready", attestation: analyzeAttestation }),
      continueAfterAnalyze: async () => prepared, continueAfterGate: gateContinuation, fetcher, onWebAccepted: accepted,
      stageCandidate, rootAttemptCount: owner.rootAttemptCount })!
    const complete = attached[SCHEDULED_PIPELINE_COMPLETION]
    expect(complete).toBeDefined()

    await expect(complete!({ identity: executionOwner, scope: {} as never, rootTaskId: owner.rootTaskId,
      stepId: "step-final", stepOrdinal: 3, candidateText: "Final candidate", signal, now: new Date() } as never))
      .resolves.toEqual({ status: "waiting_for_dependency", waitId: auditWaitId, candidateText: "Final candidate" })
    expect(accepted).toHaveBeenCalledOnce()
    expect(stageCandidate).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
      .some(body => body.action === "execute")).toBe(false)
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      executionOwner: { executionId: "execution-1", executionAttemptCount: 4 },
      handoff: analyzeProof(), attestation: analyzeAttestation, gateProof,
      scheduledWaitId: prepared.choice.required ? prepared.choice.scheduledWaitId : undefined,
    }))
    const auditWaitKey = `scheduled-audit-wait:${createHash("sha256")
      .update(JSON.stringify(["audit-task", "step-final", 1]), "utf8").digest("hex")}`
    expect(waitAudit).toHaveBeenCalledWith({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      stepId: "step-final", taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId,
      targetTaskIds: ["audit-task"], mode: "all", timeoutMs: 24 * 60 * 60 * 1_000, idempotencyKey: auditWaitKey })
    expect(order).toEqual(["append-gate", "wait-gate", "verify-gate", "append-audit", "wait-audit"])
    expect(verifyAudit).not.toHaveBeenCalled()
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
      continueAfterGate: async input => "mode" in input && input.mode === "resume_audit" ? { status: "not_registered" as const }
        : { status: "waiting_for_choice" as const, waitId: "gate-question-wait", question: "Choose a fixed option.", binding } }))
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
