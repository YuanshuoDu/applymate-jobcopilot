import { afterEach, describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, taskGraphScoutRetirementIdempotencyKeyFromIdentity } from "../subagents/task-graph-scout-retirement-contract.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { readTaskGraphRetiredScouts } from "./task-graph-retirement-completion.js"

const harness = vi.hoisted(() => ({ snapshot: null as unknown, confirmed: null as unknown, ackKey: "", steerCalls: [] as unknown[][] }))
vi.mock("../subagents/task-graph-pending-scout-scope.js", () => ({ isOrdinaryRegisteredScout: (_node: unknown, task: unknown) =>
  !!task && typeof task === "object" && (task as { failureReason?: unknown }).failureReason === null }))
vi.mock("../subagents/task-graph-snapshot.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-snapshot.js")>()
  return { ...actual, parseTaskGraphSnapshot: () => harness.snapshot }
})
vi.mock("../subagents/task-graph-pg-event-validation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-pg-event-validation.js")>()
  return { ...actual, parsePersistedTaskGraphReceipt: (_type: unknown, payload: unknown) => {
    const event = payload && typeof payload === "object" ? (payload as { event?: { idempotencyKey?: unknown } }).event : undefined
    return event?.idempotencyKey === harness.ackKey
      ? { type: "task.interrupted", nodeKey: "old-scout", idempotencyKey: harness.ackKey } : null
  } }
})
vi.mock("../subagents/task-graph-confirmed-location-steer.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-confirmed-location-steer.js")>()
  return { ...actual, readTaskGraphConfirmedLocationSteerAtSequence: async (...args: unknown[]) => {
    harness.steerCalls.push(args)
    return harness.confirmed
  } }
})

const scope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const graphId = taskGraphItemId(scope.rootTaskId), planKey = taskGraphProposalKey(scope.rootTaskId, 4)
const acceptedSteer = { kind: "confirmed", locations: ["dublin"], acceptedInputSequence: 10n, acceptedInputId: "accepted-input" }
const receiptKey = taskGraphScoutRetirementIdempotencyKeyFromIdentity({ scope: { ...scope, stepId: "action-step" },
  expectedRevision: 8, taskId: "old-task", callId: "retire-call" })!
