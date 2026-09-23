import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const DATABASE_NAME = "applymate_agent_brain_ci"
const RESULT_MARKER = "durable-child-result-after-process-restart"
const FINAL_MARKER = "parent-resumed-from-durable-child-result"

function dedicatedDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("Process-restart integration requires the dedicated disposable PostgreSQL service URL")
  return value
}

function dedicatedRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("Process-restart integration accepts only the dedicated disposable Redis DB 15 URL")
  return value
}

const databaseUrl = dedicatedDatabaseUrl()
const redisUrl = dedicatedRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type FixtureIds = { suffix: string; userId: string; sessionId: string; turnId: string }
type WorkerChild = ChildProcess & { output: string[]; errors: string[] }

const fixturePath = fileURLToPath(new URL("./production-bootstrap-process-restart.fixture.mjs", import.meta.url))
const workerCwd = fileURLToPath(new URL("../..", import.meta.url))

function startWorker(mode: "park-parent" | "resume-parent", ids: FixtureIds): WorkerChild {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode, JSON.stringify(ids)], {
    cwd: workerCwd,
    env: { ...process.env, REDIS_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl! },
    stdio: ["pipe", "pipe", "pipe"],
  }) as WorkerChild
  child.output = []
  child.errors = []
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
    const lines = stdout.split("\n")
    stdout = lines.pop() ?? ""
    child.output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
    const lines = stderr.split("\n")
    stderr = lines.pop() ?? ""
    child.errors.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  return child
}

async function waitForLine(child: WorkerChild, prefix: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = child.output.find(value => value.startsWith(prefix))
    if (line) return line
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited before ${prefix}: ${child.errors.join("\n")}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${prefix}; stdout=${child.output.join(" | ")}; stderr=${child.errors.join(" | ")}`)
}

async function waitForExit(child: WorkerChild, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker process did not exit")), timeoutMs) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

async function waitForTurnStatus(pool: Pool, turnId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1`, [turnId])
    if (result.rows[0]?.status === status) return
    if (["failed", "interrupted", "cancelled"].includes(String(result.rows[0]?.status))) {
      throw new Error(`Turn entered unexpected terminal state ${result.rows[0]?.status}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Turn ${turnId} did not reach ${status}`)
}

