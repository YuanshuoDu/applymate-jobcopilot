import { describe, expect, it, vi } from "vitest"

const nativeAppendMocks = vi.hoisted(() => ({
  createChild: vi.fn(), enqueue: vi.fn(), writeSnapshot: vi.fn(), appendReceipt: vi.fn(),
}))
const reconciliationMocks = vi.hoisted(() => ({ assertBranchHistory: vi.fn(async () => undefined) }))
vi.mock("./pg-store-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-store-create.js")>(),
  createSubagentTask: nativeAppendMocks.createChild,
}))
vi.mock("./task-graph-pg-create.js", () => ({ enqueueGraphTask: nativeAppendMocks.enqueue }))
vi.mock("./task-graph-pg-events.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-events.js")>(),
  writeTaskGraphSnapshot: nativeAppendMocks.writeSnapshot,
  appendTaskGraphReceipt: nativeAppendMocks.appendReceipt,
}))
vi.mock("./steering-reconciliation-branch-repair-history.js", () => ({
  assertTaskGraphBranchRepairHistory: reconciliationMocks.assertBranchHistory,
}))

import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { appendNativeGraphCommand, findNativeCommandReplay } from "./task-graph-native-pg.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt, TaskGraphNativeSourceProvenance } from "./task-graph-native-command.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import {
  STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION,
  steeringReconciliationIdempotencyKey,
} from "./steering-reconciliation-contract.js"
import { TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, taskGraphBranchRepairFingerprint } from "./task-graph-pg-branch-repair-relation.js"

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

function queryFor(event: unknown) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [event], rowCount: 1 }))
  return { client: { query } as unknown as Queryable, query }
}

function terminalSource(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: taskId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, turnId: scope.turnId,
    role: "auditor", taskType: "audit", status: "cancelled", attemptCount: 0,
    result: null, context: {}, expectedOutputSchema: {}, allowedActions: ["jobs.search"], budgetSnapshot: {},
    ...overrides,
  }
}

function supersessionReceiptEvent(sourceTaskId: string) {
  const callId = "plan-call-1", operationKey = steeringReconciliationIdempotencyKey(scope, callId)!
  const relation = {
    schemaVersion: "agent-harness.v2.task-graph-supersession.v2",
    operationKey, observedRevision: 4, cancellationRevision: 5, resultingRevision: 6,
    source: { nodeKey: "typed-source", taskId: sourceTaskId },
    replacement: { nodeKey: "replacement", taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "20" }, planEvent: { id: "plan-event", sequence: "21", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, 4) },
    replacementFingerprint: "a".repeat(64),
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: 4, replaceUnstarted: { nodeKey: "typed-source" } },
  }
  return {
    id: "reconciliation-event", itemId: null, taskId: scope.rootTaskId,
    type: STEERING_RECONCILIATION_EVENT_TYPE, actor: "orchestrator", correlationId: scope.turnId,
    causationId: scope.stepId, sequence: "22", idempotencyKey: operationKey, hasOutbox: false,
    payload: {
      schemaVersion: STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
      sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      stepId: scope.stepId, decision: "revise", observedRevision: 4, resultingRevision: 6,
      steerInputIds: ["steer-input"], inputCheckpoint: { throughSequence: "19" }, supersession: relation,
    },
  }
}

function branchRepairReceiptEvent(sourceTaskId: string) {
  const callId = "branch-plan-call", operationKey = steeringReconciliationIdempotencyKey(scope, callId)!
  const replaceBranch = {
    root: { nodeKey: "scout-old", taskId: "scout-old-task" },
    sources: [
      { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
    ],
  }
  const call = { expectedRevision: 4, replaceBranch, nodes: [{ key: "scout-new" }, { key: "analyst-new" }] }
  const relation = {
    schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
    operationKey, graphRootTaskId: scope.rootTaskId, observedRevision: 4, resultingRevision: 7,
    root: replaceBranch.root,
    sources: [
      { source: { nodeKey: "scout-old", taskId: "scout-old-task" }, replacementKey: "scout-new", cancellationEvent: { id: "cancel-scout", sequence: "41" } },
      { source: { nodeKey: "analyst-old", taskId: sourceTaskId }, replacementKey: "analyst-new", cancellationEvent: { id: "cancel-analyst", sequence: "42" } },
    ],
    planEvent: { id: "plan-branch", sequence: "43", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 6) },
    replacementFingerprint: taskGraphBranchRepairFingerprint(call),
    agentPlanCall: { callId, stepId: scope.stepId, expectedRevision: 4, replaceBranch },
  }
  return {
    id: "branch-reconciliation-event", itemId: null, taskId: scope.rootTaskId,
    type: STEERING_RECONCILIATION_EVENT_TYPE, actor: "orchestrator", correlationId: scope.turnId,
    causationId: scope.stepId, sequence: "44", idempotencyKey: operationKey, hasOutbox: false,
    payload: {
      schemaVersion: STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION,
      sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      stepId: scope.stepId, decision: "revise", observedRevision: 4, resultingRevision: 7,
      steerInputIds: [], inputCheckpoint: { throughSequence: "43" }, branchRepair: relation,
    },
    relation,
  }
}

