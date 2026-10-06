import { randomUUID } from "node:crypto"
import { Queue, type Job } from "bullmq"
import { Redis } from "ioredis"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { SubagentPolicy, SubagentStore, SubagentTaskRecord, SubagentTaskSpec, SubagentLease, SubagentJobPayload } from "../runtime/subagents/types.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../runtime/subagents/tree-budget-types.js"
import type { TurnEngineStore } from "../runtime/turns/turn-engine-types.js"
import type { RuntimeToolDefinition } from "../runtime/tools/types.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { lockAndAdmitSubagentDispatch, PAUSE_DEFERRED_MARKER, repairDeferredSubagentDispatches } from "./subagent-pause-dispatch.js"
import { repairStaleSubagentDispatches } from "./subagent-dispatch-recovery.js"

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
  lastError?: string | null
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

function taskNeverStarted(task: SubagentTaskRecord): boolean { return Reflect.get(task, "startedAt") == null }

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
  const turn: { id: string; sessionId: string; userId: string; rootTaskId: string; status: string; leaseOwnerId: string | null; eventSequence: number } = { id: input.turnId, sessionId: input.sessionId, userId: input.userId, rootTaskId: input.rootTaskId, status: "waiting_for_dependency", leaseOwnerId: null, eventSequence: 40 }
  const session: { id: string; userId: string; status: string } = { id: input.sessionId, userId: input.userId, status: "running" }
  let pauseSequence: number | null = null
  let resumeSequence = 0
  const pauseAdmitted = () => pauseSequence === null || resumeSequence > pauseSequence
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
        return values[0] === session.id ? { rows: [{ ...session }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions" AS session') && sql.includes("NOT EXISTS")) {
        const admitted = values[0] === session.id && values[1] === session.userId && session.status === "running" && pauseAdmitted()
        return admitted ? { rows: [{ id: session.id }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT "id" FROM "agent_turns"') && sql.includes('"status" NOT IN') && sql.includes("FOR UPDATE")) {
        const terminal = ["completed", "failed", "interrupted", "cancelled", "closed"].includes(turn.status)
        return values[0] === turn.id && values[1] === turn.sessionId && values[2] === turn.userId && !terminal
          ? { rows: [{ id: turn.id }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT "id", "turnId" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2')) {
        const task = input.tasks.get(String(values[0]))
        return task && task.sessionId === values[1] ? { rows: [{ id: task.id, turnId: task.turnId }], rowCount: 1 } : none
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
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')
        && !sql.includes('ORDER BY session."updatedAt"') && !sql.includes("NOT EXISTS")) return none

      if (sql.includes('SELECT turn."id", turn."userId", turn."sessionId", turn."rootTaskId"')) {
        return ["waiting_for_dependency", "in_progress"].includes(turn.status)
          ? { rows: [{ ...turn }], rowCount: 1 }
          : none
      }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('ORDER BY "createdAt"')) {
        const active = wait.status === "waiting" || wait.status === "ready" || wait.status === "timed_out"
        return active && wait.consumedAt === null ? { rows: [{ ...wait }], rowCount: 1 } : none
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('WHERE task."id" = $1 AND task."sessionId"')
        && !sql.includes('task."rootTaskId" = $4 FOR UPDATE') && !sql.includes('SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", task."status", task."startedAt"')) {
        const task = input.tasks.get(String(values[0]))
        return task ? { rows: [{ id: task.id, rootTaskId: task.rootTaskId, turnId: task.turnId, sessionId: task.sessionId, userId: task.userId }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT root."id", root."status", root."interruptRequestedAt"') && sql.includes('FROM "sub_agent_tasks" AS root')) {
        const root = input.tasks.get(String(values[0]))
        return root && root.sessionId === values[1] && root.turnId === values[2]
          ? { rows: [{ id: root.id, status: root.status, interruptRequestedAt: root.interruptRequestedAt }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", task."status", task."startedAt"')
        && sql.includes('task."rootTaskId" = $4 FOR UPDATE')) {
        const task = input.tasks.get(String(values[0]))
        return task && task.sessionId === values[1] && task.turnId === values[2] && task.rootTaskId === values[3]
          ? { rows: [{ id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, turnId: task.turnId, status: task.status,
            startedAt: Reflect.get(task, "startedAt") ?? null, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, leaseOwner: task.leaseOwner,
            leaseExpiresAt: task.leaseExpiresAt, interruptRequestedAt: task.interruptRequestedAt }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT dispatch."id", dispatch."payload", dispatch."lastError"') && sql.includes('WHERE dispatch."id" = $1')) {
        const row = outbox.find(candidate => candidate.id === values[0] && candidate.aggregateId === values[1] && candidate.topic === values[2]
          && candidate.lastError === values[3] && candidate.publishedAt !== null)
        return row ? { rows: [{ id: row.id, payload: row.payload, lastError: row.lastError }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT session."id", session."userId" FROM "agent_sessions" AS session') && sql.includes('ORDER BY session."updatedAt"')) {
        const candidate = [...input.tasks.values()].some(task => {
          const root = input.tasks.get(task.rootTaskId)
          return task.sessionId === session.id && task.status === "queued" && taskNeverStarted(task) && task.leaseOwner == null
            && task.leaseExpiresAt == null && task.interruptRequestedAt == null && task.attemptCount < task.maxAttempts
            && root && root.status !== "completed" && root.status !== "failed" && root.interruptRequestedAt == null
            && turn.status !== "completed" && turn.status !== "failed" && pauseAdmitted()
            && outbox.some(row => row.idempotencyKey === `subagent-dispatch:${task.id}` && row.lastError === PAUSE_DEFERRED_MARKER && row.publishedAt !== null)
        })
        return candidate ? { rows: [{ id: session.id, userId: session.userId }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')
        && sql.includes('dispatch."publishedAt" < task."updatedAt"')
        && sql.includes('ORDER BY session."updatedAt"')) {
        const candidate = [...input.tasks.values()].some(task => {
          const root = input.tasks.get(task.rootTaskId), startedAt = Reflect.get(task, "startedAt"), updatedAt = Reflect.get(task, "updatedAt")
          const dispatch = outbox.find(row => row.topic === values[0] && row.aggregateId === session.id
            && row.idempotencyKey === `subagent-dispatch:${task.id}`)
          return task.sessionId === session.id && ["queued", "retrying"].includes(task.status) && startedAt != null
            && task.leaseOwner == null && task.leaseExpiresAt == null && task.interruptRequestedAt == null
            && task.attemptCount < task.maxAttempts && root && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(root.status)
            && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(turn.status)
            && dispatch?.publishedAt != null && updatedAt instanceof Date && dispatch.publishedAt < updatedAt
        })
        return candidate ? { rows: [{ id: session.id }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT task."id" AS "taskId"') && sql.includes('dispatch."id" AS "dispatchId"')) {
        const candidate = [...input.tasks.values()].find(task => task.sessionId === values[0] && task.status === "queued"
          && taskNeverStarted(task) && task.leaseOwner == null && task.leaseExpiresAt == null && task.interruptRequestedAt == null
          && task.attemptCount < task.maxAttempts && pauseAdmitted())
        const dispatch = candidate && outbox.find(row => row.idempotencyKey === `subagent-dispatch:${candidate.id}`
          && row.topic === values[1] && row.lastError === values[2] && row.publishedAt !== null)
        return candidate && dispatch ? { rows: [{ taskId: candidate.id, sessionId: candidate.sessionId, rootTaskId: candidate.rootTaskId,
          userId: session.userId, dispatchId: dispatch.id, payload: dispatch.payload }], rowCount: 1 } : none
      }
      if (sql.includes('UPDATE "agent_outbox" SET "payload" = $1::jsonb, "publishedAt" = NULL')) {
        const row = outbox.find(candidate => candidate.id === values[1] && candidate.aggregateId === values[2] && candidate.topic === values[3]
          && candidate.lastError === values[4] && candidate.publishedAt !== null)
        if (!row) return none
        const child = input.tasks.get(String(values[5])), root = input.tasks.get(String(values[6]))
        const eligible = child && root && child.sessionId === values[2] && child.rootTaskId === values[6] && child.status === "queued"
          && taskNeverStarted(child) && child.leaseOwner == null && child.leaseExpiresAt == null && child.interruptRequestedAt == null
          && child.attemptCount < child.maxAttempts && root.interruptRequestedAt == null && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(root.status)
          && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(turn.status) && session.status === "running" && pauseAdmitted()
        if (!eligible) return none
        row.payload = JSON.parse(String(values[0])) as Record<string, unknown>; row.publishedAt = null; row.attemptCount += 1
        return { rows: [], rowCount: 1 }
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
        else outbox.push({ id, topic, aggregateId, idempotencyKey, payload, publishedAt: null, attemptCount: 0, lastError: null })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in child queue Redis integration fixture: ${sql.slice(0, 180)}`)
    },
    release() {},
  }
  return { pool: { async connect() { return client } }, turn, session, wait, outbox, events,
    setPauseRequested(value: boolean) { if (value) pauseSequence = turn.eventSequence + 1; else resumeSequence = turn.eventSequence + 2 } }
}

describe("child queue SQL fixture", () => {
  it("returns no session from stale-dispatch recovery when no expired stale dispatch exists", async () => {
    const ids = { sessionId: "fixture-session", turnId: "fixture-turn", userId: "fixture-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: root.id, ...ids })

    await expect(repairStaleSubagentDispatches(fixture.pool as never, "recovery-owner")).resolves.toBe(0)
  })

  it("returns a task turn only for the matching session", async () => {
    const ids = { sessionId: "fixture-session", turnId: "fixture-turn", userId: "fixture-user" }
    const { store, tasks } = createTaskStore()
    const task = await store.create({ ...ids, role: "analyst", taskType: "research", goal: "fixture", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: task.id, childTaskId: task.id, ...ids })
    const client = await fixture.pool.connect()
    const sql = 'SELECT "id", "turnId" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2'

    await expect(client.query(sql, [task.id, ids.sessionId])).resolves.toEqual({ rows: [{ id: task.id, turnId: ids.turnId }], rowCount: 1 })
    await expect(client.query(sql, [task.id, "foreign-session"])).resolves.toEqual({ rows: [], rowCount: 0 })
    await expect(client.query(sql, ["missing-task", ids.sessionId])).resolves.toEqual({ rows: [], rowCount: 0 })
  })

  it("locks only the owned nonterminal turn and applies the running-session pause fence", async () => {
    const ids = { sessionId: "fixture-session", turnId: "fixture-turn", userId: "fixture-user" }
    const { store, tasks } = createTaskStore()
    const task = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: task.id, childTaskId: task.id, ...ids })
    const client = await fixture.pool.connect()
    expect(await lockAndAdmitSubagentDispatch(client as never, ids)).toBe(true)
    expect(await lockAndAdmitSubagentDispatch(client as never, { ...ids, userId: "foreign-user" })).toBe(false)
    expect(await lockAndAdmitSubagentDispatch(client as never, { ...ids, sessionId: "foreign-session" })).toBe(false)
    fixture.setPauseRequested(true)
    expect(await lockAndAdmitSubagentDispatch(client as never, ids)).toBe(false)
    fixture.setPauseRequested(false)
    fixture.turn.status = "completed"
    expect(await lockAndAdmitSubagentDispatch(client as never, ids)).toBe(false)
  })

  it("requeues only the owned deferred child after the full session/turn/root/task fence", async () => {
    const ids = { sessionId: "fixture-session", turnId: "fixture-turn", userId: "fixture-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    root.status = "running"
    const child = await store.create({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "fixture child", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 2 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
    const payload: SubagentJobPayload = { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "old-owner" }
    fixture.outbox.push({ id: "deferred-dispatch", topic: "agent.subagent.dispatch", aggregateId: ids.sessionId,
      idempotencyKey: `subagent-dispatch:${child.id}`, payload, publishedAt: new Date(), attemptCount: 1, lastError: PAUSE_DEFERRED_MARKER })
    expect(await repairDeferredSubagentDispatches(fixture.pool as never, "resumed-owner")).toBe(1)
    expect(fixture.outbox[0]).toMatchObject({ publishedAt: null, attemptCount: 2, payload: { taskId: child.id, rootTaskId: root.id } })
    expect(fixture.outbox[0]?.payload.ownerId).toMatch(/^resumed-owner-/)
  })

  it("does not requeue deferred children for foreign owners, pause, terminal roots, or exhausted leases", async () => {
    const run = async (mutate: (fixture: ReturnType<typeof createSqlFixture>, root: SubagentTaskRecord, child: SubagentTaskRecord) => void) => {
      const ids = { sessionId: `fixture-session-${randomUUID()}`, turnId: `fixture-turn-${randomUUID()}`, userId: `fixture-user-${randomUUID()}` }
      const { store, tasks } = createTaskStore()
      const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
      root.status = "running"
      const child = await store.create({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "fixture child", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 2 } })
      const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
      fixture.outbox.push({ id: "deferred-dispatch", topic: "agent.subagent.dispatch", aggregateId: ids.sessionId,
        idempotencyKey: `subagent-dispatch:${child.id}`, payload: { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "old-owner" },
        publishedAt: new Date(), attemptCount: 1, lastError: PAUSE_DEFERRED_MARKER })
      mutate(fixture, root, child)
      expect(await repairDeferredSubagentDispatches(fixture.pool as never, "resumed-owner")).toBe(0)
      expect(fixture.outbox[0]?.publishedAt).not.toBeNull()
    }
    await run(fixture => fixture.setPauseRequested(true))
    await run((_fixture, root) => { root.status = "failed" })
    await run((_fixture, _root, child) => { child.attemptCount = child.maxAttempts })
    await run((fixture, _root, child) => { child.sessionId = `${fixture.session.id}-foreign` })
  })
})

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
  const events: Array<{ type: string; payload: unknown }> = []
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
  const turnStore: TurnEngineStore = {
    async startStep({ stepId, ordinal }) { return { id: stepId, ordinal } },
    async updateStep() {},
    async createItem({ owner, itemId }) { revisions.set(`${owner.taskId}:${itemId}`, 0); return { id: itemId, revision: 0 } },
    async updateItem({ owner, itemId, expectedRevision }) {
      const key = `${owner.taskId}:${itemId}`
      revisions.set(key, expectedRevision + 1)
      return { id: itemId, revision: expectedRevision + 1 }
    },
    async appendEvent(input) { events.push({ type: input.type, payload: input.payload }); return { id: `fixture-event-${randomUUID()}` } },
    async recordFinalResponse() {},
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
    turnStore,
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
  return { execute: executor, diagnostics: () => ({ modelCalls, events }) }
}

describe("deterministic production child fixture", () => {
  it("executes the child runtime from a manager-issued lease without Redis", async () => {
    const ids = { sessionId: `direct-session-${randomUUID()}`, turnId: `direct-turn-${randomUUID()}`, userId: `direct-user-${randomUUID()}` }
    const { AgentTreeManager } = await import("../runtime/subagents/manager.js")
    const { store } = createTaskStore()
    const manager = new AgentTreeManager(store)
    const root = await manager.spawn({ ...ids, role: "planner", taskType: "root", goal: "parent wait fixture" })
    root.status = "running"
    const child = await manager.spawn({
      ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "Read deterministic job evidence",
      allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "fixture-model" },
    })
    const payload: SubagentJobPayload = { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "direct-child-owner" }
    const toolCalls: Array<{ taskId: string; toolName: string }> = []
    const runtime = await deterministicChildRuntime(toolCalls)
    try {
      const outcome = await manager.run(payload, runtime.execute)
      expect(outcome, JSON.stringify({ task: child, diagnostics: runtime.diagnostics(), toolCalls })).toMatchObject({ taskId: child.id, status: "completed" })
    } finally {
      await manager.shutdown()
    }
  }, 30_000)
})

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
        subagents: { execute: childExecutor.execute, intervalMs: 60_000, queue: dispatchQueue },
      },
      startAgentRunWorker: () => undefined,
    })
    bootstraps.push(bootstrap)
    await bootstrap.subagents!.queue.worker.waitUntilReady()

    const job = await waitForCompletedJob(observerQueue!, subagentJobId(child.id))
    expect(job.data).toEqual(payload)
    expect(
      job.returnvalue,
      `child failureReason=${String(child.failureReason)}; child result=${JSON.stringify(child.result)}; diagnostics=${JSON.stringify(childExecutor.diagnostics())}; tool calls=${JSON.stringify(toolCalls)}`,
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