describeWithServices("production bootstrap recovery across a Worker process restart", () => {
  let pool: Pool | undefined
  let redis: Redis | undefined
  let turnQueue: Queue | undefined
  let childQueue: Queue | undefined
  let turnJobKey: ((turnId: string, generation?: number) => string) | undefined
  let childJobKey: ((taskId: string) => string) | undefined
  let workerOne: WorkerChild | undefined
  let workerTwo: WorkerChild | undefined
  let ids: FixtureIds
  let childTaskId: string | undefined

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl!
    const [turnModule, turnQueueModule, childModule] = await Promise.all([
      import("../runtime/turns/recovery-scanner.js"),
      import("../runtime/turns/turn-queue.js"),
      import("./subagent-queue.js"),
    ])
    turnJobKey = turnModule.turnJobId
    childJobKey = childModule.subagentJobId
    pool = new Pool({ connectionString: databaseUrl!, max: 5 })
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100 })
    await redis.ping()
    turnQueue = new Queue(turnQueueModule.TURN_QUEUE_NAME, { connection: redis, skipVersionCheck: true })
    childQueue = new Queue(childModule.SUBAGENT_QUEUE_NAME, { connection: redis, skipVersionCheck: true })
    await Promise.all([turnQueue.waitUntilReady(), childQueue.waitUntilReady()])

    const suffix = randomUUID()
    ids = {
      suffix,
      userId: `process-restart-user-${suffix}`,
      sessionId: `process-restart-session-${suffix}`,
      turnId: `process-restart-turn-${suffix}`,
    }
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.userId, `${ids.userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Resume a parent Turn after its child completes', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
    await pool.query(`INSERT INTO "agent_turns"
      ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
      VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
      ids.turnId,
      ids.sessionId,
      ids.userId,
      JSON.stringify({ goal: "Resume and report the persisted child result" }),
      JSON.stringify({ provider: "fixture", model: "fixture-model" }),
      JSON.stringify({}),
      JSON.stringify({ limits: { maxSteps: 3, maxToolCalls: 2 } }),
    ])
  }, 20_000)

  afterAll(async () => {
    for (const child of [workerOne, workerTwo]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue
      child.stdin?.write("shutdown\n")
      try { await waitForExit(child, 3_000) } catch { child.kill("SIGKILL") }
    }
    if (pool && typeof ids !== "undefined") await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]).catch(() => undefined)
    if (turnQueue && turnJobKey && typeof ids !== "undefined") {
      for (const generation of [0, 1, 2]) {
        await turnQueue.getJob(turnJobKey(ids.turnId, generation))?.then(job => job?.remove()).catch(() => undefined)
      }
    }
    if (childTaskId && childQueue && childJobKey) await childQueue.getJob(childJobKey(childTaskId))?.then(job => job?.remove()).catch(() => undefined)
    await Promise.all([turnQueue?.close(), childQueue?.close()])
    await import("../redis.js").then(module => module.closeSharedRedisConnections()).catch(() => undefined)
    if (redis && redis.status !== "end") await redis.quit().catch(() => redis?.disconnect())
    await pool?.end()
  })

  it("persists a child result, kills its Worker, and resumes the parent from PostgreSQL under a new lease", async () => {
    workerOne = startWorker("park-parent", ids)
    await waitForLine(workerOne, "READY_TO_RESTART")

    const parent = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
      `SELECT "status", "leaseOwnerId", "leaseVersion" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )
    expect(parent.rows[0]).toMatchObject({ status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1 })
    const wait = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; targetTaskIds: string[]; consumedAt: Date | null }>(
      `SELECT "id", "status", "suspendedAt", "targetTaskIds", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1`, [ids.turnId],
    )
    expect(wait.rows).toHaveLength(1)
    expect(wait.rows[0]).toMatchObject({ status: "waiting", consumedAt: null })
    expect(wait.rows[0]?.suspendedAt).toBeInstanceOf(Date)
    childTaskId = Array.isArray(wait.rows[0]?.targetTaskIds)
      ? wait.rows[0].targetTaskIds[0]
      : JSON.parse(String(wait.rows[0]?.targetTaskIds))[0]

    const child = await pool!.query<{ status: string; attemptCount: number; result: { proof?: string } }>(
      `SELECT "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [childTaskId],
    )
    expect(child.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, result: { proof: RESULT_MARKER } })
    const parentToolCalls = await pool!.query<{ content: { toolName?: string; status?: string } }>(
      `SELECT item."content" FROM "agent_items" AS item
       JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."turnId" = item."turnId"
       WHERE item."turnId" = $1 AND item."sessionId" = $2 AND item."type" = 'tool_call'
       ORDER BY step."ordinal", item."createdAt", item."id"`,
      [ids.turnId, ids.sessionId],
    )
    expect(parentToolCalls.rows.map(row => row.content)).toEqual([
      expect.objectContaining({ toolName: "agent.spawn", status: "completed" }),
      expect.objectContaining({ toolName: "agent.wait", status: "completed" }),
    ])
    const rootBeforeRestart = await pool!.query<{ rootTaskId: string | null }>(
      `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )

    workerOne.kill("SIGKILL")
    await waitForExit(workerOne)
    expect(workerOne.signalCode).toBe("SIGKILL")
    const parkedAfterKill = await pool!.query<{ status: string; leaseVersion: number }>(
      `SELECT "status", "leaseVersion" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )
    expect(parkedAfterKill.rows[0]).toEqual({ status: "waiting_for_dependency", leaseVersion: 1 })

    workerTwo = startWorker("resume-parent", ids)
    expect(workerTwo.pid).not.toBe(workerOne.pid)
    await waitForLine(workerTwo, "RESUME_CONTEXT_OK")
    await waitForTurnStatus(pool!, ids.turnId, "completed")

    const resumed = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number; rootTaskId: string | null; finalResponse: string | null }>(
      `SELECT "status", "leaseOwnerId", "leaseVersion", "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )
    expect(resumed.rows[0]).toMatchObject({ status: "completed", leaseOwnerId: null, leaseVersion: 2 })
    expect(resumed.rows[0]?.rootTaskId).toBe(rootBeforeRestart.rows[0]?.rootTaskId)
    const finalItems = await pool!.query<{ content: unknown }>(
      `SELECT "content" FROM "agent_items" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'agent_message'`, [ids.turnId, ids.sessionId],
    )
    expect(finalItems.rows).toHaveLength(1)
    expect(JSON.stringify(finalItems.rows[0]?.content)).toContain(FINAL_MARKER)
    const steps = await pool!.query<{ id: string; ordinal: number; status: string }>(
      `SELECT "id", "ordinal", "status" FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2 ORDER BY "ordinal"`, [ids.turnId, ids.sessionId],
    )
    expect(steps.rows).toHaveLength(3)
    expect(steps.rows[0]).toMatchObject({ ordinal: 0, status: "completed" })
    expect(steps.rows[1]).toMatchObject({ ordinal: 1, status: "waiting_for_tool" })
    expect(steps.rows[2]).toMatchObject({ ordinal: 2, status: "completed" })

    const persistedWait = await pool!.query<{ status: string; consumedAt: Date | null; result: unknown }>(
      `SELECT "status", "consumedAt", "result" FROM "agent_wait_conditions" WHERE "id" = $1`, [wait.rows[0]!.id],
    )
    expect(persistedWait.rows[0]?.status).toBe("ready")
    expect(persistedWait.rows[0]?.consumedAt).toBeInstanceOf(Date)
    expect(JSON.stringify(persistedWait.rows[0]?.result)).toContain(RESULT_MARKER)
    const childAfterResume = await pool!.query<{ status: string; attemptCount: number; result: unknown }>(
      `SELECT "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [childTaskId],
    )
    expect(childAfterResume.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, result: { proof: RESULT_MARKER } })
    const childCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "parentTaskId" = $2`,
      [ids.turnId, rootBeforeRestart.rows[0]?.rootTaskId],
    )
    expect(childCount.rows[0]?.count).toBe("1")
    const resumedEvents = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
      [ids.sessionId, `agent-wait:${wait.rows[0]!.id}:resumed`],
    )
    expect(resumedEvents.rows[0]?.count).toBe("1")

    const completedSnapshot = {
      leaseVersion: resumed.rows[0]?.leaseVersion,
      stepCount: steps.rows.length,
      childAttemptCount: childAfterResume.rows[0]?.attemptCount,
      parentToolCalls: parentToolCalls.rows.map(row => row.content.toolName),
      finalMessageCount: finalItems.rows.length,
      finalMessage: finalItems.rows[0]?.content,
      resumedEventCount: resumedEvents.rows[0]?.count,
    }
    // Observe a bounded post-completion settling window for delayed duplicate
    // work; this does not claim to exercise repeated wait consumption.
    await new Promise(resolve => setTimeout(resolve, 250))
    const stable = await pool!.query<{
      leaseVersion: number
      stepCount: number
      childAttemptCount: number | null
      parentToolCalls: string[]
      finalMessageCount: number
      finalMessage: unknown
      resumedEventCount: string
    }>(
      `SELECT turn."leaseVersion",
         (SELECT COUNT(*)::int FROM "agent_steps" WHERE "turnId" = turn."id" AND "sessionId" = turn."sessionId") AS "stepCount",
         (SELECT task."attemptCount" FROM "sub_agent_tasks" AS task WHERE task."id" = $2 AND task."turnId" = turn."id") AS "childAttemptCount",
         (SELECT COALESCE(json_agg(item."content"->>'toolName' ORDER BY step."ordinal", item."createdAt", item."id"), '[]'::json)
          FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."turnId" = item."turnId"
          WHERE item."turnId" = turn."id" AND item."sessionId" = turn."sessionId" AND item."type" = 'tool_call') AS "parentToolCalls",
         (SELECT COUNT(*)::int FROM "agent_items" WHERE "turnId" = turn."id" AND "sessionId" = turn."sessionId" AND "type" = 'agent_message') AS "finalMessageCount",
         (SELECT "content" FROM "agent_items" WHERE "turnId" = turn."id" AND "sessionId" = turn."sessionId" AND "type" = 'agent_message' LIMIT 1) AS "finalMessage",
         (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = turn."sessionId" AND "idempotencyKey" = $3) AS "resumedEventCount"
       FROM "agent_turns" AS turn WHERE turn."id" = $1`,
      [ids.turnId, childTaskId, `agent-wait:${wait.rows[0]!.id}:resumed`],
    )
    expect(stable.rows[0]).toEqual(completedSnapshot)

    workerTwo.stdin?.write("shutdown\n")
    await waitForExit(workerTwo)
  }, 60_000)
})
