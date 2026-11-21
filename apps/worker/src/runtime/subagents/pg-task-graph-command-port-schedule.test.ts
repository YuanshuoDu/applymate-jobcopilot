import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { scheduleTaskGraph } from "./pg-task-graph-command-port-schedule.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"

const schedulerMocks = vi.hoisted(() => ({
  lock: vi.fn(), load: vi.fn(), create: vi.fn(), planReceipt: vi.fn(), noSteering: vi.fn(), budget: vi.fn(),
  prepare: vi.fn(), reconciliationReceipt: vi.fn(), stamp: vi.fn(),
}))

vi.mock("./task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-state.js")>()
  return { ...actual, lockTaskGraphScope: schedulerMocks.lock, loadTaskGraph: schedulerMocks.load }
})
vi.mock("./task-graph-pg-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-create.js")>(), createGraphTasks: schedulerMocks.create,
}))
vi.mock("./task-graph-pg-events.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-events.js")>(), writePlanReceipt: schedulerMocks.planReceipt,
}))
vi.mock("./pg-store-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-store-create.js")>(), assertPlanningRootHasNoUnresolvedSteering: schedulerMocks.noSteering,
}))
vi.mock("../turns/turn-engine-root-budget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../turns/turn-engine-root-budget.js")>(), enforceRootStepBudget: schedulerMocks.budget,
}))
vi.mock("./steering-reconciliation-ledger.js", async importOriginal => ({
  ...await importOriginal<typeof import("./steering-reconciliation-ledger.js")>(),
  prepareSteeringReconciliation: schedulerMocks.prepare, writeSteeringReconciliationReceipt: schedulerMocks.reconciliationReceipt,
}))
vi.mock("./task-graph-pg-supersession.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-supersession.js")>(), stampCreatedScoutEnvelopes: schedulerMocks.stamp,
}))

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
} as const

function inputFor(templateId: string, key = templateId): TaskGraphScheduleInput {
  return {
    scope,
    proposal: { expectedRevision: 0, nodes: [{ key, templateId, goal: "Private scheduled work", successCriteria: [], dependsOn: [] }] },
    templates: { [templateId]: { role: "analyst", taskType: "analysis", allowedActions: [] } },
  }
}

describe("scheduleTaskGraph private scheduled nodes", () => {
  it.each([
    ["scheduled Gate", "gate", "scheduled_gate_private"],
    ["scheduled Audit", SCHEDULED_AUDIT_TEMPLATE_ID, "scheduled_audit_private"],
  ])("rejects the %s before database work", async (_name, templateId, code) => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Queryable

    await expect(scheduleTaskGraph(client, inputFor(templateId))).rejects.toMatchObject({ code })
    expect(query).not.toHaveBeenCalled()
  })
})

const parent = { allowedActions: ["agent.plan"], budgetSnapshot: { subagentPolicy: { maxConcurrency: 4, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } }
const currentScope = { ...scope }

function scoutInput(expectedRevision: number): TaskGraphScheduleInput {
  return {
    scope: currentScope,
    proposal: { expectedRevision, nodes: [{ key: `scout-${expectedRevision}`, templateId: "scout", goal: "Discover roles", successCriteria: ["Report evidence"], dependsOn: [] }] },
    templates: { scout: TASK_GRAPH_TEMPLATES.scout },
  }
}

function graphAt(revision: number) {
  return revision === 0
    ? { rootTaskId: scope.rootTaskId, item: null, snapshot: null, state: null, tasks: new Map() }
    : { rootTaskId: scope.rootTaskId, item: { id: "graph-item", revision, content: {}, createdAt: new Date() },
      snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", nodes: [] },
      state: { revision, nodes: [], appliedEvents: [] }, tasks: new Map() }
}

describe("scheduleTaskGraph objective Scout opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schedulerMocks.lock.mockResolvedValue(parent as never)
    schedulerMocks.noSteering.mockResolvedValue(undefined as never)
    schedulerMocks.budget.mockResolvedValue(undefined as never)
    schedulerMocks.planReceipt.mockResolvedValue(undefined as never)
    schedulerMocks.prepare.mockResolvedValue({} as never)
    schedulerMocks.reconciliationReceipt.mockResolvedValue(undefined as never)
    schedulerMocks.stamp.mockImplementation(async (snapshot: unknown) => snapshot)
  })

  it("opts in for the normal initial append", async () => {
    const loaded = graphAt(0)
    schedulerMocks.load.mockResolvedValue(loaded as never)
    schedulerMocks.create.mockResolvedValue({ state: { revision: 1 }, snapshot: {}, created: [], readyTaskIds: [] } as never)
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Queryable

    await scheduleTaskGraph(client, scoutInput(0))

    expect(schedulerMocks.create).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.create.mock.calls[0]?.[1]).toMatchObject({ proposal: { expectedRevision: 0 } })
    expect(schedulerMocks.create.mock.calls[0]?.[5]).toBe(loaded)
    expect(schedulerMocks.create.mock.calls[0]?.[7]).toBe(true)
  })

  it("keeps the opt-in on a normal reconciled revise at a later revision", async () => {
    const revision = 4, loaded = graphAt(revision)
    const prepared = { decision: "revise", expectedRevision: revision } as never
    schedulerMocks.load.mockResolvedValue(loaded as never)
    schedulerMocks.prepare.mockResolvedValue(prepared)
    schedulerMocks.create.mockResolvedValue({ state: { revision: revision + 1 }, snapshot: {}, created: [], readyTaskIds: [] } as never)
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Queryable
    const operation: SteeringReconciliationOperation = { scope: currentScope, decision: "revise", expectedRevision: revision, callId: "plan-call" }

    await scheduleTaskGraph(client, scoutInput(revision), operation)

    expect(schedulerMocks.create).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.create.mock.calls[0]?.[5]).toBe(loaded)
    expect(schedulerMocks.create.mock.calls[0]?.[7]).toBe(true)
    expect(schedulerMocks.create.mock.calls[0]?.[8]).toBe(prepared)
  })
})
