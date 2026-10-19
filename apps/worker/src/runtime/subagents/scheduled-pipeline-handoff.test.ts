import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { postScheduledPipelineContinuation } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"

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
      .resolves.toEqual({ status: "waiting_for_user", waitId: "question-123" })
    for (const waitId of ["", " question-123", "x".repeat(257), 42]) {
      await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
        vi.fn<typeof fetch>(async () => reply(202, { status: "waiting_for_user", waitId }))))
        .rejects.toThrow("scheduled_pipeline_handoff_in_progress")
    }
  })

  it("keeps malformed responses and network errors retryable", async () => {
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 })))).rejects.toThrow("scheduled_pipeline_handoff_response_invalid")
    await expect(postScheduledPipelineContinuation(input, new AbortController().signal,
      vi.fn<typeof fetch>(async () => { throw new Error("network down") }))).rejects.toThrow("network down")
  })
})
