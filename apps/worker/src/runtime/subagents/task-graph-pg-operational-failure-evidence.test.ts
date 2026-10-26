import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
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

function failureEvent(reason = "child_resume_unavailable", sequence = "10"): Row {
  const key = taskGraphLifecycleKey(scope.rootTaskId, node.key, 2, "task.failed"), id = "failure-event"
  const payload = { kind: "lifecycle", event: { type: "task.failed", nodeKey: node.key, expectedRevision: 0,
    idempotencyKey: key, failureReason: reason }, revision: 1,
  item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "running", phase: null,
    revision: 1, content: graph, startedAt: null, completedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId: node.taskId,
    sequence, type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload,
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId,
    outboxIdempotencyKey: `agent-event:${id}`, outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId,
      itemId: taskGraphItemId(scope.rootTaskId), taskId: node.taskId, sequence, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload } }
}
function failedRow(reason = "child_resume_unavailable") {
  return { id: node.taskId, status: "failed", role: "scout", taskType: "job_discovery", attemptCount: 2,
    leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, startedAt: new Date(1), completedAt: new Date(2),
    closedAt: null, interruptRequestedAt: null, failureReason: reason,
    result: { workerResult: null, taskGraphVerificationReport: failedReport }, confidence: null, qualityGateResult: null,
    contextSnapshotId: null, outputArtifactIds: [], hasExecutionEvidence: true }
}
function clientFor(eventRow: Row | null) {
  const query = vi.fn(async (sql: string) => sql.includes('FROM "agent_events" AS event JOIN "agent_sessions"')
    ? { rows: eventRow ? [eventRow] : [], rowCount: eventRow ? 1 : 0 } : { rows: [], rowCount: 0 })
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("proveTaskGraphOperationalFailureEvidence", () => {
  it.each(["child_resume_unavailable", "child_resume_evidence_unavailable"] as const)("proves the exact current-attempt %s leaf", async reason => {
    const f = clientFor(failureEvent(reason)), proof = await proveTaskGraphOperationalFailureEvidence(f.client,
      { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow(reason) })
    expect(proof?.failedSource).toMatchObject({ source: { nodeKey: "source", taskId: "source-task" }, attemptCount: 2, failureReason: reason })
    expect(proof?.verifiedExternalDependencies).toEqual([])
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("rejects prior-attempt, category-only, role/task-type, and forged model-result evidence", async () => {
    const client = clientFor(failureEvent()).client
    const base = { scope, snapshot: graph, sourceNodes: [node], failedNode: node, failedRow: failedRow() }
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, attemptCount: 1 } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, failureReason: "task_graph_verification_unverified" } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, taskType: "job_analysis" } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalFailureEvidence(client, { ...base, failedRow: { ...base.failedRow, result: { workerResult: { status: "completed" }, taskGraphVerificationReport: failedReport } } })).resolves.toBeNull()
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
    const missing = clientFor(null)
    await expect(proveTaskGraphOperationalFailureEvidence(missing.client, base)).resolves.toBeNull()
    const wrongReason = clientFor(failureEvent("child_resume_evidence_unavailable"))
    await expect(proveTaskGraphOperationalFailureEvidence(wrongReason.client, base)).resolves.toBeNull()
    const brokenOutbox = failureEvent(); brokenOutbox.outboxPayload = {}
    await expect(proveTaskGraphOperationalFailureEvidence(clientFor(brokenOutbox).client, base)).resolves.toBeNull()
  })
})
