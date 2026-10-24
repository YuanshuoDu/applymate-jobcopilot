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
import { CHILD_WAIT_RESUMABLE_SQL } from "../../queue/subagent-dispatch-eligibility.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { executionOwnerFence } from "../execution-owner.js"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.js"
import { reconcileDurableSubagentWaits } from "./durable-subagent-wait-resolver.js"
import { commitDurableSubagentWaitResume, loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"
import { loadChildAttemptResume } from "./child-resume.js"
import type { SubagentLease } from "./types.js"

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
type FixtureIds = { userId: string; sessionId: string; turnId: string; rootTaskId: string; waiterTaskId: string; targetTaskId: string;
  recoveryTargetPageRank?: number; recoveryCandidateCount?: number; recoveryFixtureBlockerCount?: number; recoveryCandidateObservedAt?: string }
type WorkerProcess = ChildProcess & {
  stdoutText: string
  stderrText: string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function launchWorker(mode: "worker-a" | "worker-a-crash" | "worker-b-crash-before-resume" | "worker-b-crash-resume" | "worker-b-crash-after-wait-ack" | "worker-b", queueName: string, ids: FixtureIds): WorkerProcess {
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
  child.closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
  return child
}

async function waitForMarker(child: WorkerProcess, marker: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.stdoutText.includes(marker)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = await child.closed
      throw new Error(`Worker exited before ${marker} (code=${exit.code}, signal=${exit.signal}); stdout: ${child.stdoutText}; stderr: ${child.stderrText}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${marker}; stdout: ${child.stdoutText}; stderr: ${child.stderrText}`)
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

async function seedExpiredUnsettledRecoveryBlockers(input: {
  pool: Pool; taskStore: PgSubagentTaskStore; turnStore: ReturnType<typeof createPgTurnEngineStore>;
  userId: string; suffix: string; policy: ReturnType<typeof defaultSubagentPolicy>;
  sessionIds: string[]; taskIds: string[]; count: number;
}): Promise<void> {
  for (let index = 0; index < input.count; index++) {
    const order = String(index).padStart(2, "0")
    const sessionId = `durable-child-wait-backlog-${input.suffix}-${order}`
    const turnId = `durable-child-wait-backlog-turn-${input.suffix}-${order}`
    await input.pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'unsettled recovery pagination blocker', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, input.userId])
    input.sessionIds.push(sessionId)
    await input.pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
    [turnId, sessionId, input.userId])
    const root = await input.taskStore.create({ userId: input.userId, sessionId, turnId, role: "orchestrator",
      taskType: "root", goal: "recovery pagination blocker root", allowedActions: ["external_action"], policy: input.policy })
    await input.pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`, [turnId, root.id, sessionId])
    const activatedRoot = await input.pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running'
      WHERE "id" = $1 AND "sessionId" = $2 RETURNING "id"`, [root.id, sessionId])
    if (activatedRoot.rowCount !== 1) throw new Error("Recovery blocker root activation lost its fixture identity")
    const task = await input.taskStore.create({ userId: input.userId, sessionId, turnId, parentTaskId: root.id,
      role: "analyst", taskType: "research", goal: "leave one real external call unsettled", allowedActions: ["external_action"], policy: input.policy })
    input.taskIds.push(task.id)
    const ownerId = `recovery-blocker-owner-${input.suffix}-${order}`
    const claimed = await input.taskStore.claim({ taskId: task.id, sessionId, ownerId, policy: input.policy, now: new Date() })
    if (!claimed?.leaseExpiresAt || !claimed.turnId) throw new Error("Recovery blocker did not receive a running lease")
    const lease: SubagentLease = { ...claimed, ownerId, leaseExpiresAt: claimed.leaseExpiresAt, signal: new AbortController().signal }
    const owner = executionOwnerFence({ kind: "task", lease })
    const now = new Date()
    const stepId = `recovery-blocker-step-${input.suffix}-${order}`
    await input.turnStore.startStep({ owner, stepId, ordinal: 0, attempt: claimed.attemptCount, inputThroughSequence: 0n,
      consumedInputIds: [], modelProfileSnapshot: {}, now })
    const callId = `recovery-blocker-call-${input.suffix}-${order}`
    const callItemId = `recovery-blocker-call-item-${input.suffix}-${order}`
    await input.turnStore.createItem({ owner, itemId: callItemId, stepId, type: "tool_call", status: "started", phase: null,
      content: { toolCallId: callId, toolName: "external_action", toolVersion: "1", input: {} }, now })
    await input.turnStore.appendEvent({ owner, id: `task:${task.id}:event:tool-started:${callId}`, itemId: callItemId,
      type: "tool_call.started", correlationId: callId, causationId: null,
      idempotencyKey: `task:${task.id}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "external_action", taskId: task.id } })
    const expired = await input.pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
      WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
    [task.id, sessionId, ownerId])
    if (expired.rowCount !== 1) throw new Error("Recovery blocker lease expiry lost its owner fence")
  }
}

async function readBlockerDurableState(pool: Pool, taskIds: readonly string[]): Promise<Array<{ dispatchOutbox: unknown[] }>> {
  const result = await pool.query<{ dispatchOutbox: unknown[] }>(`SELECT to_jsonb(session) AS "session", to_jsonb(turn) AS "turn", to_jsonb(root) AS "root",
      to_jsonb(task) AS "task",
      COALESCE((SELECT jsonb_agg(to_jsonb(step) ORDER BY step."id") FROM "agent_steps" AS step
        WHERE step."sessionId" = task."sessionId" AND step."turnId" = task."turnId" AND step."taskId" = task."id"), '[]'::jsonb) AS "steps",
      COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item."id") FROM "agent_items" AS item
        WHERE item."sessionId" = task."sessionId" AND item."turnId" = task."turnId" AND item."taskId" = task."id"), '[]'::jsonb) AS "items",
      COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event."sequence") FROM "agent_events" AS event
        WHERE event."sessionId" = task."sessionId" AND event."turnId" = task."turnId" AND event."taskId" = task."id"), '[]'::jsonb) AS "events",
      COALESCE((SELECT jsonb_agg(to_jsonb(outbox) ORDER BY outbox."id") FROM "agent_outbox" AS outbox
        WHERE outbox."aggregateId" = task."sessionId" AND outbox."topic" = 'agent.events'
          AND outbox."payload"->>'taskId' = task."id"), '[]'::jsonb) AS "eventOutbox",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispatch."id", 'topic', dispatch."topic",
          'aggregateId', dispatch."aggregateId", 'idempotencyKey', dispatch."idempotencyKey",
          'payload', dispatch."payload", 'attemptCount', dispatch."attemptCount", 'lastError', dispatch."lastError",
          'published', dispatch."publishedAt" IS NOT NULL) ORDER BY dispatch."id")
        FROM "agent_outbox" AS dispatch WHERE dispatch."aggregateId" = task."sessionId"
          AND dispatch."topic" = 'agent.subagent.dispatch'
          AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"), '[]'::jsonb) AS "dispatchOutbox"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) ORDER BY task."sessionId", task."id"`, [taskIds])
  return result.rows
}

