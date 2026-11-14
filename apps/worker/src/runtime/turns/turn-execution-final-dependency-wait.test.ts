import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionIdentity, TurnExecutionOptions } from "./turn-execution-types.js"
import { assertFinalDependencyWaitAvailable, prepareFinalDependencyWaitCall } from "./turn-execution-final-dependency-wait.js"

function taskIdentity(overrides: Partial<Extract<TurnExecutionIdentity, { kind: "task" }>> = {}): Extract<TurnExecutionIdentity, { kind: "task" }> {
  return {
    kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "parent-1", rootTaskId: "root-1",
    ownerId: "worker-1", attemptCount: 2, leaseExpiresAt: new Date("2026-11-13T12:00:00Z"), ...overrides,
  }
}

describe("private final dependency wait call", () => {
  it("builds a deterministic owner, attempt, and step scoped wait_subagents call", () => {
    const identity = taskIdentity(), step = { id: "step-4", ordinal: 4 }
    const first = prepareFinalDependencyWaitCall(identity, step, { taskIds: ["child-b", "child-a"] })
    const replay = prepareFinalDependencyWaitCall(identity, step, { taskIds: ["child-a", "child-b"] })

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ name: "wait_subagents", arguments: { taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 30_000 } })
    expect(first?.id).toMatch(/^final-dependency-wait:[a-f0-9]{64}$/)
    expect(first?.arguments).toMatchObject({ idempotencyKey: first?.id })
    expect(prepareFinalDependencyWaitCall(taskIdentity({ attemptCount: 3 }), step, { taskIds: ["child-a"] })?.id).not.toBe(first?.id)
    expect(prepareFinalDependencyWaitCall(identity, { ...step, id: "step-5" }, { taskIds: ["child-a"] })?.id).not.toBe(first?.id)
  })

  it.each([
    undefined,
    {},
    { taskIds: [] },
    { taskIds: ["child-a", "child-a"] },
    { taskIds: ["parent-1"] },
    { taskIds: ["root-1"] },
    { taskIds: ["child-a", "child-b", "child-c"] },
    { taskIds: ["child with spaces"] },
    { taskIds: ["child-a"], extra: true },
  ])("rejects malformed or non-child wait target requests (%j)", request => {
    expect(() => prepareFinalDependencyWaitCall(taskIdentity(), { id: "step-4", ordinal: 4 }, request)).toThrow(/Final dependency wait targets are invalid/)
  })

  it("returns null only for the explicit no-wait result", () => {
    expect(prepareFinalDependencyWaitCall(taskIdentity(), { id: "step-4", ordinal: 4 }, null)).toBeNull()
  })

  it("fails closed unless wait_subagents is registered and its exact input validates", () => {
    const call = prepareFinalDependencyWaitCall(taskIdentity(), { id: "step-4", ordinal: 4 }, { taskIds: ["child-a"] })!
    const validateToolArguments = vi.fn(() => true)
    const options = (tools: readonly unknown[], validator?: TurnExecutionOptions["validateToolArguments"]) => ({ tools, validateToolArguments: validator }) as TurnExecutionOptions

    assertFinalDependencyWaitAvailable(options([{ name: "wait_subagents", version: "1" }], validateToolArguments), call)
    expect(validateToolArguments).toHaveBeenCalledWith("wait_subagents", call.arguments)
    expect(() => assertFinalDependencyWaitAvailable(options([]), call)).toThrow(/capability is unavailable/)
    expect(() => assertFinalDependencyWaitAvailable(options([{ name: "wait_subagents", version: "2" }]), call)).toThrow(/capability is unavailable/)
    expect(() => assertFinalDependencyWaitAvailable(options([{ name: "wait_subagents", version: "1" }], () => "invalid"), call)).toThrow(/capability is unavailable/)
    expect(() => assertFinalDependencyWaitAvailable(options([{ name: "wait_subagents", version: "1" }], undefined), call)).toThrow(/capability is unavailable/)
  })
})
