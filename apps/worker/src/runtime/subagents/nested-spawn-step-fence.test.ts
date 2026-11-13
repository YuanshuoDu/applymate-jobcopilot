import { describe, expect, it, vi } from "vitest"
import { captureParentExecutionStepFence, assertCurrentParentExecutionStep } from "./nested-spawn-step-fence.js"
import type { SubagentParentExecutionFence } from "./parent-execution-fence.js"
import type { Queryable } from "./pg-store-persistence.js"

const step = { stepId: "step-1", toolCallId: "call-1" }
const parent: SubagentParentExecutionFence = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "owner-1", attemptCount: 3, step,
}

describe("nested spawn step fence", () => {
  it("copies only the exact bounded step and call identifiers", () => {
    const captured = captureParentExecutionStepFence(step)
    expect(captured).toEqual(step)
    expect(captured).not.toBe(step)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(() => captureParentExecutionStepFence({ ...step, taskId: "caller-controlled" })).toThrow()
  })

  it.each([null, {}, { ...step, toolCallId: " " }, { ...step, stepId: "x".repeat(257) }])(
    "rejects malformed step fence %#", value => expect(() => captureParentExecutionStepFence(value)).toThrow(),
  )

  it("locks the current streaming step and its exact in-flight Scout delegate call", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: step.stepId }], rowCount: 1 }))
    await expect(assertCurrentParentExecutionStep({ query } as unknown as Queryable, parent)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE OF step, item"), [
      step.stepId, parent.sessionId, parent.turnId, parent.id, parent.attemptCount, step.toolCallId,
    ])
  })

  it("rejects a missing or closed step before any spawn can proceed", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(assertCurrentParentExecutionStep({ query } as unknown as Queryable, parent)).rejects.toMatchObject({ code: "lost" })
    expect(query).toHaveBeenCalledOnce()
  })

  it("preserves the legacy no-step fence behavior", async () => {
    const query = vi.fn()
    await expect(assertCurrentParentExecutionStep({ query } as unknown as Queryable, { ...parent, step: undefined })).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})
