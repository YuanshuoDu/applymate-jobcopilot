import { randomUUID } from "node:crypto"
import { Queue, type Job } from "bullmq"
import { Redis } from "ioredis"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SubagentPolicy, SubagentStore, SubagentTaskRecord, SubagentTaskSpec, SubagentLease, SubagentJobPayload } from "../runtime/subagents/types.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../runtime/subagents/tree-budget-types.js"
import type { TurnExecutionStore } from "../runtime/turns/turn-execution-types.js"
import type { RuntimeToolDefinition } from "../runtime/tools/types.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"

const RUN_REDIS_INTEGRATION = process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1"

function dedicatedRedisUrl(): string | null {
  if (!RUN_REDIS_INTEGRATION) return null
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") {
    throw new Error("Subagent queue Redis integration requires an explicitly disposable Redis service")
  }
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) throw new Error("AGENT_TURN_REDIS_TEST_URL is required when the Redis integration gate is enabled")
  const url = new URL(value)
  if (
    url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Subagent queue Redis integration accepts only a disposable loopback Redis DB 15 URL")
  }
  return value
}

const redisUrl = dedicatedRedisUrl()
const describeWithRedis = redisUrl ? describe : describe.skip

type FixtureOutbox = {
  id: string
  topic: string
  aggregateId: string
  idempotencyKey: string
  payload: Record<string, unknown>
  publishedAt: Date | null
  attemptCount: number
}

type FixtureWait = {
  id: string
  userId: string
  sessionId: string
  turnId: string
  parentTaskId: string
  stepId: string
  targetTaskIds: string[]
  mode: "any"
  status: string
  deadlineAt: Date
  suspendedAt: Date | null
  consumedAt: Date | null
  matchedTaskIds: string[]
}

function createTaskStore(): { store: SubagentStore; tasks: Map<string, SubagentTaskRecord> } {
  const tasks = new Map<string, SubagentTaskRecord>()
  let sequence = 0
  const store: SubagentStore = {
    async create(input: SubagentTaskSpec & { policy: SubagentPolicy }) {
      const parent = input.parentTaskId ? tasks.get(input.parentTaskId) : undefined
      if (input.parentTaskId && !parent) throw new Error("fixture_parent_missing")
      const id = `redis-child-${++sequence}`
      const task: SubagentTaskRecord = {
        id, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId ?? null,
        rootTaskId: parent?.rootTaskId ?? id, parentTaskId: input.parentTaskId ?? null,
        path: parent ? `${parent.path}/${id}` : `/${id}`, depth: parent ? parent.depth + 1 : 0,
        role: input.role, taskType: input.taskType, status: "queued", goal: input.goal,
        constraints: input.constraints ?? [], successCriteria: input.successCriteria ?? [], allowedActions: input.allowedActions ?? [],
        context: input.context ?? {}, expectedOutputSchema: input.expectedOutputSchema ?? null,
        modelProfileSnapshot: input.modelProfileSnapshot ?? null, result: null, failureReason: null,
        attemptCount: 0, maxAttempts: input.policy.maxAttempts, nextAttemptAt: null,
        leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
        budgetSnapshot: { subagentPolicy: input.policy }, toolPolicySnapshot: input.toolPolicySnapshot ?? {},
      }
      tasks.set(id, task)
      return task
    },
    async get(taskId, sessionId) {
      const task = tasks.get(taskId)
      return task?.sessionId === sessionId ? task : null
    },
    async claim(input) {
      const task = tasks.get(input.taskId)
      if (!task || task.sessionId !== input.sessionId || task.status !== "queued") return null
      task.status = "running"
      task.attemptCount += 1
      task.leaseOwner = input.ownerId
      task.leaseExpiresAt = new Date(input.now.getTime() + 60_000)
      return task
    },
    async heartbeat(input) {
      const task = tasks.get(input.taskId)
      if (!task || task.sessionId !== input.sessionId || task.status !== "running" || task.leaseOwner !== input.ownerId || task.attemptCount !== input.attemptCount) return "lost"
      task.leaseExpiresAt = new Date(input.now.getTime() + 60_000)
      return "renewed"
    },
    async finish(input) {
      const task = tasks.get(input.taskId)
      if (!task || task.sessionId !== input.sessionId || task.status !== "running" || task.leaseOwner !== input.ownerId || task.attemptCount !== input.attemptCount) return null
      task.status = input.status
      task.result = input.result ?? null
      task.failureReason = input.failureReason ?? null
      task.leaseOwner = null
      task.leaseExpiresAt = null
      return input.status
    },
    async close(input) {
      const task = tasks.get(input.taskId)
      if (!task || task.sessionId !== input.sessionId) return false
      task.status = "closed"
      return true
    },
    async interruptTree() { return 0 },
    async recoverExpired() { return [] },
  }
  return { store, tasks }
}

