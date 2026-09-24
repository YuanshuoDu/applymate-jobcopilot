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
type ExitWaitContext = { stage: string; pid?: number; requestedSignal?: string; signalAccepted?: boolean; timeoutMs?: number }
type CommandAcceptanceResult = {
  inputId: string
  turnId: string
  disposition: string
  originalDisposition?: string
}
type CommandAcceptance = { accepted: CommandAcceptanceResult; duplicate: CommandAcceptanceResult }

const fixturePath = fileURLToPath(new URL("./production-bootstrap-process-restart.fixture.mjs", import.meta.url))
const workerCwd = fileURLToPath(new URL("../..", import.meta.url))

function startWorker(mode: "accept-message" | "park-parent" | "resume-parent", ids: FixtureIds): WorkerChild {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode, JSON.stringify(ids)], {
    cwd: workerCwd,
    env: { ...process.env, DATABASE_URL: databaseUrl!, REDIS_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl! },
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

function parseCommandAcceptance(line: string): CommandAcceptance {
  const prefix = "COMMAND_ACCEPTED "
  if (!line.startsWith(prefix)) throw new Error(`Unexpected command acceptance output: ${line}`)
  return JSON.parse(line.slice(prefix.length)) as CommandAcceptance
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

function exitWaitDiagnostics(child: WorkerChild, context: ExitWaitContext): string {
  return `stage=${context.stage} pid=${context.pid ?? child.pid ?? "unknown"} killed=${child.killed} requestedSignal=${context.requestedSignal ?? "none"} signalAccepted=${context.signalAccepted ?? "not-recorded"} exitCode=${child.exitCode} signalCode=${child.signalCode} stdout=${child.output.join(" | ")} stderr=${child.errors.join(" | ")}`
}

function waitForExit(child: WorkerChild, context: ExitWaitContext): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const onError = (error: Error) => finish(new Error(`${context.stage}: Worker child process error: ${error.message}; ${exitWaitDiagnostics(child, context)}`))
    child.once("exit", onExit)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      finish()
      return
    }
    timer = setTimeout(() => finish(new Error(`Worker process did not exit; ${exitWaitDiagnostics(child, context)}`)), context.timeoutMs ?? 10_000)
  })
}

function workerHasExited(child: WorkerChild): boolean { return child.exitCode !== null || child.signalCode !== null }
function cleanupError(error: unknown): string { return error instanceof Error ? error.stack ?? error.message : String(error) }

async function stopWorkerForCleanup(child: WorkerChild, workerName: string): Promise<string | null> {
  const gracefulContext: ExitWaitContext = { stage: `${workerName}-cleanup-after-shutdown`, pid: child.pid, timeoutMs: 3_000 }
  const gracefulExit = waitForExit(child, gracefulContext)
  let shutdownWriteError: string | null = null
  try { child.stdin?.write("shutdown\n") } catch (error: unknown) { shutdownWriteError = cleanupError(error) }
  try {
    await gracefulExit
    return null
  } catch (gracefulError: unknown) {
    if (workerHasExited(child)) return null
    const forcedContext: ExitWaitContext = { stage: `${workerName}-cleanup-after-SIGKILL`, pid: child.pid, requestedSignal: "SIGKILL", timeoutMs: 3_000 }
    const forcedExit = waitForExit(child, forcedContext)
    let killError: string | null = null
    try { forcedContext.signalAccepted = child.kill("SIGKILL") } catch (error: unknown) {
      forcedContext.signalAccepted = false
      killError = cleanupError(error)
    }
    try {
      await forcedExit
      return workerHasExited(child) ? null : `${workerName} cleanup wait ended without an exit state; ${exitWaitDiagnostics(child, forcedContext)}`
    } catch (forcedError: unknown) {
      return `${workerName} did not exit after graceful shutdown and SIGKILL; graceful=${cleanupError(gracefulError)}; shutdownWriteError=${shutdownWriteError ?? "none"}; killError=${killError ?? "none"}; forced=${cleanupError(forcedError)}; ${exitWaitDiagnostics(child, forcedContext)}`
    }
  }
}

