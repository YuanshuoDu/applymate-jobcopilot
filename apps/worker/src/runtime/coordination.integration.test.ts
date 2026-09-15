import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { enqueueSubagentTask } from "../queue/subagent-queue.js"
import { dispatchPendingTurnOutbox } from "./turns/recovery-scanner.js"
import { claimTurnLease, type TurnJobPayload, type TurnLease } from "./turns/lease.js"
import { runTurnJob } from "./turns/turn-queue.js"
import { executeSpawn, executeWaitSubagents } from "./tools/coordination-executors.js"
import type { CoordinationRuntimeOptions, CoordinationStore, CoordinationTaskView, DurableWaitPort } from "./tools/coordination-types.js"
import type { ToolExecutionContext } from "./tools/types.js"
import { AgentTreeManager, type SubagentClock } from "./subagents/manager.js"
import { consumeDurableWaitOutcomes } from "./subagents/durable-wait-consumer.js"
import { reconcileDurableWaits } from "./subagents/durable-wait-resolver.js"
import { suspendAndReleaseWait } from "./subagents/durable-wait-handoff.js"
import { createPgRootTaskStore } from "./subagents/root-task-store.js"
import type {
  AtomicSubagentSpawnInput,
  AtomicSubagentSpawnResult,
  SubagentExecutionResult,
  SubagentJobPayload,
  SubagentPolicy,
  SubagentStore,
  SubagentTaskRecord,
  SubagentTaskSpec,
} from "./subagents/types.js"
import { normalizeSubagentPolicy } from "./subagents/types.js"

const NOW = new Date("2026-09-13T12:00:00.000Z")
const USER_ID = "user-1"
const SESSION_ID = "session-1"
const TURN_ID = "turn-1"
const ROOT_OWNER = "root-worker"
const CHILD_OWNER = "child-worker"

class NoopClock implements SubagentClock {
  setInterval(): ReturnType<typeof setInterval> { return {} as ReturnType<typeof setInterval> }
  clearInterval(): void {}
}

class HarnessStore implements SubagentStore, CoordinationStore {
  readonly records = new Map<string, SubagentTaskRecord>()
  readonly spawnOperations = new Map<string, string>()
  readonly activities: Array<{ operation: string; taskId: string | null }> = []
  private nextId = 1

  async create(input: SubagentTaskSpec & { policy: SubagentPolicy }): Promise<SubagentTaskRecord> {
    const id = `task-${this.nextId++}`
    const parent = input.parentTaskId ? this.records.get(input.parentTaskId) : undefined
    const task: SubagentTaskRecord = {
      id, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? TURN_ID,
      rootTaskId: parent?.rootTaskId ?? id, parentTaskId: input.parentTaskId ?? null,
      path: `${parent?.path ?? ""}/${id}`, depth: parent ? parent.depth + 1 : 0,
      role: input.role, taskType: input.taskType, status: "queued", goal: input.goal,
      constraints: input.constraints ?? [], successCriteria: input.successCriteria ?? [], allowedActions: input.allowedActions ?? [],
      context: input.context ?? {}, expectedOutputSchema: input.expectedOutputSchema ?? {}, result: null, failureReason: null,
      attemptCount: 0, maxAttempts: input.policy.maxAttempts, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      modelProfileSnapshot: input.modelProfileSnapshot ?? {}, budgetSnapshot: { subagentPolicy: input.policy }, toolPolicySnapshot: input.toolPolicySnapshot ?? {},
    }
    this.records.set(id, task)
    return task
  }

  async createWithSpawn(input: AtomicSubagentSpawnInput): Promise<AtomicSubagentSpawnResult> {
    const key = `${input.sessionId}:${input.spawnIdempotencyKey}`
    const existing = this.spawnOperations.get(key)
    if (existing) return { task: this.records.get(existing) ?? null, duplicate: true }
    const task = await this.create(input)
    this.spawnOperations.set(key, task.id)
    return { task, duplicate: false }
  }

  async get(taskId: string, sessionId?: string): Promise<SubagentTaskRecord | null> {
    const task = this.records.get(taskId)
    return task && (!sessionId || task.sessionId === sessionId) ? task : null
  }

