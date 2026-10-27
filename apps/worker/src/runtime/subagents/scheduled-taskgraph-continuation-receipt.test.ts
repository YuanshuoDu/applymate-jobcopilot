import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  buildScheduledTaskGraphContinuationReceipt,
  createScheduledTaskGraphContinuationContract,
  parseScheduledTaskGraphContinuationReceipt,
  scheduledPrepareReplayReceipt,
  scheduledTaskGraphContinuationBindingDigest,
  scheduledTaskGraphStableContinuationKey,
  scheduledTaskGraphContinuationReceiptMatches,
  scheduledTaskGraphClaimMatches,
  scheduledSnapshotMatches,
  SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT,
  SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA,
} from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import type { TaskGraphCurrentState, TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const owner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-owner-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 1,
}
const binding = {
  owner, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 12, prepareScheduleRevision: 13,
}

function prepareInput(overrides: {
  turnId?: string
  snapshotDigest?: string
  evidenceDigest?: string
  checkpointDigest?: string
  graphRevision?: number
  executionAttemptCount?: number
  turnLeaseOwnerId?: string
  turnLeaseVersion?: number
  claimTokenDigest?: string
  proposalGoal?: string
} = {}): TaskGraphScheduledPrepareInput {
  const attestationOwner = {
    userId: owner.userId,
    sessionId: owner.sessionId,
    turnId: overrides.turnId ?? owner.turnId,
    rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount,
    turnLeaseOwnerId: overrides.turnLeaseOwnerId ?? owner.turnLeaseOwnerId,
    turnLeaseVersion: overrides.turnLeaseVersion ?? owner.turnLeaseVersion,
  }
  const attestation: ScheduledAutomationPipelineAttestation = {
    schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1",
    owner: attestationOwner,
    snapshotDigest: overrides.snapshotDigest ?? binding.snapshotDigest,
    graphRevision: overrides.graphRevision ?? binding.analyzeGraphRevision,
    scout: {
      taskId: "scout-1", attemptCount: 1, status: "completed", verification: "passed",
      resultDigest: "1".repeat(64), candidateJobIds: ["job-1"],
      discoveryReceipt: {
        status: "complete", taskId: "scout-1", attemptCount: 1, completedCalls: 1, candidateCount: 1,
        providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: "2".repeat(64),
      },
    },
    analyst: {
      taskId: "analyst-1", attemptCount: 1, status: "completed", verification: "passed",
      resultDigest: "3".repeat(64), dependsOnTaskIds: ["scout-1"], jobIds: ["job-1"],
    },
    evidenceDigest: overrides.evidenceDigest ?? binding.evidenceDigest,
  }
  const executionOwner = { executionId: owner.executionId, executionAttemptCount: overrides.executionAttemptCount ?? owner.executionAttemptCount }
  const continuationKey = scheduledTaskGraphContinuationKey(attestationOwner, attestation, executionOwner.executionId, executionOwner.executionAttemptCount)
  return {
    scope: {
      userId: owner.userId, sessionId: owner.sessionId, turnId: attestationOwner.turnId,
      rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, stepId: "step-1",
      turnLeaseOwner: attestationOwner.turnLeaseOwnerId, turnLeaseVersion: attestationOwner.turnLeaseVersion,
      parentLeaseOwner: "root-worker-1", parentAttemptCount: owner.rootAttemptCount,
    },
    executionOwner,
    handoff: {
      status: "analyze_checkpointed", continuationKey, checkpointDigest: overrides.checkpointDigest ?? binding.checkpointDigest,
      claimTokenDigest: overrides.claimTokenDigest ?? `sha256:${"4".repeat(64)}`,
      executionId: executionOwner.executionId, executionAttemptCount: executionOwner.executionAttemptCount,
    },
    attestation,
    proposal: { expectedRevision: attestation.graphRevision, nodes: [{
      key: "prepare", templateId: "prepare", goal: overrides.proposalGoal ?? "Prepare the selected applications",
      successCriteria: ["Persist exact materials"], dependsOn: ["analyst"],
    }] },
  }
}

