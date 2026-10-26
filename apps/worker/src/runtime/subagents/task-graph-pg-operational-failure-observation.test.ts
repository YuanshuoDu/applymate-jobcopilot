import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { proveTaskGraphOperationalObservedGraph } from "./task-graph-pg-operational-failure-observation.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION,
  type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

type Row = Record<string, unknown>
const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "scout", templateId: "scout",
  goal: "Find candidates", successCriteria: ["Find candidates"], dependsOn: [], depth: 1, taskId: "task-1", verificationDisposition: "legacy_unverified" }] }
const observedRevision = 2
const graphItemId = taskGraphItemId(scope.rootTaskId)
const timestamp = "2026-10-26T10:00:00.000Z"

function graphItem(content: TaskGraphSnapshot = snapshot, revision = observedRevision, stepId: string | null = "step-1") {
  return { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphItemId, sessionId: scope.sessionId, turnId: scope.turnId,
    stepId, taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null, revision, content,
    startedAt: timestamp, completedAt: null, createdAt: timestamp, updatedAt: timestamp }
}
function proposalRow() {
  const item = graphItem(), id = "proposal-event", idempotencyKey = taskGraphProposalKey(scope.rootTaskId, observedRevision - 1)
  const receipt = { status: "accepted", revision: observedRevision, nodes: [{ key: "scout", taskId: "task-1", status: "queued" }], readyTaskIds: ["task-1"] }
  const payload = { kind: "proposal", fingerprint: "a".repeat(64), receipt, revision: observedRevision, item, content: snapshot }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: graphItemId, taskId: scope.rootTaskId,
    sequence: "20", type: "item.delta", actor: "orchestrator", correlationId: scope.turnId, causationId: "step-1",
    idempotencyKey, payload, currentItemId: graphItemId, currentSessionId: scope.sessionId, currentTurnId: scope.turnId,
    currentTaskId: scope.rootTaskId, currentType: "task_graph", currentRevision: observedRevision, currentContent: snapshot,
    outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${id}`,
    outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: graphItemId,
      taskId: scope.rootTaskId, sequence: "20", type: "item.delta", actor: "orchestrator", correlationId: scope.turnId,
      causationId: "step-1", idempotencyKey, payload } }
}
function lifecycleRow() {
  const type = "task.failed", id = "lifecycle-event", idempotencyKey = taskGraphLifecycleKey(scope.rootTaskId, "scout", 1, type)
  const payload = { kind: "lifecycle", event: { type, nodeKey: "scout", expectedRevision: observedRevision - 1,
    idempotencyKey, failureReason: "child_resume_unavailable" }, revision: observedRevision, item: graphItem() }
  return { id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: graphItemId, taskId: "task-1", sequence: "21",
    type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey, payload,
    currentItemId: graphItemId, currentSessionId: scope.sessionId, currentTurnId: scope.turnId, currentTaskId: scope.rootTaskId,
    currentType: "task_graph", currentRevision: observedRevision, currentContent: snapshot,
    outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${id}`,
    outboxPayload: { eventId: id, sessionId: scope.sessionId, turnId: scope.turnId, itemId: graphItemId, taskId: "task-1",
      sequence: "21", type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null, idempotencyKey, payload } }
}
function clientFor(rows: readonly Row[]) {
  const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [...rows], rowCount: rows.length }))
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("proveTaskGraphOperationalObservedGraph", () => {
  it("proves a current-attempt system lifecycle event and its exact graph snapshot", async () => {
    const row = lifecycleRow(), fixture = clientFor([row])
    await expect(proveTaskGraphOperationalObservedGraph(fixture.client, { scope, observedRevision }))
      .resolves.toEqual({ event: { id: row.id, sequence: row.sequence, idempotencyKey: row.idempotencyKey }, snapshot })
    expect(fixture.query).toHaveBeenCalledTimes(1)
    expect(fixture.query.mock.calls[0]?.[1]).toEqual([scope.sessionId, scope.turnId, graphItemId, scope.userId,
      scope.rootTaskId, String(observedRevision), null])
  })

  it("proves an orchestrator proposal receipt and supports an exact replay identity", async () => {
    const row = proposalRow(), fixture = clientFor([row]), identity = { id: row.id as string, sequence: row.sequence as string,
      idempotencyKey: row.idempotencyKey as string }
    await expect(proveTaskGraphOperationalObservedGraph(fixture.client, { scope, observedRevision, event: identity,
      expectedSnapshot: snapshot })).resolves.toEqual({ event: identity, snapshot })
    expect(fixture.query.mock.calls[0]?.[1]?.[6]).toBe(identity.id)
    await expect(proveTaskGraphOperationalObservedGraph(fixture.client, { scope, observedRevision,
      expectedSnapshot: { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, goal: "Changed metadata" }] } })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalObservedGraph(fixture.client, { scope, observedRevision,
      event: { ...identity, sequence: "19" } })).resolves.toBeNull()
  })

  it("proves historical snapshots after unrelated later graph writes without substituting current metadata", async () => {
    const row = lifecycleRow(), later: TaskGraphSnapshot = { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, goal: "Later graph" }] }
    row.currentRevision = 4
    row.currentContent = later
    await expect(proveTaskGraphOperationalObservedGraph(clientFor([row]).client, { scope, observedRevision }))
      .resolves.toMatchObject({ event: { id: row.id, sequence: row.sequence }, snapshot })
    await expect(proveTaskGraphOperationalObservedGraph(clientFor([row]).client, { scope, observedRevision, expectedSnapshot: snapshot }))
      .resolves.toBeNull()
  })

  it("rejects foreign, stale, ambiguous, malformed, and outbox-free witnesses", async () => {
    const base = lifecycleRow()
    const invalid: Row[] = [
      { ...base, sessionId: "foreign-session" },
      { ...base, turnId: "foreign-turn" },
      { ...base, itemId: "foreign-item" },
      { ...base, currentTaskId: "foreign-root" },
      { ...base, currentRevision: observedRevision - 1 },
      { ...base, payload: { ...base.payload as Row, revision: observedRevision + 1 } },
      { ...base, payload: { ...base.payload as Row, item: { ...base.payload && (base.payload as Row).item as Row, content: {} } } },
      { ...base, outboxPayload: {} },
      { ...base, outboxTopic: null },
    ]
    for (const row of invalid) await expect(proveTaskGraphOperationalObservedGraph(clientFor([row]).client, { scope, observedRevision })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalObservedGraph(clientFor([base, base]).client, { scope, observedRevision })).resolves.toBeNull()
    await expect(proveTaskGraphOperationalObservedGraph(clientFor([base]).client, { scope: { ...scope, parentTaskId: "not-root" }, observedRevision }))
      .resolves.toBeNull()
  })

  it("rejects malformed proposal receipts and lifecycle provenance", async () => {
    const proposal = proposalRow(), lifecycle = lifecycleRow()
    const malformedProposal = { ...proposal, payload: { ...proposal.payload as Row, receipt: { status: "accepted", revision: 1, nodes: [], readyTaskIds: [] } } }
    const wrongActor = { ...lifecycle, actor: "orchestrator" }
    const wrongNode = { ...lifecycle, taskId: scope.rootTaskId }
    const missingOutbox = { ...proposal, outboxPayload: null }
    for (const row of [malformedProposal, wrongActor, wrongNode, missingOutbox]) {
      await expect(proveTaskGraphOperationalObservedGraph(clientFor([row]).client, { scope, observedRevision })).resolves.toBeNull()
    }
  })
})
