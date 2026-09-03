import { describe, expect, it, vi } from "vitest"

import { spawnScoutAnalystAndWait } from "./root-orchestration.js"
import type { AgentTreeManager } from "./manager.js"
import type { SubagentTaskRecord } from "./types.js"

function task(id: string, role: string): SubagentTaskRecord {
  return { id, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: `/root-1/${id}`, depth: 1, role, taskType: `${role}.read`, status: "queued", goal: role, constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {} }
}

describe("Scout/Analyst root orchestration", () => {
  it("spawns and dispatches both roles concurrently, then uses durable wait", async () => {
    const tasks = [task("task-scout", "scout"), task("task-analyst", "analyst")] as const
    const manager = { spawn: vi.fn().mockResolvedValueOnce(tasks[0]).mockResolvedValueOnce(tasks[1]) } as unknown as AgentTreeManager
    const dispatched: string[] = []
    let activeDispatches = 0
    let maxActiveDispatches = 0
    const wait = vi.fn(async (input: { targetTaskIds: readonly string[] }) => ({ waitId: "wait-1", status: "waiting" as const, deadlineAt: "2026-09-03T00:10:00.000Z", matchedTaskIds: [...input.targetTaskIds] }))
    const result = await spawnScoutAnalystAndWait(manager, { wait }, { userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", scoutGoal: "find jobs", analystGoal: "score jobs" }, async current => { activeDispatches += 1; maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches); dispatched.push(current.id); await Promise.resolve(); activeDispatches -= 1 }, { stepId: "step-1", timeoutMs: 10_000, idempotencyKey: "wait-1" })
    expect(manager.spawn).toHaveBeenCalledTimes(2)
    expect(dispatched).toEqual(["task-scout", "task-analyst"])
    expect(maxActiveDispatches).toBe(2)
    expect(result.tasks.map(item => item.rootTaskId)).toEqual(["root-1", "root-1"])
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ targetTaskIds: ["task-scout", "task-analyst"], mode: "all" }))
    expect(result.wait.status).toBe("waiting")
  })

  it("requires a runtime-owned parent so both children share one root", async () => {
    const manager = {} as AgentTreeManager
    await expect(spawnScoutAnalystAndWait(manager, {} as never, { userId: "u", sessionId: "s", turnId: "t", parentTaskId: "", scoutGoal: "s", analystGoal: "a" }, async () => undefined, { stepId: "step", timeoutMs: 1, idempotencyKey: "key" })).rejects.toThrow(/parent task/)
  })
})
