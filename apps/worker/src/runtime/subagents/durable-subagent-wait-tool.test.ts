import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../tools/registry.js"
import type { ToolExecutionContext } from "../tools/types.js"
import type { SubagentLease } from "./types.js"

const mocks = vi.hoisted(() => ({ register: vi.fn() }))
vi.mock("./durable-subagent-wait-store.js", () => ({ registerDurableSubagentWait: mocks.register }))

import { createDurableSubagentWaitTool } from "./durable-subagent-wait-tool.js"

const lease = {
  id: "parent-child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", ownerId: "worker-1",
} as SubagentLease
const output = {
  waitId: "wait-1", status: "waiting", taskIds: ["child-1"], deadlineAt: "2026-10-22T10:00:00.000Z",
  matchedTaskIds: [], tasks: [],
}

describe("createDurableSubagentWaitTool", () => {
  it("registers through the durable wait store with the server lease and active step", async () => {
    mocks.register.mockResolvedValueOnce(output)
    const pool = { connect: vi.fn() }
    const definition = createDurableSubagentWaitTool(pool as never, lease)
    const input = { idempotencyKey: "wait-key", taskIds: ["child-1"], mode: "any" as const, timeoutMs: 5000 }
    const context = { stepId: "step-8" } as ToolExecutionContext

    await expect(definition.execute(context, input)).resolves.toEqual(output)
    expect(mocks.register).toHaveBeenCalledWith(pool, {
      lease, stepId: "step-8", idempotencyKey: "wait-key", targetTaskIds: ["child-1"], mode: "any", timeoutMs: 5000,
    })
    expect(definition).toMatchObject({ name: "wait_subagents", version: "1", risk: "internal_write", domain: "coordination", idempotency: "requires_key" })
  })

  it("exposes a closed input schema with bounded direct-child requests", () => {
    const tool = createDurableSubagentWaitTool({ connect: vi.fn() } as never, lease)
    const registry = new ToolRegistry([tool])
    expect(registry.validateArguments("wait_subagents", {
      idempotencyKey: "key", taskIds: ["child-1"], mode: "all", timeoutMs: 30_000,
    }, "1")).toBe(true)
    expect(registry.validateArguments("wait_subagents", {
      idempotencyKey: "key", taskIds: ["child-1"], mode: "all", timeoutMs: 30_000, taskId: "forged",
    }, "1")).not.toBe(true)
    expect(registry.validateArguments("wait_subagents", {
      idempotencyKey: "key", taskIds: [], mode: "all", timeoutMs: 30_000,
    }, "1")).not.toBe(true)
  })

  it("accepts eight targets and rejects a ninth before registering or opening the database", async () => {
    const pool = { connect: vi.fn() }
    const tool = createDurableSubagentWaitTool(pool as never, lease)
    const registry = new ToolRegistry([tool])
    const eightTargets = Array.from({ length: 8 }, (_, index) => `child-${index + 1}`)
    const nineTargets = [...eightTargets, "child-9"]
    const makeInput = (taskIds: string[]) => ({ idempotencyKey: "key", taskIds, mode: "all" as const, timeoutMs: 5_000 })
    const context = { stepId: "step-8" } as ToolExecutionContext

    expect(registry.validateArguments("wait_subagents", makeInput(eightTargets), "1")).toBe(true)
    expect(registry.validateArguments("wait_subagents", makeInput(nineTargets), "1")).not.toBe(true)

    mocks.register.mockReset().mockResolvedValueOnce(output)
    await expect(tool.execute(context, makeInput(eightTargets))).resolves.toEqual(output)
    expect(mocks.register).toHaveBeenCalledOnce()
    expect(mocks.register.mock.calls[0]?.[1]).toMatchObject({ targetTaskIds: eightTargets })

    mocks.register.mockClear()
    await expect(Promise.resolve().then(() => tool.execute(context, makeInput(nineTargets)))).rejects.toThrow("wait_invalid")
    expect(mocks.register).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it("accepts the legacy passed status in durable child results", () => {
    const tool = createDurableSubagentWaitTool({ connect: vi.fn() } as never, lease)
    const registry = new ToolRegistry([tool])
    const legacyResult = {
      waitId: "wait-1", status: "ready", taskIds: ["child-1"], deadlineAt: "2026-10-22T10:00:00.000Z",
      matchedTaskIds: ["child-1"],
      tasks: [{ taskId: "child-1", status: "passed", role: "scout", result: null, failureReason: null }],
    }

    expect(() => registry.validators.validate(tool.outputSchema, legacyResult, "wait_subagents output")).not.toThrow()
  })
})
