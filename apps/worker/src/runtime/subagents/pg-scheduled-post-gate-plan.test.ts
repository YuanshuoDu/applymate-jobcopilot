import { beforeEach, describe, expect, it, vi } from "vitest"
import { BudgetExceededError } from "../budget.js"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import { appendScheduledPostGatePlan, readScheduledPostGatePlanningContext, verifyScheduledPostGateCompletion } from "./pg-scheduled-post-gate-plan.js"
import { scheduledPostGateDigest, SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_CRITERIA, SCHEDULED_POST_GATE_EXECUTE_GOAL, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"
import type { TaskGraphProposal, TaskGraphState } from "../planning/task-graph.js"

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), receipt: vi.fn(), validate: vi.fn(), reconcile: vi.fn(), writeReconcile: vi.fn(),
  event: vi.fn(), current: vi.fn(), capacity: vi.fn(), createTask: vi.fn(), enqueue: vi.fn(), writePlan: vi.fn(),
  readGate: vi.fn(), verifyGate: vi.fn(), preparedIds: vi.fn(), parseGate: vi.fn(), budget: vi.fn(), snapshot: vi.fn() }))
vi.mock("./task-graph-pg-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-state.js")>(), lockTaskGraphScope: mocks.lock,
  loadTaskGraph: mocks.load, currentTaskGraph: mocks.current,
}))
vi.mock("../planning/task-graph.js", async importOriginal => ({
  ...await importOriginal<typeof import("../planning/task-graph.js")>(), appendScheduledPostGateTaskGraphProposal: mocks.capacity,
}))
vi.mock("./scheduled-post-gate-handoff.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-post-gate-handoff.js")>(),
  readScheduledPostGateReceipt: mocks.receipt, validateScheduledPostGateHandoff: mocks.validate,
}))
vi.mock("./steering-reconciliation-ledger.js", async importOriginal => ({
  ...await importOriginal<typeof import("./steering-reconciliation-ledger.js")>(),
  prepareSteeringReconciliation: mocks.reconcile, writeSteeringReconciliationReceipt: mocks.writeReconcile,
}))
vi.mock("./task-graph-pg-events.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-events.js")>(),
  appendTaskGraphReceipt: mocks.event, writePlanReceipt: mocks.writePlan,
}))
vi.mock("./pg-store-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-store-create.js")>(), createSubagentTask: mocks.createTask,
}))
vi.mock("./task-graph-pg-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-create.js")>(), enqueueGraphTask: mocks.enqueue,
}))
vi.mock("./scheduled-audit-resume-context.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-audit-resume-context.js")>(), readScheduledAuditGateContinuationContext: mocks.readGate,
}))
vi.mock("./pg-scheduled-task-graph-gate-verification.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-scheduled-task-graph-gate-verification.js")>(),
  verifyScheduledGateCompletion: mocks.verifyGate,
}))
vi.mock("./scheduled-gate-contract.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-gate-contract.js")>(),
  scheduledGatePreparedJobIds: mocks.preparedIds, parseScheduledGateTaskEnvelope: mocks.parseGate,
}))
vi.mock("../turns/turn-engine-root-budget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../turns/turn-engine-root-budget.js")>(), enforceRootStepBudget: mocks.budget,
}))
vi.mock("./task-graph-snapshot.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-snapshot.js")>(), taskGraphSnapshot: mocks.snapshot,
}))

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-lease", turnLeaseVersion: 3, parentLeaseOwner: "root-lease", parentAttemptCount: 2, stepId: "plan-step" }
const refs = ["package-a", "package-b"]
const digest = `sha256:${"a".repeat(64)}`
const gateProof = { graphRevision: 5, gate: { taskId: "gate-task", attemptCount: 1, completedEventRevision: 5, resultDigest: digest },
  prepareProof: { receipt: { owner: { turnLeaseOwnerId: "original-turn-lease", turnLeaseVersion: 2 }, snapshotDigest: digest } } }