async function readRecoveryCandidateRank(pool: Pool, waiterTaskId: string, blockerTaskIds: readonly string[]): Promise<{
  targetPageRank: string; candidateCount: string; fixturePageRank: string; fixtureCandidateCount: string; fixtureBlockerCount: string; observedAt: Date;
}> {
  const result = await pool.query(`WITH horizon AS (SELECT clock_timestamp() AS "at"), eligible AS (
      SELECT task."id", task."sessionId", task."rootTaskId",
        ROW_NUMBER() OVER (ORDER BY task."sessionId", task."rootTaskId" NULLS LAST, task."id") AS "pageRank",
        COUNT(*) OVER () AS "candidateCount"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" CROSS JOIN horizon
      WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR session."status" NOT IN ('aborted', 'archived'))
        AND task."leaseExpiresAt" <= horizon."at" AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= horizon."at")
        AND (task."id" NOT LIKE 'root-%' OR session."status" IN ('aborted', 'archived') OR task."interruptRequestedAt" IS NOT NULL
          OR (task."taskType" = 'root' AND task."id" = task."rootTaskId" AND task."parentTaskId" IS NULL AND task."turnId" IS NOT NULL
            AND EXISTS (SELECT 1 FROM "agent_turns" AS rootTurn WHERE rootTurn."id" = task."turnId"
              AND rootTurn."sessionId" = task."sessionId" AND rootTurn."userId" = session."userId"
              AND rootTurn."rootTaskId" = task."id" AND rootTurn."status" = 'failed')))
    ), fixture AS (
      SELECT "id", ROW_NUMBER() OVER (ORDER BY "sessionId", "rootTaskId" NULLS LAST, "id") AS "pageRank", COUNT(*) OVER () AS "candidateCount"
      FROM eligible WHERE "id" = $1 OR "id" = ANY($2::text[])
    )
    SELECT eligible."pageRank"::text AS "targetPageRank", eligible."candidateCount"::text AS "candidateCount",
      fixture."pageRank"::text AS "fixturePageRank", fixture."candidateCount"::text AS "fixtureCandidateCount",
      (SELECT COUNT(*)::text FROM eligible AS blocker WHERE blocker."id" = ANY($2::text[])
        AND blocker."sessionId" < eligible."sessionId") AS "fixtureBlockerCount", horizon."at" AS "observedAt"
    FROM eligible JOIN fixture ON fixture."id" = eligible."id" CROSS JOIN horizon WHERE eligible."id" = $1`, [waiterTaskId, blockerTaskIds])
  const row = result.rows[0]
  if (!row) throw new Error("Recovery candidate rank could not be observed")
  return row as { targetPageRank: string; candidateCount: string; fixturePageRank: string; fixtureCandidateCount: string;
    fixtureBlockerCount: string; observedAt: Date }
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
    let workerE: WorkerProcess | undefined
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined
    const recoveryBlockerSessionIds: string[] = []
    const recoveryBlockerTaskIds: string[] = []

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
        role: "orchestrator", taskType: "root", goal: "durable child wait fixture", allowedActions: ["wait_subagents"], policy })
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
      await expect(taskStore.release({ taskId: waiter.id, sessionId: ids.sessionId, ownerId: firstOwner!, attemptCount: 1, now: new Date() })).resolves.toBe(false)
      const afterRelease = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null; dispatchAttemptCount: number; publishedAt: Date | null }>(
        `SELECT task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", dispatch."attemptCount" AS "dispatchAttemptCount", dispatch."publishedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
           AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" AND dispatch."topic" = 'agent.subagent.dispatch'
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(afterRelease.rows[0]).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: firstOwner,
        leaseExpiresAt: cut.rows[0]!.leaseExpiresAt, dispatchAttemptCount: firstOutbox.rows[0]!.attemptCount, publishedAt: firstOutbox.rows[0]!.publishedAt })
      await stopWorker(workerA)
      const firstExit = await workerA.exited
      expect(firstExit.code).toBeNull()
      expect(firstExit.signal).toBe("SIGKILL")
      const firstExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, firstOwner])
      expect(firstExpiry.rowCount).toBe(1)

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
      const targetClaim = targetLease!
      const targetLeaseExpiresAt = targetClaim.leaseExpiresAt
      if (!targetLeaseExpiresAt) throw new Error("Direct target task was claimed without a lease expiry")
      const targetExecutionLease: SubagentLease = { ...targetClaim, ownerId: "direct-child-finisher",
        leaseExpiresAt: targetLeaseExpiresAt, signal: new AbortController().signal }
      const targetOwner = executionOwnerFence({ kind: "task", lease: targetExecutionLease })
      const targetStepId = `durable-child-wait-target-step-${suffix}`
      const targetTurnStore = createPgTurnEngineStore(pool)
      const targetStep = await targetTurnStore.startStep({ owner: targetOwner, stepId: targetStepId, ordinal: 0,
        attempt: targetLease!.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
      // AgentStep ordinals are Turn-global: this direct child's real step creates a gap
      // between the wait source (ordinal 0) and the parent's later continuation.
      expect(targetStep.ordinal).toBe(1)
      await targetTurnStore.updateStep({ owner: targetOwner, stepId: targetStepId, status: "completed", finishReason: "stop",
        errorCode: null, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
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
            AND next."turnId" = task."turnId" AND next."attempt" = source."attempt" AND next."ordinal" > source."ordinal") AS "continuationCount"
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
      const preContinuationExpiry = preContinuationCut.rows[0]!.leaseExpiresAt
      if (!(preContinuationExpiry instanceof Date)) throw new Error("Pre-continuation lease has no expiry")
      await stopWorker(workerB)
      const preContinuationExit = await workerB.exited
      expect(preContinuationExit.code).toBeNull()
      expect(preContinuationExit.signal).toBe("SIGKILL")
      const renewedAfterSnapshot = await pool.query<{ leaseExpiresAt: Date }>(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = GREATEST("leaseExpiresAt" + interval '30 seconds', clock_timestamp() + interval '30 seconds')
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3
          AND "leaseExpiresAt" IS NOT NULL RETURNING "leaseExpiresAt"`,
      [waiter.id, ids.sessionId, preContinuationOwner])
      expect(renewedAfterSnapshot.rowCount).toBe(1)
      expect(renewedAfterSnapshot.rows[0]?.leaseExpiresAt.getTime()).toBeGreaterThan(preContinuationExpiry.getTime())
      const preContinuationExpiryUpdate = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, preContinuationOwner])
      expect(preContinuationExpiryUpdate.rowCount).toBe(1)

      await seedExpiredUnsettledRecoveryBlockers({ pool, taskStore, turnStore: createPgTurnEngineStore(pool), userId: ids.userId,
        suffix, policy, sessionIds: recoveryBlockerSessionIds, taskIds: recoveryBlockerTaskIds, count: 50 })
      const blockerStateBeforeRecovery = await readBlockerDurableState(pool, recoveryBlockerTaskIds)
      expect(blockerStateBeforeRecovery).toHaveLength(50)
      expect(blockerStateBeforeRecovery.map(blocker => blocker.dispatchOutbox)).toEqual(Array.from({ length: 50 }, () => []))
      const blockers = await pool.query<{ blockerCount: number; eligibleCount: number; unsettledCount: number }>(
        `SELECT COUNT(DISTINCT task."id")::int AS "blockerCount",
          (COUNT(DISTINCT task."id") FILTER (WHERE task."status" = 'running' AND task."attemptCount" = 1
            AND task."leaseExpiresAt" <= clock_timestamp() AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
            AND step."status" = 'streaming' AND call."type" = 'tool_call' AND call."status" = 'started'
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId'
            AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId"
              AND settled."taskId" = task."id" AND settled."correlationId" = started."correlationId"
              AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))))::int AS "eligibleCount",
          (COUNT(DISTINCT task."id") FILTER (WHERE started."id" IS NOT NULL AND settled."id" IS NULL))::int AS "unsettledCount"
         FROM "sub_agent_tasks" AS task
         JOIN "agent_steps" AS step ON step."sessionId" = task."sessionId" AND step."turnId" = task."turnId" AND step."taskId" = task."id"
         JOIN "agent_items" AS call ON call."sessionId" = task."sessionId" AND call."turnId" = task."turnId"
           AND call."taskId" = task."id" AND call."stepId" = step."id" AND call."type" = 'tool_call'
         LEFT JOIN "agent_events" AS started ON started."sessionId" = task."sessionId" AND started."taskId" = task."id"
           AND started."itemId" = call."id" AND started."type" = 'tool_call.started'
         LEFT JOIN "agent_events" AS settled ON settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
           AND settled."correlationId" = started."correlationId" AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
         WHERE task."id" = ANY($1::text[])`, [recoveryBlockerTaskIds],
      )
      expect(blockers.rows[0]).toMatchObject({ blockerCount: 50, eligibleCount: 50, unsettledCount: 50 })
      const candidateRank = await readRecoveryCandidateRank(pool, waiter.id, recoveryBlockerTaskIds)
      expect(Number(candidateRank.fixtureBlockerCount)).toBe(50)
      expect(Number(candidateRank.fixtureCandidateCount)).toBe(51)
      expect(Number(candidateRank.fixturePageRank)).toBe(51)
      expect(Number(candidateRank.targetPageRank)).toBeGreaterThan(50)
      expect(Number(candidateRank.candidateCount)).toBeGreaterThanOrEqual(Number(candidateRank.targetPageRank))
      ids.recoveryTargetPageRank = Number(candidateRank.targetPageRank)
      ids.recoveryCandidateCount = Number(candidateRank.candidateCount)
      ids.recoveryFixtureBlockerCount = Number(candidateRank.fixtureBlockerCount)
      ids.recoveryCandidateObservedAt = candidateRank.observedAt.toISOString()

      workerC = launchWorker("worker-b-crash-resume", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const recoveryDiagnostic = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RECOVERY_DIAGNOSTIC "))
      expect(workerC.stdoutText, `Worker C missed the waiter; ${recoveryDiagnostic ?? "diagnostic missing"}`)
        .toContain(`"id":"${waiter.id}","status":"queued"`)
      const blockerStateAfterRecovery = await readBlockerDurableState(pool, recoveryBlockerTaskIds)
      expect(blockerStateAfterRecovery).toEqual(blockerStateBeforeRecovery)
      const blockerJobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"], 0, -1)
      expect(blockerJobs.filter(job => recoveryBlockerTaskIds.includes(String(job.data.taskId)))).toHaveLength(0)
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [recoveryBlockerSessionIds])
      await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [recoveryBlockerSessionIds])
      recoveryBlockerSessionIds.length = 0
      recoveryBlockerTaskIds.length = 0
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
      // Recovery fences the in-flight generation before publishing its replacement.
      expect(preContinuationDispatch.rows[0]).toMatchObject({ attemptCount: initialGeneration + 2, publishedAt: null })
      const generation = preContinuationDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const resumedOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(resumedOutbox.rows[0]).toMatchObject({ attemptCount: generation + 1 })
      expect(resumedOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      expect(resumedOutbox.rows[0]!.attemptCount - 1).toBe(generation)
      expect(generation).toBeGreaterThan(initialGeneration)
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
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         JOIN "agent_items" AS call ON call."stepId" = source."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 2`, [waiter.id, ids.sessionId],
      )
      expect(secondCut.rows[0]).toMatchObject({ taskStatus: "running", attemptCount: 1, stepOrdinal: 2, stepStatus: "streaming",
        consumedAt: null, callStatus: "started", settledCount: 0 })
      expect(secondCut.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(secondCut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      const secondOwner = secondCut.rows[0]!.leaseOwner
      await stopWorker(workerC)
      const secondExit = await workerC.exited
      expect(secondExit.code).toBeNull()
      expect(secondExit.signal).toBe("SIGKILL")
      const secondExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, secondOwner])
      expect(secondExpiry.rowCount).toBe(1)

      workerD = launchWorker("worker-b-crash-after-wait-ack", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      const continuationRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        stepStatus: string; waitStatus: string; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", next."status" AS "stepStatus",
          wait."status" AS "waitStatus", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = task."id" AND next."sessionId" = task."sessionId" AND next."turnId" = task."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 2`, [waiter.id, ids.sessionId],
      )
      expect(continuationRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        stepStatus: "streaming", waitStatus: "ready", consumedAt: null })
      const continuationDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(continuationDispatch.rows[0]).toMatchObject({ attemptCount: generation + 2, publishedAt: null })
      const finalGeneration = continuationDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const ackResumeDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(ackResumeDispatch.rows[0]).toMatchObject({ attemptCount: finalGeneration + 1 })
      expect(ackResumeDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)

      await waitForMarker(workerD, "WORKER_B_RESUME_ACK_COMMITTED")
      const ackCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        sourceStepId: string; sourceAttempt: number; sourceOrdinal: number;
        waitId: string; waitStatus: string; consumedAt: Date | null; continuationStepId: string; continuationOrdinal: number; continuationStatus: string }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          source."id" AS "sourceStepId", source."attempt" AS "sourceAttempt", source."ordinal" AS "sourceOrdinal",
          wait."id" AS "waitId", wait."status" AS "waitStatus", wait."consumedAt", next."id" AS "continuationStepId",
          next."ordinal" AS "continuationOrdinal", next."status" AS "continuationStatus"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = source."taskId" AND next."sessionId" = source."sessionId" AND next."turnId" = source."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      const acknowledged = ackCut.rows[0]
      expect(acknowledged).toMatchObject({ taskStatus: "running", attemptCount: 1, continuationStepId: `child-resume-step:${waiter.id}:attempt:1`,
        sourceStepId: `child-wait-step:${waiter.id}:attempt:1`, sourceAttempt: 1, sourceOrdinal: 0,
        continuationOrdinal: 2, continuationStatus: "streaming", waitStatus: "ready" })
      expect(acknowledged?.leaseOwner).toEqual(expect.any(String))
      expect(acknowledged?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(acknowledged?.consumedAt).toBeInstanceOf(Date)
      const acknowledgedAt = acknowledged!.consumedAt
      const acknowledgedOwner = acknowledged!.leaseOwner
      await stopWorker(workerD)
      const ackCutExit = await workerD.exited
      expect(ackCutExit.code).toBeNull()
      expect(ackCutExit.signal).toBe("SIGKILL")
      const acknowledgedExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, acknowledgedOwner])
      expect(acknowledgedExpiry.rowCount).toBe(1)

      workerE = launchWorker("worker-b", queueName, ids)
      await waitForMarker(workerE, "WORKER_B_RECOVERED")
      const acknowledgedRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        sourceStepId: string; sourceAttempt: number; sourceOrdinal: number;
        waitStatus: string; consumedAt: Date | null; continuationStepId: string; continuationOrdinal: number; continuationStatus: string }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", source."id" AS "sourceStepId",
          source."attempt" AS "sourceAttempt", source."ordinal" AS "sourceOrdinal", wait."status" AS "waitStatus", wait."consumedAt",
          next."id" AS "continuationStepId", next."ordinal" AS "continuationOrdinal", next."status" AS "continuationStatus"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = source."taskId" AND next."sessionId" = source."sessionId" AND next."turnId" = source."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(acknowledgedRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        sourceStepId: acknowledged!.sourceStepId, sourceAttempt: acknowledged!.sourceAttempt, sourceOrdinal: acknowledged!.sourceOrdinal,
        continuationStepId: acknowledged!.continuationStepId, continuationOrdinal: 2, continuationStatus: "streaming", waitStatus: "ready" })
      expect(acknowledgedRecovery.rows[0]?.consumedAt).toEqual(acknowledgedAt)
      const acknowledgedDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(acknowledgedDispatch.rows[0]).toMatchObject({ attemptCount: finalGeneration + 2, publishedAt: null })
      const postAckGeneration = acknowledgedDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const finalDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(finalDispatch.rows[0]).toMatchObject({ attemptCount: postAckGeneration + 1 })
      expect(finalDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)
      await waitForMarker(workerE, "WORKER_B_CONSUMED_WAIT_STEP_REUSED")
      expect(workerE.stdoutText).toContain(`WORKER_B_CONSUMED_WAIT_STEP_REUSED ${JSON.stringify({ waitId: acknowledged!.waitId,
        sourceStepId: acknowledged!.sourceStepId, attempt: acknowledged!.sourceAttempt, sourceOrdinal: acknowledged!.sourceOrdinal,
        stepId: acknowledged!.continuationStepId, ordinal: acknowledged!.continuationOrdinal })}`)

      await waitForMarker(workerE, "WORKER_B_RESUMED")
      const finalExit = await workerE.exited
      expect(finalExit.code).toBe(0)
      expect(finalExit.signal).toBeNull()
      expect(workerE.stdoutText.match(/WORKER_B_RESUMED/g) ?? []).toHaveLength(1)
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; failureReason: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(finished.rows[0], JSON.stringify({ workerOutput: workerE.stdoutText, workerError: workerE.stderrText,
        failureReason: finished.rows[0]?.failureReason }))
        .toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      const durable = await pool.query<{ status: string; consumedAt: Date | null; outcome: { status: string; matchedTaskIds: string[] } }>(
        `SELECT "status", "consumedAt", "result"->'outcome' AS "outcome" FROM "agent_wait_conditions"
         WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(durable.rows[0]).toMatchObject({ status: "ready", outcome: { status: "ready", matchedTaskIds: [target.id] } })
      expect(durable.rows[0]?.consumedAt).toBeInstanceOf(Date)
      expect(durable.rows[0]?.consumedAt).toEqual(acknowledgedAt)
      const continuation = await pool.query<{ id: string; ordinal: number; attempt: number; status: string }>(
        `SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps" WHERE "taskId" = $1 AND "sessionId" = $2 ORDER BY "ordinal"`, [waiter.id, ids.sessionId],
      )
      expect(continuation.rows).toEqual([
        { id: `child-wait-step:${waiter.id}:attempt:1`, ordinal: 0, attempt: 1, status: "waiting_for_tool" },
        { id: `child-resume-step:${waiter.id}:attempt:1`, ordinal: 2, attempt: 1, status: "completed" },
      ])
      const finalItems = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
        WHERE "taskId" = $1 AND "sessionId" = $2 AND "content"->>'text' = $3`, [waiter.id, ids.sessionId, FINAL_MARKER])
      expect(finalItems.rows[0]?.count).toBe(1)
      expect(finalGeneration).toBeGreaterThan(generation)
      expect(postAckGeneration).toBeGreaterThan(finalGeneration)
      expect(finalDispatch.rows[0]!.attemptCount - 1).toBe(postAckGeneration)
      const finalResumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, postAckGeneration))
      expect(finalResumeJob).toBeDefined()
      expect(await finalResumeJob!.getState()).toBe("completed")
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await stopWorker(workerD)
      await stopWorker(workerE)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      if (recoveryBlockerSessionIds.length > 0) {
        try { await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [recoveryBlockerSessionIds]) } catch { /* preserve the original failure */ }
        try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [recoveryBlockerSessionIds]) } catch { /* preserve the original failure */ }
      }
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may not have reached the session insert */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 90_000)

  it("selects the latest sequential wait by step ordinal at maxAttempts", async () => {
    const client = await pool.connect()
    try {
      await client.query(`CREATE TEMP TABLE "sub_agent_tasks" (
        "id" text, "parentTaskId" text, "sessionId" text, "turnId" text, "rootTaskId" text,
        "status" text, "attemptCount" integer, "maxAttempts" integer
      );
      CREATE TEMP TABLE "agent_turns" ("id" text, "sessionId" text, "userId" text, "rootTaskId" text);
      CREATE TEMP TABLE "agent_steps" (
        "id" text, "sessionId" text, "turnId" text, "taskId" text, "attempt" integer, "status" text, "ordinal" integer
      );
      CREATE TEMP TABLE "agent_wait_conditions" (
        "id" text, "parentTaskId" text, "sessionId" text, "turnId" text, "userId" text, "stepId" text,
        "status" text, "suspendedAt" timestamptz, "consumedAt" timestamptz, "mode" text,
        "targetTaskIds" jsonb, "createdAt" timestamptz
      );`)
      await client.query(`INSERT INTO "sub_agent_tasks" VALUES
        ('child', 'root', 'session', 'turn', 'root', 'queued', 3, 3),
        ('target', 'child', 'session', 'turn', 'root', 'completed', 1, 3)`)
      await client.query(`INSERT INTO "agent_turns" VALUES ('turn', 'session', 'user', 'root')`)
      await client.query(`INSERT INTO "agent_steps" VALUES
        ('step-w1', 'session', 'turn', 'child', 3, 'completed', 0),
        ('step-w2', 'session', 'turn', 'child', 3, 'waiting_for_tool', 1)`)
      const sameRegistrationTime = new Date("2026-10-23T10:00:00.000Z")
      await client.query(`INSERT INTO "agent_wait_conditions" VALUES
        ('wait-w1', 'child', 'session', 'turn', 'user', 'step-w1', 'ready', $1, $1, 'any', '["target"]'::jsonb, $2),
        ('wait-w2', 'child', 'session', 'turn', 'user', 'step-w2', 'waiting', $1, NULL, 'any', '["target"]'::jsonb, $2)`, [sameRegistrationTime, sameRegistrationTime])

      const readEligibility = () => client.query<{ resumable: boolean }>(
        `SELECT ${CHILD_WAIT_RESUMABLE_SQL} AS "resumable" FROM "sub_agent_tasks" AS task WHERE task."id" = 'child'`,
      )
      await expect(readEligibility()).resolves.toMatchObject({ rows: [{ resumable: false }] })
      await client.query(`UPDATE "agent_wait_conditions" SET "status" = 'ready' WHERE "id" = 'wait-w2'`)
      await expect(readEligibility()).resolves.toMatchObject({ rows: [{ resumable: true }] })
    } finally {
      client.release()
    }
  })
})
