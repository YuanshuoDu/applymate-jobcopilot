import { describe, expect, it, vi } from "vitest"

const nativeAppendMocks = vi.hoisted(() => ({
  createChild: vi.fn(), enqueue: vi.fn(), writeSnapshot: vi.fn(), appendReceipt: vi.fn(),
}))
vi.mock("./pg-store-create.js", () => ({ createSubagentTask: nativeAppendMocks.createChild }))
vi.mock("./task-graph-pg-create.js", () => ({ enqueueGraphTask: nativeAppendMocks.enqueue }))
vi.mock("./task-graph-pg-events.js", () => ({ writeTaskGraphSnapshot: nativeAppendMocks.writeSnapshot, appendTaskGraphReceipt: nativeAppendMocks.appendReceipt }))

import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { appendNativeGraphCommand, findNativeCommandReplay } from "./task-graph-native-pg.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt, TaskGraphNativeSourceProvenance } from "./task-graph-native-command.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"

const scope: TaskGraphNativeCommandInput["scope"] = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}

function persisted(input: TaskGraphNativeCommandInput, source?: TaskGraphNativeSourceProvenance) {
  const command = normalizeNativeCommand(input), operation = command.request
  const role = source?.role ?? (operation.kind === "spawn" ? operation.role : "auditor")
  const taskType = source?.taskType ?? (operation.kind === "spawn" ? operation.taskType : "audit")
  const itemId = taskGraphItemId(scope.rootTaskId), childId = "child-1"
  const metadata = {
    schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: operation.kind,
    operationId: command.operationId, requestFingerprint: command.requestFingerprint,
    callerTaskId: scope.rootTaskId, role, taskType,
    contextDigest: "c".repeat(64), contextBytes: 2, ...(source ? { source } : {}),
  }
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{ key: "native-node", templateId: "native", goal: operation.goal,
      successCriteria: [...operation.successCriteria], dependsOn: [], depth: 1, taskId: childId,
      verificationDisposition: "legacy_unverified", nativeDelegation: metadata }],
  }
  const receipt: TaskGraphNativeCommandReceipt = {
    status: "accepted", replay: false, operationId: command.operationId,
    requestFingerprint: command.requestFingerprint, graphRevision: 1, nodeKey: "native-node",
    dispatchDisposition: "pending",
    child: { taskId: childId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId,
      path: "/root-1/child-1", depth: 1, role, taskType, status: "queued" },
    ...(source ? { source } : {}),
  }
  const item = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: scope.stepId, taskId: scope.rootTaskId, type: "task_graph",
    status: "streaming", phase: null, revision: 1, content: snapshot,
    startedAt: "2026-10-06T00:00:00.000Z", completedAt: null,
    createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z",
  }
  const event = {
    type: "item.started", itemId, taskId: scope.rootTaskId,
    idempotencyKey: command.eventIdempotencyKey,
    payload: { kind: "native_command", requestFingerprint: command.requestFingerprint,
      revision: 1, receipt, item, content: snapshot },
  }
  return { command, event, receipt, snapshot }
}

function queryFor(event: unknown): { client: Queryable; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [event], rowCount: 1 }))
  return { client: { query } as unknown as Queryable, query }
}

