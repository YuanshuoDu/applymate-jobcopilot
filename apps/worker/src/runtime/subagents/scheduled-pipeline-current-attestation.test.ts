import { describe, expect, it, vi } from "vitest"
import { buildScheduledPipelineGraphAttestation, revalidateScheduledPipelineCurrentAttestation,
  scheduledPrepareReceiptOwnerMatches } from "./scheduled-pipeline-current-attestation.js"
import type { ScheduledAutomationPipelineBridgeState } from "./scheduled-automation-pipeline-bridge.js"
import { buildScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

const scope = { userId: "u", sessionId: "s", turnId: "t", rootTaskId: "r", rootAttemptCount: 1,
  turnLeaseOwnerId: "lease", turnLeaseVersion: 1 }
const emptyState: ScheduledAutomationPipelineBridgeState = {
  turn: { ...scope, source: "manual", executionMode: "interactive", input: {}, status: "in_progress",
    leaseOwnerId: scope.turnLeaseOwnerId, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) },
  root: { id: "other-root", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, status: "running", attemptCount: 1 },
  snapshot: null, current: { revision: 0, nodes: [] }, tasks: [],
}

describe("revalidateScheduledPipelineCurrentAttestation", () => {
  it("uses the caller's locked state and fails closed on a mismatched root", async () => {
    const verifyCompletedNode = vi.fn()
    const result = await revalidateScheduledPipelineCurrentAttestation({ scope, state: emptyState, verifyCompletedNode })
    expect(result).toEqual({ status: "blocked", reasonCode: "root_lineage_invalid" })
    expect(verifyCompletedNode).not.toHaveBeenCalled()
  })
  it("requires every graph task in the already loaded owner-scoped map", async () => {
    const verifyCompletedNode = vi.fn()
    const result = await buildScheduledPipelineGraphAttestation({ scope, schedule: {}, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "child", taskId: "child-task",
      templateId: "manual", goal: "Run", successCriteria: ["Complete"], dependsOn: [], depth: 1 }] },
    current: { revision: 1, nodes: [] }, tasks: new Map(), verifyCompletedNode })
    expect(result).toEqual({ status: "blocked", reasonCode: "task_graph_incomplete" })
    expect(verifyCompletedNode).not.toHaveBeenCalled()
  })
  it("allows stable Prepare receipt lineage across a renewed live Turn lease", () => {
    const receipt = buildScheduledTaskGraphContinuationReceipt({ owner: { ...scope, executionId: "e", executionAttemptCount: 1 },
      continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
      evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 2, prepareScheduleRevision: 3 })
    if (!receipt) throw new Error("receipt fixture invalid")
    expect(scheduledPrepareReceiptOwnerMatches(receipt, { ...scope, turnLeaseOwnerId: "renewed", turnLeaseVersion: 2 })).toBe(true)
    expect(scheduledPrepareReceiptOwnerMatches(receipt, { ...scope, rootAttemptCount: 2, turnLeaseOwnerId: "renewed", turnLeaseVersion: 2 })).toBe(false)
  })
})