describe("scheduled TaskGraph continuation receipt", () => {
  it("builds and parses the exact private binding shape", () => {
    const receipt = buildScheduledTaskGraphContinuationReceipt(binding)
    expect(receipt).toEqual({ schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, ...binding })
    expect(parseScheduledTaskGraphContinuationReceipt(receipt)).toEqual(receipt)
    expect(scheduledTaskGraphContinuationBindingDigest(receipt)).toMatch(/^[a-f0-9]{64}$/)
    expect(SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT).toBe("agent.plan.scheduled_prepare_binding")
    expect(receipt).not.toHaveProperty("claimToken")
    expect(receipt).not.toHaveProperty("job")
    expect(receipt).not.toHaveProperty("body")
    expect(receipt).not.toHaveProperty("artifactContents")
  })

  it("accepts an exact replay and rejects a changed binding", () => {
    const receipt = buildScheduledTaskGraphContinuationReceipt(binding)
    expect(scheduledTaskGraphContinuationReceiptMatches(receipt, binding)).toBe(true)
    expect(scheduledTaskGraphContinuationReceiptMatches(receipt, { ...binding, checkpointDigest: "e".repeat(64) })).toBe(false)
    expect(scheduledTaskGraphContinuationReceiptMatches(undefined, binding)).toBe(false)
  })

  it("keeps the original Analyze identity and graph revision in the private contract", () => {
    const input = prepareInput()
    const contract = createScheduledTaskGraphContinuationContract(input)
    expect(contract).not.toBeNull()
    expect(contract?.binding.continuationKey).toBe(input.handoff.continuationKey)
    expect(contract?.binding.analyzeGraphRevision).toBe(input.attestation.graphRevision)
    expect(contract?.binding.prepareScheduleRevision).toBe(input.attestation.graphRevision + 1)
    expect(contract?.receipt).toMatchObject({
      schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA,
      owner: contract?.binding.owner,
      snapshotDigest: contract?.binding.snapshotDigest,
      evidenceDigest: contract?.binding.evidenceDigest,
      checkpointDigest: contract?.binding.checkpointDigest,
      analyzeGraphRevision: contract?.binding.analyzeGraphRevision,
      prepareScheduleRevision: contract?.binding.prepareScheduleRevision,
    })
    expect(contract?.receipt.continuationKey).toMatch(/^scheduled-taskgraph:sha256:[a-f0-9]{64}$/)
    expect(contract?.receipt.continuationKey).not.toBe(contract?.binding.continuationKey)
    expect(scheduledTaskGraphStableContinuationKey(contract?.binding)).toBe(contract?.receipt.continuationKey)
    expect(contract?.receipt).not.toHaveProperty("claimTokenDigest")
    expect(contract?.proposalFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it("binds the proposal fingerprint to every Analyze digest, revision, owner, attempt, and proposal", () => {
    const base = createScheduledTaskGraphContinuationContract(prepareInput())
    expect(base).not.toBeNull()
    const variants = [
      prepareInput({ snapshotDigest: `sha256:${"5".repeat(64)}` }),
      prepareInput({ evidenceDigest: "6".repeat(64) }),
      prepareInput({ checkpointDigest: "7".repeat(64) }),
      prepareInput({ graphRevision: binding.analyzeGraphRevision + 1 }),
      prepareInput({ turnId: "turn-2" }),
      prepareInput({ executionAttemptCount: owner.executionAttemptCount + 1 }),
    ]
    for (const input of variants) {
      const changed = createScheduledTaskGraphContinuationContract(input)
      expect(changed).not.toBeNull()
      expect(changed?.bindingDigest).not.toBe(base?.bindingDigest)
      expect(changed?.proposalFingerprint).not.toBe(base?.proposalFingerprint)
    }
    const changedProposal = createScheduledTaskGraphContinuationContract(prepareInput({ proposalGoal: "Prepare a different proposal" }))
    expect(changedProposal?.bindingDigest).toBe(base?.bindingDigest)
    expect(changedProposal?.proposalFingerprint).not.toBe(base?.proposalFingerprint)
  })

  it("keeps the fingerprint stable when only the transient claim token digest changes", () => {
    const first = createScheduledTaskGraphContinuationContract(prepareInput({ claimTokenDigest: `sha256:${"8".repeat(64)}` }))
    const second = createScheduledTaskGraphContinuationContract(prepareInput({ claimTokenDigest: `sha256:${"9".repeat(64)}` }))
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.claimTokenDigest).not.toBe(second?.claimTokenDigest)
    expect(first?.proposalFingerprint).toBe(second?.proposalFingerprint)
    expect(first?.receipt).not.toHaveProperty("claimTokenDigest")
    expect(JSON.stringify(first?.receipt)).not.toContain("8".repeat(64))
  })

  it("replays the immutable Analyze receipt after lease reacquisition while requiring the new live claim", () => {
    const first = createScheduledTaskGraphContinuationContract(prepareInput())
    const nextToken = "current-lease-claim"
    const reacquired = createScheduledTaskGraphContinuationContract(prepareInput({
      turnLeaseOwnerId: "turn-owner-2", turnLeaseVersion: owner.turnLeaseVersion + 1,
      claimTokenDigest: `sha256:${createHash("sha256").update(nextToken, "utf8").digest("hex")}`,
    }))
    expect(first).not.toBeNull()
    expect(reacquired).not.toBeNull()
    expect(reacquired?.binding.continuationKey).toBe(first?.binding.continuationKey)
    expect(reacquired?.receipt.continuationKey).toBe(first?.receipt.continuationKey)
    expect(reacquired?.bindingDigest).toBe(first?.bindingDigest)
    expect(reacquired?.proposalFingerprint).toBe(first?.proposalFingerprint)
    expect(reacquired?.receipt).not.toEqual(first?.receipt)
    expect(scheduledTaskGraphContinuationReceiptMatches(first?.receipt, reacquired?.receipt)).toBe(true)

    const now = new Date("2026-01-01T00:00:00.000Z")
    const liveClaim = { scheduledTaskGraphClaim: {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: reacquired!.binding.continuationKey,
      claimToken: nextToken, owner: reacquired!.binding.owner, claimedAt: "2025-12-31T23:59:00.000Z",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    } }
    const currentDigest = `sha256:${createHash("sha256").update(nextToken, "utf8").digest("hex")}`
    expect(scheduledTaskGraphClaimMatches(liveClaim, reacquired!.binding, currentDigest, now)).toBe(true)
    expect(scheduledTaskGraphClaimMatches(liveClaim, reacquired!.binding, `sha256:${"f".repeat(64)}`, now)).toBe(false)
    expect(scheduledTaskGraphClaimMatches(liveClaim, first!.binding, currentDigest, now)).toBe(false)
    expect(scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: {
      ...liveClaim.scheduledTaskGraphClaim, leaseExpiresAt: "2025-12-31T23:59:30.000Z",
    } }, reacquired!.binding, currentDigest, now)).toBe(false)
  })

  it("rejects replay receipts that differ in any owner, digest, or Analyze/schedule revision field", () => {
    const receipt = buildScheduledTaskGraphContinuationReceipt(binding)
    const changedBindings = [
      { ...binding, owner: { ...owner, turnId: "turn-2" } },
      { ...binding, continuationKey: `scheduled-taskgraph:sha256:${"e".repeat(64)}` },
      { ...binding, snapshotDigest: `sha256:${"f".repeat(64)}` },
      { ...binding, evidenceDigest: "1".repeat(64) },
      { ...binding, checkpointDigest: "2".repeat(64) },
      { ...binding, analyzeGraphRevision: binding.analyzeGraphRevision + 1, prepareScheduleRevision: binding.prepareScheduleRevision + 1 },
      { ...binding, prepareScheduleRevision: binding.prepareScheduleRevision + 1 },
    ]
    for (const changed of changedBindings) expect(scheduledTaskGraphContinuationReceiptMatches(receipt, changed)).toBe(false)
    expect(scheduledTaskGraphContinuationReceiptMatches(null, binding)).toBe(false)
  })

  it("rejects invalid identity, revision, digest, and forbidden or unknown private fields", () => {
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, owner: { ...owner, executionId: "" } })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, prepareScheduleRevision: 14 })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, checkpointDigest: "invalid" })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, claimToken: "must-never-persist" })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, jobText: "private job description" })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, body: "private body" })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({ ...binding, artifactContents: "private artifact" })).toBeNull()
    expect(buildScheduledTaskGraphContinuationReceipt({
      ...binding, owner: { ...owner, claimToken: "nested-secret" },
    })).toBeNull()

    const receipt = { schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, ...binding, claimToken: "stored-secret" }
    expect(parseScheduledTaskGraphContinuationReceipt(receipt)).toBeNull()
    expect(scheduledTaskGraphContinuationBindingDigest(receipt)).toBeNull()
  })

  it("preserves the exact Prepare task on replay and requeues only while it is ready", () => {
    const snapshot = { nodes: [
      { key: "scout-1", templateId: "scout", taskId: "scout-task", depth: 1, dependsOn: [] },
      { key: "analyst", templateId: "analyst", taskId: "analyst-task", depth: 2, dependsOn: ["scout-1"] },
      { key: "prepare", templateId: "prepare", taskId: "prepare-1", depth: 3, dependsOn: ["analyst"] },
    ] } as unknown as TaskGraphSnapshot
    const current = (status: string, revision = 13, readiness = status === "queued" ? "ready" : status === "completed" ? "terminal" : "active") =>
      ({ revision, nodes: [{ key: "prepare", taskId: "prepare-1", status, readiness }] }) as unknown as TaskGraphCurrentState
    expect(scheduledPrepareReplayReceipt(snapshot, current("queued"), 13)).toEqual({ status: "duplicate", revision: 13,
      nodes: [{ key: "prepare", taskId: "prepare-1", status: "queued" }], readyTaskIds: ["prepare-1"] })
    expect(scheduledPrepareReplayReceipt(snapshot, current("queued", 13, "waiting_for_dependencies"), 13)).toEqual({ status: "duplicate", revision: 13,
      nodes: [{ key: "prepare", taskId: "prepare-1", status: "waiting" }], readyTaskIds: [] })
    for (const [status, revision] of [["waiting", 14], ["running", 15], ["retrying", 16], ["waiting_for_user", 17], ["completed", 18]] as const) {
      expect(scheduledPrepareReplayReceipt(snapshot, current(status, revision), 13)).toEqual({ status: "duplicate", revision,
        nodes: [{ key: "prepare", taskId: "prepare-1", status: "waiting" }], readyTaskIds: [] })
    }
    expect(scheduledPrepareReplayReceipt(snapshot, current("failed", 19, "terminal"), 13)).toBeNull()
    expect(scheduledPrepareReplayReceipt(snapshot, current("queued", 14), 13)).toBeNull()
    expect(scheduledPrepareReplayReceipt(snapshot, current("running", 12), 13)).toBeNull()
    expect(scheduledPrepareReplayReceipt(snapshot, { revision: 13, nodes: [{ key: "prepare", taskId: "different-task", status: "running", readiness: "active" }] } as unknown as TaskGraphCurrentState, 13)).toBeNull()
  })

  it("matches the persisted snapshot when the live Turn row includes additional columns", () => {
    const snapshot = {
      schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], minScore: 70,
      dailyCap: 10, requireApproval: true, autoApply: false,
    }
    const digest = `sha256:${createHash("sha256").update(JSON.stringify([
      snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations, snapshot.minScore, snapshot.dailyCap,
      snapshot.requireApproval, snapshot.autoApply,
    ]), "utf8").digest("hex")}`

    expect(scheduledSnapshotMatches({ source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot },
      status: "in_progress", leaseOwnerId: "worker-1", leaseVersion: 4, leaseExpiresAt: new Date() }, digest)).toBe(true)
    expect(scheduledSnapshotMatches({ source: "interactive", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot }, status: "in_progress" }, digest)).toBe(false)
  })
})
