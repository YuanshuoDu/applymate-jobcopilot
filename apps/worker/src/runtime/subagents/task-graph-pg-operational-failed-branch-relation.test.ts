import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import {
  parseTaskGraphOperationalFailedBranchRelation,
  parseTaskGraphOperationalFailurePlanNodes,
  TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION,
  taskGraphOperationalFailedBranchFingerprint,
  type TaskGraphOperationalFailedBranchRelation,
} from "./task-graph-pg-operational-failed-branch-relation.js"
import { taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"

const rootTaskId = "root-task"
const mode: TaskGraphOperationalFailureReplacement = { root: { nodeKey: "analyst", taskId: "analyst-task" }, sources: [
  { nodeKey: "analyst", taskId: "analyst-task", replacementKey: "analyst-fresh" },
] }
const nodes = [{ key: "analyst-fresh", templateId: "analyst", goal: "Analyze current evidence", successCriteria: ["Rank the findings"],
  dependsOn: [], verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
    criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }] } }]
const fingerprint = taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 8, replaceOperationalFailure: mode, nodes })
const operationKey = `agent.plan.reconciliation:sha256:${"a".repeat(64)}`
const failedKey = taskGraphLifecycleKey(rootTaskId, "analyst", 2, "task.failed")
const planKey = taskGraphProposalKey(rootTaskId, 8)

function relation(overrides: Record<string, unknown> = {}): TaskGraphOperationalFailedBranchRelation {
  const raw = {
    schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION,
    operationKey, graphRootTaskId: rootTaskId, observedRevision: 8, resultingRevision: 9,
    failedSource: { source: mode.root, attemptCount: 2, failureReason: "child_resume_unavailable", resultDigest: "b".repeat(64),
      event: { id: "failed-event", sequence: "20", idempotencyKey: failedKey } },
    observedGraphEvent: { id: "failed-event", sequence: "20", idempotencyKey: failedKey },
    sources: [{ source: mode.root, replacementKey: "analyst-fresh" }], priorCancellations: [], cancellations: [], verifiedExternalDependencies: [],
    planEvent: { id: "plan-event", sequence: "22", idempotencyKey: planKey }, requestFingerprint: fingerprint,
    agentPlanCall: { callId: "plan-call", stepId: "root-step", expectedRevision: 8, replaceOperationalFailure: mode },
    ...overrides,
  }
  const parsed = parseTaskGraphOperationalFailedBranchRelation(raw)
  if (!parsed) throw new Error("valid operational failure relation fixture did not parse")
  return parsed
}

