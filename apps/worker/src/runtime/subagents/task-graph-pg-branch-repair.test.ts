import { describe, expect, it, vi } from "vitest"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { replayTaskGraphBranchRepairIfPresent, scheduleTaskGraphBranchRepair } from "./task-graph-pg-branch-repair.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
} as const
const branch = { root: { nodeKey: "source-scout", taskId: "task-scout" }, sources: [
  { nodeKey: "source-scout", taskId: "task-scout", replacementKey: "replacement-scout" },
  { nodeKey: "source-analyst", taskId: "task-analyst", replacementKey: "replacement-analyst" },
] } as const

describe("scheduleTaskGraphBranchRepair", () => {
  it("checks a stored v3 receipt without loading current graph state when none exists", async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const client = { query } as unknown as Queryable
    const input = { scope, proposal: { expectedRevision: 3, nodes: [] }, templates: {} } as unknown as TaskGraphScheduleInput
    const operation: SteeringReconciliationOperation = { scope, decision: "revise", expectedRevision: 3, callId: "call-1", replaceBranch: branch }

    await expect(replayTaskGraphBranchRepairIfPresent(client, input, operation)).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('FROM "agent_events" AS event')
  })

  it("rejects an existing malformed operation receipt before inspecting a changed request", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "event-1", sequence: "1", turnId: "turn-1", itemId: null,
      taskId: "root-1", type: "agent.plan.reconciliation", actor: "orchestrator", correlationId: "turn-1",
      causationId: "step-1", idempotencyKey: "agent.plan.reconciliation:sha256:" + "a".repeat(64), payload: {}, hasOutbox: false }] }))
    const client = { query } as unknown as Queryable
    const input = { scope, proposal: { expectedRevision: 3, nodes: [] }, templates: {} } as unknown as TaskGraphScheduleInput
    const operation: SteeringReconciliationOperation = { scope, decision: "revise", expectedRevision: 3, callId: "call-1", replaceBranch: branch }
    const checkBudget = vi.fn(async () => undefined)

    await expect(scheduleTaskGraphBranchRepair(client, input, {}, operation, checkBudget))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(query).toHaveBeenCalledTimes(1)
    expect(checkBudget).not.toHaveBeenCalled()
  })
})