  async claim(input: { taskId: string; sessionId: string; ownerId: string; policy: SubagentPolicy; now: Date }): Promise<SubagentTaskRecord | null> {
    const task = this.records.get(input.taskId)
    const running = [...this.records.values()].filter(row => row.sessionId === input.sessionId && row.status === "running").length
    if (!task || task.sessionId !== input.sessionId || task.status !== "queued" || running >= input.policy.maxConcurrency) return null
    const claimed = { ...task, status: "running" as const, leaseOwner: input.ownerId, leaseExpiresAt: new Date(input.now.getTime() + 60_000), attemptCount: task.attemptCount + 1 }
    this.records.set(task.id, claimed)
    return claimed
  }

  async heartbeat(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<"renewed" | "interrupted" | "lost"> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || task.leaseOwner !== input.ownerId || task.attemptCount !== input.attemptCount || task.status !== "running") return "lost"
    if (task.interruptRequestedAt) return "interrupted"
    this.records.set(task.id, { ...task, leaseExpiresAt: new Date(input.now.getTime() + 60_000) })
    return "renewed"
  }

  async finish(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; status: SubagentExecutionResult["status"]; result?: unknown; failureReason?: string; now: Date }): Promise<"completed" | "retrying" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | null> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || task.leaseOwner !== input.ownerId || task.attemptCount !== input.attemptCount || task.status !== "running") return null
    const retry = input.status === "failed" && task.attemptCount < task.maxAttempts
    const status = retry ? "queued" : input.status
    this.records.set(task.id, { ...task, status, result: input.result ?? null, failureReason: input.failureReason ?? null, leaseOwner: null, leaseExpiresAt: null })
    return retry ? "retrying" : status as "completed" | "failed" | "waiting" | "waiting_for_user"
  }

  async release(input: { taskId: string; sessionId: string; ownerId: string; attemptCount: number; now: Date }): Promise<boolean> {
    const task = this.records.get(input.taskId)
    if (!task || task.sessionId !== input.sessionId || task.leaseOwner !== input.ownerId || task.attemptCount !== input.attemptCount || task.status !== "running") return false
    this.records.set(task.id, { ...task, status: "queued", leaseOwner: null, leaseExpiresAt: null })
    return true
  }

  async close(input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
    const task = await this.get(input.taskId, input.sessionId)
    if (!task || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)) return false
    this.records.set(task.id, { ...task, status: "closed", leaseOwner: null, leaseExpiresAt: null })
    return true
  }

  async interruptTree(input: { sessionId: string; rootTaskId: string; now: Date }): Promise<number> { return [...this.records.values()].filter(row => row.sessionId === input.sessionId && row.rootTaskId === input.rootTaskId && row.status === "running").length }
  async recoverExpired(): Promise<SubagentTaskRecord[]> { return [] }

  async getTask(input: { userId: string; sessionId: string; taskId: string }): Promise<CoordinationTaskView | null> {
    const task = await this.get(input.taskId, input.sessionId)
    return task?.userId === input.userId ? task : null
  }
  async listTasks(input: { userId: string; sessionId: string; rootTaskId?: string; includeTerminal: boolean }): Promise<CoordinationTaskView[]> {
    return [...this.records.values()].filter(task => task.userId === input.userId && task.sessionId === input.sessionId && (!input.rootTaskId || task.rootTaskId === input.rootTaskId) && (input.includeTerminal || !["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status)))
  }
  async sendMessage(): Promise<never> { throw new Error("mailbox is outside this fixture") }
  async getSpawnReplay(input: { userId: string; sessionId: string; idempotencyKey: string }): Promise<CoordinationTaskView | null> {
    const id = this.spawnOperations.get(`${input.sessionId}:${input.idempotencyKey}`)
    return id ? this.getTask({ ...input, taskId: id }) : null
  }
  async recordSpawn(): Promise<boolean> { throw new Error("atomic spawn should bypass recordSpawn") }
  async appendActivity(input: { operation: string; taskId: string | null }): Promise<void> { this.activities.push({ operation: input.operation, taskId: input.taskId }) }
}

type TurnState = { id: string; sessionId: string; userId: string; rootTaskId: string; status: string; leaseOwnerId: string | null; leaseVersion: number; leaseStartedAt: Date | null; leaseExpiresAt: Date | null; revision: number }
type WaitState = { id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string; targetTaskIds: string[]; mode: "any" | "all"; status: "waiting" | "ready" | "timed_out"; matchedTaskIds: string[]; suspendedAt: Date | null; consumedAt: Date | null; result: Record<string, unknown> }
type QueryResponse = { rows: Array<Record<string, unknown>>; rowCount: number }

class IntegrationPg {
  readonly calls: string[] = []
  readonly outbox: Array<{ id: string; aggregateId: string; topic: string; payload: Record<string, unknown>; attemptCount: number; publishedAt: Date | null }> = []
  readonly state: { sessionStatus: string; turn: TurnState; wait: WaitState; stepStatus: string; consumeWrites: number }
  readonly client: { query: (sql: string, values?: readonly unknown[]) => Promise<QueryResponse>; release: () => void }
  readonly pool: pg.Pool

  constructor(private readonly store: HarnessStore, rootTaskId: string) {
    this.state = {
      sessionStatus: "running",
      turn: { id: TURN_ID, sessionId: SESSION_ID, userId: USER_ID, rootTaskId, status: "queued", leaseOwnerId: null, leaseVersion: 0, leaseStartedAt: null, leaseExpiresAt: null, revision: 0 },
      wait: { id: "wait-1", userId: USER_ID, sessionId: SESSION_ID, turnId: TURN_ID, parentTaskId: rootTaskId, stepId: "step-1", targetTaskIds: [], mode: "all", status: "waiting", matchedTaskIds: [], suspendedAt: null, consumedAt: null, result: {} },
      stepStatus: "waiting_for_tool", consumeWrites: 0,
    }
    this.client = { query: (sql, values) => this.query(sql, values), release: () => undefined }
    this.pool = { connect: async () => this.client } as unknown as pg.Pool
  }

  turnRow(): Record<string, unknown> { return { ...this.state.turn } }

  private sessionRow(): QueryResponse { return this.state.sessionStatus === "running" ? { rows: [{ id: SESSION_ID, userId: USER_ID, status: "running" }], rowCount: 1 } : { rows: [], rowCount: 0 } }
  private taskRow(task: SubagentTaskRecord): Record<string, unknown> { return { ...task, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId, status: task.status } }
  private waitRow(): Record<string, unknown> { return { ...this.state.wait, targetTaskIds: [...this.state.wait.targetTaskIds], matchedTaskIds: [...this.state.wait.matchedTaskIds], result: this.state.wait.result, createdAt: NOW, deadlineAt: new Date(NOW.getTime() + 60_000) } }

  private async query(sql: string, values: readonly unknown[] = []): Promise<QueryResponse> {
    this.calls.push(sql)
    const trimmed = sql.trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(trimmed) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql.includes("SELECT session.\"userId\"") && sql.includes("FROM \"agent_sessions\" AS session") && sql.includes("FOR UPDATE")) return this.sessionRow()
    if (sql.includes("WHERE turn.\"status\" IN ('waiting_for_dependency', 'in_progress')")) return this.state.turn.status === "waiting_for_dependency" || this.state.turn.status === "in_progress" ? { rows: [this.turnRow()], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"') && sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('JOIN "agent_sessions" AS session') && sql.includes('session."id" = dispatch."aggregateId"')) {
      const rows = this.state.sessionStatus === "running" ? this.outbox.filter(row => row.aggregateId === SESSION_ID && row.topic === "agent.turn.dispatch" && row.publishedAt === null).map(row => ({ id: row.id, aggregateId: SESSION_ID, payload: row.payload, attemptCount: row.attemptCount })) : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('SELECT "id", "payload", "attemptCount"') && sql.includes('FROM "agent_outbox"')) {
      const rows = this.outbox.filter(row => row.publishedAt === null).map(row => ({ id: row.id, payload: row.payload, attemptCount: row.attemptCount }))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('SELECT dispatch."id" FROM "agent_outbox" AS dispatch') && sql.includes('dispatch."aggregateId" = $2') && sql.includes('dispatch."topic" = $3') && sql.includes('dispatch."publishedAt" IS NULL') && sql.includes("FOR UPDATE")) {
      const row = this.outbox.find(candidate => candidate.id === String(values[0]) && candidate.aggregateId === String(values[1]) && candidate.topic === String(values[2]) && candidate.publishedAt === null)
      return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('SELECT task."id", task."status", task."sessionId"') && sql.includes('task."id" <> $3')) {
      const children = [...this.store.records.values()].filter(task => task.rootTaskId === this.state.turn.rootTaskId && task.id !== this.state.turn.rootTaskId && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(task.status))
      return { rows: children.map(task => this.taskRow(task)), rowCount: children.length }
    }
    if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('("consumedAt" IS NULL OR')) return this.state.wait.status === "ready" || this.state.wait.status === "timed_out" ? { rows: [this.waitRow()], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "userId"') && sql.includes('"consumedAt" IS NULL')) return this.state.wait.consumedAt === null && (this.state.wait.status === "waiting" || this.state.wait.status === "ready" || this.state.wait.status === "timed_out") ? { rows: [this.waitRow()], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "id" = $1') && sql.includes("FOR UPDATE")) return { rows: [this.waitRow()], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('WHERE task."id" = $1') && !sql.includes("ANY")) return { rows: [this.taskRow(this.store.records.get(this.state.turn.rootTaskId)!)], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: this.state.turn.rootTaskId, attempt: 1, status: this.state.stepStatus }], rowCount: 1 }
    if (sql.includes('ANY($1::text[])')) {
      const child = [...this.store.records.values()].find(task => task.id === this.state.wait.targetTaskIds[0])
      return child ? { rows: [{ ...this.taskRow(child), role: child.role, result: child.result, failureReason: child.failureReason }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('SELECT "id", "rootTaskId" FROM "agent_turns"')) return { rows: [{ id: TURN_ID, rootTaskId: this.state.turn.rootTaskId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('FOR UPDATE')) return { rows: [this.turnRow()], rowCount: 1 }
    if (sql.includes('SELECT session."id" FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) return this.state.sessionStatus === "running" ? { rows: [{ id: SESSION_ID }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return this.sessionRow()
    if (sql.includes('SET "result" = jsonb_set')) {
      if (this.state.wait.consumedAt !== null) return { rows: [], rowCount: 0 }
      this.state.wait.result = { ...this.state.wait.result, outcome: JSON.parse(String(values[0])) as Record<string, unknown> }
      this.state.wait.consumedAt = new Date(String(values[1])); this.state.consumeWrites += 1
      return { rows: [{ id: this.state.wait.id }], rowCount: 1 }
    }
    if (sql.includes('UPDATE "agent_wait_conditions" SET "suspendedAt"')) { this.state.wait.suspendedAt = new Date(String(values[1])); return { rows: [], rowCount: 1 } }
    if (sql.includes('UPDATE "agent_wait_conditions" SET "status" = $1')) { this.state.wait.status = String(values[0]) as WaitState["status"]; this.state.wait.matchedTaskIds = JSON.parse(String(values[1])) as string[]; return { rows: [{ id: this.state.wait.id }], rowCount: 1 } }
    if (sql.includes('SET "status" = \'in_progress\'')) {
      if (this.state.turn.status !== "queued") return { rows: [], rowCount: 0 }
      this.state.turn.status = "in_progress"; this.state.turn.leaseOwnerId = String(values[2]); this.state.turn.leaseStartedAt = new Date(String(values[3])); this.state.turn.leaseExpiresAt = new Date(this.state.turn.leaseStartedAt.getTime() + Number(values[4])); this.state.turn.leaseVersion += 1; this.state.turn.revision += 1
      return { rows: [this.turnRow()], rowCount: 1 }
    }
    if (sql.includes('SET "status" = \'waiting_for_dependency\'')) { this.state.turn.status = "waiting_for_dependency"; this.state.turn.leaseOwnerId = null; this.state.turn.leaseExpiresAt = null; this.state.turn.leaseStartedAt = null; this.state.turn.revision += 1; return { rows: [], rowCount: 1 } }
    if (sql.includes('SET "status" = \'queued\'')) { this.state.turn.status = "queued"; this.state.turn.leaseOwnerId = null; this.state.turn.leaseExpiresAt = null; this.state.turn.leaseStartedAt = null; this.state.turn.revision += 1; return { rows: [], rowCount: 1 } }
    if (sql.includes('SET "status" = $5')) { this.state.turn.status = String(values[4]); this.state.turn.leaseOwnerId = null; this.state.turn.leaseExpiresAt = null; this.state.turn.leaseStartedAt = null; this.state.turn.revision += 1; return { rows: [], rowCount: 1 } }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) { this.outbox.push({ id: String(values[0]), aggregateId: String(values[2]), topic: String(values[1]), payload: JSON.parse(String(values[4])) as Record<string, unknown>, attemptCount: 0, publishedAt: null }); return { rows: [], rowCount: 1 } }
    if (sql.startsWith('UPDATE "agent_outbox"')) {
      const row = this.outbox.find(candidate => candidate.id === String(values[0]))
      if (row) row.publishedAt = NOW
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected integration query: ${trimmed.slice(0, 180)}`)
  }
}

class FixtureQueue {
  readonly jobs: Array<{ name: string; payload: Record<string, string>; options?: { jobId?: string; attempts?: number; delay?: number } }> = []
  async add(name: string, payload: Record<string, string>, options?: { jobId?: string; attempts?: number; delay?: number }): Promise<void> { this.jobs.push({ name, payload, options }) }
}

function context(taskId: string, rootTaskId: string, stepId = "step-1"): ToolExecutionContext {
  return { scope: { userId: USER_ID }, sessionId: SESSION_ID, turnId: TURN_ID, stepId, taskId, rootTaskId, signal: new AbortController().signal, capabilities: ["canManageChildren"], reportProgress: async () => undefined }
}

function policy(): SubagentPolicy { return normalizeSubagentPolicy({ maxAttempts: 2, maxConcurrency: 2, maxFanOut: 2 }) }

describe("canonical child wait resume composition", () => {
  it("drives spawn, retry/wait, child completion, durable wake, parent re-claim and once-only outcome consumption", async () => {
    const store = new HarnessStore()
    const manager = new AgentTreeManager(store, { clock: new NoopClock(), now: () => NOW })
    const root = await manager.spawn({ userId: USER_ID, sessionId: SESSION_ID, turnId: TURN_ID, role: "orchestrator", taskType: "root", goal: "coordinate", policy: policy() })
    const db = new IntegrationPg(store, root.id)
    const queue = new FixtureQueue()
    const waitPort: DurableWaitPort = {
      wait: async input => {
        db.state.wait = { id: "wait-1", userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, parentTaskId: input.taskId!, stepId: input.stepId, targetTaskIds: [...input.targetTaskIds], mode: input.mode, status: "waiting", matchedTaskIds: [], suspendedAt: null, consumedAt: null, result: { request: { targetTaskIds: [...input.targetTaskIds], mode: input.mode, timeoutMs: input.timeoutMs } } }
        return { waitId: "wait-1", status: "waiting", deadlineAt: new Date(NOW.getTime() + 60_000).toISOString(), matchedTaskIds: [] }
      },
    }
    const runtime: CoordinationRuntimeOptions = { manager, store, wait: waitPort }
    const rootStore = createPgRootTaskStore(db.pool)
    let initialPending: unknown
    let resumedFeedback: readonly Record<string, unknown>[] = []
    const initial = await runTurnJob({ data: { turnId: TURN_ID, sessionId: SESSION_ID, ownerId: ROOT_OWNER }, attemptsMade: 0 }, {
      pool: db.pool,
      now: () => NOW,
      heartbeatMs: 60_000,
      execute: async ({ lease }) => {
        const spawn = await executeSpawn(context(root.id, root.id), { idempotencyKey: "spawn-child-1", role: "scout", taskType: "inspect", goal: "inspect fixture" }, runtime)
        const child = store.records.get(spawn.taskId)!
        await enqueueSubagentTask(queue as never, { taskId: child.id, sessionId: SESSION_ID, rootTaskId: root.id, ownerId: CHILD_OWNER })
        initialPending = await rootStore.checkCompletion?.({ lease, rootTaskId: root.id, now: NOW })
        const wait = await executeWaitSubagents(context(root.id, root.id), { idempotencyKey: "wait-child-1", taskIds: [child.id], mode: "all", timeoutMs: 30_000 }, runtime)
        expect(wait.status).toBe("waiting")
        return { status: "waiting_for_dependency", waitId: wait.waitId }
      },
      waitHandoff: input => suspendAndReleaseWait(db.pool, input),
    })
    expect(initial).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(initialPending).toMatchObject({ ok: false, blocker: "child_tasks_pending" })
    expect(db.state.turn.status).toBe("waiting_for_dependency")
    expect(db.state.wait.suspendedAt).toEqual(NOW)
    expect(queue.jobs).toHaveLength(1)

    const childJob = queue.jobs.shift()!
    const childPayload = childJob.payload as unknown as SubagentJobPayload
    const retry = await manager.run(childPayload, async ({ lease }) => {
      expect(lease.userId).toBe(USER_ID); expect(lease.sessionId).toBe(SESSION_ID); expect(lease.attemptCount).toBe(1)
      return { status: "failed", failureReason: "fixture transient failure" }
    })
    expect(retry).toMatchObject({ taskId: childPayload.taskId, status: "retrying" })
    expect(store.records.get(childPayload.taskId)?.status).toBe("queued")
    await expect(reconcileDurableWaits(db.pool, { now: NOW, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(db.state.wait.status).toBe("waiting")

    const completed = await manager.run(childPayload, async ({ lease }) => {
      expect(lease.attemptCount).toBe(2)
      return { status: "completed", result: { outcome: "child-result", taskId: lease.id } }
    })
    expect(completed).toMatchObject({ taskId: childPayload.taskId, status: "completed" })
    expect(store.records.get(childPayload.taskId)).toMatchObject({ status: "completed", result: { outcome: "child-result" }, attemptCount: 2 })

    await expect(reconcileDurableWaits(db.pool, { now: NOW, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(db.state.wait.status).toBe("ready")
    expect(db.state.turn.status).toBe("queued")
    expect(db.outbox).toHaveLength(1)
    await expect(reconcileDurableWaits(db.pool, { now: NOW, ownerId: "resolver-1" })).resolves.toEqual({ scanned: 0, resolved: 0, woken: 0 })
    expect(db.outbox).toHaveLength(1)
    expect(await dispatchPendingTurnOutbox(db.pool, queue as never)).toBe(1)
    expect(db.calls.find(sql => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('SELECT dispatch."id"'))).toContain('session."id" = dispatch."aggregateId"')
    expect(queue.jobs).toHaveLength(1)

    const parentJob = queue.jobs.shift()!
    const resumed = await runTurnJob({ data: parentJob.payload as unknown as TurnJobPayload, attemptsMade: 0 }, {
      pool: db.pool,
      now: () => NOW,
      heartbeatMs: 60_000,
      execute: async ({ lease }) => {
        const turn = db.turnRow()
        const first = await consumeDurableWaitOutcomes({ client: db.client as never, lease, turn, now: NOW })
        const second = await consumeDurableWaitOutcomes({ client: db.client as never, lease, turn: db.turnRow(), now: NOW })
        resumedFeedback = first as readonly Record<string, unknown>[]
        expect(second).toEqual(first)
        expect(JSON.stringify(first)).toContain("child-result")
        const completion = await rootStore.checkCompletion?.({ lease, rootTaskId: root.id, now: NOW })
        expect(completion).toEqual({ ok: true })
        return { status: "completed" }
      },
    })
    expect(resumed).toMatchObject({ status: "completed" })
    expect(resumedFeedback).toHaveLength(1)
    expect(db.state.wait.consumedAt).toEqual(NOW)
    expect(db.state.consumeWrites).toBe(1)
    expect(db.state.turn.status).toBe("completed")
    expect(store.activities.filter(activity => activity.operation === "spawn_subagent")).toHaveLength(1)
  })
})
