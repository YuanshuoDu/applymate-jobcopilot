import { describe, expect, it, vi } from "vitest"

import { RootTaskLifecycle, type RootLifecycleContext } from "./root-lifecycle.js"
import type { AgentTreeManager } from "./manager.js"
import type { CoordinationStore } from "../tools/coordination-types.js"

const context: RootLifecycleContext = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", rootTaskId: "root-a" }
function task(id: string, rootTaskId = "root-a", status: "queued" | "running" = "queued") {
  return { id, rootTaskId, status, userId: "user-a", sessionId: "session-a" } as never
}

describe("root subagent lifecycle", () => {
  it("waits, messages, and closes through runtime-owned scope", async () => {
    const wait = { wait: vi.fn(async () => ({ waitId: "wait-a", status: "ready" as const, deadlineAt: "2026-09-03T00:00:00.000Z", matchedTaskIds: ["child-a"] })) }
    const store = {
      getTask: vi.fn(async ({ taskId }: { taskId: string }) => task(taskId)),
      sendMessage: vi.fn(async () => ({ message: { id: "message-a" }, duplicate: false })),
    } as unknown as CoordinationStore
    const manager = { close: vi.fn(async () => true) } as unknown as AgentTreeManager
    const lifecycle = new RootTaskLifecycle(manager, store, wait)
    await expect(lifecycle.wait(context, { idempotencyKey: "wait-key", taskIds: ["child-a"] })).resolves.toMatchObject({ status: "ready" })
    await expect(lifecycle.message(context, { idempotencyKey: "message-key", targetTaskId: "child-a", kind: "result", payload: { ok: true } })).resolves.toMatchObject({ duplicate: false })
    await expect(lifecycle.close(context)).resolves.toBe(true)
    expect(wait.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", rootTaskId: "root-a", targetTaskIds: ["child-a"] }))
    expect(store.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", fromTaskId: "root-a", toTaskId: "child-a" }))
    expect(manager.close).toHaveBeenCalledWith("root-a", "session-a")
  })

  it("rejects cross-tree targets and running root close", async () => {
    const store = { getTask: vi.fn(async ({ taskId }: { taskId: string }) => task(taskId, taskId === "root-a" ? "root-a" : "other-root", taskId === "root-a" ? "running" : "queued")) } as unknown as CoordinationStore
    const manager = { close: vi.fn(async () => true) } as unknown as AgentTreeManager
    const lifecycle = new RootTaskLifecycle(manager, store)
    await expect(lifecycle.message(context, { idempotencyKey: "key", targetTaskId: "foreign", kind: "result", payload: {} })).rejects.toMatchObject({ code: "task_not_visible" })
    await expect(lifecycle.close(context)).rejects.toMatchObject({ code: "close_running" })
    expect(manager.close).not.toHaveBeenCalled()
  })
})
