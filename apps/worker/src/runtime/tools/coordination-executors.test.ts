import { describe, expect, it, vi } from "vitest"

import { AgentTreeManager } from "../subagents/manager.js"
import {
  executeCloseSubagent,
  executeInterruptSubagent,
  executeListSubagents,
  executeSendMessage,
  executeSpawn,
  executeWaitSubagents,
} from "./coordination-executors.js"
import type {
  CloseSubagentInput,
  InterruptSubagentInput,
  ListSubagentsInput,
  SendMessageInput,
  SpawnSubagentInput,
  WaitSubagentsInput,
} from "./coordination-tools.js"
import type {
  CoordinationMessage,
  CoordinationRuntimeOptions,
  CoordinationStore,
  CoordinationTaskView,
  DurableWaitPort,
} from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"

const baseTask: CoordinationTaskView = {
  id: "root-1", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-1", parentTaskId: null,
  path: "/root-1", depth: 0, role: "orchestrator", taskType: "root", status: "running", goal: "root goal",
  attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: null, interruptRequestedAt: null,
}

function makeTask(overrides: Partial<CoordinationTaskView> = {}): CoordinationTaskView {
  return { ...baseTask, ...overrides }
}

class MemoryCoordinationStore implements CoordinationStore {
  readonly tasks = new Map<string, CoordinationTaskView>([[baseTask.id, baseTask]])
  readonly spawnOperations = new Map<string, string>()
  readonly messages: CoordinationMessage[] = []
  readonly activities: string[] = []

  async getTask(input: { userId: string; sessionId: string; taskId: string }): Promise<CoordinationTaskView | null> {
    const task = this.tasks.get(input.taskId)
    return task?.userId === input.userId && task.sessionId === input.sessionId ? task : null
  }

