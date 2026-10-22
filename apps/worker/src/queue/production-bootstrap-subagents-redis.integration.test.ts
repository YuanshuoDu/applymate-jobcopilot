import { randomUUID } from "node:crypto"
import { Queue, type Job } from "bullmq"
import { Redis } from "ioredis"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { parseSubagentJobPayload, type SubagentPolicy, type SubagentStore, type SubagentTaskRecord, type SubagentTaskSpec, type SubagentLease, type SubagentJobPayload } from "../runtime/subagents/types.js"
import { parseSubagentDispatchIdentity, subagentDispatchJobId } from "../runtime/subagents/dispatch-identity.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../runtime/subagents/tree-budget-types.js"
import type { TurnEngineStore } from "../runtime/turns/turn-engine-types.js"
import type { RuntimeToolDefinition } from "../runtime/tools/types.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { CHILD_WAIT_RESUMABLE_SQL } from "./subagent-dispatch-eligibility.js"
import { lockAndAdmitSubagentDispatch, PAUSE_DEFERRED_MARKER, persistSubagentDispatch, repairDeferredSubagentDispatches } from "./subagent-pause-dispatch.js"
import { repairStaleSubagentDispatches } from "./subagent-dispatch-recovery.js"
import { recoverMissingPublishedSubagentDispatches } from "./subagent-published-dispatch-recovery.js"
import { reconcileDurableWaits } from "../runtime/subagents/durable-wait-resolver.js"

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