function baseState(): TaskGraphState {
  const nodes = [
    graphNode("scout", "scout", "scout-task", [], 1, "completed"),
    graphNode("analyst", "analyst", "analyst-task", ["scout"], 2, "completed"),
    graphNode("prepare", "prepare", "prepare-task", ["analyst"], 3, "completed"),
    graphNode("gate", "gate", "gate-task", ["prepare"], 4, "completed"),
  ]
  return { revision: 5, nodes, appliedEvents: [] }
}
function graphNode(key: string, templateId: string, taskId: string, dependsOn: readonly string[], depth: number,
  status: "queued" | "completed" | "running" | "waiting" = "completed") {
  return { key, templateId, taskId, goal: `${key} goal`, successCriteria: [`${key} complete`], dependsOn, depth, status }
}
function loaded(state = baseState()) {
  return { snapshot: { schemaVersion: "agent-harness.v2.task-graph.v2", nodes: state.nodes, rootSuccessCriteria: ["finish safely"] },
    state, item: { id: "graph-item", revision: state.revision },
    tasks: new Map([["gate-task", { id: "gate-task", status: "completed", result: { status: "completed" } }]]) }
}
function plan(packageRefs = refs): TaskGraphProposal {
  return { expectedRevision: 5, nodes: [
    { key: "execute-a", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_EXECUTE_GOAL,
      successCriteria: SCHEDULED_POST_GATE_EXECUTE_CRITERIA, dependsOn: ["gate"], packageRefs: [packageRefs[0]!] },
    { key: "execute-b", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_EXECUTE_GOAL,
      successCriteria: SCHEDULED_POST_GATE_EXECUTE_CRITERIA, dependsOn: ["gate"], packageRefs: [packageRefs[1]!] },
    { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_AUDIT_GOAL,
      successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA, dependsOn: ["execute-a", "execute-b"] },
  ] }
}
function input(proposal: TaskGraphProposal = plan()) {
  const callId = "plan-call"
  return { scope, proposal, operation: { scope, decision: "revise" as const, expectedRevision: proposal.expectedRevision, callId } }
}
function client() { return { query: vi.fn(async (sql: string) => sql.startsWith("UPDATE \"sub_agent_tasks\"")
  ? { rows: [], rowCount: 1 } : { rows: [] }) } }

function configure(proof: unknown = gateProof, approvedRefs: readonly string[] = refs): void {
  const state = baseState()
  mocks.lock.mockResolvedValue({ budgetSnapshot: { subagentPolicy: { maxAttempts: 2, maxFanOut: 4, maxDepth: 8, maxConcurrency: 2 } } })
  mocks.load.mockResolvedValue(loaded(state))
  mocks.receipt.mockResolvedValue(null)
  mocks.validate.mockResolvedValue(true)
  mocks.reconcile.mockResolvedValue(null)
  mocks.readGate.mockResolvedValue({ status: "gate_continuation", handoff: { executionId: "execution-1", executionAttemptCount: 1,
    continuationKey: "continuation-1" }, prepareProof: { receipt: { snapshotDigest: digest } } })
  mocks.verifyGate.mockResolvedValue(proof)
  mocks.preparedIds.mockReturnValue(approvedRefs)
  mocks.parseGate.mockReturnValue({ structuredResult: { status: "completed", approvedJobIds: approvedRefs } })
  mocks.budget.mockResolvedValue(undefined)
  mocks.capacity.mockImplementation((stateValue: TaskGraphState, proposalValue: TaskGraphProposal) => {
    const addedNodes = proposalValue.nodes.map((node, index) => ({ ...node, depth: index === proposalValue.nodes.length - 1 ? 6 : 5,
      status: "queued" as const }))
    return { ok: true, state: { ...stateValue, revision: stateValue.revision + 1, nodes: [...stateValue.nodes, ...addedNodes] }, addedNodes }
  })
  mocks.createTask.mockResolvedValueOnce({ id: "execute-task-a" }).mockResolvedValueOnce({ id: "execute-task-b" })
    .mockResolvedValueOnce({ id: "audit-task" })
  mocks.snapshot.mockImplementation((stateValue: TaskGraphState, taskIds: ReadonlyMap<string, string>, rootSuccessCriteria: readonly string[]) => ({
    schemaVersion: "agent-harness.v2.task-graph.v2", nodes: stateValue.nodes.map(node => ({ ...node, taskId: taskIds.get(node.key) ?? node.taskId })),
    rootSuccessCriteria,
  }))
}

beforeEach(() => { vi.resetAllMocks(); configure() })