describe("TaskGraph operational failed-branch relation", () => {
  it("accepts an exact singleton failed leaf with no cancellation receipt", () => {
    const parsed = relation()
    expect(parsed).toMatchObject({ schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION,
      failedSource: { failureReason: "child_resume_unavailable", attemptCount: 2, event: { idempotencyKey: failedKey } },
      sources: [{ source: { nodeKey: "analyst", taskId: "analyst-task" } }], cancellations: [], resultingRevision: 9 })
    expect(taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 8, replaceOperationalFailure: mode, nodes })).toBe(fingerprint)
  })

  it("accepts the fixed server deadline reason in the existing relation shape", () => {
    const parsed = parseTaskGraphOperationalFailedBranchRelation({
      ...relation(), failedSource: { ...relation().failedSource, failureReason: "task_graph_child_deadline_exceeded" },
    })
    expect(parsed?.failedSource.failureReason).toBe("task_graph_child_deadline_exceeded")
  })

  it("accepts a full closure whose prior dependency cancellation is the observed graph witness", () => {
    const closureMode: TaskGraphOperationalFailureReplacement = { root: { nodeKey: "scout", taskId: "scout-task" }, sources: [
      { nodeKey: "scout", taskId: "scout-task", replacementKey: "scout-fresh" },
      { nodeKey: "analyst", taskId: "analyst-task", replacementKey: "analyst-fresh" },
    ] }
    const sourceBindings = closureMode.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey }))
    const raw = {
      ...relation(), observedRevision: 9, resultingRevision: 10,
      failedSource: { ...relation().failedSource, source: closureMode.root,
        event: { id: "failed-event", sequence: "20", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "scout", 2, "task.failed") } },
      observedGraphEvent: { id: "analyst-cancel", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") },
      sources: sourceBindings,
      priorCancellations: [{ source: { nodeKey: "analyst", taskId: "analyst-task" }, event: {
        id: "analyst-cancel", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") } }],
      cancellations: [],
      planEvent: { id: "plan-event", sequence: "23", idempotencyKey: taskGraphProposalKey(rootTaskId, 9) },
      agentPlanCall: { callId: "plan-call", stepId: "root-step", expectedRevision: 9, replaceOperationalFailure: closureMode },
    }
    const parsed = parseTaskGraphOperationalFailedBranchRelation(raw)
    expect(parsed?.priorCancellations.map(item => item.source.nodeKey)).toEqual(["analyst"])
    expect(parsed?.cancellations).toEqual([])
    expect(parsed?.resultingRevision).toBe(10)
  })

  it("accepts split prior and new cancellations and counts only new writes in the resulting revision", () => {
    const threeSourceMode: TaskGraphOperationalFailureReplacement = { root: { nodeKey: "scout", taskId: "scout-task" }, sources: [
      { nodeKey: "scout", taskId: "scout-task", replacementKey: "scout-fresh" },
      { nodeKey: "analyst", taskId: "analyst-task", replacementKey: "analyst-fresh" },
      { nodeKey: "analyst-2", taskId: "analyst-task-2", replacementKey: "analyst-2-fresh" },
    ] }
    const raw = {
      ...relation(), observedRevision: 9, resultingRevision: 11,
      failedSource: { ...relation().failedSource, source: threeSourceMode.root,
        event: { id: "failed-event", sequence: "20", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "scout", 2, "task.failed") } },
      observedGraphEvent: { id: "analyst-cancel", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") },
      sources: threeSourceMode.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
      priorCancellations: [{ source: { nodeKey: "analyst", taskId: "analyst-task" }, event: {
        id: "analyst-cancel", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") } }],
      cancellations: [{ source: { nodeKey: "analyst-2", taskId: "analyst-task-2" }, event: {
        id: "analyst-2-cancel", sequence: "23", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst-2", 0, "task.cancelled") } }],
      planEvent: { id: "plan-event", sequence: "24", idempotencyKey: taskGraphProposalKey(rootTaskId, 10) },
      agentPlanCall: { callId: "plan-call", stepId: "root-step", expectedRevision: 9, replaceOperationalFailure: threeSourceMode },
    }
    const parsed = parseTaskGraphOperationalFailedBranchRelation(raw)
    expect(parsed?.priorCancellations.map(item => item.source.nodeKey)).toEqual(["analyst"])
    expect(parsed?.cancellations.map(item => item.source.nodeKey)).toEqual(["analyst-2"])
    expect(parsed?.resultingRevision).toBe(11)
  })

  it.each([
    ["a failed source that is not the operation root", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, failedSource: { ...value.failedSource, source: { nodeKey: "scout", taskId: "scout-task" } },
    })],
    ["a model supplied failure reason", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, failedSource: { ...value.failedSource, failureReason: "task_graph_verification_unverified" },
    })],
    ["a cancellation of the failed root", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, cancellations: [{ source: value.failedSource.source, event: {
        id: "cancel-event", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") } }],
    })],
    ["a non-covering prior and new cancellation partition", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, priorCancellations: [{ source: value.failedSource.source, event: value.observedGraphEvent }],
    })],
    ["a prior cancellation after the observed graph event", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, priorCancellations: [{ source: value.failedSource.source, event: {
        id: "prior-cancel", sequence: "21", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") } }],
    })],
    ["a new cancellation before the observed graph event", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, cancellations: [{ source: value.failedSource.source, event: {
        id: "new-cancel", sequence: "19", idempotencyKey: taskGraphLifecycleKey(rootTaskId, "analyst", 0, "task.cancelled") } }],
    })],
    ["an observed event before the failure", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, observedGraphEvent: { id: "older", sequence: "19", idempotencyKey: "other-event" },
    })],
    ["a changed attempt identity", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, failedSource: { ...value.failedSource, attemptCount: 1 },
    })],
    ["a wrong plan revision key", (value: TaskGraphOperationalFailedBranchRelation) => ({
      ...value, planEvent: { ...value.planEvent, idempotencyKey: taskGraphProposalKey(rootTaskId, 7) },
    })],
    ["an extra relation field", (value: TaskGraphOperationalFailedBranchRelation) => ({ ...value, modelReason: "forged" })],
  ])("rejects %s", (_name, mutate) => {
    expect(parseTaskGraphOperationalFailedBranchRelation(mutate(relation()))).toBeNull()
  })

  it("rejects sparse, accessor-backed, and symbol-bearing proof arrays without invoking accessors", () => {
    const valid = relation(), sparse = new Array(1)
    expect(parseTaskGraphOperationalFailedBranchRelation({ ...valid, sources: sparse })).toBeNull()
    let getterCalls = 0
    const accessor = [{ source: valid.sources[0]!.source, replacementKey: valid.sources[0]!.replacementKey }]
    Object.defineProperty(accessor, "0", { enumerable: true, get() { getterCalls += 1; return valid.sources[0] } })
    expect(parseTaskGraphOperationalFailedBranchRelation({ ...valid, sources: accessor })).toBeNull()
    const symbolArray = [...valid.sources]
    Object.defineProperty(symbolArray, Symbol("hidden"), { value: true })
    expect(parseTaskGraphOperationalFailedBranchRelation({ ...valid, sources: symbolArray })).toBeNull()
    expect(getterCalls).toBe(0)
  })

  it("uses planner normalization for the full request fingerprint", () => {
    const normalized = taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 8,
      replaceOperationalFailure: mode, nodes, rootSuccessCriteria: [" Keep scope ", "Keep scope"] })
    expect(taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 8,
      replaceOperationalFailure: mode, nodes, rootSuccessCriteria: ["Keep scope"] })).toBe(normalized)
    expect(taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 9,
      replaceOperationalFailure: mode, nodes })).not.toBe(fingerprint)
    expect(taskGraphOperationalFailedBranchFingerprint({ rootTaskId, expectedRevision: 8,
      replaceOperationalFailure: mode, nodes, rootSuccessCriteria: ["Different scope"] })).not.toBe(fingerprint)
  })

  it("parses persisted replacement nodes as exact typed planner inputs", () => {
    expect(parseTaskGraphOperationalFailurePlanNodes(nodes)).toEqual(nodes)
    expect(parseTaskGraphOperationalFailurePlanNodes([{ ...nodes[0], repairOf: { nodeKey: "old", taskId: "old-task", criterionIds: ["x"] } }])).toBeNull()
    expect(parseTaskGraphOperationalFailurePlanNodes([{ ...nodes[0], extra: true }])).toBeNull()
    expect(parseTaskGraphOperationalFailurePlanNodes([{ ...nodes[0], verification: { ...nodes[0].verification, role: "scout" } }])).toBeNull()
  })
})
