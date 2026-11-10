import { describe, expect, it } from "vitest"
import { SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA } from "./scheduled-gate-contract.js"
import {
  parseScheduledPostGateExecuteTaskEnvelope, parseScheduledPostGateHandoff, scheduledPostGateDigest,
  scheduledPostGateHandoffKey, scheduledPostGateScopeMatchesOwner, SCHEDULED_POST_GATE_HANDOFF_SCHEMA,
} from "./scheduled-post-gate-contract.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "lease-1", turnLeaseVersion: 3, executionId: "execution-1", executionAttemptCount: 1 }
const refs = ["package-a", "package-b"]
const snapshotDigest = digest("snapshot")
const continuationKey = "continuation-1"
const proof = { schemaVersion: SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA, graphRevision: 7,
  prepareProof: { receipt: { owner, snapshotDigest, continuationKey, checkpointDigest: digest("checkpoint"),
    evidenceDigest: digest("evidence"), analyzeGraphRevision: 5 } },
  gate: { taskId: "gate-task", attemptCount: 1, resultDigest: digest("gate-result"), completedEventRevision: 7 } }

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEDULED_POST_GATE_HANDOFF_SCHEMA, owner, snapshotDigest, continuationKey,
    gateTaskId: "gate-task", gateAttemptCount: 1, gateCompletedEventRevision: 7, gateProofDigest: scheduledPostGateDigest(proof),
    gateProof: proof, gateResultDigest: proof.gate.resultDigest, packageRefs: refs, packageDigest: scheduledPostGateDigest(refs),
    proposalDigest: digest("proposal"), gateGraphRevision: 7, graphRevision: 8,
    executeNodes: [{ key: "execute-a", taskId: "execute-task-a", packageRefs: [refs[0]] },
      { key: "execute-b", taskId: "execute-task-b", packageRefs: [refs[1]] }], auditTaskId: "audit-task", ...overrides,
  }
}
function digest(value: string): string { return scheduledPostGateDigest(value) }
function executeEnvelope(queued: unknown, failed: unknown) {
  return { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: null, structuredResult: { queued, failed } }
}

describe("scheduled post-Gate contract parsing", () => {
  it("accepts a frozen handoff whose Execute partitions exactly cover the Gate refs", () => {
    const parsed = parseScheduledPostGateHandoff(handoff())
    expect(parsed).not.toBeNull()
    expect(parsed?.packageRefs).toEqual(refs)
    expect(parsed?.executeNodes.map(node => node.packageRefs)).toEqual([[refs[0]], [refs[1]]])
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.executeNodes)).toBe(true)
  })

  it("rejects missing, duplicated, and extra package assignments", () => {
    const base = handoff() as ReturnType<typeof handoff>
    expect(parseScheduledPostGateHandoff({ ...base, executeNodes: [
      { key: "execute-a", taskId: "execute-task-a", packageRefs: [refs[0]] },
    ] })).toBeNull()
    expect(parseScheduledPostGateHandoff({ ...base, executeNodes: [
      { key: "execute-a", taskId: "execute-task-a", packageRefs: refs },
      { key: "execute-b", taskId: "execute-task-b", packageRefs: [refs[1]] },
    ] })).toBeNull()
    expect(parseScheduledPostGateHandoff({ ...base, executeNodes: [
      { key: "execute-a", taskId: "execute-task-a", packageRefs: [refs[0], "package-extra"] },
      { key: "execute-b", taskId: "execute-task-b", packageRefs: [refs[1]] },
    ] })).toBeNull()
  })

  it("rejects sparse Gate package and Execute arrays", () => {
    const sparseRefs = new Array<string>(2)
    sparseRefs[1] = refs[1]
    expect(parseScheduledPostGateHandoff({ ...handoff(), packageRefs: sparseRefs,
      packageDigest: scheduledPostGateDigest(sparseRefs) })).toBeNull()
    const sparsePartition = new Array<string>(2)
    sparsePartition[1] = refs[0]
    expect(parseScheduledPostGateHandoff({ ...handoff(), executeNodes: [
      { key: "execute-a", taskId: "execute-task-a", packageRefs: sparsePartition },
      { key: "execute-b", taskId: "execute-task-b", packageRefs: [refs[1]] },
    ] })).toBeNull()
    const sparseNodes = new Array<unknown>(2)
    sparseNodes[1] = (handoff() as ReturnType<typeof handoff>).executeNodes[1]
    expect(parseScheduledPostGateHandoff({ ...handoff(), executeNodes: sparseNodes })).toBeNull()
  })

  it("rejects proof digest or revision changes and accepts one empty partition for an empty Gate result", () => {
    const value = handoff()
    expect(parseScheduledPostGateHandoff({ ...value, gateProofDigest: digest("different-proof") })).toBeNull()
    expect(parseScheduledPostGateHandoff({ ...value, graphRevision: 9 })).toBeNull()
    const empty = { ...value, packageRefs: [], packageDigest: scheduledPostGateDigest([]), executeNodes: [
      { key: "execute-empty", taskId: "execute-empty-task", packageRefs: [] },
    ] }
    expect(parseScheduledPostGateHandoff(empty)?.executeNodes[0]?.packageRefs).toEqual([])
  })

  it("binds the stable handoff key to Root and Gate attempts", () => {
    const input = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      rootAttemptCount: owner.rootAttemptCount, gateTaskId: "gate-task", gateAttemptCount: 1 }
    expect(scheduledPostGateHandoffKey(input)).toBe(scheduledPostGateHandoffKey(input))
    expect(scheduledPostGateHandoffKey({ ...input, gateAttemptCount: 2 })).not.toBe(scheduledPostGateHandoffKey(input))
  })

  it("matches only the immutable Root and Turn lease provenance", () => {
    const scope: TaskGraphExecutionScope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, stepId: "step-1",
      turnLeaseOwner: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion,
      parentLeaseOwner: owner.turnLeaseOwnerId, parentAttemptCount: owner.rootAttemptCount }
    expect(scheduledPostGateScopeMatchesOwner(scope, owner)).toBe(true)
    expect(scheduledPostGateScopeMatchesOwner({ ...scope, turnLeaseVersion: 4 }, owner)).toBe(false)
    expect(scheduledPostGateScopeMatchesOwner({ ...scope, parentAttemptCount: 3 }, owner)).toBe(false)
  })

  it("accepts the non-submitting empty Execute result and rejects malformed package arrays", () => {
    expect(parseScheduledPostGateExecuteTaskEnvelope(executeEnvelope([], []), "completed", refs))
      .toEqual({ queued: [], failed: [] })
    expect(parseScheduledPostGateExecuteTaskEnvelope(executeEnvelope([refs[0]], [refs[1]]), "completed", refs))
      .toEqual({ queued: [refs[0]], failed: [refs[1]] })
    const sparse = new Array<string>(2)
    sparse[1] = refs[0]
    expect(parseScheduledPostGateExecuteTaskEnvelope(executeEnvelope(sparse, []), "completed", refs)).toBeNull()
    expect(parseScheduledPostGateExecuteTaskEnvelope(executeEnvelope([refs[0]], [refs[0]]), "completed", refs)).toBeNull()
  })
})
