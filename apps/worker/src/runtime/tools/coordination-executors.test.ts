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

  it("delegates wait to the durable AH2-025 port and never starts a Worker", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, status: "queued" })
    runtime.store.tasks.set(child.id, child)
    const input: WaitSubagentsInput = { idempotencyKey: "wait-1", taskIds: [child.id], mode: "any", timeoutMs: 5000 }
    await expect(executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)).resolves.toMatchObject({ status: "ready", matchedTaskIds: ["child"] })
    expect(runtime.wait.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", taskId: "root-1", rootTaskId: "root-1", targetTaskIds: ["child"], timeoutMs: 5000 }))
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
    expect(runtime.wait.cancel).toHaveBeenCalledWith(expect.objectContaining({ taskId: "root-1", reason: "interrupted" }))
  })

  it("fails visibly when durable wait is not integrated", async () => {
    const runtime = makeRuntime()
    const noWait = { ...runtime.options, wait: undefined }
    await expect(executeWaitSubagents(context(), { idempotencyKey: "wait-2", taskIds: ["root-1"], mode: "all", timeoutMs: 1000 }, noWait))
      .rejects.toMatchObject({ code: "coordination_wait_unavailable" })
  })
})
