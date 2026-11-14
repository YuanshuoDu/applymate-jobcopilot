import { hashApprovalNonce } from "@jobcopilot/agent-protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ScheduledGateReplayOwnerFence } from "./gate-replay"
import { buildGateReplayExpectation, gateReviewReplayCoordinates } from "./gate-review-replay"
import type { ApprovalScopeInput } from "./types"

const owner: ScheduledGateReplayOwnerFence["owner"] = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "lease-1", turnLeaseVersion: 5, executionId: "execution-1", executionAttemptCount: 4,
}
const scope: ApprovalScopeInput = {
  userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, jobId: "job-1",
  toolCallId: "placeholder", action: "review_application", resourceHash: "resource-hash",
  materialHash: "material-hash", answersHash: "answers-hash", revision: 7,
  expiresAt: new Date("2026-11-14T12:15:00.000Z"),
}
const attempt = { id: owner.executionId, attemptCount: owner.executionAttemptCount }
function fence(overrides: Partial<ScheduledGateReplayOwnerFence> = {}): ScheduledGateReplayOwnerFence {
  return { owner, key: "continuation-1", claimToken: "claim-1", gateTaskId: "gate-1", assertCurrent: async () => true, ...overrides }
}

beforeEach(() => vi.stubEnv("AGENT_WORKER_SECRET", "test-server-only-shared-secret"))
afterEach(() => vi.unstubAllEnvs())

describe("Gate replay identity helper", () => {
  it("keeps the scheduled HMAC stable across retry lease changes and marker-only Gate changes", async () => {
    const firstFence = fence()
    const first = gateReviewReplayCoordinates(scope, attempt, firstFence, "scheduled-taskgraph-gate-review")
    const retry = gateReviewReplayCoordinates(scope, attempt, fence({
      owner: { ...owner, turnLeaseOwnerId: "lease-2", turnLeaseVersion: 6 }, claimToken: "claim-2",
    }), "scheduled-taskgraph-gate-review")
    const otherGate = gateReviewReplayCoordinates(scope, attempt, fence({ gateTaskId: "gate-2" }), "scheduled-taskgraph-gate-review")

    expect(retry).toEqual(first)
    expect(otherGate).toEqual(first)
    const original = await buildGateReplayExpectation({ title: "Review", body: "Materials",
      payload: { jobId: scope.jobId, scheduledGateReview: { gateTaskId: firstFence.gateTaskId } } }, scope, first)
    const changedMarker = await buildGateReplayExpectation({ title: "Review", body: "Materials",
      payload: { jobId: scope.jobId, scheduledGateReview: { gateTaskId: "gate-2" } } }, scope, otherGate)
    expect(changedMarker.approvalId).toBe(original.approvalId)
    expect(changedMarker.payload).not.toEqual(original.payload)
  })

  it("binds identity to the continuation key and review scope with domain-separated modes", () => {
    const baseline = gateReviewReplayCoordinates(scope, attempt, fence(), "scheduled-taskgraph-gate-review")
    const changedKey = gateReviewReplayCoordinates(scope, attempt, fence({ key: "continuation-2" }), "scheduled-taskgraph-gate-review")
    const changedJob = gateReviewReplayCoordinates({ ...scope, jobId: "job-2" }, attempt, fence(), "scheduled-taskgraph-gate-review")
    const legacyMode = gateReviewReplayCoordinates(scope, attempt, fence(), "gate-review")

    expect(changedKey.approvalId).not.toBe(baseline.approvalId)
    expect(changedJob.approvalId).not.toBe(baseline.approvalId)
    expect(legacyMode.approvalId).not.toBe(baseline.approvalId)
  })

  it("builds the exact persisted replay expectation", async () => {
    const coordinates = gateReviewReplayCoordinates(scope, attempt, fence(), "scheduled-taskgraph-gate-review")
    const payload = { jobId: scope.jobId, applicationTaskId: "application-task-1" }

    await expect(buildGateReplayExpectation({ title: "Review", body: "Materials", payload }, scope, coordinates))
      .resolves.toEqual({ approvalId: coordinates.approvalId, nonce: coordinates.nonce,
        nonceHash: await hashApprovalNonce(coordinates.nonce), scope, taskId: null,
        taskPayloadField: "applicationTaskId", title: "Review", body: "Materials", impact: null, payload })
  })
})