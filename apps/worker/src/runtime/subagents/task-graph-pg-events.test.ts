import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { appendTaskGraphReceipt, appendTaskGraphReceiptWithIdentity, taskGraphSupersessionEnvelopeMatches, taskGraphSupersessionProposalMatches, writePlanReceipt, writeTaskLifecycleReceipt, writeTaskLifecycleReceiptWithIdentity } from "./task-graph-pg-events.js"
import { taskGraphFingerprint, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import type { GraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphEvent } from "../planning/task-graph.js"

describe("TaskGraph event persistence", () => {
  it("returns persisted event identity and leaves normal plan payloads v1-shaped", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      return sql.includes('RETURNING "eventSequence"') ? { rows: [{ eventSequence: "17" }], rowCount: 1 } : { rows: [], rowCount: 1 }
    }) } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1 }
    const proposal = { expectedRevision: 0, nodes: [{ key: "new", templateId: "analyst", goal: "Analyze", successCriteria: ["Report"], dependsOn: [] }] }
    const state = { revision: 1, nodes: [], appliedEvents: [] }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] } as const
    const identity = await appendTaskGraphReceiptWithIdentity(client, { scope, itemId: null, taskId: scope.rootTaskId,
      type: "test", idempotencyKey: "test-key", payload: {} })
    expect(identity).toMatchObject({ sequence: "17" })
    await writePlanReceipt(client, { scope, state, snapshot, expectedRevision: 0, now: new Date(0),
      idempotencyKey: "plan-key", fingerprint: taskGraphFingerprint(proposal),
      receipt: { status: "accepted", revision: 1, nodes: [{ key: "new", taskId: "new-task", status: "queued" }], readyTaskIds: ["new-task"] } })
    const planPayload = JSON.parse(String(calls.find(call => call.sql.includes('INSERT INTO "agent_events"') && call.values?.[6] === "item.started")?.values?.[10])) as Record<string, unknown>
    expect(planPayload).not.toHaveProperty("operationKey")
    expect(planPayload).not.toHaveProperty("observedRevision")
  })

  it("returns event identity from lifecycle writes without changing the revision wrapper", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.startsWith('UPDATE "agent_items"')
      ? { rows: [{ stepId: "step-1", status: "streaming", phase: null, startedAt: null, completedAt: null, createdAt: null }], rowCount: 1 }
      : sql.includes('RETURNING "eventSequence"') ? { rows: [{ eventSequence: "21" }], rowCount: 1 } : { rows: [], rowCount: 1 }) } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1 }
    const event: TaskGraphEvent = { type: "task.cancelled", idempotencyKey: "cancel-key", expectedRevision: 1, nodeKey: "old" }
    const written = await writeTaskLifecycleReceiptWithIdentity(client, scope, "graph-item", "old-task", event, 1,
      { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] })
    expect(written).toMatchObject({ sequence: "21", revision: 2 })
    await expect(writeTaskLifecycleReceipt(client, scope, "graph-item", "old-task", event, 1,
      { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] })).resolves.toBe(2)
  })

  it("allows only identity and explanatory text to vary in the supersession envelope", () => {
    const source = { key: "old", taskId: "old-task", templateId: "scout", goal: "Old goal", successCriteria: ["Old text"],
      dependsOn: ["prerequisite"], depth: 2, verificationDisposition: "typed", verification: { role: "scout" },
      registeredScoutEnvelope: { role: "scout", taskType: "discovery" }, repairOf: { nodeKey: "prior", taskId: "prior-task" } }
    const replacement = { ...source, key: "new", taskId: "new-task", goal: "New goal", successCriteria: ["Previously verified" ] }
    expect(taskGraphSupersessionEnvelopeMatches(source, replacement)).toBe(true)
    expect(taskGraphSupersessionEnvelopeMatches(source, { ...replacement, depth: 3 })).toBe(false)
    expect(taskGraphSupersessionEnvelopeMatches(source, { ...replacement, registeredScoutEnvelope: { role: "scout", taskType: "other" } })).toBe(false)
    expect(taskGraphSupersessionEnvelopeMatches(source, { ...replacement, repairOf: { nodeKey: "other", taskId: "prior-task" } })).toBe(false)
    expect(taskGraphSupersessionProposalMatches(source, replacement, "root-1")).toBe(true)
    expect(taskGraphSupersessionProposalMatches(source, { ...replacement, dependsOn: ["different"] }, "root-1")).toBe(false)
  })

  it("treats an omitted repair graph root as the active root for comparison only", () => {
    const source = { templateId: "scout", verification: { role: "scout" }, dependsOn: [], nativeDelegation: null,
      repairOf: { nodeKey: "prior", taskId: "prior-task", graphRootTaskId: "root-1" } }
    const proposal = { ...source, repairOf: { nodeKey: "prior", taskId: "prior-task" } }
    expect(taskGraphSupersessionProposalMatches(source, proposal, "root-1")).toBe(true)
    expect(taskGraphSupersessionProposalMatches(source, { ...proposal, repairOf: { ...proposal.repairOf, graphRootTaskId: "other-root" } }, "root-1")).toBe(false)
    expect(proposal.repairOf).not.toHaveProperty("graphRootTaskId")
  })

  it("persists an itemless private receipt without writing an outbox record", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "17" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }) } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1 }
    await appendTaskGraphReceipt(client, { scope, itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation",
      idempotencyKey: "agent.plan.reconciliation:sha256:" + "a".repeat(64), actor: "orchestrator",
      causationId: "step-2", payload: { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", steerInputIds: ["private-input"] }, outbox: false })

    const event = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(event?.values?.[3]).toBeNull()
    expect(event?.values?.[4]).toBe(scope.rootTaskId)
    expect(event?.values?.[6]).toBe("agent.plan.reconciliation")
    expect(event?.values?.[7]).toBe("orchestrator")
    expect(calls.some(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("redacts and bounds worker failure text before writing the event and stream outbox", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "4" }], rowCount: 1 }
        if (sql.startsWith('UPDATE "agent_items"')) return { rows: [{
          stepId: "step-1", status: "streaming", phase: null,
          startedAt: new Date("2026-09-01T00:00:00.000Z"), completedAt: null, createdAt: new Date("2026-09-01T00:00:00.000Z"),
        }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
    } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
    }
    const rawFailure = "authorization: Bearer abcdefghijklmnop user@example.com\n" + "detail ".repeat(100)
    const event: TaskGraphEvent = {
      type: "task.failed", idempotencyKey: "event-key", expectedRevision: 2, nodeKey: "child", failureReason: rawFailure,
    }

    await writeTaskLifecycleReceipt(client, scope, "graph-item", "child-task", event, 2, { schemaVersion: "agent-harness.v2.task-graph", nodes: [] })

    const eventWrite = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    const persisted = JSON.parse(String(eventWrite?.values?.[10])) as { event: TaskGraphEvent }
    expect(eventWrite?.values?.[4]).toBe("child-task")
    expect(eventWrite?.values?.[4]).toBe("child-task")
    expect(persisted.event.type).toBe("task.failed")
    if (persisted.event.type !== "task.failed") throw new Error("expected task.failed event")
    expect(persisted.event.failureReason).not.toContain("abcdefghijklmnop")
    expect(persisted.event.failureReason).not.toContain("user@example.com")
    expect(persisted.event.failureReason).not.toContain("\n")
    expect(Buffer.byteLength(persisted.event.failureReason, "utf8")).toBeLessThanOrEqual(500)
    const outboxWrite = calls.find(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(outboxWrite).toBeDefined()
    expect(String(outboxWrite?.values?.[3])).not.toContain("abcdefghijklmnop")
  })
})
