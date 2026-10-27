import { describe, expect, it } from "vitest"
import {
  blocked, claimLeaseIsActive, claimLeaseIsValidAndExpired, hasMarkerlessScoutState, hasPrepareCheckpoint,
  gateFailureDiagnostic, isWaitResult, mapCheckpointError, parseScheduledTaskGraphPipelineRequest, reportLeaseIsCurrent,
  scheduledTaskGraphClaimIsValid, scheduledTaskGraphLineageOwnerIsSame, scheduledTaskGraphRootLeaseIsLive,
} from "./scheduled-taskgraph-pipeline-request"

const owner = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
  turnLeaseOwnerId: "lease", turnLeaseVersion: 2, executionId: "e", executionAttemptCount: 0 }

describe("scheduled TaskGraph pipeline request helpers", () => {
  it("parses the action envelope and rejects malformed JSON", async () => {
    const valid = await parseScheduledTaskGraphPipelineRequest(new Request("https://local.invalid", { method: "POST",
      body: JSON.stringify({ action: "execute", owner: { ...owner, executionId: undefined, executionAttemptCount: undefined },
        attestation: {}, prepareProof: {}, gateCompletionProof: {} }) }))
    expect(valid?.action).toBe("execute")
    const invalid = await parseScheduledTaskGraphPipelineRequest(new Request("https://local.invalid", { method: "POST", body: "{" }))
    expect(invalid).toBeNull()
  })

  it("preserves checkpoint error classifications", () => {
    expect(mapCheckpointError({ reason: "discovery_incomplete" })).toBe("scheduled_pipeline_discovery_incomplete")
    expect(mapCheckpointError({ reason: "owner_mismatch" })).toBe("scheduled_pipeline_owner_mismatch")
    expect(mapCheckpointError({ reason: "invalid_attestation" })).toBe("scheduled_pipeline_attestation_invalid")
    expect(blocked(409, "scheduled_pipeline_discovery_incomplete").status).toBe(409)
  })

  it("retains lease, continuation, and wait classifications", () => {
    const state = { nextStage: "scout" }
    expect(hasMarkerlessScoutState(state)).toBe(true)
    expect(hasMarkerlessScoutState({ ...state, scheduledTaskGraphWait: {} })).toBe(false)
    expect(isWaitResult({ status: "waiting_for_user", waitId: "w", stage: "analyst" })).toBe(true)
    expect(isWaitResult({ status: "completed", waitId: "w", stage: "analyst" })).toBe(false)
    expect(claimLeaseIsActive({ scheduledTaskGraphClaim: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } })).toBe(true)
    expect(claimLeaseIsActive({ scheduledTaskGraphClaim: { leaseExpiresAt: "invalid" } })).toBe(false)
    expect(hasPrepareCheckpoint({ nextStage: "prepare", scheduledTaskGraphContinuation: { key: "k", owner } }, "k", owner)).toBe(true)
    expect(reportLeaseIsCurrent({ status: "waiting_for_user", leaseOwnerId: null, leaseVersion: 2, leaseExpiresAt: null }, owner)).toBe(true)
    const claim = { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: "k", claimToken: "token",
      owner, claimedAt: new Date(Date.now() - 2_000).toISOString(), leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }
    expect(claimLeaseIsValidAndExpired(claim, "k", owner, Date.now())).toBe(true)
    expect(claimLeaseIsValidAndExpired(claim, "wrong", owner, Date.now())).toBe(false)
    expect(scheduledTaskGraphClaimIsValid({ ...claim, leaseExpiresAt: new Date(Date.now() + 1_000).toISOString() }, owner, "k", "token")).toBe(true)
    expect(scheduledTaskGraphLineageOwnerIsSame(owner, owner)).toBe(true)
    expect(scheduledTaskGraphLineageOwnerIsSame({ ...owner, executionId: "foreign" }, owner)).toBe(false)
    expect(scheduledTaskGraphRootLeaseIsLive({ status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 1_000) }, owner)).toBe(true)
    expect(gateFailureDiagnostic("gate_execution", new Error("scheduled_taskgraph_gate_result_invalid")))
      .toEqual({ phase: "gate_execution", errorClass: "error", safeErrorCode: "scheduled_taskgraph_gate_result_invalid" })
  })
})