function createTaskStore(): { store: SubagentStore; tasks: Map<string, SubagentTaskRecord>; bindOutbox: (rows: FixtureOutbox[]) => void } {
  const tasks = new Map<string, SubagentTaskRecord>()
  let publishedOutbox: FixtureOutbox[] = []
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
    async matchesPublishedDispatch({ payload, dispatchIdentity }) {
      const identity = parseSubagentDispatchIdentity(dispatchIdentity, payload.taskId)
      const task = tasks.get(payload.taskId)
      const dispatch = publishedOutbox.find(row => row.topic === "agent.subagent.dispatch"
        && row.aggregateId === payload.sessionId && row.idempotencyKey === `subagent-dispatch:${payload.taskId}`)
      const currentPayload = dispatch ? parseSubagentJobPayload(dispatch.payload) : null
      return !!identity && !!task && !!dispatch && dispatch.publishedAt !== null
        && Number.isSafeInteger(dispatch.attemptCount) && dispatch.attemptCount === identity.generation + 1
        && task.sessionId === payload.sessionId && task.rootTaskId === payload.rootTaskId
        && identity.taskId === payload.taskId && currentPayload?.taskId === payload.taskId
        && currentPayload.sessionId === payload.sessionId && currentPayload.rootTaskId === payload.rootTaskId
        && currentPayload.ownerId === payload.ownerId
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
  return { store, tasks, bindOutbox(rows) { publishedOutbox = rows } }
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
  const transactionBoundaries: string[] = []
  let transactionOpen = false
  const terminalTaskStatuses = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
  const terminalTurnStatuses = new Set(["completed", "failed", "interrupted", "cancelled"])
  const missingDispatchTasks = (sessionIds: readonly string[] = [session.id]) => [...input.tasks.values()].filter(task => {
    const root = input.tasks.get(task.rootTaskId)
    const due = task.nextAttemptAt == null || task.nextAttemptAt <= new Date()
    const hasDispatch = outbox.some(row => row.topic === "agent.subagent.dispatch" && row.idempotencyKey === `subagent-dispatch:${task.id}`)
    return sessionIds.includes(task.sessionId) && task.sessionId === session.id && task.turnId === turn.id
      && task.userId === session.userId && ["queued", "retrying"].includes(task.status)
      && task.interruptRequestedAt === null && task.attemptCount < task.maxAttempts && due && !hasDispatch
      && root?.sessionId === task.sessionId && root.turnId === task.turnId && !terminalTaskStatuses.has(root.status)
      && !terminalTurnStatuses.has(turn.status) && session.status === "running" && pauseAdmitted()
  })

  const client = {
    async query(sql: string, values: unknown[] = []) {
      const none = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 }
      if (sql === "BEGIN") { transactionOpen = true; transactionBoundaries.push(sql); return { rows: [], rowCount: 1 } }
      if (sql === "COMMIT" || sql === "ROLLBACK") { transactionOpen = false; transactionBoundaries.push(sql); return { rows: [], rowCount: 1 } }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }

      if (sql.includes('SELECT dispatch."id" AS "dispatchId"') && sql.includes('dispatch."publishedAt" <= CURRENT_TIMESTAMP')) {
        const rows = outbox.flatMap(row => {
          const taskId = row.idempotencyKey.replace(/^subagent-dispatch:/, "")
          const task = input.tasks.get(taskId), root = task ? input.tasks.get(task.rootTaskId) : undefined
          const publishedAt = row.publishedAt
          if (row.topic !== values[0] || !task || !root || !publishedAt || publishedAt.getTime() > Date.now() - 30_000
            || row.attemptCount < 1 || task.status !== "queued" || task.attemptCount !== 0
            || task.sessionId !== session.id || task.turnId !== turn.id || task.rootTaskId !== input.rootTaskId
            || turn.rootTaskId !== task.rootTaskId || root.status !== "running" || turn.status === "completed" || session.status !== "running") return []
          return [{
            dispatchId: row.id, topic: row.topic, aggregateId: row.aggregateId, idempotencyKey: row.idempotencyKey,
            payload: row.payload, attemptCount: row.attemptCount, publishedAt, publishedAtText: publishedAt.toISOString(),
            taskId: task.id, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId,
            taskStatus: task.status, taskAttemptCount: task.attemptCount, taskMaxAttempts: task.maxAttempts,
            taskStartedAt: Reflect.get(task, "startedAt") ?? null, taskLeaseOwner: task.leaseOwner,
            taskLeaseExpiresAt: task.leaseExpiresAt, taskInterruptRequestedAt: task.interruptRequestedAt,
            taskNextAttemptAt: task.nextAttemptAt, userId: session.userId, sessionStatus: session.status,
            turnStatus: turn.status, turnRootTaskId: turn.rootTaskId,
            rootStatus: root.status, rootInterruptRequestedAt: root.interruptRequestedAt,
          }]
        })
        return { rows: rows.slice(0, Number(values[3])), rowCount: rows.length }
      }

      if (sql.includes('SELECT session."id", session."status", session."userId"')) {
        return values[0] === session.id ? { rows: [{ ...session }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT session."id", session."userId", session."status"') && sql.includes("FOR UPDATE")) {
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
      if (sql.includes('SELECT turn."id", turn."status", turn."rootTaskId"')
        && sql.includes('FROM "agent_turns" AS turn') && sql.includes("FOR UPDATE")) {
        const terminal = ["completed", "failed", "interrupted", "cancelled", "closed"].includes(turn.status)
        return values[0] === turn.id && values[1] === turn.sessionId && values[2] === turn.userId
          && values[4] === turn.rootTaskId && !terminal
          ? { rows: [{ id: turn.id, status: turn.status, rootTaskId: turn.rootTaskId }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT turn."id" FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
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
        && sql.includes('LEFT JOIN "agent_outbox" AS dispatch') && sql.includes('dispatch."id" IS NULL')
        && sql.includes('ORDER BY session."updatedAt"')) {
        const rows = missingDispatchTasks().length > 0 ? [{ id: session.id }] : []
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('SELECT task."id", task."sessionId", task."rootTaskId"')
        && sql.includes('LEFT JOIN "agent_outbox" AS dispatch') && sql.includes('session."id" = ANY($1::text[])')
        && sql.includes('LIMIT $3 FOR UPDATE OF task SKIP LOCKED')) {
        const rows = missingDispatchTasks((values[0] as string[]).map(String)).slice(0, Number(values[2])).map(task => ({
          id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId,
        }))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')
        && !sql.includes('ORDER BY session."updatedAt"') && !sql.includes("NOT EXISTS")) return none

      if (sql.includes('SELECT turn."id", turn."userId", turn."sessionId", turn."rootTaskId"')) {
        return ["waiting_for_dependency", "in_progress"].includes(turn.status)
          ? { rows: [{ ...turn, sessionStatus: session.status }], rowCount: 1 }
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
      if (sql.includes('SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status"')
        && sql.includes('task."rootTaskId" = $4 FOR UPDATE')) {
        const task = input.tasks.get(String(values[0]))
        return task && task.sessionId === values[1] && task.turnId === values[2] && task.rootTaskId === values[3]
          ? { rows: [{ id: task.id, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId,
            status: task.status, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts,
            startedAt: Reflect.get(task, "startedAt") ?? null, leaseOwner: task.leaseOwner, leaseExpiresAt: task.leaseExpiresAt,
            interruptRequestedAt: task.interruptRequestedAt, nextAttemptAt: task.nextAttemptAt }], rowCount: 1 } : none
      }
      if (sql.includes('SELECT dispatch."id", dispatch."topic", dispatch."aggregateId", dispatch."idempotencyKey"')
        && sql.includes("FOR UPDATE")) {
        const row = outbox.find(candidate => candidate.id === values[0] && candidate.aggregateId === values[1]
          && candidate.topic === values[2] && candidate.idempotencyKey === values[3])
        return row ? { rows: [{ id: row.id, topic: row.topic, aggregateId: row.aggregateId,
          idempotencyKey: row.idempotencyKey, payload: row.payload, attemptCount: row.attemptCount,
          publishedAtText: row.publishedAt?.toISOString() ?? null }], rowCount: 1 } : none
      }
      if (sql.includes('UPDATE "agent_outbox" AS dispatch SET "publishedAt" = NULL')) {
        const row = outbox.find(candidate => candidate.id === values[0] && candidate.topic === values[1]
          && candidate.aggregateId === values[2] && candidate.idempotencyKey === values[3]
          && candidate.attemptCount === values[4] && candidate.publishedAt?.toISOString() === values[5]
          && JSON.stringify(candidate.payload) === String(values[6]))
        if (!row) return none
        row.publishedAt = null
        return { rows: [], rowCount: 1 }
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
        return row ? { rows: [{ id: row.id, payload: row.payload, lastError: row.lastError, attemptCount: row.attemptCount }], rowCount: 1 } : none
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
          userId: session.userId, dispatchId: dispatch.id, payload: dispatch.payload, dispatchAttemptCount: dispatch.attemptCount }], rowCount: 1 } : none
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
      if (sql.includes('FROM "agent_steps"') && !sql.includes(CHILD_WAIT_RESUMABLE_SQL)) {
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
    transactionOpen: () => transactionOpen, transactionBoundaries,
    setPauseRequested(value: boolean) { if (value) pauseSequence = turn.eventSequence + 1; else resumeSequence = turn.eventSequence + 2 } }
}

describe("child queue SQL fixture", () => {
  it("resolves a completed child into the durable parent wake and dispatch", async () => {
    const ids = { sessionId: "wait-session", turnId: "wait-turn", userId: "wait-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    root.status = "running"
    const child = await store.create({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "fixture child", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    child.status = "completed"
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })

    await expect(reconcileDurableWaits(fixture.pool as never, { ownerId: "fixture-wait-resolver" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fixture.wait).toMatchObject({ status: "ready", matchedTaskIds: [child.id] })
    expect(fixture.turn).toMatchObject({ status: "queued", leaseOwnerId: null })
    expect(fixture.events).toHaveLength(1)
    expect(fixture.outbox.filter(row => row.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fixture.outbox.find(row => row.topic === "agent.turn.dispatch")).toMatchObject({
      aggregateId: ids.sessionId,
      idempotencyKey: `turn-dispatch:${ids.turnId}`,
      payload: { turnId: ids.turnId, sessionId: ids.sessionId, ownerId: "fixture-wait-resolver" },
    })
  })

  it("returns no session from stale-dispatch recovery when no expired stale dispatch exists", async () => {
    const ids = { sessionId: "fixture-session", turnId: "fixture-turn", userId: "fixture-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: root.id, ...ids })

    await expect(repairStaleSubagentDispatches(fixture.pool as never, "recovery-owner")).resolves.toBe(0)
  })

  it("creates one durable intent for a missing dispatch and finds no candidate on replay", async () => {
    const ids = { sessionId: "missing-dispatch-session", turnId: "missing-dispatch-turn", userId: "missing-dispatch-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    root.status = "running"
    const child = await store.create({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "fixture child", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 2 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
    vi.doMock("../redis.js", () => ({ redisConnection: {}, redisCommandConnection: {}, closeSharedRedisConnections: async () => undefined }))
    const { repairMissingSubagentDispatches } = await import("./subagent-queue.js")
    vi.doUnmock("../redis.js")

    await expect(repairMissingSubagentDispatches(fixture.pool as never, "missing-recovery-owner")).resolves.toBe(1)
    expect(fixture.outbox).toHaveLength(1)
    expect(fixture.outbox[0]).toMatchObject({
      topic: "agent.subagent.dispatch", aggregateId: ids.sessionId, idempotencyKey: `subagent-dispatch:${child.id}`,
      publishedAt: null, payload: { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "missing-recovery-owner" },
    })
    await expect(repairMissingSubagentDispatches(fixture.pool as never, "missing-recovery-owner")).resolves.toBe(0)
    expect(fixture.outbox).toHaveLength(1)
    vi.resetModules()
  })

  it("clears a definitively missing publication with the recovery SQL fixture", async () => {
    const ids = { sessionId: "published-recovery-session", turnId: "published-recovery-turn", userId: "published-recovery-user" }
    const { store, tasks } = createTaskStore()
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "fixture root", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 1 } })
    root.status = "running"
    const child = await store.create({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal: "fixture child", policy: { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 2 } })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
    const payload: SubagentJobPayload = { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "published-recovery-owner" }
    await persistSubagentDispatch(fixture.pool as never, payload)
    const row = fixture.outbox[0]!
    row.publishedAt = new Date(Date.now() - 31_000)
    row.attemptCount = 1

    const wrongRootProbe = vi.fn(async () => null)
    fixture.turn.rootTaskId = "foreign-root"
    await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, { getJob: wrongRootProbe })).resolves.toBe(0)
    expect(wrongRootProbe).not.toHaveBeenCalled()
    expect(row).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, payload })
    fixture.turn.rootTaskId = root.id

    const changedRootProbe = vi.fn(async () => {
      fixture.turn.rootTaskId = "foreign-root"
      return null
    })
    await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, { getJob: changedRootProbe })).resolves.toBe(0)
    expect(changedRootProbe).toHaveBeenCalledTimes(1)
    expect(fixture.transactionOpen()).toBe(false)
    expect(row).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, payload })
    fixture.turn.rootTaskId = root.id

    const getJob = vi.fn(async (jobId: string) => {
      expect(jobId).toBe(subagentDispatchJobId(child.id, 0))
      expect(fixture.transactionOpen()).toBe(false)
      return null
    })
    await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, { getJob })).resolves.toBe(1)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(row).toMatchObject({ publishedAt: null, attemptCount: 1, payload })
    expect(child).toMatchObject({ status: "queued", attemptCount: 0, leaseOwner: null, leaseExpiresAt: null })
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
    vi.resetModules()
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

  it("re-publishes only a definitively missing stale Bull generation", async () => {
    const ids = { sessionId: `missing-job-session-${randomUUID()}`, turnId: `missing-job-turn-${randomUUID()}`, userId: `missing-job-user-${randomUUID()}` }
    const { dispatchPendingSubagentOutbox, persistSubagentDispatch, subagentJobId } = await import("./subagent-queue.js")
    const { store, tasks, bindOutbox } = createTaskStore()
    const policy = { maxConcurrency: 1, maxDepth: 1, maxFanOut: 1, maxAttempts: 2 }
    const root = await store.create({ ...ids, role: "planner", taskType: "root", goal: "missing dispatch fixture", policy })
    root.status = "running"
    const child = await store.create({ ...ids, parentTaskId: root.id, role: "scout", taskType: "research", goal: "recover one lost publication", policy })
    const fixture = createSqlFixture({ tasks, rootTaskId: root.id, childTaskId: child.id, ...ids })
    bindOutbox(fixture.outbox)
    const payload: SubagentJobPayload = { taskId: child.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "redis-recovery-owner" }
    const firstId = subagentJobId(child.id, 0)
    const nextId = subagentJobId(child.id, 1)
    try {
      await persistSubagentDispatch(fixture.pool as never, payload)
      await expect(dispatchPendingSubagentOutbox(fixture.pool as never, dispatchQueue!)).resolves.toBe(1)
      const original = await observerQueue!.getJob(firstId)
      expect(original).toBeDefined()
      expect(original?.data).toEqual(payload)
      expect(original?.attemptsMade).toBe(0)
      fixture.outbox[0]!.publishedAt = new Date(Date.now() - 31_000)
      const publishedAt = fixture.outbox[0]!.publishedAt
      const attemptCount = fixture.outbox[0]!.attemptCount

      await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, {})).resolves.toBe(0)
      await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, {
        getJob: async () => { throw new Error("Redis probe unavailable") },
      })).resolves.toBe(0)
      await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, dispatchQueue!)).resolves.toBe(0)
      expect(fixture.outbox[0]).toMatchObject({ publishedAt, attemptCount, payload })

      await original!.remove()
      await expect(observerQueue!.getJob(firstId)).resolves.toBeUndefined()
      const lookedUp: string[] = []
      await expect(recoverMissingPublishedSubagentDispatches(fixture.pool as never, {
        getJob: async jobId => {
          lookedUp.push(jobId)
          expect(fixture.transactionOpen()).toBe(false)
          expect(fixture.transactionBoundaries.at(-1)).toBe("COMMIT")
          return observerQueue!.getJob(jobId)
        },
      })).resolves.toBe(1)
      expect(lookedUp).toEqual([firstId])
      expect(fixture.transactionOpen()).toBe(false)
      expect(fixture.transactionBoundaries.slice(-2)).toEqual(["BEGIN", "COMMIT"])
      expect(fixture.outbox[0]).toMatchObject({ publishedAt: null, attemptCount, payload })
      expect(child).toMatchObject({ status: "queued", attemptCount: 0, leaseOwner: null, leaseExpiresAt: null })
      expect(root.status).toBe("running")

      await expect(dispatchPendingSubagentOutbox(fixture.pool as never, dispatchQueue!)).resolves.toBe(1)
      const next = await observerQueue!.getJob(nextId)
      expect(next).toBeDefined()
      expect(next?.data).toEqual(payload)
      expect(next?.attemptsMade).toBe(0)
      expect(await observerQueue!.getJob(firstId)).toBeUndefined()
      const scopedJobs = (await observerQueue!.getJobs(["waiting", "active", "delayed", "completed", "failed"], 0, 100))
        .filter(job => job.data.sessionId === ids.sessionId)
      expect(scopedJobs.map(job => job.id)).toEqual([nextId])
      expect(fixture.outbox[0]).toMatchObject({ publishedAt: expect.any(Date), attemptCount: attemptCount + 1, payload })
      expect(child).toMatchObject({ status: "queued", attemptCount: 0, leaseOwner: null, leaseExpiresAt: null })
    } finally {
      const remaining = await Promise.all([observerQueue!.getJob(firstId), observerQueue!.getJob(nextId)])
      await Promise.all(remaining.filter((job): job is Job<SubagentJobPayload> => Boolean(job)).map(job => job.remove().catch(() => undefined)))
    }
  }, 25_000)

  it("defers a saturated same-session job without an attempt, then skips a cancelled redelivery", async () => {
    const ids = { sessionId: "capacity-session-" + randomUUID(), turnId: "capacity-turn-" + randomUUID(), userId: "capacity-user-" + randomUUID() }
    const { AgentTreeManager } = await import("../runtime/subagents/manager.js")
    const { createSubagentQueue, dispatchPendingSubagentOutbox, persistSubagentDispatch, subagentJobId } = await import("./subagent-queue.js")
    const { store, tasks, bindOutbox } = createTaskStore()
    const manager = new AgentTreeManager(store, { heartbeatMs: 60_000 })
    const queueExecutions: string[] = []
    const runtime = createSubagentQueue({ manager, execute: async ({ lease }) => {
      queueExecutions.push(lease.id)
      return { status: "completed", result: { taskId: lease.id } }
    } })
    const heldRuns: Array<Promise<unknown>> = []
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    async function createRootAndChildren(suffix: string) {
      const root = await manager.spawn({ ...ids, role: "planner", taskType: "root", goal: suffix + " root", policy: { maxConcurrency: 4, maxDepth: 8, maxFanOut: 8, maxAttempts: 3 } })
      root.status = "running"
      const child = (goal: string) => manager.spawn({ ...ids, parentTaskId: root.id, role: "analyst", taskType: "research", goal })
      return { root, child }
    }
    function holdFour(children: SubagentTaskRecord[]) {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const runs = children.map(task => manager.run({ taskId: task.id, sessionId: ids.sessionId, rootTaskId: task.rootTaskId, ownerId: "holder-" + task.id }, async () => {
        await gate
        return { status: "completed" as const }
      }))
      heldRuns.push(...runs)
      return { release, runs }
    }
    async function waitForDelayedJob(id: string): Promise<Job<SubagentJobPayload>> {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const job = await observerQueue!.getJob(id)
        if (job) {
          const state = await job.getState()
          if (state === "delayed") return job
          if (state === "failed") throw new Error("Subagent job " + id + " failed before deferral")
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error("Timed out waiting for subagent job " + id + " to defer")
    }
    try {
      await runtime.worker.waitUntilReady()
      const first = await createRootAndChildren("first")
      const firstHolders = await Promise.all(Array.from({ length: 4 }, (_, index) => first.child("holder " + index)))
      const firstTarget = await first.child("first target")
      const firstPayload: SubagentJobPayload = { taskId: firstTarget.id, sessionId: ids.sessionId, rootTaskId: first.root.id, ownerId: "first-dispatch" }
      const firstSql = createSqlFixture({ tasks, rootTaskId: first.root.id, childTaskId: firstTarget.id, ...ids })
      bindOutbox(firstSql.outbox)
      const firstHold = holdFour(firstHolders)
      releaseFirst = firstHold.release
      await waitFor(() => manager.activeCount(ids.sessionId) === 4)
      await persistSubagentDispatch(firstSql.pool as never, firstPayload)
      await expect(dispatchPendingSubagentOutbox(firstSql.pool as never, runtime.queue)).resolves.toBe(1)
      const firstJobId = subagentJobId(firstTarget.id)
      const firstDelayed = await waitForDelayedJob(firstJobId)
      expect(firstDelayed.id).toBe(firstJobId)
      expect(firstDelayed.data).toEqual(firstPayload)
      expect(firstDelayed.attemptsMade).toBe(0)
      expect(firstTarget.attemptCount).toBe(0)
      expect(firstSql.outbox[0]).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, payload: firstPayload })

      releaseFirst()
      await Promise.all(firstHold.runs)
      const firstCompleted = await waitForCompletedJob(observerQueue!, firstJobId)
      expect(firstCompleted.id).toBe(firstJobId)
      expect(firstCompleted.data).toEqual(firstPayload)
      expect(firstTarget).toMatchObject({ status: "completed", attemptCount: 1 })
      expect(queueExecutions).toEqual([firstTarget.id])
      expect(firstSql.outbox[0]).toMatchObject({ attemptCount: 1, payload: firstPayload })

      const second = await createRootAndChildren("cancelled")
      const secondHolders = await Promise.all(Array.from({ length: 4 }, (_, index) => second.child("holder " + index)))
      const cancelledTarget = await second.child("cancel before redelivery")
      const cancelledPayload: SubagentJobPayload = { taskId: cancelledTarget.id, sessionId: ids.sessionId, rootTaskId: second.root.id, ownerId: "cancelled-dispatch" }
      const secondSql = createSqlFixture({ tasks, rootTaskId: second.root.id, childTaskId: cancelledTarget.id, ...ids })
      bindOutbox(secondSql.outbox)
      const secondHold = holdFour(secondHolders)
      releaseSecond = secondHold.release
      await waitFor(() => manager.activeCount(ids.sessionId) === 4)
      await persistSubagentDispatch(secondSql.pool as never, cancelledPayload)
      await expect(dispatchPendingSubagentOutbox(secondSql.pool as never, runtime.queue)).resolves.toBe(1)
      const cancelledJobId = subagentJobId(cancelledTarget.id)
      const cancelledDelayed = await waitForDelayedJob(cancelledJobId)
      expect(cancelledDelayed.attemptsMade).toBe(0)
      expect(cancelledDelayed.data).toEqual(cancelledPayload)
      cancelledTarget.status = "cancelled"

      releaseSecond()
      await Promise.all(secondHold.runs)
      const cancelledCompleted = await waitForCompletedJob(observerQueue!, cancelledJobId)
      expect(cancelledCompleted.id).toBe(cancelledJobId)
      expect(cancelledCompleted.data).toEqual(cancelledPayload)
      expect(cancelledTarget).toMatchObject({ status: "cancelled", attemptCount: 0 })
      expect(queueExecutions).toEqual([firstTarget.id])
      expect(secondSql.outbox[0]).toMatchObject({ attemptCount: 1, payload: cancelledPayload })
    } finally {
      releaseFirst?.()
      releaseSecond?.()
      await Promise.allSettled(heldRuns)
      await runtime.close().catch(() => undefined)
      await manager.shutdown().catch(() => undefined)
    }
  }, 35_000)
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
