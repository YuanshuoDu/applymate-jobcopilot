import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  parseTaskGraphFailedBranchRepairRelation,
  taskGraphItemId,
  taskGraphLifecycleKey,
  taskGraphProposalKey,
  type TaskGraphFailedBranchReconciliationCodecs,
} from "./task-graph-failed-branch-relation.js"

const codecs: TaskGraphFailedBranchReconciliationCodecs = {
  sha256: value => createHash("sha256").update(value, "utf8").digest("hex"),
  utf8ByteLength: value => new TextEncoder().encode(value).byteLength,
}
const sourceRoot = { nodeKey: "failed-root", taskId: "task-root" }
const child = { nodeKey: "failed-child", taskId: "task-child" }
const branch = { root: sourceRoot, sources: [
  { ...sourceRoot, replacementKey: "new-root" },
  { ...child, replacementKey: "new-child" },
] }

function relation() {
  return {
    schemaVersion: "agent-harness.v2.task-graph-failed-branch-repair.v1",
    operationKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
    graphRootTaskId: "root-task", observedRevision: 4, resultingRevision: 6,
    branchRoot: sourceRoot,
    sources: branch.sources.map(value => ({ source: { nodeKey: value.nodeKey, taskId: value.taskId }, replacementKey: value.replacementKey })),
    failedSource: {
      source: sourceRoot, attemptCount: 2, resultDigest: "b".repeat(64), reportDigest: "c".repeat(64),
      event: { id: "failed-event", sequence: "10", idempotencyKey: taskGraphLifecycleKey("root-task", sourceRoot.nodeKey, 2, "task.failed", codecs) },
    },
    cancellations: [{
      source: child, event: { id: "cancel-event", sequence: "11", idempotencyKey: taskGraphLifecycleKey("root-task", child.nodeKey, 0, "task.cancelled", codecs) },
    }],
    verifiedExternalDependencies: [],
    planEvent: { id: "plan-event", sequence: "12", idempotencyKey: taskGraphProposalKey("root-task", 5, codecs) },
    requestFingerprint: "d".repeat(64),
    agentPlanCall: { callId: "call-1", stepId: "step-1", expectedRevision: 4, replaceBranch: branch },
  }
}

describe("TaskGraph failed-branch relation", () => {
  it("parses the canonical relation and preserves exact source-to-replacement bindings", () => {
    const parsed = parseTaskGraphFailedBranchRepairRelation(relation(), codecs)
    expect(parsed?.sources).toEqual(relation().sources)
    expect(parsed?.planEvent.sequence).toBe("12")
    expect(parsed?.agentPlanCall.replaceBranch).toEqual(branch)
  })

  it("rejects mismatched mappings, stale plan keys, and malformed hash codecs", () => {
    const value = relation()
    const mismatched = { ...value, sources: [{ ...value.sources[0]!, replacementKey: "foreign" }, value.sources[1]] }
    expect(parseTaskGraphFailedBranchRepairRelation(mismatched, codecs)).toBeNull()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...value, planEvent: { ...value.planEvent, idempotencyKey: "wrong" } }, codecs)).toBeNull()
    expect(parseTaskGraphFailedBranchRepairRelation(value, { sha256: () => "wrong", utf8ByteLength: () => 1 })).toBeNull()
  })

  it("keeps the canonical event-key formulas bounded and deterministic", () => {
    const rootHash = createHash("sha256").update("root-task", "utf8").digest("hex")
    const nodeHash = createHash("sha256").update("failed-root", "utf8").digest("hex").slice(0, 20)
    expect(taskGraphItemId("root-task", codecs)).toBe(`task-graph-${rootHash}`)
    expect(taskGraphProposalKey("root-task", 5, codecs)).toBe(`task-graph-${rootHash}:proposal:5`)
    expect(taskGraphLifecycleKey("root-task", "failed-root", 2, "task.failed", codecs))
      .toBe(`task-graph-${rootHash}:node:${nodeHash}:2:task.failed`)
  })
})