describe("durable native TaskGraph replay", () => {
  it.each(["spawn", "followup"] as const)("preserves a pinned root checklist during native %s snapshot writes", async kind => {
    vi.clearAllMocks()
    const pinned = ["Whole original objective", "Include evidence"]
    const sourceRow = {
      id: "source-1", rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, turnId: scope.turnId,
      role: "auditor", taskType: "audit", status: "completed", attemptCount: 0, result: {}, context: {},
      expectedOutputSchema: {}, allowedActions: ["jobs.search"], budgetSnapshot: {},
    }
    const child = {
      id: "child-2", rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, path: "/root-1/child-2",
      depth: 1, role: kind === "spawn" ? "scout" : "auditor", taskType: kind === "spawn" ? "research" : "audit",
      status: "queued", budgetSnapshot: {}, allowedActions: [],
    }
    nativeAppendMocks.createChild.mockResolvedValue(child)
    nativeAppendMocks.enqueue.mockResolvedValue(undefined)
    nativeAppendMocks.writeSnapshot.mockResolvedValue({ itemId: taskGraphItemId(scope.rootTaskId), revision: 2 })
    nativeAppendMocks.appendReceipt.mockResolvedValue("event-2")
    const query = vi.fn(async (sql: string) => sql.includes("FROM \"sub_agent_tasks\" AS task JOIN")
      ? { rows: [sourceRow], rowCount: 1 } : { rows: [], rowCount: 1 })
    const client = { query } as unknown as Queryable
    const request = kind === "spawn"
      ? { kind, idempotencyKey: "native-spawn-pin", role: "scout" as const, taskType: "research", goal: "Find roles" }
      : { kind, idempotencyKey: "native-followup-pin", sourceTaskId: "source-1", goal: "Refine the audit" }
    const input = { scope, request } as TaskGraphNativeCommandInput
    const command = normalizeNativeCommand(input)
    const loaded = {
      rootTaskId: scope.rootTaskId, item: { id: taskGraphItemId(scope.rootTaskId), revision: 1, content: null, createdAt: new Date() },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [], rootSuccessCriteria: pinned } as TaskGraphSnapshot,
      state: { revision: 1, nodes: [], appliedEvents: [] }, tasks: new Map(),
    }

    await appendNativeGraphCommand(client, input, command, { budgetSnapshot: {}, allowedActions: [] }, loaded)

    const written = nativeAppendMocks.writeSnapshot.mock.calls[0]?.[2] as TaskGraphSnapshot | undefined
    expect(written?.rootSuccessCriteria).toEqual(pinned)
    expect(nativeAppendMocks.appendReceipt.mock.calls[0]?.[1]).toMatchObject({
      payload: { kind: "native_command", content: { rootSuccessCriteria: pinned } },
    })
  })

  it("returns the original spawn receipt without depending on later graph revisions", async () => {
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "spawn", idempotencyKey: "native-1", role: "scout", taskType: "research", goal: "Find jobs" },
    }
    const value = persisted(input), fake = queryFor(value.event)
    const replay = await findNativeCommandReplay(fake.client, input, value.command)

    expect(replay).toEqual({ ...value.receipt, status: "duplicate", replay: true })
    expect(fake.query.mock.calls[0]?.[1]).toEqual([scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), value.command.eventIdempotencyKey, scope.userId])
    expect(fake.query).toHaveBeenCalledTimes(1)
  })

  it("round-trips the optional source receipt and conflicts on kind reuse before source reads", async () => {
    const source: TaskGraphNativeSourceProvenance = {
      taskId: "source-1", rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, turnId: scope.turnId,
      role: "auditor", taskType: "audit", status: "completed", attemptCount: 0,
      resultDigest: "a".repeat(64), graphNodeKey: null, origin: "native_legacy",
    }
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "shared-key", sourceTaskId: source.taskId, goal: "Refine audit" },
    }
    const value = persisted(input, source), fake = queryFor(value.event)
    await expect(findNativeCommandReplay(fake.client, input, value.command)).resolves.toEqual({
      ...value.receipt, status: "duplicate", replay: true,
    })

    const changedKind: TaskGraphNativeCommandInput = {
      scope, request: { kind: "spawn", idempotencyKey: "shared-key", role: "auditor", taskType: "audit", goal: "Refine audit" },
    }
    await expect(findNativeCommandReplay(fake.client, changedKind, normalizeNativeCommand(changedKind)))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
  })

  it("fails closed when an event identity or receipt snapshot disagrees", async () => {
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "spawn", idempotencyKey: "native-2", role: "executor", taskType: "preflight", goal: "Inspect state" },
    }
    const value = persisted(input), altered = { ...value.event, taskId: "foreign-root" }, fake = queryFor(altered)
    await expect(findNativeCommandReplay(fake.client, input, value.command)).rejects.toThrow("task_graph_native_receipt_invalid")
  })
})
