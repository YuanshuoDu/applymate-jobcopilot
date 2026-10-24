import { describe, expect, it } from "vitest"
import { parseScheduledTaskGraphActionRequest, scheduledTaskGraphExecuteGateCompletionProof,
  scheduledTaskGraphGateTaskLeaseIsCurrent, scheduledTaskGraphGateTurnIsCurrent } from "./scheduled-taskgraph-gate-rpc"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 2, turnLeaseOwnerId: "root-lease", turnLeaseVersion: 4 }
const digest = `sha256:${"a".repeat(64)}`
const gateTask = { id: "gate-1", sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "running",
  attemptCount: 3, leaseOwner: "gate-lease", leaseExpiresAt: new Date(10_000), interruptRequestedAt: null, closedAt: null,
  expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "prepare", taskType: "scheduled_taskgraph_gate" },
  allowedActions: [] }

describe("scheduled TaskGraph Gate RPC contract", () => {
  it("accepts only the exact Gate action fields and bounds private choice history", () => {
    const valid = { action: "gate", owner, attestation: {}, prepareProof: {}, gateTaskId: gateTask.id,
      gateLeaseOwnerId: "gate-lease", gateAttemptCount: 3, validatedChoice: { kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "skip" },
      priorChoices: Array.from({ length: 51 }, () => ({ kind: "weak_cover_letter", jobIds: ["job-1"], choiceId: "skip" })) }
    expect(parseScheduledTaskGraphActionRequest(valid)).toMatchObject({ action: "gate", gateAttemptCount: 3 })
    expect(parseScheduledTaskGraphActionRequest({ ...valid, validatedChoice: null })).not.toHaveProperty("validatedChoice")
    expect(parseScheduledTaskGraphActionRequest({ ...valid, priorChoices: [...valid.priorChoices, valid.priorChoices[0]] })).toBeNull()
    expect(parseScheduledTaskGraphActionRequest({ ...valid, claimToken: "caller-supplied" })).toBeNull()
    expect(parseScheduledTaskGraphActionRequest({ ...valid, persistedCheckpoint: { nextStage: "gate" } })).toBeNull()
  })

  it("accepts the exact live Gate child when DurableWait has released the Root Turn lease", () => {
    const suspendedTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
      status: "waiting_for_tool", leaseOwnerId: null, leaseVersion: owner.turnLeaseVersion + 1, leaseExpiresAt: null }
    expect(scheduledTaskGraphGateTurnIsCurrent(suspendedTurn, { owner, mode: "gate_child", now: 5_000 })).toBe(true)
    expect(scheduledTaskGraphGateTurnIsCurrent(suspendedTurn, { owner, mode: "root_execute", now: 5_000 })).toBe(false)
    expect(scheduledTaskGraphGateTurnIsCurrent({ ...suspendedTurn, leaseOwnerId: "stale-owner" }, { owner, mode: "gate_child", now: 5_000 })).toBe(false)
    expect(scheduledTaskGraphGateTurnIsCurrent({ ...suspendedTurn, leaseExpiresAt: new Date(10_000) }, { owner, mode: "gate_child", now: 5_000 })).toBe(false)
    expect(scheduledTaskGraphGateTaskLeaseIsCurrent(gateTask, { owner, taskId: gateTask.id,
      leaseOwnerId: "gate-lease", attemptCount: 3, now: 5_000 })).toBe(true)
  })

  it("accepts an active newer Root lease for the child while Execute still requires the receipt lease", () => {
    const resumedTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, rootTaskId: owner.rootTaskId,
      status: "in_progress", leaseOwnerId: "root-lease-v2", leaseVersion: owner.turnLeaseVersion + 1,
      leaseExpiresAt: new Date(10_000) }
    expect(scheduledTaskGraphGateTurnIsCurrent(resumedTurn, { owner, mode: "gate_child", now: 5_000 })).toBe(true)
    expect(scheduledTaskGraphGateTurnIsCurrent(resumedTurn, { owner, mode: "root_execute", now: 5_000 })).toBe(false)
    expect(scheduledTaskGraphGateTurnIsCurrent({ ...resumedTurn, leaseExpiresAt: new Date(5_000) },
      { owner, mode: "gate_child", now: 5_000 })).toBe(false)
  })

  it("rejects stale, foreign, cancelled, or non-specialized Gate child leases", () => {
    const expected = { owner, taskId: gateTask.id, leaseOwnerId: "gate-lease", attemptCount: 3, now: 5_000 }
    for (const task of [
      { ...gateTask, leaseOwner: "other" }, { ...gateTask, attemptCount: 2 }, { ...gateTask, leaseExpiresAt: new Date(5_000) },
      { ...gateTask, interruptRequestedAt: new Date() }, { ...gateTask, allowedActions: ["jobs.search"] },
      { ...gateTask, expectedOutputSchema: { ...gateTask.expectedOutputSchema, extra: true } },
    ]) expect(scheduledTaskGraphGateTaskLeaseIsCurrent(task, expected)).toBe(false)
    expect(scheduledTaskGraphGateTurnIsCurrent({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      rootTaskId: owner.rootTaskId, status: "in_progress", leaseOwnerId: "other", leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(10_000) }, { owner, mode: "root_execute", now: 5_000 })).toBe(false)
    expect(scheduledTaskGraphGateTurnIsCurrent({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      rootTaskId: owner.rootTaskId, status: "completed", leaseOwnerId: null, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: null }, { owner, mode: "gate_child", now: 5_000 })).toBe(false)
  })

  it("accepts only the typed Worker Execute proof reference shape", () => {
    const proof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 15,
      prepareProof: {}, gate: { taskId: "gate-1", attemptCount: 3, resultDigest: digest, completedEventRevision: 15 } }
    expect(scheduledTaskGraphExecuteGateCompletionProof(proof)).toEqual(proof)
    expect(scheduledTaskGraphExecuteGateCompletionProof({ ...proof, graphRevision: 14 })).toBeNull()
    expect(scheduledTaskGraphExecuteGateCompletionProof({ ...proof, gate: { ...proof.gate, extra: true } })).toBeNull()
    expect(scheduledTaskGraphExecuteGateCompletionProof({ ...proof, gate: { ...proof.gate, resultDigest: "0".repeat(64) } })).toBeNull()
  })

  it("parses a Root-owned Execute action separately from Gate child authority", () => {
    const proof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 15,
      prepareProof: {}, gate: { taskId: "gate-1", attemptCount: 3, resultDigest: digest, completedEventRevision: 15 } }
    expect(parseScheduledTaskGraphActionRequest({ action: "execute", owner, attestation: {}, prepareProof: {}, gateCompletionProof: proof }))
      .toMatchObject({ action: "execute", gateCompletionProof: proof })
    expect(parseScheduledTaskGraphActionRequest({ action: "execute", owner, attestation: {}, prepareProof: {}, gateCompletionProof: proof,
      gateAttemptCount: 3 })).toBeNull()
  })
})
