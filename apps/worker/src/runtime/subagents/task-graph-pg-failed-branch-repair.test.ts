import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { findSteeringReconciliationReplay } from "./steering-reconciliation-ledger.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { assertTaskGraphBranchRepairToolCall } from "./steering-reconciliation-branch-repair-history.js"
import { scheduleTaskGraphBranchRepair } from "./task-graph-pg-branch-repair.js"
import { scheduleTaskGraphBranchOperation, selectFailedBranchDescendants } from "./task-graph-pg-failed-branch-repair.js"

vi.mock("./steering-reconciliation-ledger.js", () => ({ findSteeringReconciliationReplay: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: vi.fn() }))
vi.mock("./steering-reconciliation-branch-repair-history.js", () => ({ assertTaskGraphBranchRepairToolCall: vi.fn() }))
vi.mock("./task-graph-pg-branch-repair.js", () => ({
  assertReplacementSnapshot: vi.fn(), lockTaskGraphBranchSources: vi.fn(), scheduleTaskGraphBranchRepair: vi.fn(),
}))

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
} as const
const branch = { root: { nodeKey: "failed-scout", taskId: "task-scout" }, sources: [
  { nodeKey: "failed-scout", taskId: "task-scout", replacementKey: "fresh-scout" },
  { nodeKey: "cancelled-analyst", taskId: "task-analyst", replacementKey: "fresh-analyst" },
] } as const
const input = { scope, proposal: { expectedRevision: 4, nodes: [
  { key: "fresh-scout", templateId: "scout", goal: "Refresh", successCriteria: ["Find one"], dependsOn: [] },
  { key: "fresh-analyst", templateId: "analyst", goal: "Reassess", successCriteria: ["Score one"], dependsOn: ["fresh-scout"] },
] }, templates: {}, replaceBranch: branch } as unknown as TaskGraphScheduleInput
const operation: SteeringReconciliationOperation = {
  scope, decision: "revise", expectedRevision: 4, callId: "plan-call", replaceBranch: branch,
}
const client = { query: vi.fn() } as unknown as Queryable
const parent = { taskType: "root", role: "orchestrator", allowedActions: ["agent.plan"] }
const checkBudget = vi.fn(async () => undefined)
const replayMock = vi.mocked(findSteeringReconciliationReplay)
const loadMock = vi.mocked(loadTaskGraph)
const toolCallMock = vi.mocked(assertTaskGraphBranchRepairToolCall)
const legacyMock = vi.mocked(scheduleTaskGraphBranchRepair)

describe("scheduleTaskGraphBranchOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    replayMock.mockResolvedValue(null)
  })

  it("returns a strict stored replay before loading current graph state or checking budget", async () => {
    const stored = { status: "duplicate" as const, revision: 5, nodes: [], readyTaskIds: [] }
    replayMock.mockResolvedValue(stored)

    await expect(scheduleTaskGraphBranchOperation(client, input, parent, operation, checkBudget)).resolves.toBe(stored)
    expect(replayMock).toHaveBeenCalledTimes(1)
    expect(loadMock).not.toHaveBeenCalled()
    expect(legacyMock).not.toHaveBeenCalled()
    expect(checkBudget).not.toHaveBeenCalled()
  })

  it("maps a same-key changed request to conflict before reading the graph", async () => {
    replayMock.mockRejectedValue(new Error("steering_reconciliation_idempotency_conflict"))

    await expect(scheduleTaskGraphBranchOperation(client, input, parent, operation, checkBudget))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(loadMock).not.toHaveBeenCalled()
    expect(checkBudget).not.toHaveBeenCalled()
  })

  it("keeps a nonfailed source on the existing strict v3 path", async () => {
    loadMock.mockResolvedValue({ tasks: new Map([["task-scout", { status: "queued" }]]) } as never)
    const stored = { status: "accepted" as const, revision: 5, nodes: [], readyTaskIds: [] }
    legacyMock.mockResolvedValue(stored)

    await expect(scheduleTaskGraphBranchOperation(client, input, parent, operation, checkBudget)).resolves.toBe(stored)
    expect(legacyMock).toHaveBeenCalledWith(client, input, parent, operation, checkBudget)
    expect(toolCallMock).not.toHaveBeenCalled()
  })

  it("routes a failed root to v4 proof instead of reviving the v3 cancellation path", async () => {
    loadMock.mockResolvedValue({ tasks: new Map([["task-scout", { status: "failed" }]]) } as never)
    toolCallMock.mockRejectedValue(new Error("steering_reconciliation_branch_repair_event_invalid"))

    await expect(scheduleTaskGraphBranchOperation(client, input, parent, operation, checkBudget))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(toolCallMock).toHaveBeenCalledWith(client, scope, "plan-call", 4, branch)
    expect(legacyMock).not.toHaveBeenCalled()
    expect(checkBudget).not.toHaveBeenCalled()
  })
})

describe("selectFailedBranchDescendants", () => {
  it("selects the exact failed root when source order places its Analyst descendant first", () => {
    const sources = [
      { key: "analyst-child", taskId: "task-analyst", templateId: "analyst" },
      { key: "failed-scout", taskId: "task-scout", templateId: "scout" },
    ]
    expect(selectFailedBranchDescendants(sources, { nodeKey: "failed-scout", taskId: "task-scout" }))
      .toEqual({ failedRoot: sources[1], descendants: [sources[0]] })
    expect(selectFailedBranchDescendants(sources, { nodeKey: "failed-scout", taskId: "foreign-task" })).toBeNull()
  })
})
