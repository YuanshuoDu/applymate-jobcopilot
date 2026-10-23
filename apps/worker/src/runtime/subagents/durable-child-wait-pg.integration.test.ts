import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy } from "./types.js"
import { subagentDispatchJobId } from "./dispatch-identity.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const FINAL_MARKER = "parent-resumed-from-durable-child-result"
const fixturePath = fileURLToPath(new URL("./durable-child-wait-process-restart.fixture.mjs", import.meta.url))
const workerCwd = fileURLToPath(new URL("../../..", import.meta.url))

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== "" || url.hash !== "") throw new Error("Child-wait integration requires the disposable PostgreSQL service URL")
  return value
}

function disposableRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379" || url.pathname !== "/15" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "") throw new Error("Child-wait integration accepts only disposable Redis DB 15")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const redisUrl = disposableRedisUrl()
const withServices = databaseUrl && redisUrl && process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" ? describe : describe.skip
type FixtureIds = { userId: string; sessionId: string; turnId: string; rootTaskId: string; waiterTaskId: string; targetTaskId: string }
type WorkerProcess = ChildProcess & { stdoutText: string; stderrText: string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

function launchWorker(mode: "worker-a" | "worker-a-crash" | "worker-b-crash-before-resume" | "worker-b-crash-resume" | "worker-b", queueName: string, ids: FixtureIds): WorkerProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode, queueName, JSON.stringify(ids)], {
    cwd: workerCwd,
    env: { ...process.env, DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl! },
    stdio: ["ignore", "pipe", "pipe"],
  }) as WorkerProcess
  child.stdoutText = ""
  child.stderrText = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => { child.stdoutText += chunk })
  child.stderr?.on("data", (chunk: string) => { child.stderrText += chunk })
  child.exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })))
  return child
}

async function waitForMarker(child: WorkerProcess, marker: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.stdoutText.includes(marker)) return
    if (child.exitCode !== null) throw new Error(`Worker exited before ${marker}: ${child.stderrText}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${marker}; stderr: ${child.stderrText}`)
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error("Timed out waiting for durable child-wait state")
}

async function stopWorker(child: WorkerProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill("SIGKILL")
  await Promise.race([child.exited, new Promise(resolve => setTimeout(resolve, 5_000))])
}

