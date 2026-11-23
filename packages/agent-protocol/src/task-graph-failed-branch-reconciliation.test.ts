import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import {
  parseTaskGraphFailedBranchReconciliationReceipt,
  taskGraphFailedBranchReconciliationOperationKey,
  TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION,
  type TaskGraphFailedBranchReconciliationCodecs,
  type TaskGraphFailedBranchReconciliationExpected,
} from "./task-graph-failed-branch-reconciliation.js"
import { taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-failed-branch-relation.js"

const codecs: TaskGraphFailedBranchReconciliationCodecs = {
  sha256: value => createHash("sha256").update(value, "utf8").digest("hex"),
  utf8ByteLength: value => Buffer.byteLength(value, "utf8"),
}
const expected: TaskGraphFailedBranchReconciliationExpected = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-task",
}
const branchRoot = { nodeKey: "failed-root", taskId: "task-root" }
const child = { nodeKey: "failed-child", taskId: "task-child" }
const callId = "call-1"
const stepId = "step-1"

function receipt() {
  const operationKey = taskGraphFailedBranchReconciliationOperationKey({ ...expected, stepId }, callId, codecs)!
  const branch = { root: branchRoot, sources: [
    { ...branchRoot, replacementKey: "new-root" },
    { ...child, replacementKey: "new-child" },
  ] }
  return {
    schemaVersion: TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION,
    sessionId: expected.sessionId, turnId: expected.turnId, rootTaskId: expected.rootTaskId, stepId,
    decision: "revise", observedRevision: 4, resultingRevision: 6, steerInputIds: [], inputCheckpoint: { throughSequence: "9" },
    failedBranch: {
      schemaVersion: "agent-harness.v2.task-graph-failed-branch-repair.v1", operationKey,
      graphRootTaskId: expected.rootTaskId, observedRevision: 4, resultingRevision: 6, branchRoot,
      sources: branch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
      failedSource: { source: branchRoot, attemptCount: 2, resultDigest: "a".repeat(64), reportDigest: "b".repeat(64),
        event: { id: "failed-event", sequence: "10", idempotencyKey: taskGraphLifecycleKey(expected.rootTaskId, branchRoot.nodeKey, 2, "task.failed", codecs) } },
      cancellations: [{ source: child, event: { id: "cancel-event", sequence: "11",
        idempotencyKey: taskGraphLifecycleKey(expected.rootTaskId, child.nodeKey, 0, "task.cancelled", codecs) } }],
      verifiedExternalDependencies: [],
      planEvent: { id: "plan-event", sequence: "12", idempotencyKey: taskGraphProposalKey(expected.rootTaskId, 5, codecs) },
      requestFingerprint: "c".repeat(64),
      agentPlanCall: { callId, stepId, expectedRevision: 4, replaceBranch: branch },
    },
  }
}

describe("TaskGraph failed-branch reconciliation receipt", () => {
  it("parses the closed v4 receipt with authenticated owner scope", () => {
    const parsed = parseTaskGraphFailedBranchReconciliationReceipt(receipt(), codecs, expected)
    expect(parsed).not.toBeNull()
    expect(parsed?.stepId).toBe(stepId)
    expect(parsed?.resultingRevision).toBe(6)
    expect(parsed?.failedBranch.sources.map(source => source.replacementKey)).toEqual(["new-root", "new-child"])
    expect(parsed?.failedBranch.planEvent.sequence).toBe("12")
  })

  it("rejects foreign scope, changed operation lineage, unsupported fields, and stale envelopes", () => {
    expect(parseTaskGraphFailedBranchReconciliationReceipt(receipt(), codecs, { ...expected, userId: "foreign-user" })).toBeNull()
    expect(parseTaskGraphFailedBranchReconciliationReceipt(receipt(), codecs, { ...expected, sessionId: "foreign-session" })).toBeNull()
    expect(parseTaskGraphFailedBranchReconciliationReceipt({ ...receipt(), debug: true }, codecs, expected)).toBeNull()
    expect(parseTaskGraphFailedBranchReconciliationReceipt({ ...receipt(), schemaVersion: "agent-harness.v2.plan-reconciliation.v3" }, codecs, expected)).toBeNull()
    expect(parseTaskGraphFailedBranchReconciliationReceipt({ ...receipt(), resultingRevision: 7 }, codecs, expected)).toBeNull()
  })

  it("applies the persisted UTF-8 budget through the injected codec", () => {
    const oversized = { ...codecs, utf8ByteLength: () => 16 * 1024 + 1 }
    expect(parseTaskGraphFailedBranchReconciliationReceipt(receipt(), oversized, expected)).toBeNull()
  })
})
