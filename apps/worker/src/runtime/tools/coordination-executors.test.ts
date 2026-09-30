import { describe, expect, it, vi } from "vitest"

import { AgentTreeManager } from "../subagents/manager.js"
import {
  executeCloseSubagent,
  executeFollowup,
  executeInterruptSubagent,
  executeListSubagents,
  executeSendMessage,
  executeSpawn,
  executeWaitSubagents,
} from "./coordination-executors.js"
import { createCoordinationTools } from "./coordination-tools.js"
import type {
  CloseSubagentInput,
  FollowupInput,
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
import { ToolSchemaValidator } from "./schema-validator.js"
import type { ToolExecutionContext } from "./types.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"

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
    spawn: vi.fn(async (input: { userId: string; sessionId: string; turnId?: string | null; parentTaskId?: string | null; role: string; taskType: string; goal: string; context?: unknown }) => {
      const parent = input.parentTaskId ? store.tasks.get(input.parentTaskId) : undefined
      const task = makeTask({
        id: `child-${nextTask++}`, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? null,
        rootTaskId: parent?.rootTaskId ?? `child-${nextTask - 1}`, parentTaskId: parent?.id ?? null,
        path: `${parent?.path ?? ""}/child-${nextTask - 1}`, depth: (parent?.depth ?? -1) + 1,
        role: input.role, taskType: input.taskType, goal: input.goal, context: input.context ?? null, status: "queued", leaseOwner: null,
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

  it("rejects an existing spawn replay from another turn", async () => {
    const runtime = makeRuntime()
    const stale = makeTask({ id: "stale-child", turnId: "turn-old", rootTaskId: "stale-child", path: "/stale-child", status: "queued" })
    runtime.store.tasks.set(stale.id, stale)
    runtime.store.spawnOperations.set("session-a:spawn-stale", stale.id)

    await expect(executeSpawn(context(), { idempotencyKey: "spawn-stale", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_idempotency_conflict" })
    expect(runtime.store.activities).toHaveLength(0)
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
  })

  it("rejects an existing spawn replay from the wrong parent branch", async () => {
    const runtime = makeRuntime()
    const otherRoot = makeTask({ id: "root-2", rootTaskId: "root-2", path: "/root-2" })
    const stale = makeTask({ id: "stale-child", parentTaskId: "root-1", rootTaskId: "root-1", path: "/root-1/stale-child", depth: 1, status: "queued" })
    runtime.store.tasks.set(otherRoot.id, otherRoot)
    runtime.store.tasks.set(stale.id, stale)
    runtime.store.spawnOperations.set("session-a:spawn-branch", stale.id)

    await expect(executeSpawn(context({ taskId: otherRoot.id, rootTaskId: otherRoot.rootTaskId }), { idempotencyKey: "spawn-branch", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_idempotency_conflict" })
    expect(runtime.store.activities).toHaveLength(0)
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
  })

  it("rejects an atomic duplicate winner from another turn or branch", async () => {
    const runtime = makeRuntime()
    const stale = makeTask({ id: "atomic-stale", turnId: "turn-old", parentTaskId: "root-1", rootTaskId: "root-1", path: "/root-1/atomic-stale", depth: 1, status: "queued" })
    runtime.store.tasks.set(stale.id, stale)
    runtime.manager.supportsAtomicSpawn = vi.fn(() => true)
    runtime.manager.spawnAtomic = vi.fn(async () => ({ task: null, duplicate: true, atomic: true }))
    runtime.store.getSpawnReplay = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stale)

    await expect(executeSpawn(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "spawn-atomic-stale", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_idempotency_conflict" })
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("rejects a record-race winner from another turn or branch after closing the loser", async () => {
    const runtime = makeRuntime()
    const stale = makeTask({ id: "race-stale", turnId: "turn-old", parentTaskId: "root-1", rootTaskId: "root-1", path: "/root-1/race-stale", depth: 1, status: "queued" })
    runtime.store.tasks.set(stale.id, stale)
    runtime.store.recordSpawn = vi.fn(async () => false)
    runtime.store.getSpawnReplay = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stale)

    await expect(executeSpawn(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "spawn-race-stale", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_idempotency_conflict" })
    expect(runtime.manager.close).toHaveBeenCalledWith("child-1", "session-a")
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("records supervisor activity when a non-atomic spawn loses the idempotency race", async () => {
    const runtime = makeRuntime()
    const winner = makeTask({ id: "race-winner", path: "/race-winner", status: "queued" })
    runtime.store.tasks.set(winner.id, winner)
    runtime.store.recordSpawn = vi.fn(async () => false)
    runtime.store.getSpawnReplay = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner)

    await expect(executeSpawn(context(), { idempotencyKey: "spawn-race", role: "scout", taskType: "inspect", goal: "Inspect" }, runtime.options))
      .resolves.toMatchObject({ taskId: winner.id, replay: true })
    expect(runtime.manager.close).toHaveBeenCalledWith("child-1", "session-a")
    expect(runtime.store.activities).toEqual(["spawn_subagent"])
  })

  it.each(["root", "orchestrator", "admin", "elevated", "future-role", "toString", "constructor", "__proto__"])("rejects unsupported spawn role %s before dispatch", async role => {
    const runtime = makeRuntime()
    await expect(executeSpawn(context(), { idempotencyKey: `spawn-${role}`, role, taskType: "inspect", goal: "Inspect" }, runtime.options)).rejects.toMatchObject({ code: "coordination_invalid_input" })
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
    expect(runtime.store.spawnOperations.size).toBe(0)
    expect(runtime.store.activities).toHaveLength(0)
    expect(runtime.store.tasks.size).toBe(1)
  })

  it("creates a follow-up from a terminal same-turn child under the current runtime parent", async () => {
    const runtime = makeRuntime()
    const source = makeTask({
      id: "source", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/source", depth: 1,
      role: "reviewer", taskType: "review", status: "completed", attemptCount: 2,
      result: { summary: "done", email: "private@example.com", userId: "foreign-user", nested: { apiKey: "secret", safe: true }, text: "x".repeat(3_000) },
    })
    runtime.store.tasks.set(source.id, source)
    const input: FollowupInput = {
      idempotencyKey: "followup-1", taskId: source.id, goal: "Recheck the result",
      constraints: ["read only"], successCriteria: ["explain the correction"],
      context: { note: "caller context", sessionId: "foreign-session", secret: "hide", text: "y".repeat(3_000) },
    }

    const result = await executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)
    expect(result).toMatchObject({ sourceTaskId: source.id, parentTaskId: "root-1", replay: false, status: "queued" })
    const spawn = runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ parentTaskId: "root-1", role: "reviewer", taskType: "review", goal: input.goal })
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("allowedActions")
    const followupContext = spawn.mock.calls[0]?.[0].context as Record<string, unknown>
    expect(followupContext).toMatchObject({ callerContext: expect.objectContaining({ $truncated: true }), provenance: expect.objectContaining({ sourceTaskId: source.id, sourceStatus: "completed", sourceAttemptCount: 2, priorResult: expect.objectContaining({ $truncated: true }) }) })
    expect(JSON.stringify(followupContext)).not.toMatch(/private@example\.com|foreign-user|foreign-session|secret/)
    expect(JSON.stringify(followupContext)).not.toContain("toolPolicy")
  })

  it("keeps a follow-up replay durable and rejects reuse across sources", async () => {
    const runtime = makeRuntime()
    const source = makeTask({ id: "source", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/source", depth: 1, role: "scout", taskType: "research", status: "failed", attemptCount: 3 })
    const other = makeTask({ id: "other", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/other", depth: 1, role: "scout", taskType: "research", status: "completed", attemptCount: 1 })
    runtime.store.tasks.set(source.id, source)
    runtime.store.tasks.set(other.id, other)
    const input: FollowupInput = { idempotencyKey: "followup-replay", taskId: source.id, goal: "Retry the review" }
    const first = await executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)
    const second = await executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1", toolCallId: "retry-call" }), input, runtime.options)
    expect(first).toMatchObject({ replay: false })
    expect(second).toMatchObject({ taskId: first.taskId, replay: true })
    expect(runtime.manager.spawn).toHaveBeenCalledOnce()

    await expect(executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), { ...input, taskId: other.id }, runtime.options))
      .rejects.toMatchObject({ code: "coordination_idempotency_conflict" })
    expect(runtime.manager.spawn).toHaveBeenCalledOnce()
  })

  it("supports atomic follow-up replay and fences duplicate winners to the current parent", async () => {
    const runtime = makeRuntime()
    const source = makeTask({ id: "source", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/source", depth: 1, role: "scout", taskType: "research", status: "completed" })
    runtime.store.tasks.set(source.id, source)
    let atomicCalls = 0
    runtime.manager.supportsAtomicSpawn = vi.fn(() => true)
    runtime.manager.spawnAtomic = vi.fn(async (spec: { parentTaskId?: string | null; role: string; taskType: string; goal: string; context?: unknown }) => {
      atomicCalls += 1
      if (atomicCalls > 1) return { task: null, duplicate: true, atomic: true }
      const task = makeTask({ id: "atomic-followup", rootTaskId: "root-1", parentTaskId: spec.parentTaskId ?? null, path: "/root-1/atomic-followup", depth: 1, role: spec.role, taskType: spec.taskType, goal: spec.goal, status: "queued", context: spec.context })
      runtime.store.tasks.set(task.id, task)
      runtime.store.spawnOperations.set("session-a:atomic-followup", task.id)
      return { task: task as never, duplicate: false, atomic: true }
    })

    const input: FollowupInput = { idempotencyKey: "atomic-followup", taskId: source.id, goal: "Continue" }
    const first = await executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)
    const winner = runtime.store.tasks.get("atomic-followup")
    runtime.store.getSpawnReplay = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner ?? null)
    const second = await executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1", toolCallId: "atomic-retry" }), input, runtime.options)
    expect(first).toMatchObject({ taskId: "atomic-followup", replay: false })
    expect(second).toMatchObject({ taskId: "atomic-followup", replay: true })
    expect(runtime.manager.close).not.toHaveBeenCalled()
  })

  it.each([
    ["non-terminal", { id: "active", status: "running" as const }],
    ["root", { id: "root-1", status: "completed" as const }],
    ["cross-turn", { id: "old-turn", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/old-turn", depth: 1, status: "completed" as const, turnId: "turn-old" }],
  ] as const)("rejects a %s follow-up source before spawn", async (_label, overrides) => {
    const runtime = makeRuntime()
    const source = makeTask(overrides)
    runtime.store.tasks.set(source.id, source)
    await expect(executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: `followup-${source.id}`, taskId: source.id, goal: "Continue" }, runtime.options))
      .rejects.toMatchObject({ code: overrides.id === "root-1" ? "coordination_followup_root_forbidden" : overrides.status === "running" ? "coordination_followup_source_not_terminal" : "coordination_task_not_found" })
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
    expect(runtime.store.activities).toHaveLength(0)
  })

  it("rejects foreign sources and a missing, terminal, or cross-turn runtime parent", async () => {
    const runtime = makeRuntime()
    const source = makeTask({ id: "source", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/source", depth: 1, status: "completed" })
    runtime.store.tasks.set(source.id, source)
    runtime.store.tasks.set("foreign", makeTask({ id: "foreign", userId: "user-b", sessionId: "session-b", rootTaskId: "foreign", path: "/foreign", status: "completed" }))
    const input = (taskId: string, idempotencyKey: string): FollowupInput => ({ taskId, idempotencyKey, goal: "Continue" })
    await expect(executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), input("foreign", "followup-foreign"), runtime.options)).rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(executeFollowup(context(), input(source.id, "followup-no-parent"), runtime.options)).rejects.toMatchObject({ code: "coordination_task_not_found" })
    const terminalParentStore = Object.assign(Object.create(Object.getPrototypeOf(runtime.store)), runtime.store, {
      getTask: vi.fn(async ({ taskId }: { taskId: string }) => taskId === "root-1" ? makeTask({ status: "completed" }) : source),
    }) as CoordinationStore
    await expect(executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1" }), input(source.id, "followup-parent-terminal"), { ...runtime.options, store: terminalParentStore })).rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(executeFollowup(context({ taskId: "root-1", rootTaskId: "root-1", turnId: "turn-new" }), input(source.id, "followup-parent-cross-turn"), runtime.options)).rejects.toMatchObject({ code: "coordination_task_not_found" })
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
  })

  it("does not pass an injected expected output schema to the manager", async () => {
    const runtime = makeRuntime()
    const input = {
      idempotencyKey: "spawn-raw",
      role: "scout",
      taskType: "inspect",
      goal: "Inspect the job",
      expectedOutputSchema: { schemaVersion: "forged", role: "analyst" },
      delegateOutputSchemaMarker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    } as unknown as SpawnSubagentInput

    await executeSpawn(context(), input, runtime.options)

    const spawn = runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("expectedOutputSchema")
  })

  it("passes only the exact runtime-owned Scout marker to the manager spec", async () => {
    const runtime = makeRuntime()
    await executeSpawn(context({ delegateOutputSchemaMarker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" } }), {
      idempotencyKey: "spawn-structured", role: "scout", taskType: "inspect", goal: "Inspect the job",
    }, runtime.options)
    const spawn = runtime.manager.spawn as unknown as ReturnType<typeof vi.fn>
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" } })
  })

  it("rejects an invalid internal marker before lineage or manager dispatch", async () => {
    const runtime = makeRuntime()
    await expect(executeSpawn(context({ delegateOutputSchemaMarker: { schemaVersion: "forged", role: "reviewer" } }), {
      idempotencyKey: "spawn-invalid-marker", role: "scout", taskType: "inspect", goal: "Inspect the job",
    }, runtime.options)).rejects.toMatchObject({ code: "coordination_invalid_input" })
    expect(runtime.manager.spawn).not.toHaveBeenCalled()
    expect(runtime.store.activities).toHaveLength(0)
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
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, role: "scout", status: "queued" })
    runtime.store.tasks.set(child.id, child)
    const input: WaitSubagentsInput = { idempotencyKey: "wait-1", taskIds: [child.id], mode: "any", timeoutMs: 5000 }
    await expect(executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), input, runtime.options)).resolves.toMatchObject({ status: "ready", matchedTaskIds: ["child"], tasks: [{ taskId: "child", status: "queued", role: "scout", result: null, failureReason: null }] })
    expect(runtime.wait.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a", taskId: "root-1", rootTaskId: "root-1", targetTaskIds: ["child"], timeoutMs: 5000 }))
  })

  it("refreshes ready targets and returns redacted bounded task evidence", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, role: "scout", status: "queued" })
    const large = makeTask({ id: "large", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/large", depth: 1, role: "scout", status: "queued" })
    runtime.store.tasks.set(child.id, child)
    runtime.store.tasks.set(large.id, large)
    runtime.wait.wait = vi.fn(async () => {
      runtime.store.tasks.set(child.id, makeTask({ ...child, status: "completed", result: { userId: "foreign-user", apiKey: "secret", summary: "ready" } }))
      runtime.store.tasks.set(large.id, makeTask({ ...large, status: "failed", result: { summary: "x".repeat(3_000) }, failureReason: "é".repeat(300) }))
      return { waitId: "wait-ready", status: "ready" as const, deadlineAt: "2026-09-03T00:01:00.000Z", matchedTaskIds: [child.id] }
    })

    const result = await executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "wait-ready", taskIds: [child.id, large.id], mode: "any", timeoutMs: 5000 }, runtime.options)
    expect(result.tasks).toEqual([
      { taskId: "child", status: "completed", role: "scout", result: { apiKey: "[REDACTED]", summary: "ready" }, failureReason: null },
      { taskId: "large", status: "failed", role: "scout", result: expect.objectContaining({ $truncated: true }), failureReason: expect.any(String) },
    ])
    expect(result.tasks[0]).not.toHaveProperty("userId")
    expect(Buffer.byteLength(result.tasks[1]!.failureReason ?? "", "utf8")).toBeLessThanOrEqual(500)
    expect(runtime.store.activities).toContain("wait_subagents")
  })

  it("returns a bounded Scout/Analyst aggregate and preserves legacy results", async () => {
    const runtime = makeRuntime()
    const scout = makeTask({ id: "scout", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/scout", depth: 1, role: "scout", status: "completed", result: { structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-2", source: "source", url: null, evidenceIds: ["e-2"] }], evidence: [{ id: "e-2", kind: "job", ref: "job-2", source: "source" }], summary: "found" } } })
    const analyst = makeTask({ id: "analyst", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/analyst", depth: 1, role: "analyst", status: "completed", result: { structuredResult: { role: "scout" } } })
    const legacy = makeTask({ id: "legacy", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/legacy", depth: 1, role: "other", status: "completed", result: { summary: "legacy" } })
    runtime.store.tasks.set(scout.id, scout); runtime.store.tasks.set(analyst.id, analyst); runtime.store.tasks.set(legacy.id, legacy)
    const result = await executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "aggregate", taskIds: [scout.id, analyst.id, legacy.id], mode: "all", timeoutMs: 5000 }, runtime.options)
    expect(result.aggregate).toMatchObject({ status: "partial", successfulRoles: ["scout"], failedRoles: ["analyst"], jobIds: ["job-2"] })
    expect(result.tasks.find(task => task.taskId === legacy.id)?.result).toEqual({ summary: "legacy" })
  })

  it("fails closed for invalid structured results and reports pending roles", async () => {
    const runtime = makeRuntime()
    const invalid = makeTask({ id: "scout", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/scout", depth: 1, role: "scout", status: "completed", result: { structuredResult: { role: "analyst" } } })
    const pending = makeTask({ id: "analyst", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/analyst", depth: 1, role: "analyst", status: "running", result: { structuredResult: { secret: "omit" } } })
    runtime.store.tasks.set(invalid.id, invalid); runtime.store.tasks.set(pending.id, pending)
    const result = await executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "aggregate-invalid", taskIds: [invalid.id, pending.id], mode: "all", timeoutMs: 5000 }, runtime.options)
    expect(result.tasks[0]).toMatchObject({ result: null, failureReason: "invalid_structured_result" })
    expect(result.aggregate).toMatchObject({ status: "pending", failedRoles: ["scout"], pendingRoles: ["analyst"] })
  })

  it("omits the aggregate when a valid structured result cannot survive wait projection", async () => {
    const runtime = makeRuntime()
    const large = makeTask({ id: "scout", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/scout", depth: 1, role: "scout", status: "completed", result: { structuredResult: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [], evidence: [], summary: "x".repeat(3_000) } } })
    runtime.store.tasks.set(large.id, large)
    const result = await executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "aggregate-large", taskIds: [large.id], mode: "all", timeoutMs: 5000 }, runtime.options)
    expect(result).not.toHaveProperty("aggregate")
    expect(result.tasks[0]?.result).toMatchObject({ $truncated: true })
  })

  it("returns the initial bounded task shape while a wait remains pending", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "child", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child", depth: 1, role: "scout", status: "queued", result: { sessionId: "foreign-session", apiKey: "secret", summary: "pending" }, failureReason: "é".repeat(300) })
    runtime.store.tasks.set(child.id, child)
    const pendingWait = {
      wait: vi.fn(async () => {
        runtime.store.tasks.set(child.id, makeTask({ ...child, status: "completed", result: { summary: "late" } }))
        return { waitId: "wait-pending", status: "waiting" as const, deadlineAt: "2026-09-03T00:01:00.000Z", matchedTaskIds: [] }
      }),
    } satisfies DurableWaitPort

    const result = await executeWaitSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { idempotencyKey: "wait-pending", taskIds: [child.id], mode: "all", timeoutMs: 5000 }, { ...runtime.options, wait: pendingWait })
    expect(result.tasks).toEqual([{ taskId: "child", status: "queued", role: "scout", result: { apiKey: "[REDACTED]", summary: "pending" }, failureReason: expect.any(String) }])
    expect(result.tasks[0]).not.toHaveProperty("sessionId")
    expect(Buffer.byteLength(result.tasks[0]!.failureReason ?? "", "utf8")).toBeLessThanOrEqual(500)
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
    runtime.store.tasks.set("queued", makeTask({ id: "queued", rootTaskId: "root-1", path: "/root-1/queued", status: "queued", result: { summary: "hidden" }, failureReason: "hidden" }))
    runtime.store.tasks.set("done", makeTask({ id: "done", rootTaskId: "root-1", path: "/root-1/done", status: "completed" }))
    await expect(executeListSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { includeTerminal: false } satisfies ListSubagentsInput, runtime.options))
      .resolves.toMatchObject({ tasks: [{ taskId: "queued", result: null, failureReason: null }] })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "root-1" } satisfies CloseSubagentInput, runtime.options))
      .rejects.toMatchObject({ code: "coordination_close_not_allowed" })
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "queued" } satisfies CloseSubagentInput, runtime.options))
      .resolves.toMatchObject({ status: "closed", closed: true })
    await expect(executeInterruptSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { taskId: "queued", reason: "stop" } satisfies InterruptSubagentInput, runtime.options))
      .resolves.toMatchObject({ rootTaskId: "root-1", status: "interrupt_requested" })
    expect(runtime.manager.interruptSubtree).toHaveBeenCalledWith("session-a", "root-1", "/root-1/queued")
    expect(runtime.wait.cancel).toHaveBeenCalledWith(expect.objectContaining({ taskId: "queued", reason: "interrupted" }))
  })

  it("retries durable wait cancellation after close succeeds but the first cancel fails", async () => {
    const runtime = makeRuntime()
    runtime.wait.cancel.mockRejectedValueOnce(new Error("temporary wait store failure"))
    const input = { taskId: "root-1" } satisfies CloseSubagentInput
    runtime.store.tasks.set("queued", makeTask({ id: "queued", rootTaskId: "root-1", path: "/root-1/queued", status: "queued" }))

    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { ...input, taskId: "queued" }, runtime.options))
      .rejects.toThrow("temporary wait store failure")
    await expect(executeCloseSubagent(context({ taskId: "root-1", rootTaskId: "root-1" }), { ...input, taskId: "queued" }, runtime.options))
      .resolves.toMatchObject({ taskId: "queued", status: "closed", closed: false })

    expect(runtime.manager.close).toHaveBeenCalledOnce()
    expect(runtime.wait.cancel).toHaveBeenCalledTimes(2)
    expect(runtime.wait.cancel).toHaveBeenLastCalledWith({ userId: "user-a", sessionId: "session-a", taskId: "queued", reason: "closed" })
  })

  it("returns redacted bounded evidence for terminal tasks and suppresses active values", async () => {
    const runtime = makeRuntime()
    runtime.store.tasks.set("done", makeTask({
      id: "done", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/done", depth: 1, status: "completed",
      result: { summary: "finished", userId: "foreign-user", nested: { sessionId: "foreign-session", taskId: "foreign-task", safe: "ok" } },
      failureReason: "é".repeat(300),
    }))
    runtime.store.tasks.set("large", makeTask({
      id: "large", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/large", depth: 1, status: "failed",
      result: { summary: "x".repeat(3_000) }, failureReason: "failed",
    }))
    runtime.store.tasks.set("running", makeTask({
      id: "running", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/running", depth: 1, status: "running",
      result: { summary: "in-flight", sessionId: "foreign-session" }, failureReason: "hidden",
    }))

    const output = await executeListSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { includeTerminal: true }, runtime.options)
    const done = output.tasks.find(task => task.taskId === "done")
    const large = output.tasks.find(task => task.taskId === "large")
    const running = output.tasks.find(task => task.taskId === "running")
    expect(done).toMatchObject({ result: { summary: "finished", nested: { safe: "ok" } }, failureReason: expect.any(String) })
    expect(done?.result).not.toHaveProperty("userId")
    expect(done?.result).not.toHaveProperty("nested.sessionId")
    expect(done?.result).not.toHaveProperty("nested.taskId")
    expect(Buffer.byteLength(done?.failureReason ?? "", "utf8")).toBeLessThanOrEqual(500)
    expect(large?.result).toMatchObject({ $truncated: true })
    expect(running).toMatchObject({ result: null, failureReason: null })
  })

  it("caps list output at 50 rows after preserving store order", async () => {
    const runtime = makeRuntime()
    for (let index = 0; index < 55; index += 1) {
      const task = makeTask({ id: `child-${index}`, rootTaskId: "root-1", parentTaskId: "root-1", path: `/root-1/child-${index}`, depth: 1, status: "queued" })
      runtime.store.tasks.set(task.id, task)
    }
    const output = await executeListSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), {}, runtime.options)
    expect(output.tasks).toHaveLength(50)
    expect(output.tasks[0]?.taskId).toBe("child-0")
    expect(output.tasks[49]?.taskId).toBe("child-49")
  })

  it("keeps list evidence compatible with the strict output schema", async () => {
    const runtime = makeRuntime()
    const child = makeTask({ id: "done", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/done", depth: 1, status: "completed", result: { summary: "finished" } })
    runtime.store.tasks.set(child.id, child)
    const output = await executeListSubagents(context({ taskId: "root-1", rootTaskId: "root-1" }), { includeTerminal: true }, runtime.options)
    const definition = createCoordinationTools(runtime.options).find(tool => tool.name === "list_subagents")
    if (!definition) throw new Error("list_subagents definition missing")
    expect(() => new ToolSchemaValidator().validate(definition.outputSchema, output, "list_subagents output")).not.toThrow()
    expect(output.tasks[0]).toHaveProperty("result")
    expect(output.tasks[0]).toHaveProperty("failureReason")
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