  async listTasks(input: { userId: string; sessionId: string; rootTaskId?: string; includeTerminal: boolean }): Promise<CoordinationTaskView[]> {
    return [...this.tasks.values()].filter(task => task.userId === input.userId && task.sessionId === input.sessionId &&
      (!input.rootTaskId || task.rootTaskId === input.rootTaskId) && (input.includeTerminal || !["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)))
  }

  async sendMessage(input: { userId: string; sessionId: string; turnId: string; fromTaskId: string | null; toTaskId: string; kind: string; payload: unknown; idempotencyKey: string }): Promise<{ message: CoordinationMessage; duplicate: boolean }> {
    const existing = this.messages.find(message => message.idempotencyKey === input.idempotencyKey)
    if (existing) return { message: existing, duplicate: true }
    const message = { id: `message-${this.messages.length + 1}`, sessionId: input.sessionId, turnId: input.turnId, fromTaskId: input.fromTaskId, toTaskId: input.toTaskId, kind: input.kind, idempotencyKey: input.idempotencyKey, createdAt: new Date("2026-09-03T00:00:00.000Z") }
    this.messages.push(message)
    return { message, duplicate: false }
  }

  async getSpawnReplay(input: { userId: string; sessionId: string; idempotencyKey: string }): Promise<CoordinationTaskView | null> {
    const taskId = this.spawnOperations.get(`${input.sessionId}:${input.idempotencyKey}`)
    return taskId ? this.getTask({ ...input, taskId }) : null
  }

  async recordSpawn(input: { userId: string; sessionId: string; idempotencyKey: string; task: CoordinationTaskView }): Promise<boolean> {
    const key = `${input.sessionId}:${input.idempotencyKey}`
    if (this.spawnOperations.has(key)) return false
    this.spawnOperations.set(key, input.task.id)
    return true
  }

  async appendActivity(input: { operation: string }): Promise<void> { this.activities.push(input.operation) }
}

function makeRuntime() {
  const store = new MemoryCoordinationStore()
  let nextTask = 1
  const manager = {
    spawn: vi.fn(async (input: { userId: string; sessionId: string; turnId?: string | null; parentTaskId?: string | null; role: string; taskType: string; goal: string }) => {
      const parent = input.parentTaskId ? store.tasks.get(input.parentTaskId) : undefined
      const task = makeTask({
        id: `child-${nextTask++}`, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? null,
        rootTaskId: parent?.rootTaskId ?? `child-${nextTask - 1}`, parentTaskId: parent?.id ?? null,
        path: `${parent?.path ?? ""}/child-${nextTask - 1}`, depth: (parent?.depth ?? -1) + 1,
        role: input.role, taskType: input.taskType, goal: input.goal, status: "queued", leaseOwner: null,
      })
      store.tasks.set(task.id, task)
      return task
    }),
    close: vi.fn(async (taskId: string, sessionId: string) => {
      const task = store.tasks.get(taskId)
      if (!task || task.sessionId !== sessionId || task.status === "running") return false
      store.tasks.set(taskId, { ...task, status: "closed" })
      return true
    }),
    interrupt: vi.fn(async (sessionId: string, rootTaskId: string) => {
      let count = 0
      for (const task of store.tasks.values()) if (task.sessionId === sessionId && task.rootTaskId === rootTaskId && task.status !== "completed") count += 1
      return count
    }),
    interruptSubtree: vi.fn(async (sessionId: string, rootTaskId: string, targetPath: string) => {
      let count = 0
      for (const task of store.tasks.values()) if (task.sessionId === sessionId && task.rootTaskId === rootTaskId
        && (task.path === targetPath || task.path.startsWith(`${targetPath}/`)) && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)) count += 1
      return count
    }),
  } as unknown as AgentTreeManager
  const wait = {
    wait: vi.fn(async (input: { targetTaskIds: readonly string[] }) => ({ waitId: "wait-1", status: "ready" as const, deadlineAt: "2026-09-03T00:01:00.000Z", matchedTaskIds: [...input.targetTaskIds] })),
    cancel: vi.fn(async () => undefined),
  } satisfies DurableWaitPort
  const options: CoordinationRuntimeOptions = { manager, store, wait }
  return { store, manager, wait, options }
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", signal: new AbortController().signal,
    capabilities: ["canManageChildren"], reportProgress: async () => undefined, toolCallId: "call-a", ...overrides,
  }
}

describe("coordination executors", () => {
  it("spawns through the manager, records durable dispatch, and replays by key", async () => {
    const runtime = makeRuntime()
    const input: SpawnSubagentInput = { idempotencyKey: "spawn-1", role: "scout", taskType: "inspect", goal: "Inspect the job" }
    const first = await executeSpawn(context(), input, runtime.options)
    const second = await executeSpawn(context({ toolCallId: "call-b" }), input, runtime.options)
    expect(first).toMatchObject({ taskId: "child-1", parentTaskId: null, replay: false })
    expect(second).toMatchObject({ taskId: "child-1", replay: true })
    expect((runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    expect(runtime.store.spawnOperations.get("session-a:spawn-1")).toBe("child-1")
    expect(runtime.store.activities).toContain("spawn_subagent")
  })

  it("uses the production atomic spawn seam without a second spawn transaction", async () => {
    const runtime = makeRuntime()
    const task = makeTask({ id: "child-atomic", status: "queued", path: "/child-atomic" })
    runtime.manager.supportsAtomicSpawn = vi.fn(() => true)
    runtime.manager.spawnAtomic = vi.fn(async () => ({ task: task as never, duplicate: false, atomic: true }))
    runtime.store.recordSpawn = vi.fn(async () => { throw new Error("recordSpawn must not run") })
    const result = await executeSpawn(context(), { idempotencyKey: "spawn-atomic", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options)
    expect(result).toMatchObject({ taskId: "child-atomic", replay: false })
    expect(runtime.manager.spawnAtomic).toHaveBeenCalledOnce()
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
  })

  it("replays an atomic duplicate without closing the winner", async () => {
    const runtime = makeRuntime()
    const task = makeTask({ id: "child-winner", status: "queued", path: "/child-winner" })
    runtime.store.tasks.set(task.id, task)
    runtime.store.spawnOperations.set("session-a:spawn-atomic", task.id)
    runtime.manager.supportsAtomicSpawn = vi.fn(() => true)
    runtime.manager.spawnAtomic = vi.fn(async () => ({ task: null, duplicate: true, atomic: true }))
    const result = await executeSpawn(context(), { idempotencyKey: "spawn-atomic", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options)
    expect(result).toMatchObject({ taskId: "child-winner", replay: true })
    expect(runtime.manager.close).not.toHaveBeenCalled()
    expect(runtime.store.activities).toContain("spawn_subagent")
  })

  it("does not pass an injected expected output schema to the manager", async () => {
    const runtime = makeRuntime()
    const input = {
      idempotencyKey: "spawn-raw",
      role: "scout",
      taskType: "inspect",
      goal: "Inspect the job",
      expectedOutputSchema: { schemaVersion: "forged", role: "analyst" },
    } as unknown as SpawnSubagentInput

    await executeSpawn(context(), input, runtime.options)

    const spawn = runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("expectedOutputSchema")
  })

  it("sends idempotent mailbox messages without implicitly spawning", async () => {
    const runtime = makeRuntime()
    const input: SendMessageInput = { idempotencyKey: "message-1", taskId: "root-1", kind: "result", payload: { ok: true } }
    await expect(executeSendMessage(context(), input, runtime.options)).resolves.toMatchObject({ status: "queued" })
    await expect(executeSendMessage(context({ toolCallId: "call-b" }), input, runtime.options)).resolves.toMatchObject({ status: "duplicate" })
    expect(runtime.store.messages).toHaveLength(1)
    expect((runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it("does not reveal a task that belongs to another tenant or session", async () => {
    const runtime = makeRuntime()
    runtime.store.tasks.set("foreign", makeTask({ id: "foreign", userId: "user-b", sessionId: "session-b", rootTaskId: "foreign", path: "/foreign" }))
    await expect(executeSendMessage(context(), { idempotencyKey: "foreign-1", taskId: "foreign", kind: "probe", payload: null }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(executeSendMessage(context(), { idempotencyKey: "foreign-1", taskId: "foreign", kind: "probe", payload: null }, runtime.options))
      .rejects.toThrow("Subagent task is unavailable")
  })

  it.each(["target", "sender"] as const)("fails closed when the %s task belongs to another turn", async side => {
    const runtime = makeRuntime()
    const crossed = makeTask({ id: "crossed", turnId: "turn-old", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/crossed", depth: 1 })
    runtime.store.tasks.set(crossed.id, crossed)
    const caller = side === "sender" ? context({ taskId: crossed.id, rootTaskId: "root-1" }) : context()
    const taskId = side === "target" ? crossed.id : "root-1"

    await expect(executeSendMessage(caller, { idempotencyKey: `cross-turn-${side}`, taskId, kind: "probe", payload: null }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_task_not_found" })
    expect(runtime.store.messages).toHaveLength(0)
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("delegates wait to the durable AH2-025 port and never starts a Worker", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, status: "queued" })
    runtime.store.tasks.set(child.id, child)
    const input: WaitSubagentsInput = { idempotencyKey: "wait-1", taskIds: [child.id], mode: "any", timeoutMs: 5000 }
    await expect(executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)).resolves.toMatchObject({ status: "ready", matchedTaskIds: ["child"] })
    expect(runtime.wait.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", taskId: "root-1", rootTaskId: "root-1", targetTaskIds: ["child"], timeoutMs: 5000 }))
  })

  it("rejects a wait target from another turn before waiting or recording activity", async () => {
    const runtime = makeRuntime()
    const stale = makeTask({ id: "stale", turnId: "turn-old", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/stale", depth: 1, status: "queued" })
    runtime.store.tasks.set(stale.id, stale)

    await expect(executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "wait-cross-turn", taskIds: [stale.id], mode: "any", timeoutMs: 5000 }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_task_not_found" })
    expect(runtime.wait.wait).not.toHaveBeenCalled()
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("lists only the current tree and protects close/interrupt transitions", async () => {
    const runtime = makeRuntime()
    runtime.store.tasks.set("queued", makeTask({ id: "queued", rootTaskId: "root-1", path: "/root-1/queued", status: "queued" }))
    runtime.store.tasks.set("done", makeTask({ id: "done", rootTaskId: "root-1", path: "/root-1/done", status: "completed" }))
    await expect(executeListSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { includeTerminal: false } satisfies ListSubagentsInput, runtime.options))
      .resolves.toMatchObject({ tasks: [expect.objectContaining({ taskId: "queued" })] })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "root-1" } satisfies CloseSubagentInput, runtime.options))
      .rejects.toMatchObject({ code: "coordination_close_not_allowed" })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "queued" } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ status: "closed", closed: true })
    await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "queued", reason: "stop" } satisfies InterruptSubagentInput, runtime.options))
      .resolves.toMatchObject({ rootTaskId: "root-1", status: "interrupt_requested" })
    expect(runtime.manager.interruptSubtree).toHaveBeenCalledWith("session-a", "root-1", "/root-1/queued")
    expect(runtime.wait.cancel).toHaveBeenCalledWith(expect.objectContaining({ taskId: "queued", reason: "interrupted" }))
  })

  it("allows a root caller to interrupt a descendant and a child caller to close its own descendant", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, status: "queued" })
    const grandchild = makeTask({ id: "grandchild", rootTaskId: "root-1", parentTaskId: "child", path: "/root-1/child/grandchild", depth: 2, status: "queued" })
    runtime.store.tasks.set(child.id, child)
    runtime.store.tasks.set(grandchild.id, grandchild)

    await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: child.id } satisfies InterruptSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, rootTaskId: "root-1", status: "interrupt_requested" })
    expect(runtime.manager.interruptSubtree).toHaveBeenCalledWith("session-a", "root-1", child.path)

    await expect(executeCloseSubagent(context({ taskId: child.id, rootTaskId: "root-1" }), { taskId: grandchild.id } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: grandchild.id, status: "closed", closed: true })
    expect(runtime.manager.close).toHaveBeenCalledWith(grandchild.id, "session-a")
  })

  it("allows a child to manage itself but hides siblings and ancestors from lifecycle controls", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, status: "queued" })
    const sibling = makeTask({ id: "sibling", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/sibling", depth: 1, status: "queued" })
    runtime.store.tasks.set(child.id, child)
    runtime.store.tasks.set(sibling.id, sibling)

    await expect(executeCloseSubagent(context({ taskId: child.id, rootTaskId: "root-1" }), { taskId: child.id } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, status: "closed", closed: true })

    const activityCount = runtime.store.activities.length
    await expect(executeInterruptSubagent(context({ taskId: child.id, rootTaskId: "root-1" }), { taskId: sibling.id } satisfies InterruptSubagentInput, runtime.options))
      .rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(executeCloseSubagent(context({ taskId: child.id, rootTaskId: "root-1" }), { taskId: "root-1" } satisfies CloseSubagentInput, runtime.options))
      .rejects.toMatchObject({ code: "coordination_task_not_found" })
    expect(runtime.store.activities).toHaveLength(activityCount)
    expect(runtime.manager.interruptSubtree).not.toHaveBeenCalled()
    expect(runtime.manager.close).toHaveBeenCalledOnce()
    expect(runtime.wait.cancel).toHaveBeenCalledOnce()
  })

  it("does not reveal foreign user, session, or root tasks to lifecycle controls", async () => {
    const runtime = makeRuntime()
    runtime.store.tasks.set("foreign-user", makeTask({ id: "foreign-user", userId: "user-b", sessionId: "session-a", rootTaskId: "foreign-root", path: "/foreign-root/target", status: "queued" }))
    runtime.store.tasks.set("foreign-root", makeTask({ id: "foreign-root", rootTaskId: "foreign-root", path: "/foreign-root", status: "queued" }))
    runtime.store.tasks.set("foreign-session", makeTask({ id: "foreign-session", sessionId: "session-b", rootTaskId: "foreign-session", path: "/foreign-session", status: "queued" }))

    for (const taskId of ["foreign-user", "foreign-session", "foreign-root"]) {
      await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId } satisfies InterruptSubagentInput, runtime.options))
        .rejects.toMatchObject({ code: "coordination_task_not_found" })
    }
    expect(runtime.manager.interruptSubtree).not.toHaveBeenCalled()
    expect(runtime.wait.cancel).not.toHaveBeenCalled()
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("keeps child-to-parent messages available and repeated terminal controls idempotent", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, status: "interrupted" })
    runtime.store.tasks.set(child.id, child)

    await expect(executeSendMessage(context({ taskId: child.id, rootTaskId: "root-1" }), { idempotencyKey: "child-result", taskId: "root-1", kind: "result", payload: { ok: true } }, runtime.options))
      .resolves.toMatchObject({ taskId: "root-1", status: "queued" })
    await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: child.id } satisfies InterruptSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, status: "interrupt_requested" })
    await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: child.id } satisfies InterruptSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, status: "interrupt_requested" })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: child.id } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, status: "interrupted", closed: false })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: child.id } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ taskId: child.id, status: "interrupted", closed: false })
    expect(runtime.manager.interruptSubtree).toHaveBeenCalledTimes(2)
    expect(runtime.manager.close).not.toHaveBeenCalled()
  })

  it("fails visibly when durable wait is not integrated", async () => {
    const runtime = makeRuntime()
    const noWait = { ...runtime.options, wait: undefined }
    await expect(executeWaitSubagents(context(), { idempotencyKey: "wait-2", taskIds: ["root-1"], mode: "all", timeoutMs: 1000 }, noWait))
      .rejects.toMatchObject({ code: "coordination_wait_unavailable" })
  })
})