const ackKey = taskGraphLifecycleKey(scope.rootTaskId, "old-scout", 2, "task.interrupted")
const receipt = {
  schemaVersion: TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION, sessionId: "session", turnId: "turn", rootTaskId: "root",
  nodeKey: "old-scout", taskId: "old-task", attempt: 2, interruptRequestedAt: "2026-11-19T10:00:00.000Z",
  graphRevision: 8, acceptedPlanRevision: 5, acceptedSteerSequence: "10", reconciliationStepId: "revise-step",
  reconciliationThroughSequence: "10", reconciliationEventId: "reconcile-event", reconciliationEventSequence: "12",
  reconciliationIdempotencyKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`, planEventId: "plan-event",
  planEventSequence: "11", planIdempotencyKey: planKey, replacementNodeKey: "new-scout", replacementTaskId: "new-task",
  replacementSourceSequence: "10",
}
const locations = (value: string) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
  criteria: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: [value] } }] })
const oldNode = { key: "old-scout", taskId: "old-task", templateId: "scout", goal: "Old scope", successCriteria: ["Find"],
  dependsOn: [], depth: 1, verificationDisposition: "typed", verification: locations("london") }
const newNode = { key: "new-scout", taskId: "new-task", templateId: "scout", goal: "New scope", successCriteria: ["Find"],
  dependsOn: [], depth: 1, verificationDisposition: "typed", verification: locations("dublin") }
const snapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: [oldNode, newNode] }

function loaded(): LoadedGraph {
  return { rootTaskId: "root", discoveryTurnEligibility: "ordinary", item: { id: graphId, revision: 8, content: {}, createdAt: new Date(0) },
    snapshot, state: { revision: 8 }, tasks: new Map([
      ["old-task", { id: "old-task", role: "scout", taskType: "job_discovery", status: "interrupted", failureReason: "Subagent task subtree was interrupted", attemptCount: 2, result: null }],
      ["new-task", { id: "new-task", role: "scout", taskType: "job_discovery", status: "completed", failureReason: null, attemptCount: 1, result: {} }],
    ]), sourceInputCheckpointByNodeKey: new Map([
      ["old-scout", { inputThroughSequence: 9n }], ["new-scout", { inputThroughSequence: 10n }],
    ]) } as unknown as LoadedGraph
}
const reconciliation = { unresolvedInputs: [], currentRevision: 8, lastReconciledInputThroughSequence: 10n } as never

function client(callTaskId = "old-task") {
  const planEvent = { id: "plan-event", sequence: "11", type: "item.delta", actor: "orchestrator", itemId: graphId,
    taskId: "root", correlationId: "turn", causationId: "revise-step", idempotencyKey: planKey, hasOutbox: true,
    payload: { kind: "proposal", fingerprint: "a".repeat(64), revision: 5, content: snapshot,
      receipt: { status: "accepted", revision: 5, nodes: [{ key: "new-scout", taskId: "new-task", status: "queued" }], readyTaskIds: ["new-task"] },
      item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphId, sessionId: "session", turnId: "turn", taskId: "root",
        type: "task_graph", revision: 5, stepId: "revise-step", content: snapshot } } }
  const reconcileEvent = { id: "reconcile-event", sequence: "12", type: "agent.plan.reconciliation", actor: "orchestrator",
    itemId: null, taskId: "root", correlationId: "turn", causationId: "revise-step",
    idempotencyKey: receipt.reconciliationIdempotencyKey, hasOutbox: false,
    payload: { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: "session", turnId: "turn", rootTaskId: "root",
      stepId: "revise-step", decision: "revise", observedRevision: 4, resultingRevision: 5, steerInputIds: ["accepted-input"],
      inputCheckpoint: { throughSequence: "10" } } }
  const retirementEvent = { id: "retirement-event", sequence: "13", type: "task_graph.superseded_scout_retirement", actor: "system",
    itemId: graphId, taskId: "old-task", correlationId: "turn", causationId: "action-step", idempotencyKey: receiptKey,
    payload: receipt, hasOutbox: false }
  const ackPayload = { kind: "lifecycle", revision: 5, item: { id: graphId, sessionId: "session", turnId: "turn",
    taskId: "root", type: "task_graph", revision: 5 }, event: { type: "task.interrupted", idempotencyKey: ackKey,
      nodeKey: "old-scout", expectedRevision: 4 } }
  const ackEvent = { id: "ack-event", sequence: "14", type: "item.delta", actor: "system", itemId: graphId,
    taskId: "old-task", correlationId: "turn", causationId: null, idempotencyKey: ackKey, hasOutbox: true, payload: ackPayload }
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('event."itemId" = $3 AND event."type" = $4')) return { rows: [retirementEvent] }
    if (sql.includes('WHERE event."id" = $1')) return { rows: [params?.[0] === "plan-event" ? planEvent : reconcileEvent] }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "old-task", status: "interrupted", role: "scout",
      taskType: "job_discovery", attemptCount: 2, interruptRequestedAt: new Date(receipt.interruptRequestedAt), leaseOwner: null,
      leaseExpiresAt: null, hasChild: false }] }
    if (sql.includes('event."idempotencyKey" = $5')) return { rows: [ackEvent] }
    if (sql.includes('ANY($1::text[])')) return { rows: [
      { id: "action-step", ordinal: 9, attempt: 1, status: "failed", taskId: "root" },
      { id: "revise-step", ordinal: 6, attempt: 1, status: "interrupted", taskId: "root" },
    ] }
    if (sql.includes('item."type" = \'tool_call\'')) return { rows: [{ id: "call-item", status: "started", content: {
      toolCallId: "retire-call", toolName: "agent.retire_superseded_scout", toolVersion: "1",
      input: { expectedRevision: 8, taskId: callTaskId },
    } }] }
    return { rows: [] }
  })
  return { query }
}

afterEach(() => { harness.snapshot = null; harness.confirmed = null; harness.ackKey = ""; harness.steerCalls = [] })

describe("task graph retirement completion read", () => {
  it("accepts the committed request and exact Worker ack without requiring a tool result", async () => {
    harness.snapshot = snapshot
    harness.confirmed = acceptedSteer
    harness.ackKey = ackKey
    const db = client()

    const result = await readTaskGraphRetiredScouts(db as never, scope, loaded(), reconciliation)
    expect(db.query).toHaveBeenCalledTimes(7)
    expect(harness.steerCalls[0]?.[1]).toEqual({ userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root" })
    expect(result).toEqual(new Map([[
      "old-scout", { nodeKey: "old-scout", taskId: "old-task", attempt: 2, interruptRequestedAt: receipt.interruptRequestedAt,
        receiptEventId: "retirement-event", lifecycleEventId: "ack-event" },
    ]]))
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('item."type" = \'tool_result\''))).toBe(false)
  })

  it("fails closed for malformed receipts and a call with a different target", async () => {
    const malformedClient = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [
      { id: "receipt-one", sequence: "15", taskId: "old-task", payload: {} },
    ] })) }
    await expect(readTaskGraphRetiredScouts(malformedClient as never, scope, loaded(), reconciliation)).resolves.toEqual(new Map())

    harness.snapshot = snapshot
    harness.confirmed = acceptedSteer
    harness.ackKey = ackKey
    await expect(readTaskGraphRetiredScouts(client("foreign-task") as never, scope, loaded(), reconciliation)).resolves.toEqual(new Map())
  })

  it("does not accept duplicate task-bound receipts", async () => {
    const duplicate = { id: "receipt-one", sequence: "15", taskId: "old-task", payload: receipt }
    const db = { query: vi.fn(async (..._args: unknown[]) => ({ rows: [duplicate, { ...duplicate, id: "receipt-two" }] })) }
    await expect(readTaskGraphRetiredScouts(db as never, scope, loaded(), reconciliation)).resolves.toEqual(new Map())
    expect(db.query).toHaveBeenCalledTimes(1)
  })
})