describe("scheduled post-Gate PG plan command", () => {
  it("treats an ordinary native TaskGraph as not applicable before scheduled Gate proof parsing", async () => {
    const db = client()
    mocks.load.mockResolvedValue({ ...loaded(), discoveryTurnEligibility: "ordinary" })

    await expect(readScheduledPostGatePlanningContext(db as never, { scope } as never))
      .resolves.toEqual({ status: "not_applicable" })
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(mocks.readGate).not.toHaveBeenCalled()
  })

  it("treats an unknown user-source TaskGraph as not applicable before scheduled Gate proof parsing", async () => {
    const db = client()
    mocks.load.mockResolvedValue({ ...loaded(), discoveryTurnEligibility: "unknown" })

    await expect(readScheduledPostGatePlanningContext(db as never, { scope } as never))
      .resolves.toEqual({ status: "not_applicable" })
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(mocks.readGate).not.toHaveBeenCalled()
  })

  it("keeps a scheduled graph with invalid Gate proof fail-closed", async () => {
    const db = client()
    mocks.load.mockResolvedValue({ ...loaded(), discoveryTurnEligibility: "scheduled" })
    mocks.readGate.mockResolvedValue({ status: "invalid" })

    await expect(readScheduledPostGatePlanningContext(db as never, { scope } as never))
      .resolves.toEqual({ status: "invalid" })
    expect(mocks.readGate).toHaveBeenCalledOnce()
  })

  it("rejects a non-revise reconciliation operation before any database write", async () => {
    const db = client(), value = input()
    value.operation.decision = "keep" as never
    await expect(appendScheduledPostGatePlan(db as never, value as never))
      .rejects.toMatchObject({ code: "scheduled_post_gate_reconciliation_scope" })
    expect(db.query).not.toHaveBeenCalled()
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.writeReconcile).not.toHaveBeenCalled()
    expect(mocks.event).not.toHaveBeenCalled()
  })

  it("verifies completion from scope and persisted handoff without needing a fresh proposal", async () => {
    const db = client()
    mocks.lock.mockResolvedValue({})
    mocks.load.mockResolvedValue({ snapshot: null, state: null, item: null })
    mocks.receipt.mockResolvedValue(null)

    await expect(verifyScheduledPostGateCompletion(db as never, { scope } as never)).resolves.toBeNull()
    await expect(verifyScheduledPostGateCompletion(db as never, { scope, proposal: undefined, operation: undefined } as never))
      .resolves.toBeNull()
    expect(mocks.lock).toHaveBeenCalledWith(db, scope)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.writeReconcile).not.toHaveBeenCalled()
  })

  it("rejects a mismatched package partition before reconciliation, capacity, or task writes", async () => {
    const db = client(), valid = plan()
    const value = input({ ...valid, nodes: [valid.nodes[0]!, { ...valid.nodes[2]!, dependsOn: ["execute-a"] }] })
    await expect(appendScheduledPostGatePlan(db as never, value as never))
      .rejects.toMatchObject({ code: "scheduled_post_gate_proposal" })
    expect(mocks.verifyGate).toHaveBeenCalledOnce()
    expect(mocks.capacity).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.writePlan).not.toHaveBeenCalled()
  })

  it("rejects a stale lease owner before any graph read or plan write", async () => {
    const db = client(), value = input()
    const staleScope = { ...scope, turnLeaseOwner: "expired-lease" }
    mocks.lock.mockRejectedValue(new TaskGraphCommandError("task_graph_scope_stale", "The Turn lease is stale"))
    await expect(appendScheduledPostGatePlan(db as never, { ...value, scope: staleScope,
      operation: { ...value.operation, scope: staleScope } } as never)).rejects.toMatchObject({ code: "task_graph_scope_stale" })
    expect(mocks.lock).toHaveBeenCalledWith(db, staleScope, true)
    expect(db.query).toHaveBeenCalledOnce()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.capacity).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("rejects an idempotency replay with a different proposal digest", async () => {
    const db = client(), value = input()
    mocks.receipt.mockResolvedValue({ proposalDigest: scheduledPostGateDigest({ expectedRevision: 5, nodes: [] }) })
    await expect(appendScheduledPostGatePlan(db as never, value as never))
      .rejects.toMatchObject({ code: "scheduled_post_gate_idempotency_conflict" })
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(mocks.capacity).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.writePlan).not.toHaveBeenCalled()
    expect(mocks.event).not.toHaveBeenCalled()
  })

  it("fails closed when the persisted Gate proof cannot be verified", async () => {
    configure(null)
    const db = client()
    await expect(appendScheduledPostGatePlan(db as never, input() as never))
      .rejects.toMatchObject({ code: "scheduled_post_gate_gate_proof" })
    expect(mocks.capacity).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.writePlan).not.toHaveBeenCalled()
  })

  it("rejects capacity overflow without creating children or writing an accepted plan", async () => {
    mocks.capacity.mockReturnValue({ ok: false, error: { code: "node_limit" } })
    const db = client()
    await expect(appendScheduledPostGatePlan(db as never, input() as never))
      .rejects.toMatchObject({ code: "scheduled_post_gate_append" })
    expect(mocks.capacity).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.objectContaining({ maxNodes: 11 }))
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.writePlan).not.toHaveBeenCalled()
    expect(mocks.event).not.toHaveBeenCalled()
  })

  it("requires two remaining continuation steps before accepting the plan", async () => {
    mocks.budget.mockRejectedValueOnce(new BudgetExceededError("steps", 5, 2, 4))
    const db = client()
    await expect(appendScheduledPostGatePlan(db as never, input() as never))
      .rejects.toMatchObject({ code: "task_graph_continuation_budget_required" })
    expect(mocks.budget).toHaveBeenCalledWith(db, expect.objectContaining({ taskId: scope.rootTaskId }), 2)
    expect(mocks.capacity).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("accepts once, returns current task states on idempotent replay, and preserves bounded retries", async () => {
    const db = client(), value = input()
    const accepted = await appendScheduledPostGatePlan(db as never, value as never)
    expect(accepted).toMatchObject({ status: "accepted", revision: 6, readyTaskIds: ["execute-task-a", "execute-task-b"] })
    expect(accepted.nodes.map(node => node.status)).toEqual(["queued", "queued", "waiting"])
    expect(mocks.createTask).toHaveBeenNthCalledWith(1, db, expect.objectContaining({
      taskType: "scheduled_taskgraph_execute", policy: expect.objectContaining({ maxAttempts: 2 }),
    }), true, expect.any(Object))
    expect(mocks.createTask).toHaveBeenNthCalledWith(3, db, expect.objectContaining({
      taskType: "scheduled_taskgraph_post_gate_audit", policy: expect.objectContaining({ maxAttempts: 2 }),
    }), true, expect.any(Object))

    const storedHandoff = mocks.event.mock.calls[0]?.[1]?.payload
    expect(storedHandoff).toMatchObject({ graphRevision: 6, gateGraphRevision: 5, auditTaskId: "audit-task" })
    const replayGraph = { revision: 6, nodes: [
      graphNode("execute-a", SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, "execute-task-a", ["gate"], 5, "running"),
      graphNode("execute-b", SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, "execute-task-b", ["gate"], 5, "queued"),
      graphNode(SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, "audit-task",
        ["execute-a", "execute-b"], 6, "waiting"),
    ] }
    replayGraph.nodes[1] = { ...replayGraph.nodes[1]!, readiness: "ready" } as typeof replayGraph.nodes[number]
    mocks.load.mockResolvedValue({ ...loaded(), state: { ...baseState(), revision: 6 } })
    mocks.receipt.mockResolvedValue(storedHandoff)
    mocks.current.mockReturnValue(replayGraph)
    const duplicate = await appendScheduledPostGatePlan(db as never, value as never)
    expect(duplicate).toMatchObject({ status: "duplicate", revision: 6,
      nodes: [{ status: "running" }, { status: "queued" }, { status: "waiting" }], readyTaskIds: ["execute-task-b"] })
    expect(mocks.createTask).toHaveBeenCalledTimes(3)
    expect(mocks.writePlan).toHaveBeenCalledOnce()
    expect(mocks.event).toHaveBeenCalledOnce()
  })

  it("keeps the plan operation bound to the exact live scope and expected revision", async () => {
    const db = client(), value = input()
    value.operation.expectedRevision = 4
    await expect(appendScheduledPostGatePlan(db as never, value as never)).rejects.toBeInstanceOf(TaskGraphCommandError)
    expect(db.query).not.toHaveBeenCalled()
  })
})
