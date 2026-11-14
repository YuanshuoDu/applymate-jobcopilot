import { hashApprovalNonce } from "@jobcopilot/agent-protocol"
import { createHmac } from "node:crypto"

import type { ReplayReceiptExpectation, ScheduledGateReplayOwnerFence } from "./gate-replay"
import type { ApprovalScopeInput } from "./types"

type GateReplayAttempt = { id: string; attemptCount: number } | undefined
type GateReplayMode = "gate-review" | "scheduled-taskgraph-gate-review"
type ReplayExpectationInput = Readonly<{ title: string; body: string; impact?: unknown; payload: unknown }>

/** Derives stable receipt coordinates from the exact server-owned Gate review identity. */
export function gateReviewReplayCoordinates(
  scope: ApprovalScopeInput,
  attempt: GateReplayAttempt,
  ownerFence: ScheduledGateReplayOwnerFence | undefined,
  mode: GateReplayMode,
) {
  if (scope.action !== "review_application" || !attempt || !attempt.id.trim()
    || !Number.isSafeInteger(attempt.attemptCount) || attempt.attemptCount < 0) {
    throw new Error("Gate receipt replay requires an exact execution attempt")
  }
  const owner = ownerFence?.owner
  if (!ownerFence || !owner
    || owner.userId !== scope.userId || owner.sessionId !== scope.sessionId || owner.turnId !== scope.turnId
    || !owner.rootTaskId.trim() || !Number.isSafeInteger(owner.rootAttemptCount) || owner.rootAttemptCount < 1
    || !owner.turnLeaseOwnerId.trim() || !Number.isSafeInteger(owner.turnLeaseVersion) || owner.turnLeaseVersion < 1
    || owner.executionId !== attempt.id || owner.executionAttemptCount !== attempt.attemptCount
    || mode === "scheduled-taskgraph-gate-review" && (!ownerFence.gateTaskId?.trim() || ownerFence.gateTaskId.length > 256)
    || !ownerFence.key.trim() || !ownerFence.claimToken.trim() || typeof ownerFence.assertCurrent !== "function") {
    throw new Error("Gate receipt replay requires an exact scheduled owner fence")
  }
  const secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!secret) throw new Error("Gate receipt replay signing key is unavailable")

  const identity = JSON.stringify([
    1,
    scope.userId,
    scope.sessionId,
    scope.turnId,
    attempt.id,
    attempt.attemptCount,
    [owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount],
    scope.jobId,
    scope.action,
    scope.resourceHash,
    scope.materialHash,
    scope.answersHash,
    ...(mode === "scheduled-taskgraph-gate-review" ? [ownerFence.key] : []),
  ])
  const derive = (label: "approval-id" | "receipt-nonce" | "tool-call-id") => createHmac("sha256", secret)
    .update(`${mode === "scheduled-taskgraph-gate-review" ? "applymate.scheduled-gate-review-replay.v2" : "applymate.gate-review-replay.v1"}:${label}\0${identity}`)
    .digest("hex")

  return {
    approvalId: `gate_review_${derive("approval-id")}`,
    nonce: derive("receipt-nonce"),
    toolCallId: `application-review:${derive("tool-call-id")}`,
  }
}

/** Builds the persisted replay expectation without changing the stable HMAC identity. */
export async function buildGateReplayExpectation(
  input: ReplayExpectationInput,
  scope: ApprovalScopeInput,
  replayCoordinates: ReturnType<typeof gateReviewReplayCoordinates>,
): Promise<ReplayReceiptExpectation> {
  return {
    approvalId: replayCoordinates.approvalId,
    nonce: replayCoordinates.nonce,
    nonceHash: await hashApprovalNonce(replayCoordinates.nonce),
    scope,
    taskId: null,
    taskPayloadField: "applicationTaskId",
    title: input.title,
    body: input.body,
    impact: input.impact ?? null,
    payload: input.payload,
  }
}