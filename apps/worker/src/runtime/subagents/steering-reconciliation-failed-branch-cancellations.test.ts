import type { PoolClient } from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { verifyTaskGraphFailedBranchCancellationHistory } from "./steering-reconciliation-failed-branch-cancellations.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION,
  type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  type TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"

type Row = Record<string, unknown>
const scope: GraphIdentityScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }] }
const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, rootSuccessCriteria: ["Keep the objective"], nodes: [
  { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Search", successCriteria: ["Find roles"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification: scoutVerification },
  { key: "analyst-a", taskId: "analyst-a-task", templateId: "analyst", goal: "Analyze A", successCriteria: ["Rank"], dependsOn: ["scout"], depth: 2,
    verificationDisposition: "typed", verification: analystVerification },
  { key: "analyst-b", taskId: "analyst-b-task", templateId: "analyst", goal: "Analyze B", successCriteria: ["Compare"], dependsOn: ["analyst-a"], depth: 3,
    verificationDisposition: "typed", verification: analystVerification },
] }
const replaceBranch: TaskGraphBranchReplacement = { root: { nodeKey: "scout", taskId: "scout-task" }, sources: [
  { nodeKey: "scout", taskId: "scout-task", replacementKey: "scout-new" },
  { nodeKey: "analyst-a", taskId: "analyst-a-task", replacementKey: "analyst-a-new" },
  { nodeKey: "analyst-b", taskId: "analyst-b-task", replacementKey: "analyst-b-new" },
] }
const failedEvent = { id: "failed-event", sequence: "10", idempotencyKey: taskGraphLifecycleKey("root", "scout", 1, "task.failed") }
const cancellationEvents = [
  { id: "cancel-a", sequence: "21", idempotencyKey: taskGraphLifecycleKey("root", "analyst-a", 0, "task.cancelled") },
  { id: "cancel-b", sequence: "22", idempotencyKey: taskGraphLifecycleKey("root", "analyst-b", 0, "task.cancelled") },
]
const observedItemStepId = "prior-plan-step"
const relation: TaskGraphFailedBranchRepairRelation = {
  schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  operationKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`, graphRootTaskId: "root", observedRevision: 4, resultingRevision: 7,
  branchRoot: replaceBranch.root,
  sources: replaceBranch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
  failedSource: { source: replaceBranch.root, attemptCount: 1, resultDigest: "b".repeat(64), reportDigest: "c".repeat(64), event: failedEvent },
  cancellations: [
    { source: { nodeKey: "analyst-a", taskId: "analyst-a-task" }, event: cancellationEvents[0]! },
    { source: { nodeKey: "analyst-b", taskId: "analyst-b-task" }, event: cancellationEvents[1]! },
  ],
  verifiedExternalDependencies: [],
  planEvent: { id: "plan-event", sequence: "23", idempotencyKey: taskGraphProposalKey("root", 6) },
  requestFingerprint: "d".repeat(64),
  agentPlanCall: { callId: "call", stepId: "step", expectedRevision: 4, replaceBranch },
}

function lifecycleRow(id: string, sequence: string, key: string, nodeKey: string, taskId: string, expectedRevision: number): Row {
  const payload = { kind: "lifecycle", revision: expectedRevision + 1,
    event: { type: "task.cancelled", nodeKey, expectedRevision, idempotencyKey: key },
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
      turnId: scope.turnId, stepId: observedItemStepId, taskId: scope.rootTaskId, type: "task_graph", revision: expectedRevision + 1, content: snapshot } }
  const row = { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId,
    sequence, type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: "step", idempotencyKey: key, payload,
    sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId }
  return { ...row, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${id}`,
    outboxPayload: { eventId: id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
      sequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
      idempotencyKey: key, payload } }
}

function fixture() {
  const events = [lifecycleRow("cancel-a", "21", cancellationEvents[0]!.idempotencyKey, "analyst-a", "analyst-a-task", 4),
    lifecycleRow("cancel-b", "22", cancellationEvents[1]!.idempotencyKey, "analyst-b", "analyst-b-task", 5)]
  const tasks: Row[] = ["analyst-a-task", "analyst-b-task"].map((id, index) => ({ id, role: "analyst", status: "cancelled", attemptCount: 0,
    leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, startedAt: null, completedAt: new Date(0), closedAt: null,
    interruptRequestedAt: null, failureReason: null, result: null, confidence: null, qualityGateResult: null, contextSnapshotId: null,
    outputArtifactIds: [], sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId,
    sourceNodeKey: index === 0 ? "analyst-a" : "analyst-b" }))
  const evidenceState = { wait: false, dispatch: false }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT task."id", task."role"')) return { rows: tasks, rowCount: tasks.length }
    if (sql.includes('AS "hasExecutionEvidence"')) return { rows: tasks.map(task => ({ id: task.id,
      hasExecutionEvidence: false, hasWaitEvidence: evidenceState.wait, hasDispatch: evidenceState.dispatch })), rowCount: tasks.length }
    throw new Error("unexpected cancellation history query")
  })
  return { events, tasks, query, evidenceState, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("failed-branch operation cancellation history", () => {
  it("accepts exact post-call cancellation receipts and requires clean retained rows with dispatch removed", async () => {
    const f = fixture()
    await expect(verifyTaskGraphFailedBranchCancellationHistory(f.client, scope, relation, snapshot, observedItemStepId, 20n, f.events)).resolves.toBe(true)
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls[1]?.[0]).toContain("agent.subagent.dispatch")
  })

  it.each([
    ["an event before the original call", (f: ReturnType<typeof fixture>) => { f.events[0]!.sequence = "19" }],
    ["a cancellation caused by another step", (f: ReturnType<typeof fixture>) => { f.events[0]!.causationId = "other-step" }],
    ["a skipped revision", (f: ReturnType<typeof fixture>) => {
      const row = f.events[1]!, payload = row.payload as Row
      row.payload = { ...payload, revision: 7, event: { ...(payload.event as Row), expectedRevision: 6 } }
    }],
    ["a present cancellation bound to another task", (f: ReturnType<typeof fixture>) => { f.events[0]!.taskId = "foreign-task" }],
    ["a lifecycle item bound to another prior plan Step", (f: ReturnType<typeof fixture>) => {
      const row = f.events[0]!, payload = row.payload as Row, item = payload.item as Row
      row.payload = { ...payload, item: { ...item, stepId: "foreign-prior-step" } }
      const outbox = row.outboxPayload as Row
      row.outboxPayload = { ...outbox, payload: row.payload }
    }],
    ["a missing outbox mirror", (f: ReturnType<typeof fixture>) => { delete f.events[0]!.outboxPayload }],
  ])("rejects %s", async (_name, mutate) => {
    const f = fixture(); mutate(f)
    await expect(verifyTaskGraphFailedBranchCancellationHistory(f.client, scope, relation, snapshot, observedItemStepId, 20n, f.events)).resolves.toBe(false)
  })

  it.each([
    ["a retained execution artifact", (f: ReturnType<typeof fixture>) => { f.tasks[0]!.result = { status: "completed" } }],
    ["an unsettled wait", (f: ReturnType<typeof fixture>) => { f.evidenceState.wait = true }],
    ["a retained dispatch", (f: ReturnType<typeof fixture>) => { f.evidenceState.dispatch = true }],
  ])("rejects %s", async (_name, mutate) => {
    const f = fixture(); mutate(f)
    await expect(verifyTaskGraphFailedBranchCancellationHistory(f.client, scope, relation, snapshot, observedItemStepId, 20n, f.events)).resolves.toBe(false)
  })
})
