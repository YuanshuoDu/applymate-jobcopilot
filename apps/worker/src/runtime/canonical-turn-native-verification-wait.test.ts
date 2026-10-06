import { describe, expect, it, vi } from "vitest"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import { waitForNativeVerification } from "./canonical-turn-native-verification-wait.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-2", turnLeaseOwner: "worker-1", turnLeaseVersion: 3, parentLeaseOwner: "worker-1", parentAttemptCount: 1,
}

describe("waitForNativeVerification", () => {
  it("uses the existing owned all-target wait without leaking the candidate", async () => {
    const wait = vi.fn(async (_input: Parameters<DurableWaitPort["wait"]>[0]) => ({ waitId: "wait-1", status: "waiting" as const, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [] }))
    const result = await waitForNativeVerification({ port: { wait } as unknown as DurableWaitPort, scope, targetTaskIds: ["control-1", "child-1"] })
    expect(result.status).toBe("waiting")
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      taskId: scope.rootTaskId, stepId: scope.stepId, targetTaskIds: ["child-1", "control-1"], mode: "all",
    }))
    expect(JSON.stringify(wait.mock.calls[0]?.[0])).not.toContain("candidate")
  })

  it("rejects empty, duplicate-root, and oversized wait target sets", async () => {
    const port = { wait: vi.fn() } as unknown as DurableWaitPort
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: [] })).rejects.toThrow("native_verification_wait_targets_invalid")
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: [scope.rootTaskId] })).rejects.toThrow("native_verification_wait_targets_invalid")
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: Array.from({ length: 9 }, (_, i) => `task-${i}`) })).rejects.toThrow("native_verification_wait_targets_invalid")
    expect(port.wait).not.toHaveBeenCalled()
  })
})