async function attemptCleanup(failures: string[], label: string, action: () => Promise<unknown>): Promise<void> {
  try { await action() } catch (error: unknown) { failures.push(`${label}: ${cleanupError(error)}`) }
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

type WakeupDispatchRow = {
  id: string
  attemptCount: number
  publishedAt: Date | null
  lastError: string | null
  payload: unknown
}

type WakeupDispatchSnapshot = {
  dispatchBeforeRestart: { rows: WakeupDispatchRow[] }
  wakeupJob: Awaited<ReturnType<Queue["getJob"]>>
}

async function waitForWakeupDispatch(
  pool: Pool,
  queue: Queue,
  ids: FixtureIds,
  turnJobKey: (turnId: string, generation?: number) => string,
  timeoutMs = 5_000,
): Promise<WakeupDispatchSnapshot> {
  const deadline = Date.now() + timeoutMs
  let expectedJobId = turnJobKey(ids.turnId, 0)
  while (Date.now() < deadline) {
    const dispatchBeforeRestart = await pool.query<WakeupDispatchRow>(
      `SELECT "id", "attemptCount", "publishedAt", "lastError", "payload"
       FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2`,
      [ids.sessionId, `turn-dispatch:${ids.turnId}`],
    )
    const attemptCount = Number(dispatchBeforeRestart.rows[0]?.attemptCount ?? 0)
    const generation = Math.max(0, attemptCount - 1)
    expectedJobId = turnJobKey(ids.turnId, generation)
    const wakeupJob = await queue.getJob(expectedJobId)
    if (dispatchBeforeRestart.rows[0]?.publishedAt && wakeupJob) {
      return { dispatchBeforeRestart, wakeupJob }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  const dispatchBeforeRestart = await pool.query<WakeupDispatchRow>(
    `SELECT "id", "attemptCount", "publishedAt", "lastError", "payload"
     FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2`,
    [ids.sessionId, `turn-dispatch:${ids.turnId}`],
  )
  const attemptCount = Number(dispatchBeforeRestart.rows[0]?.attemptCount ?? 0)
  const recentGenerations = Array.from({ length: 6 }, (_, index) => Math.max(0, attemptCount - 4) + index)
  const generations = [...new Set([0, 1, 2, Math.max(0, attemptCount - 1), ...recentGenerations])]
  const [jobStates, queuePaused] = await Promise.all([
    Promise.all(generations.map(async generation => {
      const candidateId = turnJobKey(ids.turnId, generation)
      try {
        return { generation, jobId: candidateId, state: await queue.getJobState(candidateId) }
      } catch (error: unknown) {
        return { generation, jobId: candidateId, state: `error:${cleanupError(error)}` }
      }
    })),
    queue.isPaused().catch((error: unknown) => `error:${cleanupError(error)}`),
  ])
  throw new Error(`Timed out waiting for published parent wakeup dispatch and current BullMQ generation: ${JSON.stringify({
    outbox: dispatchBeforeRestart.rows[0] ?? null,
    expectedJobId,
    queuePaused,
    jobStates,
  })}`)
}

describeWithServices("production bootstrap recovery across a Worker process restart", () => {
  let pool: Pool | undefined
  let redis: Redis | undefined
  let turnQueue: Queue | undefined
  let turnQueuePaused = false
  let childQueue: Queue | undefined
  let turnJobKey: ((turnId: string, generation?: number) => string) | undefined
  let childJobKey: ((taskId: string) => string) | undefined
  let workerOne: WorkerChild | undefined
  let workerTwo: WorkerChild | undefined
  let commandAcceptance: WorkerChild | undefined
  let ids: FixtureIds
  let childTaskId: string | undefined
  let wakeupGeneration: number | undefined

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
      turnId: `process-restart-turn-pending-${suffix}`,
    }
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.userId, `${ids.userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Resume a parent Turn after its child completes', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
  }, 20_000)

  afterAll(async () => {
    const cleanupFailures: string[] = []
    for (const [workerName, child] of [["command-acceptance", commandAcceptance], ["worker1", workerOne], ["worker2", workerTwo]] as const) {
      if (!child || workerHasExited(child)) continue
      try {
        const failure = await stopWorkerForCleanup(child, workerName)
        if (failure) cleanupFailures.push(failure)
      } catch (error: unknown) {
        cleanupFailures.push(`${workerName} cleanup threw: ${cleanupError(error)}; ${exitWaitDiagnostics(child, { stage: `${workerName}-cleanup`, pid: child.pid })}`)
      }
    }
    if (turnQueuePaused && turnQueue) {
      await attemptCleanup(cleanupFailures, "turn queue resume", async () => {
        await turnQueue!.resume()
        turnQueuePaused = false
      })
    }
    if (pool && typeof ids !== "undefined") await attemptCleanup(cleanupFailures, "fixture database cleanup", async () => {
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId])
    })
    if (turnQueue && turnJobKey && typeof ids !== "undefined") {
      const generations = new Set([0, 1, 2])
      if (wakeupGeneration !== undefined) generations.add(wakeupGeneration)
      for (const generation of generations) {
        await attemptCleanup(cleanupFailures, `turn job ${generation} cleanup`, async () => {
          await turnQueue!.getJob(turnJobKey!(ids.turnId, generation))?.then(job => job?.remove())
        })
      }
    }
    if (childTaskId && childQueue && childJobKey) await attemptCleanup(cleanupFailures, "subagent job cleanup", async () => {
      await childQueue!.getJob(childJobKey!(childTaskId!))?.then(job => job?.remove())
    })
    if (turnQueue) await attemptCleanup(cleanupFailures, "turn queue close", async () => { await turnQueue!.close() })
    if (childQueue) await attemptCleanup(cleanupFailures, "subagent queue close", async () => { await childQueue!.close() })
    await attemptCleanup(cleanupFailures, "shared Redis connection cleanup", async () => {
      await import("../redis.js").then(module => module.closeSharedRedisConnections())
    })
    if (redis && redis.status !== "end") await attemptCleanup(cleanupFailures, "Redis client cleanup", async () => {
      try { await redis!.quit() } catch (error: unknown) { redis!.disconnect(); throw error }
    })
    if (pool) await attemptCleanup(cleanupFailures, "PostgreSQL pool cleanup", async () => { await pool!.end() })
    if (cleanupFailures.length > 0) throw new Error(`Process-restart fixture cleanup failed:\n${cleanupFailures.join("\n")}`)
  })

  it("persists a child result, kills its Worker, and resumes the parent from PostgreSQL under a new lease", async () => {
    // Exercise the Web command service against the migrated disposable database.
    // The fixture calls message() twice with the same clientMessageId, then
    // exits before any Worker consumer is started.
    commandAcceptance = startWorker("accept-message", ids)
    const acceptedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
    await waitForExit(commandAcceptance, { stage: "command-acceptance-after-result", pid: commandAcceptance.pid })
    expect(commandAcceptance.exitCode).toBe(0)
    const acceptance = parseCommandAcceptance(acceptedLine)
    expect(acceptance.accepted.disposition).toBe("started")
    expect(acceptance.duplicate).toMatchObject({
      inputId: acceptance.accepted.inputId,
      turnId: acceptance.accepted.turnId,
      disposition: "duplicate",
      originalDisposition: "started",
    })
    ids.turnId = acceptance.accepted.turnId
    const acceptedFacts = await pool!.query<{
      turnCount: string
      inputCount: string
      userMessageCount: string
      acceptedEventCount: string
      turnDispatchCount: string
      turnStatus: string | null
      outboxPublishedAt: Date | null
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2) AS "turnCount",
         (SELECT COUNT(*)::text FROM "agent_inputs" WHERE "sessionId" = $2 AND "clientMessageId" = $3 AND "targetTurnId" = $1) AS "inputCount",
         (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'user_message') AS "userMessageCount",
         (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $2 AND "idempotencyKey" = $4) AS "acceptedEventCount",
         (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "aggregateId" = $2 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $5) AS "turnDispatchCount",
         (SELECT "status" FROM "agent_turns" WHERE "id" = $1) AS "turnStatus",
         (SELECT "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $2 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $5) AS "outboxPublishedAt"`,
      [
        ids.turnId,
        ids.sessionId,
        `process-restart-message:${ids.suffix}`,
        `agent-command:process-restart-message:${ids.suffix}`,
        `turn-dispatch:${ids.turnId}`,
      ],
    )
    expect(acceptedFacts.rows[0]).toMatchObject({
      turnCount: "1",
      inputCount: "1",
      userMessageCount: "1",
      acceptedEventCount: "1",
      turnDispatchCount: "1",
      turnStatus: "queued",
      outboxPublishedAt: null,
    })

    workerOne = startWorker("park-parent", ids)
    await waitForLine(workerOne, "PARENT_SUSPENDED")
    // Freeze the real shared Turn queue before the child completes so Process 1 cannot claim its wakeup.
    await turnQueue!.pause()
    turnQueuePaused = true
    expect(await turnQueue!.isPaused()).toBe(true)
    workerOne.stdin?.write("persist-child-result\n")
    await waitForLine(workerOne, "READY_TO_RESTART")

    const parent = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
      `SELECT "status", "leaseOwnerId", "leaseVersion" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )
    expect(parent.rows[0]).toMatchObject({ status: "queued", leaseOwnerId: null, leaseVersion: 1 })
    const wait = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; targetTaskIds: string[]; consumedAt: Date | null }>(
      `SELECT "id", "status", "suspendedAt", "targetTaskIds", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1`, [ids.turnId],
    )
    expect(wait.rows).toHaveLength(1)
    expect(wait.rows[0]).toMatchObject({ status: "ready", consumedAt: null })
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
    const resumedEventBeforeRestart = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
      [ids.sessionId, `agent-wait:${wait.rows[0]!.id}:resumed`],
    )
    expect(resumedEventBeforeRestart.rows[0]?.count).toBe("1")
    const { dispatchBeforeRestart, wakeupJob } = await waitForWakeupDispatch(pool!, turnQueue!, ids, turnJobKey!)
    expect(dispatchBeforeRestart.rows[0]?.publishedAt).toBeInstanceOf(Date)
    expect(wakeupJob).toBeDefined()
    const publishedGeneration = Math.max(0, Number(dispatchBeforeRestart.rows[0]?.attemptCount ?? 0) - 1)
    wakeupGeneration = publishedGeneration
    expect(wakeupJob?.id).toBe(turnJobKey!(ids.turnId, publishedGeneration))
    expect(wakeupJob?.data).toMatchObject({
      turnId: ids.turnId,
      sessionId: ids.sessionId,
      ownerId: `restart-wait-resolver-${workerOne.pid}`,
    })
    expect(await turnQueue!.isPaused()).toBe(true)

    if (workerOne.pid === undefined) throw new Error("Worker 1 has no PID at the restart boundary")
    const workerOnePid = workerOne.pid
    const workerOneExitContext: ExitWaitContext = { stage: "worker1-after-SIGKILL", pid: workerOnePid, requestedSignal: "SIGKILL" }
    const workerOneExit = waitForExit(workerOne, workerOneExitContext)
    const killAccepted = workerOne.kill("SIGKILL")
    workerOneExitContext.signalAccepted = killAccepted
    await workerOneExit
    expect(killAccepted, exitWaitDiagnostics(workerOne, workerOneExitContext)).toBe(true)
    expect({ pid: workerOne.pid, killed: workerOne.killed, exitCode: workerOne.exitCode, signalCode: workerOne.signalCode })
      .toEqual({ pid: workerOnePid, killed: true, exitCode: null, signalCode: "SIGKILL" })
    const parkedAfterKill = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
      `SELECT "status", "leaseOwnerId", "leaseVersion" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId],
    )
    expect(parkedAfterKill.rows[0]).toEqual({ status: "queued", leaseOwnerId: null, leaseVersion: 1 })

    await turnQueue!.resume()
    turnQueuePaused = false
    expect(await turnQueue!.isPaused()).toBe(false)
    workerTwo = startWorker("resume-parent", ids)
    expect(workerTwo.pid).not.toBe(workerOnePid)
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
    await waitForLine(workerTwo, "SHUTDOWN_STAGE bootstrap_close:complete", 10_000)
    await waitForExit(workerTwo, { stage: "worker2-after-shutdown", pid: workerTwo.pid })
    expect(workerTwo.exitCode).toBe(0)
    expect(workerTwo.signalCode).toBeNull()
  }, 60_000)
})
