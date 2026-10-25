import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { postScheduledPipelineContinuation, postScheduledPipelineExecute, postScheduledPipelineGate, scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledGateCandidateSetDigest } from "./scheduled-gate-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"

const owner: ScheduledAutomationPipelineBridgeScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 5,
}
const digest = `sha256:${"a".repeat(64)}`
const attestation: ScheduledAutomationPipelineAttestation = {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner, snapshotDigest: digest, graphRevision: 3,
  scout: { taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest,
    candidateJobIds: ["job-1"], discoveryReceipt: { status: "complete", taskId: "scout-1", attemptCount: 1, completedCalls: 1,
      candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: digest } },
  analyst: { taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed", resultDigest: digest,
    dependsOnTaskIds: ["scout-1"], jobIds: ["job-1"] }, evidenceDigest: digest,
}
const input = { owner, attestation }
const report = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 7 }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const analyzeProof = (handoffOwner = owner) => {
  const executionId = "execution-1", executionAttemptCount = 4
  return { status: "analyze_checkpointed", continuationKey: scheduledTaskGraphContinuationKey(handoffOwner, attestation, executionId, executionAttemptCount),
    checkpointDigest: "b".repeat(64), claimTokenDigest: `sha256:${"c".repeat(64)}`, executionId, executionAttemptCount }
}
const prepareProof = { result: { jobs: [{ jobId: "job-1", status: "prepared" }, { jobId: "job-2", status: "skipped" }] } } as unknown as ScheduledPrepareTaskGraphProof
const gateInput = { ...input, prepareProof, gateTaskId: "gate-1", gateLeaseOwnerId: "gate-worker-1", gateAttemptCount: 2 }
const gateQuestion = { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-1"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-1"]), allowedChoiceIds: ["continue", "review", "skip"] }
const gateChoice = { kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "continue" } as const

beforeEach(() => {
  vi.stubEnv("AGENT_WEB_URL", "https://applymate.example")
  vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret-canary")
})
afterEach(() => vi.unstubAllEnvs())

