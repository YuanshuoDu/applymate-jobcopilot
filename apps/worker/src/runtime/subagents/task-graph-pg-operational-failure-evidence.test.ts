import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import { proveTaskGraphOperationalFailureEvidence } from "./task-graph-pg-operational-failure-evidence.js"
import { taskGraphItemId, taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

type Row = Record<string, unknown>
const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const node: StoredTaskGraphNode = { key: "source", templateId: "scout", taskId: "source-task", goal: "Find candidates",
  successCriteria: ["Find candidates"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification }
const graph: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node] }
const failedReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
  criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null }

function lifecycleEvent(type: "task.started" | "task.failed", sequence: string, reason?: string, currentNode = node,
  currentGraph: TaskGraphSnapshot = graph, attemptCount = 2): Row {
  const key = taskGraphLifecycleKey(scope.rootTaskId, currentNode.key, attemptCount, type), id = `${type}-event`
  const event = type === "task.failed" ? { type, nodeKey: currentNode.key, expectedRevision: 0,
    idempotencyKey: key, failureReason: reason } : { type, nodeKey: currentNode.key, expectedRevision: 0, idempotencyKey: key }
  const payload = { kind: "lifecycle", event, revision: 1,
  item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "running", phase: null,
    revision: 1, content: currentGraph, startedAt: null, completedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId: currentNode.taskId,
    sequence, type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload,
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId,
    outboxIdempotencyKey: `agent-event:${id}`, outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId,
      itemId: taskGraphItemId(scope.rootTaskId), taskId: currentNode.taskId, sequence, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload } }
}
function failureEvent(reason = "child_resume_unavailable", sequence = "10", currentNode = node,
  currentGraph: TaskGraphSnapshot = graph): Row {
  return lifecycleEvent("task.failed", sequence, reason, currentNode, currentGraph)
}
function startedEvent(sequence = "5", attemptCount = 2, currentNode = node, currentGraph: TaskGraphSnapshot = graph): Row {
  return lifecycleEvent("task.started", sequence, undefined, currentNode, currentGraph, attemptCount)
}
function failedRow(reason = "child_resume_unavailable") {
  return { id: node.taskId, status: "failed", role: "scout", taskType: "job_discovery", attemptCount: 2,
    leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, startedAt: new Date(1), completedAt: new Date(2),
    closedAt: null, interruptRequestedAt: null, failureReason: reason,
    result: { workerResult: null, taskGraphVerificationReport: failedReport }, confidence: null, qualityGateResult: null,
    contextSnapshotId: null, outputArtifactIds: [], hasExecutionEvidence: true }
}
function clientForRows(eventRows: Row[], deadlineRows: Row[]) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const matching = sql.includes('FROM "agent_events" AS event JOIN "agent_sessions"')
      ? eventRows.filter(event => event.idempotencyKey === values?.[1] || event.respondsToKey === values?.[1])
      : sql.includes('SELECT task."absoluteDeadlineAt"') ? deadlineRows : []
    return { rows: matching, rowCount: matching.length }
  })
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> }
}
function clientFor(...eventRows: Row[]) {
  return clientForRows(eventRows, [{ absoluteDeadlineAt: new Date(1), completedAt: new Date(2), checkedAt: new Date(3) }])
}
function clientForDeadline(deadlineRow: Row | null, ...eventRows: Row[]) {
  return clientForRows(eventRows, deadlineRow ? [deadlineRow] : [])
}

