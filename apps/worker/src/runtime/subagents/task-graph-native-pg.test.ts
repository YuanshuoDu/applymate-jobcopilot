import { describe, expect, it, vi } from "vitest"

import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { appendNativeGraphCommand, findNativeCommandReplay } from "./task-graph-native-pg.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt, TaskGraphNativeSourceProvenance } from "./task-graph-native-command.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { GraphParent, LoadedGraph } from "./task-graph-pg-state.js"
import { taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import {
  STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  steeringReconciliationIdempotencyKey,
} from "./steering-reconciliation-contract.js"

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