withServices("durable child wait across PostgreSQL/Redis Worker process restart", () => {
  let pool: Pool
  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 8 }) })
  afterAll(async () => { await pool?.end() })

  it("recovers registered, pre-continuation, and streaming-continuation crash cuts on one attempt", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-user-${suffix}`,
      sessionId: `durable-child-wait-session-${suffix}`,
      turnId: `durable-child-wait-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
    }
    const queueName = `agent-child-wait-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined
    let workerD: WorkerProcess | undefined
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.userId, `${ids.userId}@example.invalid`])
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
        VALUES ($1, $2, 'Wait for a direct child and resume after restart', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
      await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
        "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [ids.turnId, ids.sessionId, ids.userId])

      const root = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        role: "orchestrator", taskType: "root", goal: "durable child wait fixture", allowedActions: [], policy })
      ids.rootTaskId = root.id
      await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`, [ids.turnId, root.id, ids.sessionId])
      await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1 AND "sessionId" = $2`, [root.id, ids.sessionId])
      const waiter = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, parentTaskId: root.id,
        role: "analyst", taskType: "research", goal: "wait for a direct child", allowedActions: ["wait_subagents"], policy })
      ids.waiterTaskId = waiter.id
      const target = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, parentTaskId: waiter.id,
        role: "scout", taskType: "research", goal: "produce a direct-child result", allowedActions: [], policy })
      ids.targetTaskId = target.id

      const firstPayload = { taskId: waiter.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "worker-a-dispatch" }
      await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb)`, [
        `durable-child-wait-dispatch-${suffix}`, ids.sessionId, `subagent-dispatch:${waiter.id}`, JSON.stringify(firstPayload),
      ])

      workerA = launchWorker("worker-a-crash", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const firstOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(firstOutbox.rows[0]).toMatchObject({ attemptCount: 1 })
      expect(firstOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const firstGeneration = firstOutbox.rows[0]!.attemptCount - 1
      expect(firstGeneration).toBe(0)
      const firstJob = await queue.getJob(subagentDispatchJobId(waiter.id, firstGeneration))
      expect(firstJob).toBeDefined()
      await waitForMarker(workerA, "WORKER_A_REGISTERED")
      const cut = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepStatus: string; stepAttempt: number; waitStatus: string; suspendedAt: Date | null; consumedAt: Date | null;
        callStatus: string; startedCount: number; settledCount: number; resultCount: number }>(
        `SELECT task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", step."status" AS "stepStatus",
          step."attempt" AS "stepAttempt", wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId') AS "startedCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount",
          (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = task."sessionId" AND result."taskId" = task."id"
            AND result."stepId" = step."id" AND result."type" = 'tool_result') AS "resultCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_steps" AS step ON step."taskId" = task."id" AND step."sessionId" = task."sessionId"
         JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_items" AS call ON call."stepId" = step."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2 AND step."ordinal" = 0 AND wait."stepId" = step."id"`,
        [waiter.id, ids.sessionId],
      )
      expect(cut.rows[0]).toMatchObject({ status: "running", attemptCount: 1, stepStatus: "streaming", stepAttempt: 1,
        waitStatus: "waiting", suspendedAt: null, consumedAt: null, callStatus: "started", startedCount: 1, settledCount: 0, resultCount: 0 })
      const firstOwner = cut.rows[0]?.leaseOwner
      expect(firstOwner).toEqual(expect.any(String))
      expect(cut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(await firstJob!.getState()).toBe("active")
      await stopWorker(workerA)
      const firstExit = await workerA.exited
      expect(firstExit.code).toBeNull()
      expect(firstExit.signal).toBe("SIGKILL")
      await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 AND "leaseExpiresAt" = $4`,
      [waiter.id, ids.sessionId, firstOwner, cut.rows[0]!.leaseExpiresAt])

      workerB = launchWorker("worker-b-crash-before-resume", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_RECOVERED")
      const recovered = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepStatus: string; waitStatus: string; suspendedAt: Date | null; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          step."status" AS "stepStatus", wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_steps" AS step ON step."taskId" = task."id" AND step."sessionId" = task."sessionId"
         JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         WHERE task."id" = $1 AND task."sessionId" = $2 AND step."ordinal" = 0 AND wait."stepId" = step."id"`, [waiter.id, ids.sessionId],
      )
      expect(recovered.rows[0]).toMatchObject({ taskStatus: "waiting", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null,
        stepStatus: "waiting_for_tool", waitStatus: "waiting", consumedAt: null })
      expect(recovered.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const recoveryStart = workerB.stdoutText.indexOf("WORKER_B_RECOVERED")
      const recoveryReady = workerB.stdoutText.indexOf("WORKER_B_READY")
      expect(recoveryStart).toBeGreaterThanOrEqual(0)
      expect(recoveryReady).toBeGreaterThan(recoveryStart)

      const targetLease = await taskStore.claim({ taskId: target.id, sessionId: ids.sessionId, ownerId: "direct-child-finisher", policy, now: new Date() })
      expect(targetLease).not.toBeNull()
      await expect(taskStore.finish({ taskId: target.id, sessionId: ids.sessionId, ownerId: "direct-child-finisher",
        attemptCount: targetLease!.attemptCount, status: "completed", result: { finalText: "durable-child-result-after-process-restart" }, now: new Date() })).resolves.toBe("completed")

      const dispatch = await waitFor(async () => {
        const [wait, task, row] = await Promise.all([
          pool.query<{ status: string }>(`SELECT "status" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId]),
          pool.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId]),
          pool.query<{ payload: unknown; attemptCount: number; publishedAt: Date | null }>(`SELECT "payload", "attemptCount", "publishedAt" FROM "agent_outbox"
            WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`]),
        ])
        const current = row.rows[0]
        return wait.rows[0]?.status === "ready" && task.rows[0]?.status === "queued" && current?.publishedAt === null
          ? current : null
      })
      expect(dispatch.attemptCount).toBe(1)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const initialResumeOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(initialResumeOutbox.rows[0]).toMatchObject({ attemptCount: 2 })
      expect(initialResumeOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const initialGeneration = initialResumeOutbox.rows[0]!.attemptCount - 1
      expect(initialGeneration).toBe(firstGeneration + 1)
      const initialResumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, initialGeneration))
      expect(initialResumeJob).toBeDefined()

      await waitForMarker(workerB, "WORKER_B_RESUME_NOT_STARTED")
      expect(await initialResumeJob!.getState()).toBe("active")
      const preContinuationCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        leaseExpiresAt: Date | null; sourceStatus: string; sourceIsLatest: boolean; waitStatus: string; suspendedAt: Date | null;
        consumedAt: Date | null; callStatus: string; startedCount: number; settledCount: number; continuationCount: number }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          source."status" AS "sourceStatus", source."ordinal" = (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest
            WHERE latest."taskId" = task."id" AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId" AND latest."attempt" = task."attemptCount") AS "sourceIsLatest",
          wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId') AS "startedCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount",
          (SELECT COUNT(*)::int FROM "agent_steps" AS next WHERE next."taskId" = task."id" AND next."sessionId" = task."sessionId"
            AND next."turnId" = task."turnId" AND next."attempt" = source."attempt" AND next."ordinal" = source."ordinal" + 1) AS "continuationCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_items" AS call ON call."stepId" = source."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(preContinuationCut.rows[0]).toMatchObject({ taskStatus: "running", attemptCount: 1, sourceStatus: "waiting_for_tool",
        sourceIsLatest: true, waitStatus: "ready", consumedAt: null, callStatus: "started", startedCount: 1, settledCount: 0, continuationCount: 0 })
      expect(preContinuationCut.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(preContinuationCut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(preContinuationCut.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const preContinuationOwner = preContinuationCut.rows[0]!.leaseOwner
      await stopWorker(workerB)
      const preContinuationExit = await workerB.exited
      expect(preContinuationExit.code).toBeNull()
      expect(preContinuationExit.signal).toBe("SIGKILL")
      await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 AND "leaseExpiresAt" = $4`,
      [waiter.id, ids.sessionId, preContinuationOwner, preContinuationCut.rows[0]!.leaseExpiresAt])

      workerC = launchWorker("worker-b-crash-resume", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const preContinuationRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        sourceStatus: string; waitStatus: string; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", source."status" AS "sourceStatus",
          wait."status" AS "waitStatus", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(preContinuationRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        sourceStatus: "waiting_for_tool", waitStatus: "ready", consumedAt: null })
      const preContinuationDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(preContinuationDispatch.rows[0]).toMatchObject({ attemptCount: 2, publishedAt: null })
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const resumedOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(resumedOutbox.rows[0]).toMatchObject({ attemptCount: 3 })
      expect(resumedOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const generation = resumedOutbox.rows[0]!.attemptCount - 1
      expect(generation).toBe(firstGeneration + 2)
      const resumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, generation))
      expect(resumeJob).toBeDefined()

      await waitForMarker(workerC, "WORKER_B_RESUME_STEP_STARTED")
      const secondCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepOrdinal: number; stepStatus: string; consumedAt: Date | null; callStatus: string; settledCount: number }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", next."ordinal" AS "stepOrdinal",
          next."status" AS "stepStatus", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = task."id" AND next."sessionId" = task."sessionId" AND next."turnId" = task."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = source."ordinal" + 1
         JOIN "agent_items" AS call ON call."stepId" = source."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 1`, [waiter.id, ids.sessionId],
      )
      expect(secondCut.rows[0]).toMatchObject({ taskStatus: "running", attemptCount: 1, stepOrdinal: 1, stepStatus: "streaming",
        consumedAt: null, callStatus: "started", settledCount: 0 })
      expect(secondCut.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(secondCut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      const secondOwner = secondCut.rows[0]!.leaseOwner
      await stopWorker(workerC)
      const secondExit = await workerC.exited
      expect(secondExit.code).toBeNull()
      expect(secondExit.signal).toBe("SIGKILL")
      await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 AND "leaseExpiresAt" = $4`,
      [waiter.id, ids.sessionId, secondOwner, secondCut.rows[0]!.leaseExpiresAt])

      workerD = launchWorker("worker-b", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      const continuationRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        stepStatus: string; waitStatus: string; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", next."status" AS "stepStatus",
          wait."status" AS "waitStatus", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = task."id" AND next."sessionId" = task."sessionId" AND next."turnId" = task."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = source."ordinal" + 1
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 1`, [waiter.id, ids.sessionId],
      )
      expect(continuationRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        stepStatus: "streaming", waitStatus: "ready", consumedAt: null })
      const continuationDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(continuationDispatch.rows[0]).toMatchObject({ attemptCount: 3, publishedAt: null })
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const finalDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(finalDispatch.rows[0]).toMatchObject({ attemptCount: 4 })
      expect(finalDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)

      await waitForMarker(workerD, "WORKER_B_RESUMED")
      const thirdExit = await workerD.exited
      expect(thirdExit.code).toBe(0)
      expect(thirdExit.signal).toBeNull()
      expect(workerD.stdoutText.match(/WORKER_B_RESUMED/g) ?? []).toHaveLength(1)
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(finished.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      const durable = await pool.query<{ status: string; consumedAt: Date | null; outcome: { status: string; matchedTaskIds: string[] } }>(
        `SELECT "status", "consumedAt", "result"->'outcome' AS "outcome" FROM "agent_wait_conditions"
         WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(durable.rows[0]).toMatchObject({ status: "ready", outcome: { status: "ready", matchedTaskIds: [target.id] } })
      expect(durable.rows[0]?.consumedAt).toBeInstanceOf(Date)
      const continuation = await pool.query<{ ordinal: number; attempt: number; status: string }>(
        `SELECT "ordinal", "attempt", "status" FROM "agent_steps" WHERE "taskId" = $1 AND "sessionId" = $2 ORDER BY "ordinal"`, [waiter.id, ids.sessionId],
      )
      expect(continuation.rows).toEqual([
        { ordinal: 0, attempt: 1, status: "waiting_for_tool" },
        { ordinal: 1, attempt: 1, status: "completed" },
      ])
      const finalItems = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
        WHERE "taskId" = $1 AND "sessionId" = $2 AND "content"->>'text' = $3`, [waiter.id, ids.sessionId, FINAL_MARKER])
      expect(finalItems.rows[0]?.count).toBe(1)
      const finalResumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, generation + 1))
      expect(finalResumeJob).toBeDefined()
      expect(await finalResumeJob!.getState()).toBe("completed")
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await stopWorker(workerD)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may not have reached the session insert */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 90_000)
})