function followupQueryFor(source: unknown, events: readonly unknown[] = [], hasHistoryMembership = false) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.includes('FROM "sub_agent_tasks" AS task') ? [source]
      : sql.includes('FROM "agent_events" AS event') ? [...events]
        : sql.includes('FROM "agent_items" AS item') ? [{ hasMembership: hasHistoryMembership }] : [],
    rowCount: 0,
  }))
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
      ? { rows: [sourceRow], rowCount: 1 }
      : sql.includes("FROM \"agent_items\" AS item") ? { rows: [{ hasMembership: false }], rowCount: 1 } : { rows: [], rowCount: 1 })
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

describe("native TaskGraph role admission", () => {
  it("rejects Application Filler from native spawn before writes", async () => {
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "spawn", idempotencyKey: "native-filler-spawn", role: "application_filler", taskType: "application_fill_for_review", goal: "Prepare for review" },
    }
    const fake = queryFor(null)
    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, {} as LoadedGraph))
      .rejects.toMatchObject({ code: "native_role_not_allowed" })
    expect(fake.query).not.toHaveBeenCalled()
  })

  it("rejects native follow-up that would inherit Application Filler role", async () => {
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "native-filler-followup", sourceTaskId: "filler-source", goal: "Continue filling" },
    }
    const fake = followupQueryFor({
      id: "filler-source", rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, turnId: scope.turnId,
      role: "application_filler", taskType: "application_fill_for_review", status: "completed", attemptCount: 1,
      result: null, context: {}, expectedOutputSchema: {}, allowedActions: [], budgetSnapshot: {},
    })
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_role_not_allowed" })
    expect(fake.query).toHaveBeenCalledTimes(3)
  })

  it("blocks follow-up from a task named as the source of a scoped v2 supersession receipt", async () => {
    const taskId = "superseded-source"
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-superseded", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId), [supersessionReceiptEvent(taskId)])
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_source_superseded" })
    expect(fake.query).toHaveBeenCalledTimes(2)
    expect(fake.query.mock.calls[1]?.[1]).toEqual([
      scope.sessionId, scope.turnId, scope.rootTaskId, STEERING_RECONCILIATION_EVENT_TYPE, taskId, scope.userId,
    ])
  })

  it("blocks any source in a scoped v3 branch receipt only after validating its full history", async () => {
    reconciliationMocks.assertBranchHistory.mockClear()
    const taskId = "analyst-old-task", event = branchRepairReceiptEvent(taskId)
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-branch-superseded", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId), [event])
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_source_superseded" })
    expect(fake.query.mock.calls[1]?.[0]).toContain("jsonb_array_elements")
    const { stepId: currentStepId, ...ownerScope } = scope
    expect(currentStepId).toBe("step-1")
    expect(reconciliationMocks.assertBranchHistory).toHaveBeenCalledWith(fake.client, ownerScope, event.relation,
      { id: event.id, sequence: 44n, stepId: event.relation.agentPlanCall.stepId, idempotencyKey: event.idempotencyKey })
  })

  it("fails closed when a matching v3 source receipt has invalid branch history", async () => {
    reconciliationMocks.assertBranchHistory.mockRejectedValueOnce(new Error("invalid branch history"))
    const taskId = "analyst-old-task", event = branchRepairReceiptEvent(taskId)
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-invalid-branch-receipt", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId), [event])
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_source_unavailable" })
  })

  it("fails closed for a malformed matching supersession receipt", async () => {
    const taskId = "malformed-superseded-source", event = supersessionReceiptEvent(taskId)
    const payload = event.payload
    const malformed = {
      ...event,
      payload: { ...payload, supersession: { ...payload.supersession, source: { ...payload.supersession.source, nodeKey: "" } } },
    }
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-malformed-supersession", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId), [malformed])
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_source_unavailable" })
    expect(fake.query).toHaveBeenCalledTimes(2)
  })

  it("keeps a cancelled legacy source with no graph history on the normal follow-up path", async () => {
    const taskId = "cancelled-without-receipt"
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-cancelled-no-receipt", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId, { allowedActions: "malformed" }))
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_policy_invalid" })
    expect(fake.query).toHaveBeenCalledTimes(3)
    expect(fake.query.mock.calls[2]?.[1]).toEqual([
      scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), scope.rootTaskId,
      "task_graph", taskId, scope.userId,
    ])
  })

  it("fails closed for historical graph membership without a matching supersession receipt", async () => {
    const taskId = "historical-graph-source"
    const input: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-unlinked-history", sourceTaskId: taskId, goal: "Continue audit" },
    }
    const fake = followupQueryFor(terminalSource(taskId), [], true)
    const loaded = { state: null, snapshot: null, tasks: new Map() } as unknown as LoadedGraph

    await expect(appendNativeGraphCommand(fake.client, input, normalizeNativeCommand(input), {} as GraphParent, loaded))
      .rejects.toMatchObject({ code: "native_source_unavailable" })
    expect(fake.query).toHaveBeenCalledTimes(3)
    expect(fake.query.mock.calls[2]?.[1]).toEqual([
      scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), scope.rootTaskId,
      "task_graph", taskId, scope.userId,
    ])
  })
})
