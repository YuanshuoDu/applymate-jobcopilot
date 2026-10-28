import { beforeEach, describe, expect, it, vi } from "vitest"
import { scheduledAutomationSnapshotDigest } from "./scheduled-taskgraph-pipeline-checkpoint"
import { isScheduledPrepareChoiceWaitId, validateScheduledPrepareWaitIdentity } from "./scheduled-taskgraph-prepare-choice-identity"

const mocks = vi.hoisted(() => ({ events: vi.fn(), steps: vi.fn(), items: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentEvent: { findMany: mocks.events }, agentStep: { findFirst: mocks.steps }, agentItem: { findFirst: mocks.items } } }))

const owner = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", rootAttemptCount: 2,
  turnLeaseOwnerId: "worker_1", turnLeaseVersion: 4, executionId: "execution_1", executionAttemptCount: 0 }
const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 80, dailyCap: 5, requireApproval: false, autoApply: false }
const finalStepId = "step_final_1", finalStepOrdinal = 1
const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1", owner,
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: scheduledAutomationSnapshotDigest(snapshot),
  evidenceDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), analyzeGraphRevision: 9, prepareScheduleRevision: 10 }
const proof = { receipt, completion: {}, result: {} }
const baseCandidate = { sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount,
  finalStepId, finalStepOrdinal, stepAttempt: 1, candidateText: "candidate", finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 } }

function scopedCandidate(userId: string) {
  return { ...baseCandidate, schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v3",
    sourceReceipt: { schemaVersion: 1, scope: { userId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, stepId: finalStepId },
      bindings: [{ key: "E-job-1", observationId: "tool-result:call-1", toolCallId: "call-1", toolName: "jobs.search", sourceRef: "jobs/0",
        inputDigest: `sha256:${"d".repeat(64)}`, resultDigest: `sha256:${"e".repeat(64)}` }] } }
}

function configureCandidate(payload: unknown) {
  mocks.events.mockImplementation((query: { where: { type: string } }) => Promise.resolve(query.where.type === "agent.plan.scheduled_prepare_binding"
    ? [{ payload: receipt }]
    : [{ type: "native_verification.scheduled_candidate_staged", taskId: owner.rootTaskId, correlationId: finalStepId, payload }]))
  mocks.steps.mockImplementation((query: { where: { id?: string } }) => Promise.resolve(query.where.id
    ? { id: finalStepId, status: "streaming" } : { id: finalStepId }))
  mocks.items.mockResolvedValue(null)
}

describe("scheduled prepare choice identity source scope", () => {
  beforeEach(() => {
    mocks.events.mockReset()
    mocks.steps.mockReset()
    mocks.items.mockReset()
  })

  it("keeps legacy v2 and null-receipt candidates valid", async () => {
    const v3WithoutReceipt = { ...baseCandidate, schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v3", sourceReceipt: null }
    configureCandidate(v3WithoutReceipt)
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)

    const { sourceReceipt: _unused, ...v2Candidate } = scopedCandidate(owner.userId)
    configureCandidate({ ...v2Candidate, schemaVersion: "agent-harness.v2.scheduled-pipeline-candidate.v2" })
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)
  })

  it("requires a scoped v3 source receipt to match the owner user", async () => {
    configureCandidate(scopedCandidate(owner.userId))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(true)

    configureCandidate(scopedCandidate("other_user"))
    await expect(validateScheduledPrepareWaitIdentity({ owner, snapshot, proof })).resolves.toBe(false)
  })

  it("accepts only canonical choice IDs for the current Turn", () => {
    const id = `agent-question:${owner.turnId}:canonical:${"f".repeat(64)}`
    expect(isScheduledPrepareChoiceWaitId(owner.turnId, id)).toBe(true)
    expect(isScheduledPrepareChoiceWaitId("other_turn", id)).toBe(false)
    expect(isScheduledPrepareChoiceWaitId(owner.turnId, `${id}x`)).toBe(false)
  })
})