describe("scheduled pipeline HTTP handoff", () => {
  it("sends only owner and attestation in JSON and accepts a fully shaped completion report", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report }))
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal, fetcher)).resolves.toEqual({ status: "completed" })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("https://applymate.example/api/internal/agent-runtime/scheduled-pipeline")
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("x-agent-worker-secret")).toBe("worker-secret-canary")
    expect(JSON.parse(String(init?.body))).toEqual(input)
    expect(String(init?.body)).not.toContain("worker-secret-canary")
  })

  it("supports configured non-loopback HTTP handoffs", async () => {
    vi.stubEnv("AGENT_WEB_URL", "http://applymate.example")
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report }))
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal, fetcher)).resolves.toEqual({ status: "completed" })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-agent-worker-secret")).toBe("worker-secret-canary")
  })

  it.each(["localhost", "127.0.0.1", "[::1]"])("allows explicit loopback HTTP development host %s", async host => {
    vi.stubEnv("AGENT_WEB_URL", `http://${host}`)
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report }))
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal, fetcher)).resolves.toEqual({ status: "completed" })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-agent-worker-secret")).toBe("worker-secret-canary")
  })

  it("returns an owner-bound Analyze checkpoint proof exactly on repeated handoffs", async () => {
    const proof = analyzeProof()
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, proof))
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal, fetcher))
      .resolves.toEqual({ status: "analyze_checkpointed", proof })
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal, fetcher))
      .resolves.toEqual({ status: "analyze_checkpointed", proof })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("preserves the Analyze continuation identity when a new Worker lease reclaims the Turn", async () => {
    const reboundOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: owner.turnLeaseVersion + 1 }
    const proof = analyzeProof(reboundOwner)
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, proof))
    expect(scheduledTaskGraphContinuationKey(owner, attestation, proof.executionId, proof.executionAttemptCount))
      .toBe(scheduledTaskGraphContinuationKey(reboundOwner, attestation, proof.executionId, proof.executionAttemptCount))
    await expect(postScheduledPipelineContinuation({ owner: reboundOwner, attestation }, new AbortController().signal, fetcher))
      .resolves.toEqual({ status: "analyze_checkpointed", proof })
  })

  it.each([
    (proof: ReturnType<typeof analyzeProof>) => ({ ...proof, continuationKey: `scheduled-taskgraph:sha256:${"c".repeat(64)}` }),
    (proof: ReturnType<typeof analyzeProof>) => ({ ...proof, checkpointDigest: "not-a-digest" }),
    (proof: ReturnType<typeof analyzeProof>) => ({ ...proof, claimTokenDigest: "not-a-digest" }),
    (proof: ReturnType<typeof analyzeProof>) => ({ ...proof, executionAttemptCount: -1 }),
    (proof: ReturnType<typeof analyzeProof>) => ({ ...proof, extra: true }),
    (proof: ReturnType<typeof analyzeProof>) => { const { claimTokenDigest: _ignored, ...rest } = proof; return rest },
    (proof: ReturnType<typeof analyzeProof>) => { const { executionId: _ignored, ...rest } = proof; return rest },
  ])("blocks an invalid Analyze checkpoint proof", async mutate => {
    const proof = mutate(analyzeProof())
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, proof))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_analyze_checkpoint_invalid" })
  })

  it.each([
    [400, "scheduled_pipeline_request_invalid"], [401, "scheduled_pipeline_unauthorized"],
    [403, "scheduled_pipeline_entitlement_required"], [403, "scheduled_pipeline_ai_unavailable"],
    [429, "scheduled_pipeline_ai_budget_exhausted"], [409, "scheduled_pipeline_claim_conflict"],
  ])("maps typed pre-claim HTTP %i to a terminal blocked result", async (status, errorCode) => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(status, { status: "blocked", errorCode })))).resolves.toEqual({ status: "blocked", errorCode })
  })

  it.each([
    {}, { ...report, failed: -1 }, { ...report, processed: Number.MAX_SAFE_INTEGER + 1 },
    { ...report, queued: 1.5 }, { ...report, unexpected: 1 },
  ])("rejects an incomplete or unsafe completion report", async invalidReport => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report: invalidReport })))).rejects.toThrow("scheduled_pipeline_handoff_retryable")
  })

  it.each([202, 500])("keeps HTTP %i retryable", async status => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(status, { status: "accepted", duplicate: true })))).rejects.toThrow(
      status === 202 ? "scheduled_pipeline_handoff_in_progress" : "scheduled_pipeline_handoff_retryable")
  })

  it("returns a typed durable wait only for a valid waiting receipt", async () => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "question-123", stage: "analysis" }))))
      .resolves.toEqual({ status: "waiting_for_user", waitId: "question-123", waitKind: "external" })
    for (const waitId of ["", " question-123", "x".repeat(257), 42]) {
      await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
        vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId }))))
        .rejects.toThrow("scheduled_pipeline_handoff_in_progress")
    }
  })

  it("keeps the Web wait ID distinct from the echoed scheduled Prepare wait ID", async () => {
    const scheduledWaitId = "scheduled-choice-456"
    const preparedInput = { ...input, prepareProof: { proof: "opaque" }, scheduledWaitId }
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "web-gate-wait-123", scheduledWaitId }))))
      .resolves.toEqual({ status: "waiting_for_user", waitId: "web-gate-wait-123", waitKind: "scheduled_prepare", scheduledWaitId })
  })

  it("allows a Gate wait without a Worker choice ID when the scheduled snapshot disables the choice", async () => {
    const preparedInput = { ...input, prepareProof: { proof: "opaque" } }
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "web-gate-wait-123" }))))
      .resolves.toEqual({ status: "waiting_for_user", waitId: "web-gate-wait-123", waitKind: "external" })
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "web-gate-wait-123", scheduledWaitId: "unexpected" }))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_wait_identity_mismatch" })
  })

  it("accepts only the explicit Gate checkpoint after a verified Prepare handoff", async () => {
    const preparedInput = { ...input, prepareProof: { proof: "opaque" } }
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { status: "gate_checkpointed" }))))
      .resolves.toEqual({ status: "gate_checkpointed" })
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report }))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_missing" })
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { status: "gate_checkpointed" }))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_gate_checkpoint_unexpected" })
  })

  it("accepts only a closed Execute wait response with its persisted opaque wait ID", async () => {
    const prepared = { prepareProof: { result: {} }, scheduledWaitId: "prepare-choice-wait-1",
      gateCompletionProof: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1" } } as const
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: "execute", ...input, ...prepared })
      return reply(200, { status: "completed", report })
    })
    await expect(postScheduledPipelineExecute({ ...input, ...prepared } as never, new AbortController().signal, fetcher))
      .resolves.toEqual({ status: "completed", report })
    await expect(postScheduledPipelineExecute({ ...input, ...prepared } as never, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1" }))))
      .resolves.toEqual({ status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1" })
    for (const invalid of [
      { status: "waiting_for_user" },
      { status: "waiting_for_user", waitId: "" },
      { status: "waiting_for_user", waitId: " question-1" },
      { status: "waiting_for_user", waitId: "x".repeat(257) },
      { status: "waiting_for_user", waitId: "question-1", stage: "writer" },
    ]) {
      await expect(postScheduledPipelineExecute({ ...input, ...prepared } as never, new AbortController().signal,
        vi.fn<typeof fetch>(async () => reply(202, invalid)))).rejects.toThrow("scheduled_pipeline_handoff_in_progress")
    }
    await expect(postScheduledPipelineExecute({ ...input, ...prepared, scheduledWaitId: " " } as never,
      new AbortController().signal, fetcher)).rejects.toThrow("scheduled_pipeline_handoff_input_invalid")
  })

  it.each([
    { ...report, extra: true }, { ...report, processed: -1 }, { ...report, queued: 1.25 },
    { ...report, durationMs: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not return a report unless every exact field is a safe non-negative integer", async invalidReport => {
    const prepared = { prepareProof: { result: {} }, gateCompletionProof: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1" } } as const
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, { status: "completed", report: invalidReport }))
    await expect(postScheduledPipelineExecute({ ...input, ...prepared } as never, new AbortController().signal, fetcher))
      .rejects.toThrow("scheduled_pipeline_handoff_retryable")
  })

  it("posts only the fixed child fence and projected current/prior Gate choices", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(200, gateQuestion))
    await expect(postScheduledPipelineGate({ ...gateInput, scheduledWaitId: "root-wait-1",
      validatedChoice: gateChoice as never,
      priorChoices: [gateChoice] }, new AbortController().signal, fetcher)).resolves.toEqual(gateQuestion)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe("https://applymate.example/api/internal/agent-runtime/scheduled-pipeline")
    expect(new Headers(init?.headers).get("x-agent-worker-secret")).toBe("worker-secret-canary")
    expect(JSON.parse(String(init?.body))).toEqual({ action: "gate", ...gateInput, scheduledWaitId: "root-wait-1",
      validatedChoice: gateChoice, priorChoices: [gateChoice] })
    expect(String(init?.body)).not.toContain("scheduledGateChoiceBinding")
    expect(String(init?.body)).not.toContain("claimToken")
    await expect(postScheduledPipelineGate({ ...gateInput,
      validatedChoice: { ...gateChoice, scheduledGateChoiceBinding: "private" } as never }, new AbortController().signal, fetcher))
      .rejects.toThrow("scheduled_pipeline_gate_input_invalid")
  })

  it("rejects malformed Gate outcomes and maps only typed Gate blocks", async () => {
    await expect(postScheduledPipelineGate(gateInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { ...gateQuestion, unexpected: true }))))
      .rejects.toThrow("scheduled_pipeline_gate_response_invalid")
    await expect(postScheduledPipelineGate(gateInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(200, { ...gateQuestion, jobIds: ["job-2"],
        candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-2"]) }))))
      .rejects.toThrow("scheduled_pipeline_gate_response_invalid")
    await expect(postScheduledPipelineGate(gateInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(409, { status: "blocked", errorCode: "scheduled_pipeline_gate_task_stale" }))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_gate_task_stale" })
  })

  it.each(["different-scheduled-choice", undefined])("rejects a missing or mismatched scheduled wait echo (%s)", async echoedScheduledWaitId => {
    const scheduledWaitId = "scheduled-choice-456"
    const preparedInput = { ...input, prepareProof: { proof: "opaque" }, scheduledWaitId }
    await expect(postScheduledPipelineContinuation(preparedInput, new AbortController().signal,
      vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId: "web-gate-wait-123", scheduledWaitId: echoedScheduledWaitId }))))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_pipeline_wait_identity_mismatch" })
  })

  it("keeps malformed responses and network errors retryable", async () => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 })))).rejects.toThrow("scheduled_pipeline_handoff_response_invalid")
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => { throw new Error("network down") }))).rejects.toThrow("network down")
  })
})
