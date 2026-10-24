import type { PoolClient } from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { proveTaskGraphFailedBranchEvidence } from "./task-graph-pg-failed-branch-evidence.js"
import { taskGraphItemId, taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

type Row = Record<string, unknown>
const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }] }
const digest = "a".repeat(64)

function node(key: string, templateId: "scout" | "analyst", taskId: string, dependsOn: string[], depth: number): StoredTaskGraphNode {
  return { key, templateId, taskId, goal: `Goal ${key}`, successCriteria: [`Criterion ${key}`], dependsOn, depth,
    verificationDisposition: "typed", verification: templateId === "scout" ? scoutVerification : analystVerification }
}
function snapshot(): TaskGraphSnapshot {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    node("foundation-z", "scout", "foundation-z-task", [], 1),
    node("foundation-a", "analyst", "foundation-a-task", ["foundation-z"], 2),
    node("branch-scout", "scout", "branch-scout-task", ["foundation-a"], 3),
    node("branch-analyst", "analyst", "branch-analyst-task", ["branch-scout", "foundation-a"], 4),
  ] }
}
function report(status: "passed" | "unverified", criterionId = "candidate-count") {
  const reasonCode = status === "passed" ? "criteria_met" : "result_invalid"
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode,
    criteria: [{ criterionId, status, reasonCode }], evidenceDigest: status === "passed" ? digest : null, resultDigest: status === "passed" ? digest : null }
}
function task(id: string, role: string, status: string, attemptCount: number, result: unknown, failureReason: string | null) {
  return { id, role, status, attemptCount, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
    startedAt: status === "cancelled" ? null : new Date("2026-10-24T10:00:00Z"), completedAt: new Date("2026-10-24T10:01:00Z"), closedAt: null,
    interruptRequestedAt: null, failureReason, result, confidence: null, qualityGateResult: null,
    contextSnapshotId: null, outputArtifactIds: [] }
}
function event(nodeKey: string, taskId: string, sequence: number, expectedRevision: number,
  type: "task.completed" | "task.failed" | "task.cancelled", graph: TaskGraphSnapshot): Row & {
    id: string; taskId: string; sequence: string; payload: Row; outboxPayload: Row
  } {
  const attempt = type === "task.cancelled" ? 0 : 1
  const key = taskGraphLifecycleKey(scope.rootTaskId, nodeKey, attempt, type)
  const value = { type, nodeKey, expectedRevision, idempotencyKey: key,
    ...(type === "task.failed" ? { failureReason: "task_graph_verification_unverified" } : {}) }
  const payload = { kind: "lifecycle", event: value, revision: expectedRevision + 1,
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
      turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "running", phase: null,
      revision: expectedRevision + 1, content: graph, startedAt: null, completedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } }
  const id = `${nodeKey}-${type}`
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId), taskId,
    sequence: String(sequence), type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null,
    idempotencyKey: key, payload, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId,
    outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${id}`,
    outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId),
      taskId, sequence: String(sequence), type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null,
      idempotencyKey: key, payload } }
}

function fixture() {
  const graph = snapshot(), scoutReport = report("unverified"), scoutCompletedReport = report("passed"), analystCompletedReport = report("passed", "finding-count")
  const taskRows = [
    task("foundation-z-task", "scout", "completed", 1, { status: "completed", taskGraphVerificationReport: scoutCompletedReport }, null),
    task("foundation-a-task", "analyst", "completed", 1, { status: "completed", taskGraphVerificationReport: analystCompletedReport }, null),
    task("branch-scout-task", "scout", "failed", 1, { status: "failed", taskGraphVerificationReport: scoutReport }, "task_graph_verification_unverified"),
    task("branch-analyst-task", "analyst", "waiting", 0, null, null),
  ]
  const events = [
    event("foundation-z", "foundation-z-task", 10, 0, "task.completed", graph),
    event("foundation-a", "foundation-a-task", 11, 1, "task.completed", graph),
    event("branch-scout", "branch-scout-task", 12, 2, "task.failed", graph),
    event("branch-analyst", "branch-analyst-task", 13, 3, "task.cancelled", graph),
  ]
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions"')) {
      const ids = values?.[0] as string[], rows = taskRows.filter(row => ids.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_events" AS event JOIN "agent_sessions"')) {
      const keys = values?.[1] as string[], rows = events.filter(row => keys.includes(String(row.idempotencyKey)))
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected query ${String(values?.length)}`)
  })
  return { graph, taskRows, events, query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("persisted failed TaskGraph branch evidence", () => {
  it("proves the exact typed failed Scout and transitive verified ancestors without assuming descendant status", async () => {
    const f = fixture(), sourceNodes = f.graph.nodes.filter(node => node.key === "branch-scout" || node.key === "branch-analyst")
    const proof = await proveTaskGraphFailedBranchEvidence(f.client, { scope, snapshot: f.graph, sourceNodes })
    expect(proof).toMatchObject({ failedSource: { source: { nodeKey: "branch-scout", taskId: "branch-scout-task" }, attemptCount: 1 },
      verifiedExternalDependencies: [{ dependency: { nodeKey: "foundation-a" } }, { dependency: { nodeKey: "foundation-z" } }] })
    expect(proof).not.toHaveProperty("cancellations")
    const taskLock = f.query.mock.calls[0]
    expect(taskLock?.[1]?.[0]).toEqual(["branch-scout-task", "foundation-a-task", "foundation-z-task"])
    expect(f.query).toHaveBeenCalledTimes(2)
  })

  it("accepts verified ancestor history when an unrelated node is appended before the failed Scout", async () => {
    const f = fixture(), historical = f.graph
    const unrelated = node("unrelated", "scout", "unrelated-task", [], 1)
    const current: TaskGraphSnapshot = { ...historical, nodes: [...historical.nodes, unrelated] }
    f.graph = current
    for (const index of [0, 1, 2]) {
      const row = f.events[index]!, payload = row.payload as Row, item = payload.item as Row
      row.payload = { ...payload, item: { ...item, content: current } }
      const outbox = row.outboxPayload as Row
      row.outboxPayload = { ...outbox, payload: row.payload }
    }
    const sourceNodes = current.nodes.filter(value => value.key === "branch-scout" || value.key === "branch-analyst")
    const proof = await proveTaskGraphFailedBranchEvidence(f.client, { scope, snapshot: current, sourceNodes })
    expect(proof?.verifiedExternalDependencies).toHaveLength(2)
  })

  it("fails closed for a typed external ancestor whose prior repair lineage is not part of v1 proof", async () => {
    const f = fixture(), target = node("foundation-target", "scout", "foundation-target-task", [], 1)
    const repairedAncestor = { ...f.graph.nodes[0]!, repairOf: { graphRootTaskId: scope.rootTaskId,
      nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-count"] } }
    f.graph = { ...f.graph, nodes: [target, repairedAncestor, ...f.graph.nodes.slice(1)] }
    for (const index of [2, 3]) {
      const row = f.events[index]!, payload = row.payload as Row, item = payload.item as Row
      row.payload = { ...payload, item: { ...item, content: f.graph } }
      const outbox = row.outboxPayload as Row
      row.outboxPayload = { ...outbox, payload: row.payload }
    }
    const sourceNodes = f.graph.nodes.filter(value => value.key === "branch-scout" || value.key === "branch-analyst")
    await expect(proveTaskGraphFailedBranchEvidence(f.client, { scope, snapshot: f.graph, sourceNodes })).resolves.toBeNull()
    expect(f.query).toHaveBeenCalled()
  })

  it.each([
    ["an extant but misbound completion receipt", (f: ReturnType<typeof fixture>) => {
      f.events[0]!.taskId = "foreign-task"
    }],
    ["an ancestor completed after the Scout failure", (f: ReturnType<typeof fixture>) => {
      f.events[0]!.sequence = "15"
    }],
    ["a currently failed external dependency", (f: ReturnType<typeof fixture>) => {
      f.taskRows[0]!.status = "failed"
    }],
  ])("fails closed for %s", async (_name, mutate) => {
    const f = fixture(); mutate(f)
    await expect(proveTaskGraphFailedBranchEvidence(f.client, { scope, snapshot: f.graph, sourceNodes: f.graph.nodes.slice(2) })).resolves.toBeNull()
  })

  it("rejects a candidate list that omits a descendant of the failed Scout", async () => {
    const f = fixture()
    await expect(proveTaskGraphFailedBranchEvidence(f.client, { scope, snapshot: f.graph, sourceNodes: [f.graph.nodes[2]!] })).resolves.toBeNull()
  })
})