function createSqlFixture(input: { tasks: Map<string, SubagentTaskRecord>; rootTaskId: string; childTaskId: string; sessionId: string; turnId: string; userId: string }) {
  const turn = { id: input.turnId, sessionId: input.sessionId, userId: input.userId, rootTaskId: input.rootTaskId, status: "waiting_for_dependency", leaseOwnerId: null, eventSequence: 40 }
  const wait: FixtureWait = {
    id: `redis-wait-${randomUUID()}`, userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
    parentTaskId: input.rootTaskId, stepId: `redis-step-${randomUUID()}`, targetTaskIds: [input.childTaskId],
    mode: "any", status: "waiting", deadlineAt: new Date(Date.now() + 60_000), suspendedAt: new Date(), consumedAt: null, matchedTaskIds: [],
  }
  const outbox: FixtureOutbox[] = []
  const events: Array<Record<string, unknown>> = []

  const client = {
    async query(sql: string, values: unknown[] = []) {
      const none = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }

      if (sql.includes('SELECT session."id", session."status", session."userId"')) {
        return values[0] === input.sessionId ? { rows: [{ id: input.sessionId, userId: input.userId, status: "running" }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"') && sql.includes('ORDER BY dispatch."createdAt"')) {
        const rows = outbox.filter(row => row.topic === values[0] && row.publishedAt === null).map(row => ({ id: row.id, aggregateId: row.aggregateId, payload: row.payload, attemptCount: row.attemptCount }))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"') && sql.includes('WHERE dispatch."id" = $1')) {
        const row = outbox.find(candidate => candidate.id === values[0] && candidate.aggregateId === values[1] && candidate.topic === values[2] && candidate.publishedAt === null)
        return row ? { rows: [{ id: row.id, aggregateId: row.aggregateId, payload: row.payload, attemptCount: row.attemptCount }], rowCount: 1 } : none
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('LEFT JOIN "sub_agent_tasks" AS root') && sql.includes('FOR UPDATE OF task')) {
        const task = input.tasks.get(String(values[0]))
        const root = input.tasks.get(input.rootTaskId)
        return task && root ? { rows: [{
          id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, turnId: task.turnId, status: task.status,
          attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, leaseOwner: task.leaseOwner, leaseExpiresAt: task.leaseExpiresAt,
          interruptRequestedAt: task.interruptRequestedAt, nextAttemptAt: task.nextAttemptAt,
          rootId: root.id, rootSessionId: root.sessionId, rootTurnId: root.turnId, rootStatus: root.status,
          turnRowId: turn.id, turnSessionId: turn.sessionId, turnUserId: turn.userId, turnStatus: turn.status, retryDue: true,
        }], rowCount: 1 } : none
      }
      if (sql.includes('UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP')) {
        const row = outbox.find(candidate => candidate.id === values[0] && candidate.aggregateId === values[1] && candidate.topic === values[2] && candidate.publishedAt === null)
        if (row) { row.publishedAt = new Date(); row.attemptCount += 1; return { rows: [], rowCount: 1 } }
        return none
      }
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')) return none

      if (sql.includes('SELECT turn."id", turn."userId", turn."sessionId", turn."rootTaskId"')) {
        return ["waiting_for_dependency", "in_progress"].includes(turn.status)
          ? { rows: [{ ...turn }], rowCount: 1 }
          : none
      }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('ORDER BY "createdAt"')) {
        const active = wait.status === "waiting" || wait.status === "ready" || wait.status === "timed_out"
        return active && wait.consumedAt === null ? { rows: [{ ...wait }], rowCount: 1 } : none
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('WHERE task."id" = $1 AND task."sessionId"')) {
        const task = input.tasks.get(String(values[0]))
        return task ? { rows: [{ id: task.id, rootTaskId: task.rootTaskId, turnId: task.turnId, sessionId: task.sessionId, userId: task.userId }], rowCount: 1 } : none
      }
      if (sql.includes('FROM "agent_steps"')) {
        return values[0] === wait.stepId ? { rows: [{ id: wait.stepId, taskId: input.rootTaskId, attempt: 1, status: "waiting_for_tool" }], rowCount: 1 } : none
      }
      if (sql.includes('WHERE task."id" = ANY($1::text[])')) {
        const target = input.tasks.get(input.childTaskId)
        return target ? { rows: [{ id: target.id, rootTaskId: target.rootTaskId, turnId: target.turnId, sessionId: target.sessionId, userId: target.userId, status: target.status }], rowCount: 1 } : none
      }
      if (sql.includes('UPDATE "agent_wait_conditions" SET "status"')) {
        if (wait.id !== values[3] || wait.status !== "waiting") return none
        wait.status = String(values[0])
        wait.matchedTaskIds = JSON.parse(String(values[1])) as string[]
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns" SET "status" = \'queued\'')) {
        if (turn.status !== "waiting_for_dependency" || turn.leaseOwnerId !== null) return none
        turn.status = "queued"
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_sessions" AS session SET "eventSequence"')) {
        turn.eventSequence += 1
        return { rows: [{ eventSequence: turn.eventSequence }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_events"')) {
        events.push({ sql, values })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        let topic: string
        let id: string
        let aggregateId: string
        let idempotencyKey: string
        let payload: Record<string, unknown>
        if (sql.includes("'agent.session.event'")) {
          [id, aggregateId, idempotencyKey] = values as [string, string, string]
          topic = "agent.session.event"
          payload = JSON.parse(String(values[3])) as Record<string, unknown>
        } else {
          [id, topic, aggregateId, idempotencyKey] = values as [string, string, string, string]
          payload = JSON.parse(String(values[4])) as Record<string, unknown>
        }
        const existing = outbox.find(row => row.idempotencyKey === idempotencyKey)
        if (existing) { existing.payload = payload; existing.publishedAt = null; existing.attemptCount += 1 }
        else outbox.push({ id, topic, aggregateId, idempotencyKey, payload, publishedAt: null, attemptCount: 0 })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in child queue Redis integration fixture: ${sql.slice(0, 180)}`)
    },
    release() {},
  }
  return { pool: { async connect() { return client } }, turn, wait, outbox, events }
}

async function waitForCompletedJob<T>(queue: Queue<T>, id: string, timeoutMs = 10_000): Promise<Job<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await queue.getJob(id)
    if (job) {
      const status = await job.getState()
      if (status === "completed") return (await queue.getJob(id))!
      if (status === "failed") throw new Error(`Subagent job ${id} failed: ${job.failedReason}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for Subagent job ${id} to complete`)
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for the durable parent wait to resolve")
}

const modelProfile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}

async function deterministicChildRuntime(toolCalls: Array<{ taskId: string; toolName: string }>) {
  const { createProductionChildExecutor } = await import("../runtime/subagents/production-child-runtime.js")
  let modelCalls = 0
  const model: ModelAdapter = {
    id: "fixture-child-model", profile: modelProfile,
    async *stream() {
      modelCalls += 1
      const call = modelCalls
      if (call === 1) {
        yield { type: "tool_call_completed", callId: `read-${call}`, name: "jobs.search", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text: "Found one deterministic candidate." }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
  const tool: RuntimeToolDefinition = {
    schemaVersion, name: "jobs.search", version: "1", description: "Read fixture jobs", capabilities: ["read"],
    inputSchema: Type.Object({}, { additionalProperties: true }), outputSchema: Type.Object({}, { additionalProperties: true }),
    risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: ["read"],
    async execute() { return { jobs: [{ id: "fixture-job" }] } },
  }
  const revisions = new Map<string, number>()
  const turnStore: TurnExecutionStore = {
    async startStep({ stepId, ordinal }) { return { id: stepId, ordinal } },
    async updateStep() {},
    async createItem({ identity, itemId }) { revisions.set(`${identity.taskId}:${itemId}`, 0); return { id: itemId, revision: 0 } },
    async updateItem({ identity, itemId, expectedRevision }) {
      const key = `${identity.taskId}:${itemId}`
      revisions.set(key, expectedRevision + 1)
      return { id: itemId, revision: expectedRevision + 1 }
    },
    async appendEvent() { return { id: `fixture-event-${randomUUID()}` } },
  }
  const treeBudget: TreeBudgetReservationStore = {
    async reserve(input) {
      return { ...input, id: `fixture-budget-${input.stepId}`, units: 1, status: "reserved", createdAt: new Date(), updatedAt: new Date(), settledAt: null } as TreeBudgetReservation
    },
    async settle(input) {
      return { ...input, units: 1, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() } as TreeBudgetReservation
    },
  }
  const executor = createProductionChildExecutor({
    pool: { async connect() { throw new Error("fixture pool should not be used by the deterministic child runtime") } } as never,
    turnStore: turnStore as never,
    treeBudget,
    authorizeUsage: async () => ({ settle: async () => undefined }),
    modelRuntimeFactory: () => model,
    toolRuntimeFactory: () => ({
      definitions: [tool],
      router: { async execute(context, request) {
        toolCalls.push({ taskId: context.taskId ?? "", toolName: request.toolName })
        return { ...request, status: "completed", output: { jobs: [{ id: "fixture-job" }] }, errorCode: null }
      } },
      validateArguments: () => true,
    }),
    resumeLoader: async () => undefined,
  })
  return executor
}

describeWithRedis("production child scheduling and wait wakeup (real Redis/BullMQ)", () => {
  let probeRedis: Redis | undefined
  let dispatchQueue: Queue<SubagentJobPayload> | undefined
  let observerQueue: Queue<SubagentJobPayload> | undefined
  let queueName: string | undefined
  const bootstraps: Array<{ close(): Promise<void> }> = []

  beforeAll(async () => {
    probeRedis = new Redis(redisUrl!, {
      lazyConnect: true, maxRetriesPerRequest: null, enableReadyCheck: false,
      connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await probeRedis.connect()
    await probeRedis.ping()
    vi.doMock("../redis.js", () => ({
      redisConnection: probeRedis,
      redisCommandConnection: probeRedis,
      closeSharedRedisConnections: async () => undefined,
    }))
    const queueModule = await import("./subagent-queue.js")
    queueName = queueModule.SUBAGENT_QUEUE_NAME
    dispatchQueue = new Queue<SubagentJobPayload>(queueName, { connection: probeRedis, skipVersionCheck: true })
    observerQueue = new Queue<SubagentJobPayload>(queueName, { connection: probeRedis, skipVersionCheck: true })
    await Promise.all([dispatchQueue.waitUntilReady(), observerQueue.waitUntilReady()])
    await dispatchQueue.obliterate({ force: true })
  }, 15_000)

  afterAll(async () => {
    for (const bootstrap of bootstraps.reverse()) await bootstrap.close().catch(() => undefined)
    await observerQueue?.obliterate({ force: true }).catch(() => undefined)
    await observerQueue?.close().catch(() => undefined)
    await dispatchQueue?.close().catch(() => undefined)
    if (probeRedis && probeRedis.status !== "end") await probeRedis.quit().catch(() => probeRedis?.disconnect())
    vi.doUnmock("../redis.js")
  })

  it("dispatches and consumes a child through production bootstrap, then wakes its durable parent wait", async () => {
    const ids = { sessionId: `redis-session-${randomUUID()}`, turnId: `redis-turn-${randomUUID()}`, userId: `redis-user-${randomUUID()}` }
    const { AgentTreeManager } = await import("../runtime/subagents/manager.js")
    const { persistSubagentDispatch, subagentJobId } = await import("./subagent-queue.js")
    const { store, tasks } = createTaskStore()
    const manager = new AgentTreeManager(store)
    const root = await manager.spawn({ ...ids, role: "planner", taskType: "root", goal: "parent wait fixture" })
    root.status = "running"
    const child = await manager.spawn({
      ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "Read deterministic job evidence",
      allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "fixture-model" },
    })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
    const payload: SubagentJobPayload = { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "redis-child-owner" }
    await persistSubagentDispatch(fixture.pool as never, payload)
    const toolCalls: Array<{ taskId: string; toolName: string }> = []
    const childExecutor = await deterministicChildRuntime(toolCalls)
    const runtime = {
      execute: async () => ({ status: "completed" as const }),
      manager,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      close: async () => undefined,
    }
    const { startProductionAgentRuntime } = await import("./production-bootstrap.js")
    const bootstrap = await startProductionAgentRuntime({
      pool: fixture.pool as never,
      createRuntime: async () => runtime as never,
      bootstrapOptions: {
        ownerId: "redis-child-worker",
        turnQueueFactory: () => ({
          queue: { add: async () => undefined }, worker: { pause: async () => undefined },
          active: { size: 0, values: () => [] }, close: async () => undefined,
        }) as never,
        turnRecoveryFactory: () => ({ close: async () => undefined }) as never,
        waitResolver: { intervalMs: 10, batchSize: 1, ownerId: "redis-wait-resolver" },
        subagents: { execute: childExecutor, intervalMs: 60_000, queue: dispatchQueue },
      },
      startAgentRunWorker: () => undefined,
    })
    bootstraps.push(bootstrap)
    await bootstrap.subagents!.queue.worker.waitUntilReady()

    const job = await waitForCompletedJob(observerQueue!, subagentJobId(child.id))
    expect(job.data).toEqual(payload)
    expect(
      job.returnvalue,
      `child failureReason=${String(child.failureReason)}; child result=${JSON.stringify(child.result)}; tool calls=${JSON.stringify(toolCalls)}`,
    ).toMatchObject({ taskId: child.id, status: "completed" })
    expect(fixture.outbox.find(row => row.topic === "agent.subagent.dispatch")).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1 })
    expect(child.status).toBe("completed")
    expect(child.result).toMatchObject({ status: "completed", toolCallCount: 1, finalText: "Found one deterministic candidate." })
    expect(toolCalls).toEqual([{ taskId: child.id, toolName: "jobs.search" }])

    await waitFor(() => fixture.wait.status === "ready" && fixture.turn.status === "queued")
    expect(fixture.wait.matchedTaskIds).toEqual([child.id])
    expect(fixture.turn).toMatchObject({ status: "queued", leaseOwnerId: null })
    expect(fixture.events).toHaveLength(1)
    expect(fixture.outbox.filter(row => row.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fixture.outbox.find(row => row.topic === "agent.turn.dispatch")).toMatchObject({
      aggregateId: ids.sessionId,
      idempotencyKey: `turn-dispatch:${ids.turnId}`,
      payload: { turnId: ids.turnId, sessionId: ids.sessionId, ownerId: "redis-wait-resolver" },
    })
  }, 25_000)
})
