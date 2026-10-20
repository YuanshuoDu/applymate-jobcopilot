import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import { completeScheduledPipelineBeforeTerminal } from "./scheduled-pipeline-completion.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

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
      bridge: async () => ready, fetcher })).resolves.toEqual({ status: "waiting_for_user", waitId: "wait-123", candidateText: "Final." })
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
