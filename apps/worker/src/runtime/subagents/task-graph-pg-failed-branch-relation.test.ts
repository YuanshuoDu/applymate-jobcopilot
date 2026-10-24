import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import {
  parseTaskGraphFailedBranchRepairRelation,
  TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  taskGraphFailedBranchRepairFingerprint,
  type TaskGraphFailedBranchRepairRelation,
} from "./task-graph-pg-failed-branch-relation.js"
import { taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"

const replaceBranch: TaskGraphBranchReplacement = { root: { nodeKey: "scout-old", taskId: "scout-task" }, sources: [
  { nodeKey: "scout-old", taskId: "scout-task", replacementKey: "scout-new" },
  { nodeKey: "analyst-old", taskId: "analyst-task", replacementKey: "analyst-new" },
] }
const input = { expectedRevision: 7, replaceBranch, nodes: [
  { key: "scout-new", templateId: "scout", goal: "Refresh search", successCriteria: ["Find roles"], dependsOn: [],
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    ] } },
  { key: "analyst-new", templateId: "analyst", goal: "Review evidence", successCriteria: ["Rank roles"], dependsOn: ["scout-new"],
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
      { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    ] } },
] }
const digest = taskGraphFailedBranchRepairFingerprint(input)
const operationKey = `agent.plan.reconciliation:sha256:${"a".repeat(64)}`
const failedKey = taskGraphLifecycleKey("graph-root", "scout-old", 2, "task.failed")
const cancelKey = taskGraphLifecycleKey("graph-root", "analyst-old", 0, "task.cancelled")

function relation(overrides: Record<string, unknown> = {}): TaskGraphFailedBranchRepairRelation {
  const value = {
    schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey, graphRootTaskId: "graph-root", observedRevision: 7, resultingRevision: 9,
    branchRoot: replaceBranch.root,
    sources: replaceBranch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
    failedSource: { source: replaceBranch.root, attemptCount: 2, resultDigest: "b".repeat(64), reportDigest: "c".repeat(64),
      event: { id: "failed-event", sequence: "20", idempotencyKey: failedKey } },
    cancellations: [{ source: { nodeKey: "analyst-old", taskId: "analyst-task" },
      event: { id: "cancel-event", sequence: "21", idempotencyKey: cancelKey } }],
    verifiedExternalDependencies: [{ dependency: { nodeKey: "foundation", taskId: "foundation-task" }, attemptCount: 1,
      resultDigest: "d".repeat(64), reportDigest: "e".repeat(64), completedEvent: { id: "complete-event", sequence: "19",
        idempotencyKey: taskGraphLifecycleKey("graph-root", "foundation", 1, "task.completed") } }],
    planEvent: { id: "plan-event", sequence: "23", idempotencyKey: taskGraphProposalKey("graph-root", 8) },
    requestFingerprint: digest,
    agentPlanCall: { callId: "call-1", stepId: "step-1", expectedRevision: 7, replaceBranch },
    ...overrides,
  }
  const parsed = parseTaskGraphFailedBranchRepairRelation(value)
  if (!parsed) throw new Error("valid v4 relation fixture did not parse")
  return parsed
}

describe("TaskGraph failed-branch relation", () => {
  it("accepts the exact full-request fingerprint and ordered persisted proof identities", () => {
    const parsed = relation()
    expect(parsed).toMatchObject({ schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
      requestFingerprint: digest, observedRevision: 7, resultingRevision: 9,
      failedSource: { event: { idempotencyKey: failedKey } },
      cancellations: [{ event: { idempotencyKey: cancelKey } }],
      verifiedExternalDependencies: [{ dependency: { nodeKey: "foundation" } }] })
    expect(taskGraphFailedBranchRepairFingerprint(input)).toBe(parsed.requestFingerprint)
  })

  it.each([
    ["wrong source attempt key", (value: TaskGraphFailedBranchRepairRelation) => ({ ...value,
      failedSource: { ...value.failedSource, attemptCount: 1 } })],
    ["missing closure cancellation", (value: TaskGraphFailedBranchRepairRelation) => ({ ...value, cancellations: [] })],
    ["external completion after failure", (value: TaskGraphFailedBranchRepairRelation) => ({ ...value,
      verifiedExternalDependencies: [{ ...value.verifiedExternalDependencies[0]!, completedEvent: {
        ...value.verifiedExternalDependencies[0]!.completedEvent, sequence: "22" } }] })],
    ["wrong proposal key", (value: TaskGraphFailedBranchRepairRelation) => ({ ...value,
      planEvent: { ...value.planEvent, idempotencyKey: taskGraphProposalKey("graph-root", 7) } })],
    ["unknown receipt field", (value: TaskGraphFailedBranchRepairRelation) => ({ ...value, cancellationReason: "user" })],
  ])("rejects %s", (_name, mutate) => {
    const parsed = relation()
    expect(parseTaskGraphFailedBranchRepairRelation(mutate(parsed))).toBeNull()
  })

  it("rejects malformed operation key and duplicate or foreign source identities", () => {
    const parsed = relation()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...parsed, operationKey: "agent.plan.reconciliation:sha256:bad" })).toBeNull()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...parsed, sources: [parsed.sources[0], parsed.sources[0]] })).toBeNull()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...parsed, cancellations: [{ ...parsed.cancellations[0],
      source: { ...parsed.cancellations[0]!.source, taskId: "foreign-task" } }] })).toBeNull()
  })

  it("preserves snapshot source order when the branch root is not the first source", () => {
    const valid = relation(), sources = [valid.sources[1]!, valid.sources[0]!]
    const reversed = parseTaskGraphFailedBranchRepairRelation({ ...valid, sources,
      cancellations: [{ ...valid.cancellations[0]!, source: sources[0]!.source }] })
    expect(reversed?.sources.map(item => item.source.nodeKey)).toEqual(["analyst-old", "scout-old"])
    expect(reversed?.cancellations.map(item => item.source.nodeKey)).toEqual(["analyst-old"])
  })

  it("requires one revision per operation-created cancellation before the public plan event", () => {
    const valid = relation()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...valid, resultingRevision: 8 })).toBeNull()
    expect(parseTaskGraphFailedBranchRepairRelation({ ...valid,
      planEvent: { ...valid.planEvent, idempotencyKey: taskGraphProposalKey("graph-root", 7) } })).toBeNull()
  })

  it("changes the fingerprint when any part of the original planning request changes", () => {
    expect(taskGraphFailedBranchRepairFingerprint({ ...input, nodes: [{ ...input.nodes[0], goal: "Changed" }, input.nodes[1] ] }))
      .not.toBe(digest)
    expect(taskGraphFailedBranchRepairFingerprint({ ...input, expectedRevision: input.expectedRevision + 1 })).not.toBe(digest)
    expect(taskGraphFailedBranchRepairFingerprint({ ...input, replaceBranch: { ...replaceBranch, sources: [
      replaceBranch.sources[0]!, { ...replaceBranch.sources[1]!, replacementKey: "different-key" },
    ] } })).not.toBe(digest)
  })
})
