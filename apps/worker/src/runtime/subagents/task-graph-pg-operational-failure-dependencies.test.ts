import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { proveTaskGraphOperationalExternalDependencies, taskGraphOperationalExternalAncestors } from "./task-graph-pg-operational-failure-dependencies.js"
import { taskGraphItemId, taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }] }
const scout: StoredTaskGraphNode = { key: "scout-source", templateId: "scout", taskId: "scout-task", goal: "Find candidates",
  successCriteria: ["Find candidates"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification }
const analyst: StoredTaskGraphNode = { key: "analyst-source", templateId: "analyst", taskId: "analyst-task", goal: "Analyze candidates",
  successCriteria: ["Analyze candidates"], dependsOn: [scout.key], depth: 2, verificationDisposition: "typed", verification: analystVerification }
const graph: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [scout, analyst] }
const digest = "a".repeat(64)
const passedReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
  criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: digest, resultDigest: digest }

function completionEvent(sequence: string) {
  const key = taskGraphLifecycleKey(scope.rootTaskId, scout.key, 1, "task.completed"), id = "completed-scout-event"
  const payload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: scout.key, expectedRevision: 0, idempotencyKey: key }, revision: 1,
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
      turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "running", phase: null,
      revision: 1, content: graph, startedAt: null, completedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId: scout.taskId,
    sequence, type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload,
    turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId, outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId,
    outboxIdempotencyKey: `agent-event:${id}`, outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId,
      itemId: taskGraphItemId(scope.rootTaskId), taskId: scout.taskId, sequence, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: null, idempotencyKey: key, payload } }
}
function clientFor(sequence = "8") {
  const task = { id: scout.taskId, status: "completed", role: "scout", taskType: "job_discovery", attemptCount: 1,
    leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, startedAt: new Date(1), completedAt: new Date(2), closedAt: null,
    interruptRequestedAt: null, failureReason: null, result: { status: "completed", taskGraphVerificationReport: passedReport } }
  const query = vi.fn(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
    ? { rows: [task], rowCount: 1 } : { rows: [completionEvent(sequence)], rowCount: 1 })
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("verified external ancestors for operational failure", () => {
  it("derives the complete external ancestor set and binds passed evidence before failure", async () => {
    expect(taskGraphOperationalExternalAncestors(graph, [analyst])).toEqual([scout])
    const f = clientFor(), proof = await proveTaskGraphOperationalExternalDependencies(f.client,
      { scope, snapshot: graph, sourceNodes: [analyst], failedEventSequence: "10" })
    expect(proof).toMatchObject([{ dependency: { nodeKey: scout.key, taskId: scout.taskId }, attemptCount: 1,
      completedEvent: { sequence: "8", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, scout.key, 1, "task.completed") } }])
    expect(f.query).toHaveBeenCalledTimes(2)
  })

  it("rejects completion after the failed-source event and unknown ancestors", async () => {
    await expect(proveTaskGraphOperationalExternalDependencies(clientFor("11").client,
      { scope, snapshot: graph, sourceNodes: [analyst], failedEventSequence: "10" })).resolves.toBeNull()
    const malformed: TaskGraphSnapshot = { ...graph, nodes: [{ ...analyst, dependsOn: ["missing"] }] }
    const f = clientFor()
    expect(taskGraphOperationalExternalAncestors(malformed, [malformed.nodes[0]!])).toBeNull()
    await expect(proveTaskGraphOperationalExternalDependencies(f.client,
      { scope, snapshot: malformed, sourceNodes: [malformed.nodes[0]!], failedEventSequence: "10" })).resolves.toBeNull()
    expect(f.query).not.toHaveBeenCalled()
  })
})
