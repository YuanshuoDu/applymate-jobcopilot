import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import { waitForNativeVerification } from "./canonical-turn-native-verification-wait.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-2", turnLeaseOwner: "worker-1", turnLeaseVersion: 3, parentLeaseOwner: "worker-1", parentAttemptCount: 1,
}

describe("waitForNativeVerification", () => {
  it("preserves the existing bounded key and owned all-target wait without leaking the candidate", async () => {
    const wait = vi.fn(async (_input: Parameters<DurableWaitPort["wait"]>[0]) => ({ waitId: "wait-1", status: "waiting" as const, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [] }))
    const result = await waitForNativeVerification({ port: { wait } as unknown as DurableWaitPort, scope, targetTaskIds: ["control-1", "child-1", "child-1"] })
    expect(result.status).toBe("waiting")
    const targetDigest = createHash("sha256").update("child-1\0control-1", "utf8").digest("hex")
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      taskId: scope.rootTaskId, stepId: scope.stepId, targetTaskIds: ["child-1", "control-1"], mode: "all",
      timeoutMs: 24 * 60 * 60 * 1_000,
      idempotencyKey: `native-verification:${scope.rootTaskId}:${scope.stepId}:${targetDigest}`,
    }))
    expect(JSON.stringify(wait.mock.calls[0]?.[0])).not.toContain("candidate")
  })

  it("hashes only overflowing UTF-8 identities and binds the complete immutable tuple", async () => {
    const longScope: TaskGraphExecutionScope = {
      ...scope,
      userId: `user-${"é".repeat(40)}`, sessionId: `session-${"é".repeat(40)}`, turnId: `turn-${"é".repeat(40)}`,
      rootTaskId: `root-${"é".repeat(70)}`, parentTaskId: `root-${"é".repeat(70)}`,
      stepId: `step-${"é".repeat(70)}`,
    }
    const targets = ["control-1", `child-${"é".repeat(60)}`]
    const identityValues = [longScope.userId, longScope.sessionId, longScope.turnId, longScope.rootTaskId, longScope.stepId, ...targets]
    expect(identityValues.every(value => Buffer.byteLength(value, "utf8") <= 256)).toBe(true)
    expect(targets.every(value => value.length <= 128)).toBe(true)
    const legacyShape = `native-verification:${longScope.rootTaskId}:${longScope.stepId}:${"0".repeat(64)}`
    expect(legacyShape.length).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(legacyShape, "utf8")).toBeGreaterThan(256)

    const keyFor = async (selectedScope: TaskGraphExecutionScope, selectedTargets: readonly string[]) => {
      const wait = vi.fn(async (_input: Parameters<DurableWaitPort["wait"]>[0]) => ({ waitId: "wait-1", status: "waiting" as const, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [] }))
      await waitForNativeVerification({ port: { wait } as unknown as DurableWaitPort, scope: selectedScope, targetTaskIds: selectedTargets })
      return wait.mock.calls[0]?.[0].idempotencyKey
    }
    const key = await keyFor(longScope, targets)
    expect(Buffer.byteLength(key ?? "", "utf8")).toBeLessThanOrEqual(256)
    expect(key).toMatch(/^native-verification:v2:[0-9a-f]{64}$/)

    const rotatedLease = { ...longScope, turnLeaseOwner: "new-lease", turnLeaseVersion: 99, parentLeaseOwner: "new-parent-lease", parentAttemptCount: 7 }
    await expect(keyFor(rotatedLease, [targets[1]!, targets[0]!, targets[0]!])).resolves.toBe(key)
    await expect(keyFor({ ...longScope, parentTaskId: "unforwarded-parent" }, targets)).resolves.toBe(key)
    await expect(keyFor({ ...longScope, userId: `${longScope.userId}x` }, targets)).resolves.not.toBe(key)
    await expect(keyFor({ ...longScope, sessionId: `${longScope.sessionId}x` }, targets)).resolves.not.toBe(key)
    await expect(keyFor({ ...longScope, turnId: `${longScope.turnId}x` }, targets)).resolves.not.toBe(key)
    await expect(keyFor({ ...longScope, rootTaskId: `${longScope.rootTaskId}x`, parentTaskId: `${longScope.parentTaskId}x` }, targets)).resolves.not.toBe(key)
    await expect(keyFor({ ...longScope, stepId: `${longScope.stepId}x` }, targets)).resolves.not.toBe(key)
    await expect(keyFor(longScope, [`${targets[0]}x`, targets[1]!])).resolves.not.toBe(key)
  })

  it("preserves the legacy key at 256 bytes and versions only the 257-byte overflow", async () => {
    const keyFor = async (rootTaskId: string, stepId: string) => {
      const wait = vi.fn(async (_input: Parameters<DurableWaitPort["wait"]>[0]) => ({ waitId: "wait-1", status: "waiting" as const, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [] }))
      await waitForNativeVerification({ port: { wait } as unknown as DurableWaitPort, scope: { ...scope, rootTaskId, parentTaskId: rootTaskId, stepId }, targetTaskIds: ["control-1"] })
      return wait.mock.calls[0]?.[0].idempotencyKey
    }
    const exactRoot = "r".repeat(85)
    const exactStep = "s".repeat(85)
    const exactLegacy = `native-verification:${exactRoot}:${exactStep}:${createHash("sha256").update("control-1", "utf8").digest("hex")}`
    expect(Buffer.byteLength(exactLegacy, "utf8")).toBe(256)
    await expect(keyFor(exactRoot, exactStep)).resolves.toBe(exactLegacy)

    const overflowStep = "s".repeat(86)
    const overflowLegacy = `native-verification:${exactRoot}:${overflowStep}:${"0".repeat(64)}`
    expect(Buffer.byteLength(overflowLegacy, "utf8")).toBe(257)
    const overflow = await keyFor(exactRoot, overflowStep)
    expect(overflow).toMatch(/^native-verification:v2:[0-9a-f]{64}$/)
    expect(Buffer.byteLength(overflow ?? "", "utf8")).toBeLessThanOrEqual(256)
  })

  it("rejects empty, duplicate-root, and oversized wait target sets", async () => {
    const port = { wait: vi.fn() } as unknown as DurableWaitPort
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: [] })).rejects.toThrow("native_verification_wait_targets_invalid")
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: [scope.rootTaskId] })).rejects.toThrow("native_verification_wait_targets_invalid")
    await expect(waitForNativeVerification({ port, scope, targetTaskIds: Array.from({ length: 9 }, (_, i) => `task-${i}`) })).rejects.toThrow("native_verification_wait_targets_invalid")
    expect(port.wait).not.toHaveBeenCalled()
  })
})
