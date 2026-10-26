import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { proveTaskGraphOperationalFailureCancellations } from "./task-graph-pg-operational-failure-cancellations.js"
import { taskGraphItemId, taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphBranchSourceRow } from "./task-graph-pg-branch-repair.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const scope: GraphIdentityScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "jobs", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const root: StoredTaskGraphNode = { key: "failed-scout", taskId: "failed-task", templateId: "scout", goal: "Find roles",
  successCriteria: ["Find one role"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification }
const child: StoredTaskGraphNode = { key: "waiting-analyst", taskId: "child-task", templateId: "analyst", goal: "Score roles",
  successCriteria: ["Score one role"], dependsOn: [root.key], depth: 2, verificationDisposition: "legacy_unverified" }
const graph: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [root, child] }
const key = taskGraphLifecycleKey(scope.rootTaskId, child.key, 0, "task.cancelled")

function sourceRow(changes: Row = {}): TaskGraphBranchSourceRow {
  return { id: child.taskId, status: "cancelled", attemptCount: 0, failureReason: "A prerequisite task did not complete.",
    leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, startedAt: null, completedAt: new Date(20), closedAt: null,
    interruptRequestedAt: null, result: null, confidence: null, qualityGateResult: null, contextSnapshotId: null,
    outputArtifactIds: [], hasCanonicalDispatch: false, ...changes }
}
function eventRow(changes: Row = {}): Row {
  const id = "cancel-event", seq = "11"
  const event = { type: "task.cancelled", nodeKey: child.key, expectedRevision: 3, idempotencyKey: key }
  const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null,
    revision: 4, content: graph, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" }
  const payload = { kind: "lifecycle", event, revision: 4, item }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId: child.taskId,
    sequence: seq, type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload,
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId,
    outboxIdempotencyKey: `agent-event:${id}`, outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId,
      itemId: taskGraphItemId(scope.rootTaskId), taskId: child.taskId, sequence: seq, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload }, eventCount: 1, hasOtherEvidence: false, ...changes }
}
function rootWait(changes: Row = {}): Row {
  const targetTaskIds = [child.taskId, root.taskId].sort()
  const tasks = targetTaskIds.map(taskId => taskId === child.taskId
    ? { taskId, status: "cancelled", role: "analyst", result: null, failureReason: null }
    : { taskId, status: "failed", role: "scout", result: null, failureReason: "source failed" })
  return { id: "root-wait", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, stepId: "root-step", idempotencyKey: "wait-call", targetTaskIds, mode: "all", status: "ready", matchedTaskIds: targetTaskIds,
    createdAt: new Date(10), deadlineAt: new Date(1010), resolvedAt: new Date(30), suspendedAt: new Date(20), consumedAt: new Date(40),
    result: { request: { targetTaskIds, mode: "all", timeoutMs: 1000 }, outcome: { waitId: "root-wait", status: "ready",
      matchedTaskIds: targetTaskIds, targetTaskIds, tasks } },
    sessionUserId: scope.userId, parentId: scope.rootTaskId, parentSessionId: scope.sessionId, parentTurnId: scope.turnId,
    parentRootTaskId: scope.rootTaskId, parentParentTaskId: null, parentRole: "orchestrator", parentTaskType: "root",
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, resolvedStepId: changes.stepId ?? "root-step",
    stepTaskId: scope.rootTaskId, stepAttempt: 1, ...changes }
}
function fixture(event: Row | null = eventRow(), row: TaskGraphBranchSourceRow = sourceRow(), waits: readonly Row[] = []) {
  const targetRows = [
    { id: child.taskId, rootTaskId: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId,
      status: "cancelled", role: "analyst", userId: scope.userId, attemptCount: 0,
      failureReason: "A prerequisite task did not complete.", startedAt: null, leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: null, completedAt: new Date(20), closedAt: null, interruptRequestedAt: null, result: null,
      confidence: null, qualityGateResult: null, contextSnapshotId: null, outputArtifactIds: [], hasCanonicalDispatch: false },
    { id: root.taskId, rootTaskId: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId,
      status: "failed", role: "scout", userId: scope.userId, attemptCount: 2,
      failureReason: "child_resume_unavailable", startedAt: new Date(1), leaseOwner: null, result: null },
  ]
  const query = vi.fn(async (sql: string) => sql.includes('FROM "agent_wait_conditions" wait')
    ? { rows: [...waits], rowCount: waits.length }
    : sql.includes('SELECT task."id", task."rootTaskId"')
      ? { rows: targetRows.filter(target => waits.some(wait => Array.isArray(wait.targetTaskIds) && wait.targetTaskIds.includes(target.id))), rowCount: targetRows.length }
      : sql.includes('SELECT task."id"') ? { rows: [row], rowCount: 1 }
        : { rows: event ? [event] : [], rowCount: event ? 1 : 0 })
  const client: Client = { query: query as unknown as Client["query"] }
  return { client, query, input: { scope, failureGraph: graph, failureSequence: "10", observedSequence: "12",
    sourceNodes: [root, child], failedNode: root } }
}

