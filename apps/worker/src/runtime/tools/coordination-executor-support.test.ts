import { describe, expect, it, vi } from "vitest"

import type { CoordinationTaskView } from "./coordination-types.js"
import {
  activity,
  assertSpawnReplay,
  boundedFailureReason,
  currentTurnTask,
  waitResult,
} from "./coordination-executor-support.js"
import { CoordinationError } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"

const context = (overrides: Record<string, unknown> = {}) => ({
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  reportProgress: vi.fn().mockResolvedValue(undefined), ...overrides,
}) as unknown as ToolExecutionContext

const task: CoordinationTaskView = {
  id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null,
  path: "/root-1/task-1", depth: 1, role: "scout", taskType: "research", status: "completed", goal: "inspect",
  attemptCount: 1, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
  result: null, failureReason: null,
}

describe("coordination executor support", () => {
  it("keeps task evidence scoped to the current Turn and rejects mismatched lineage", () => {
    expect(currentTurnTask(context(), task)).toBe(task)
    expect(() => currentTurnTask(context({ turnId: "turn-other" }), task)).toThrowError(CoordinationError)
    expect(() => assertSpawnReplay({ ...task, parentTaskId: "parent-other" }, context(), { parentTaskId: null, rootTaskId: "root-1" }))
      .toThrowError("Spawn replay does not match the current runtime lineage")
  })

  it("removes foreign identity keys from bounded wait results", () => {
    expect(waitResult({ taskId: "private-task", sessionId: "private-session", result: { safe: true } })).toEqual({ result: { safe: true } })
    expect(waitResult(null)).toBeNull()
  })

  it("bounds failure previews by UTF-8 bytes", () => {
    const result = boundedFailureReason(`${"a".repeat(499)}€`)
    expect(Buffer.byteLength(result ?? "", "utf8")).toBeLessThanOrEqual(500)
    expect(result).toBe("a".repeat(499))
  })

  it("persists activity even when the progress sink is unavailable", async () => {
    const appendActivity = vi.fn().mockResolvedValue(undefined)
    const reportProgress = vi.fn().mockRejectedValue(new Error("disconnected"))
    const options = { store: { appendActivity } } as unknown as Parameters<typeof activity>[1]
    await expect(activity(context({ reportProgress }), options, "spawn_subagent", "task-1", { status: "queued" }, "idem-1")).resolves.toBeUndefined()
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "idem-1:spawn_subagent", taskId: "task-1" }))
    expect(reportProgress).toHaveBeenCalledOnce()
  })
})