describe("proveTaskGraphOperationalFailureEvidence", () => {
  it.each(["child_resume_unavailable", "child_resume_evidence_unavailable"] as const)("proves the exact current-attempt %s leaf", async reason => {
    const f = clientFor(failureEvent(reason)), proof = await proveTaskGraphOperationalFailureEvidence(f.client,
      { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow(reason) })
    expect(proof?.failedSource).toMatchObject({ source: { nodeKey: "source", taskId: "source-task" }, attemptCount: 2, failureReason: reason })
    expect(proof?.verifiedExternalDependencies).toEqual([])
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("accepts the persisted no-result resume envelope after JSON drops undefined workerResult", async () => {
    const f = clientFor(failureEvent())
    const task = { ...failedRow(), result: { taskGraphVerificationReport: failedReport } }
    const proof = await proveTaskGraphOperationalFailureEvidence(f.client,
      { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: task })
    expect(proof?.failedSource).toMatchObject({ failureReason: "child_resume_unavailable", resultDigest: expect.any(String) })
  })

  it("proves deadline replacement only from the exact current-attempt started receipt before failure", async () => {
    const f = clientFor(startedEvent(), failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON))
    const proof = await proveTaskGraphOperationalFailureEvidence(f.client,
      { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON) })
    expect(proof?.failedSource).toMatchObject({ attemptCount: 2, failureReason: TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON,
      event: { id: "task.failed-event", sequence: "10" } })
    expect(f.query).toHaveBeenCalledTimes(3)

    const deadlineInput = { scope, snapshot: graph, sourceNodes: [node], failedNode: node,
      failedRow: failedRow(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON) }
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(startedEvent("11"), failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const wrongAttemptStart = { ...startedEvent("5", 1), respondsToKey: taskGraphLifecycleKey(scope.rootTaskId, node.key, 2, "task.started") }
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(wrongAttemptStart, failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const foreignStart = startedEvent()
    foreignStart.turnUserId = "another-user"
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(foreignStart, failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const foreignNode: StoredTaskGraphNode = { ...node, key: "other-source", taskId: "other-task" }
    const foreignGraph: TaskGraphSnapshot = { ...graph, nodes: [foreignNode] }
    const wrongTaskStart = { ...startedEvent("5", 2, foreignNode, foreignGraph),
      respondsToKey: taskGraphLifecycleKey(scope.rootTaskId, node.key, 2, "task.started") }
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(wrongTaskStart, failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const wrongItemStart = startedEvent()
    wrongItemStart.itemId = "foreign-task-graph-item"
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(wrongItemStart, failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const unoutboxedStart = startedEvent()
    unoutboxedStart.outboxPayload = {}
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(unoutboxedStart, failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      deadlineInput)).resolves.toBeNull()
    const malformedReport = { ...failedReport, criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: null }] }
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(startedEvent(), failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)).client,
      { ...deadlineInput, failedRow: { ...deadlineInput.failedRow,
        result: { workerResult: null, taskGraphVerificationReport: malformedReport } } })).resolves.toBeNull()
    const validReceipts = [startedEvent(), failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON)]
    for (const invalidTimer of [
      { absoluteDeadlineAt: null, completedAt: new Date(200), checkedAt: new Date(300) },
      { absoluteDeadlineAt: new Date(400), completedAt: new Date(500), checkedAt: new Date(300) },
      { absoluteDeadlineAt: new Date(100), completedAt: new Date(50), checkedAt: new Date(300) },
    ]) {
      await expect(proveTaskGraphOperationalFailureEvidence(clientForDeadline(invalidTimer, ...validReceipts).client,
        deadlineInput)).resolves.toBeNull()
    }
    await expect(proveTaskGraphOperationalFailureEvidence(clientForDeadline(null, ...validReceipts).client,
      deadlineInput)).resolves.toBeNull()
  })

  it("admits the same bounded deadline proof for a typed Analyst", async () => {
    const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }] }
    const analyst: StoredTaskGraphNode = { ...node, key: "analysis", templateId: "analyst", taskId: "analysis-task",
      verificationDisposition: "typed", verification: analystVerification }
    const analystGraph: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [analyst] }
    const analystReport = { ...failedReport, criteria: [{ criterionId: "finding-count", status: "unverified", reasonCode: "result_invalid" }] }
    const f = clientFor(startedEvent("5", 2, analyst, analystGraph),
      failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON, "10", analyst, analystGraph))
    const proof = await proveTaskGraphOperationalFailureEvidence(f.client, { scope, snapshot: analystGraph,
      sourceNodes: [analyst], failedNode: analyst, failedRow: { ...failedRow(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON),
        id: analyst.taskId, role: "analyst", taskType: "job_analysis", result: { workerResult: null, taskGraphVerificationReport: analystReport } } })
    expect(proof?.failedSource).toMatchObject({ source: { nodeKey: "analysis", taskId: "analysis-task" },
      failureReason: TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON, attemptCount: 2 })
  })

  it("does not make an expired scheduled Gate eligible even when it had started", async () => {
    const gate: StoredTaskGraphNode = { key: "gate", templateId: "gate", taskId: "gate-task", goal: "Wait for approval",
      successCriteria: ["Approval is recorded"], dependsOn: [], depth: 1, verificationDisposition: "specialized" }
    const gateGraph: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [gate] }
    const row = { ...failedRow(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON), id: gate.taskId, role: "prepare", taskType: "scheduled_taskgraph_gate" }
    const f = clientFor(startedEvent("5", 2, gate, gateGraph), failureEvent(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON, "10", gate, gateGraph))
    await expect(proveTaskGraphOperationalFailureEvidence(f.client,
      { scope, snapshot: gateGraph, sourceNodes: [gate], failedNode: gate, failedRow: row })).resolves.toBeNull()
    expect(f.query).not.toHaveBeenCalled()
  })

  it("rejects prior-attempt, category-only, role/task-type, and forged model-result evidence", async () => {
    const client = clientFor(failureEvent()).client
    const base = { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow() }
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, attemptCount: 1 } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, failureReason: "task_graph_verification_unverified" } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, taskType: "job_analysis" } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, result: { workerResult: { status: "completed" }, taskGraphVerificationReport: failedReport } } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, result: {
      workerResult: null, taskGraphVerificationReport: failedReport, rawOutput: "extra" } } })).resolves.toBeNull()
  })

  it("binds the failed closure to its failure-time graph while tolerating unrelated later nodes", async () => {
    const unrelated: StoredTaskGraphNode = { key: "later", templateId: "analyst", taskId: "later-task", goal: "Later work",
      successCriteria: ["Score one role"], dependsOn: [], depth: 1, verificationDisposition: "legacy_unverified" }
    const current = { ...graph, nodes: [node, unrelated] }, f = clientFor(failureEvent())
    const proof = await proveTaskGraphOperationalFailureEvidence(f.client, { scope, snapshot: current, sourceNodes: [node],
      failedNode: node, failedRow: failedRow() })
    expect(proof?.failureGraph).toEqual(graph)
    await expect(proveTaskGraphOperationalFailureEvidence(f.client, { scope, snapshot: current,
      sourceNodes: [{ ...node, goal: "Changed after the failure" }], failedNode: node, failedRow: failedRow() })).resolves.toBeNull()
  })

  it("rejects a missing, mismatched, or un-outboxed exact failure event", async () => {
    const base = { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow() }
    const missing = clientFor()
    await expect(proveTaskGraphOperationalFailureEvidence(missing.client, base)).resolves.toBeNull()
    const wrongReason = clientFor(failureEvent("child_resume_evidence_unavailable"))
    await expect(proveTaskGraphOperationalFailureEvidence(wrongReason.client, base)).resolves.toBeNull()
    const brokenOutbox = failureEvent(); brokenOutbox.outboxPayload = {}
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(brokenOutbox).client, base)).resolves.toBeNull()
  })
})