describe("proveTaskGraphOperationalFailureCancellations", () => {
  it("accepts only the exact automatic pristine dependency cancellation", async () => {
    const f = fixture()
    await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toEqual([{
      source: { nodeKey: child.key, taskId: child.taskId },
      event: { id: "cancel-event", sequence: "11", idempotencyKey: key },
    }])
    expect(f.query).toHaveBeenCalledTimes(3)
  })

  it("accepts multiple consumed Root all-waits that recorded the automatic cancellation", async () => {
    const first = rootWait(), second = rootWait({ id: "root-wait-2", stepId: "root-step-2" })
    for (const wait of [first, second]) (wait.result as Row).outcome = { ...((wait.result as Row).outcome as Row), waitId: wait.id }
    const f = fixture(eventRow(), sourceRow(), [first, second])
    await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toEqual([{
      source: { nodeKey: child.key, taskId: child.taskId }, event: { id: "cancel-event", sequence: "11", idempotencyKey: key },
    }])
  })

  it("rejects unresolved, malformed, and child-owned wait references", async () => {
    for (const wait of [
      rootWait({ status: "waiting", resolvedAt: null, consumedAt: null }),
      rootWait({ consumedAt: null }),
      rootWait({ matchedTaskIds: [root.taskId] }),
      rootWait({ parentTaskId: child.taskId, parentId: child.taskId, parentParentTaskId: scope.rootTaskId,
        parentRole: "analyst", parentTaskType: "analyst" }),
      rootWait({ sessionId: "foreign-session" }),
      rootWait({ stepTaskId: child.taskId }),
    ]) {
      const f = fixture(eventRow(), sourceRow(), [wait])
      await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toBeNull()
    }
    const pendingRow = sourceRow({ status: "waiting", failureReason: null, completedAt: null })
    const pending = fixture(null, pendingRow, [rootWait({ status: "waiting", resolvedAt: null, consumedAt: null })])
    await expect(proveTaskGraphOperationalFailureCancellations(pending.client, pending.input)).resolves.toBeNull()
  })

  it("rejects other cancellation causes, activity, event ambiguity, and broken receipts", async () => {
    const otherCause = fixture(eventRow(), sourceRow({ failureReason: "A prerequisite task was not verified." }))
    await expect(proveTaskGraphOperationalFailureCancellations(otherCause.client, otherCause.input)).resolves.toEqual([])
    for (const mutation of [
      { eventCount: 2 }, { hasOtherEvidence: true }, { payload: { kind: "other" } },
      { outboxPayload: {} }, { sequence: "10" },
    ]) {
      const f = fixture(eventRow(mutation))
      await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toBeNull()
    }
    const lateEvent = eventRow({ sequence: "13" })
    ;(lateEvent.outboxPayload as Row).sequence = "13"
    const late = fixture(lateEvent)
    await expect(proveTaskGraphOperationalFailureCancellations(late.client, late.input)).resolves.toBeNull()
    const artifact = fixture(eventRow(), sourceRow({ outputArtifactIds: ["artifact"] }))
    await expect(proveTaskGraphOperationalFailureCancellations(artifact.client, artifact.input)).resolves.toBeNull()
  })

  it("leaves non-cancelled descendants for the transactional cancellation path", async () => {
    const f = fixture(null, sourceRow({ status: "waiting", failureReason: null, completedAt: null }))
    await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toEqual([])
    expect(f.query).toHaveBeenCalledTimes(2)
  })

  it("does not relabel the replacement transaction's later cancellations as prior failures", async () => {
    const f = fixture(eventRow(), sourceRow({ failureReason: null }))
    await expect(proveTaskGraphOperationalFailureCancellations(f.client, f.input)).resolves.toEqual([])
    expect(f.query).toHaveBeenCalledTimes(2)
  })
})
