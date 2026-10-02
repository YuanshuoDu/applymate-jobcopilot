import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool, type PoolClient } from "pg"
import { Redis } from "ioredis"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

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

type FixtureFollowUp = { clientMessageId: string; text: string }
type CheckpointKind = "approval" | "question" | "tool-result"
type FixtureIds = {
  suffix: string
  userId: string
  sessionId: string
  turnId: string
  followUps?: FixtureFollowUp[]
  followUpCommand?: FixtureFollowUp & { userId?: string; sessionId?: string }
  checkpointKind?: CheckpointKind
  checkpointWaitId?: string
  checkpointJobId?: string
  checkpointAnswer?: string
  readCallId?: string
}
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

function startWorker(mode: "accept-message" | "park-parent" | "resume-parent" | "park-active-follow-up" | "accept-active-follow-up" | "resume-active-follow-up" | "replay-active-terminal" | "checkpoint-worker1" | "checkpoint-worker2" | "resolve-checkpoint", ids: FixtureIds): WorkerChild {
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

type CheckpointResumeDiagnostics = {
  pool: Pool
  queue: Queue
  turnId: string
  toolCallId: string
  turnJobKey: (turnId: string, generation?: number) => string
}

async function checkpointResumeDiagnostics(input: CheckpointResumeDiagnostics): Promise<string> {
  const [turn, root, step, toolItems, dispatch] = await Promise.all([
    input.pool.query(`SELECT "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt", "rootTaskId", "error"
      FROM "agent_turns" WHERE "id" = $1`, [input.turnId]),
    input.pool.query(`SELECT task."status", task."leaseOwner", task."leaseExpiresAt", task."failureReason"
      FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId"
      WHERE turn."id" = $1`, [input.turnId]),
    input.pool.query(`SELECT "ordinal", "status", "errorCode", "finishReason"
      FROM "agent_steps" WHERE "turnId" = $1 AND "ordinal" = 0`, [input.turnId]),
    input.pool.query(`SELECT "id", "type", "status", "stepId", "content"
      FROM "agent_items" WHERE "turnId" = $1 AND "content"->>'toolCallId' = $2
        AND "type" IN ('tool_call', 'tool_result') ORDER BY "id"`, [input.turnId, input.toolCallId]),
    input.pool.query(`SELECT "id", "attemptCount", "publishedAt", "lastError", "payload"
      FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`, [`turn-dispatch:${input.turnId}`]),
  ])
  const attemptCount = Number(dispatch.rows[0]?.attemptCount ?? 0)
  const recentGenerations = [Math.max(0, attemptCount - 1), attemptCount, attemptCount + 1]
  const generations = [...new Set([0, 1, 2, ...recentGenerations])]
  const [jobGenerations, queueCounts, queuePaused] = await Promise.all([
    Promise.all(generations.map(async generation => {
      const jobId = input.turnJobKey(input.turnId, generation)
      try {
        const job = await input.queue.getJob(jobId)
        return { generation, jobId, state: job ? await job.getState() : "missing", data: job?.data ?? null }
      } catch (error: unknown) {
        return { generation, jobId, state: `error:${cleanupError(error)}` }
      }
    })),
    input.queue.getJobCounts("wait", "active", "delayed", "completed", "failed", "paused"),
    input.queue.isPaused(),
  ])
  return JSON.stringify({
    turn: turn.rows[0] ?? null,
    root: root.rows[0] ?? null,
    step0: step.rows[0] ?? null,
    toolItems: toolItems.rows,
    dispatch: dispatch.rows[0] ?? null,
    jobGenerations,
    queueCounts,
    queuePaused,
  })
}

async function waitForCheckpointResume(
  child: WorkerChild,
  kind: CheckpointKind,
  timeoutMs = 20_000,
  diagnostics?: CheckpointResumeDiagnostics,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const resumed = child.output.find(value => value.startsWith(`CHECKPOINT_RESUME_CONTEXT_OK ${kind} `))
    if (resumed) return resumed
    if (kind === "question") {
      const answerCount = child.output.find(value => value.startsWith("CHECKPOINT_QUESTION_CONTEXT_COUNT "))
      if (answerCount) throw new Error(`Worker 2 did not receive exactly one durable question answer in its model request: ${answerCount}`)
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker 2 exited before recovering ${kind}: ${child.errors.join("\n")}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  let runtime = "unavailable"
  if (diagnostics) {
    try { runtime = await checkpointResumeDiagnostics(diagnostics) } catch (error: unknown) { runtime = `diagnostics-error:${cleanupError(error)}` }
  }
  const requestStarted = child.output.some(value => value.startsWith(`CHECKPOINT_MODEL_REQUEST_STARTED ${kind} `))
  throw new Error(`Timed out waiting for Worker 2 to recover ${kind}; modelRequestStarted=${requestStarted}; runtime=${runtime}; stdout=${child.output.join(" | ")}; stderr=${child.errors.join(" | ")}`)
}

async function waitForSuccessorProvider(pool: Pool, queue: Queue, child: WorkerChild, turnId: string, successorIndex: number, jobId: string): Promise<string> {
  try {
    return await waitForLine(child, `SUCCESSOR_PROVIDER_ACTIVE ${successorIndex}`)
  } catch (error: unknown) {
    const [turn, root, steps, inputs, dispatch, job, queueCounts, queuePaused] = await Promise.all([
      pool.query(`SELECT "status", "leaseOwnerId", "leaseVersion", "rootTaskId", "error" FROM "agent_turns" WHERE "id" = $1`, [turnId]),
      pool.query(`SELECT task."status", task."leaseOwner", task."failureReason" FROM "agent_turns" AS turn
        JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" WHERE turn."id" = $1`, [turnId]),
      pool.query(`SELECT "ordinal", "status", "errorCode", "finishReason" FROM "agent_steps" WHERE "turnId" = $1 ORDER BY "ordinal"`, [turnId]),
      pool.query(`SELECT "id", "targetTurnId", "status", "consumedByStepId" FROM "agent_inputs" WHERE "targetTurnId" = $1 ORDER BY "acceptedSequence", "id"`, [turnId]),
      pool.query(`SELECT "id", "attemptCount", "publishedAt", "lastError", "payload" FROM "agent_outbox"
        WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`, [`turn-dispatch:${turnId}`]),
      queue.getJob(jobId).then(async found => found ? { state: await found.getState(), data: found.data } : { state: "missing" }),
      queue.getJobCounts("wait", "active", "delayed", "completed", "failed", "paused"),
      queue.isPaused(),
    ])
    const events = await pool.query(`SELECT "type", "payload" FROM "agent_events" WHERE "turnId" = $1 AND "type" IN ('turn.failed', 'step.completed') ORDER BY "sequence" DESC LIMIT 5`, [turnId])
    throw new Error(`${error instanceof Error ? error.message : String(error)}; successorRuntime=${JSON.stringify({
      worker: { pid: child.pid, exited: workerHasExited(child), stdout: child.output, stderr: child.errors },
      turn: turn.rows[0] ?? null, root: root.rows[0] ?? null, steps: steps.rows, inputs: inputs.rows,
      dispatch: dispatch.rows[0] ?? null, job, queueCounts, queuePaused, events: events.rows,
    })}`)
  }
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

async function removeTurnFixtureJobAfterWorkersExit(queue: Queue, redis: Redis, jobId: string): Promise<void> {
  // A SIGKILL leaves BullMQ's lock key until its TTL expires. These job IDs
  // belong only to this disposable Redis fixture, and callers stop all child
  // Workers before removing the lock and the corresponding job.
  await redis.del(`${queue.toKey(jobId)}:lock`)
  await queue.getJob(jobId)?.then(job => job?.remove())
}

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

async function waitForTurnStatus(pool: Pool, turnId: string, status: string, timeoutMs = 20_000, child?: WorkerChild): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1`, [turnId])
    if (result.rows[0]?.status === status) return
    if (["failed", "interrupted", "cancelled"].includes(String(result.rows[0]?.status))) {
      const [state, failure] = await Promise.all([
        pool.query<Record<string, unknown>>(`SELECT turn."status", turn."error", root."status" AS "rootStatus", root."failureReason", root."result",
            (SELECT step."errorCode" FROM "agent_steps" AS step WHERE step."turnId" = turn."id" ORDER BY step."ordinal" DESC LIMIT 1) AS "latestStepErrorCode"
          FROM "agent_turns" AS turn LEFT JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" WHERE turn."id" = $1`, [turnId]),
        pool.query<Record<string, unknown>>(`SELECT event."payload" FROM "agent_events" AS event
          WHERE event."turnId" = $1 AND event."type" = 'turn.failed' ORDER BY event."sequence" DESC LIMIT 1`, [turnId]),
      ])
      throw new Error(`Turn entered unexpected terminal state ${result.rows[0]?.status}; state=${JSON.stringify(state.rows[0] ?? null)}; failureEvent=${JSON.stringify(failure.rows[0]?.payload ?? null)}; workerStderr=${child?.errors.join(" | ") ?? "unavailable"}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Turn ${turnId} did not reach ${status}`)
}

async function waitForLockWait(pool: Pool, queryFragment: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let waiting: Array<{ pid: number; query: string }> = []
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number; query: string }>(
      `SELECT pid, query FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND position($1 in query) > 0`,
      [queryFragment],
    )
    waiting = result.rows
    if (waiting.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for a lock waiter matching ${queryFragment}; waiting=${JSON.stringify(waiting)}`)
}

type WakeupDispatchRow = {
  id: string
  attemptCount: number
  publishedAt: Date | null
  lastError: string | null
  payload: unknown
}

async function waitForCheckpointToolResult(pool: Pool, turnId: string, toolCallId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await pool.query<{
      calls: string; completedCalls: string; results: string; completedResults: string
      resultStepId: string | null; callStepId: string | null; turnStatus: string; leaseOwnerId: string | null
      leaseActive: boolean; rootTaskId: string | null; stepCount: string; readStepStatus: string | null; laterStepCount: string
    }>(
      `SELECT turn."status" AS "turnStatus", turn."leaseOwnerId", turn."rootTaskId",
         turn."leaseExpiresAt" > CURRENT_TIMESTAMP AS "leaseActive",
         (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_call' AND "content"->>'toolCallId' = $2) AS "calls",
         (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_call' AND "status" = 'completed' AND "content"->>'toolCallId' = $2 AND "content"->>'status' = 'completed') AS "completedCalls",
         (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2) AS "results",
         (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_result' AND "status" = 'completed' AND "content"->>'toolCallId' = $2) AS "completedResults",
         (SELECT "stepId" FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2 LIMIT 1) AS "resultStepId",
         (SELECT "stepId" FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_call' AND "content"->>'toolCallId' = $2 LIMIT 1) AS "callStepId",
         (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id") AS "stepCount",
         (SELECT "status" FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 0 LIMIT 1) AS "readStepStatus",
         (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" > 0) AS "laterStepCount"
       FROM "agent_turns" AS turn WHERE turn."id" = $1`,
      [turnId, toolCallId],
    )
    const row = result.rows[0]
    if (row?.calls === "1" && row.completedCalls === "1" && row.results === "1" && row.completedResults === "1"
      && row.turnStatus === "in_progress" && row.leaseOwnerId && row.leaseActive && row.rootTaskId
      && row.stepCount === "1" && row.readStepStatus === "streaming" && row.laterStepCount === "0"
      && row.resultStepId === row.callStepId) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for a durable completed checkpoint tool result with its active lease and no downstream step for ${toolCallId}`)
}

async function waitForCheckpointWait(pool: Pool, kind: Exclude<CheckpointKind, "tool-result">, ids: FixtureIds): Promise<void> {
  const itemId = `agent-wait:${kind}:${ids.checkpointWaitId}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await pool.query<{
      turnStatus: string; leaseOwnerId: string | null; rootTaskId: string | null; leaseActive: boolean
      itemCount: string; itemStatus: string | null; itemContent: Record<string, unknown> | null
      startEventCount: string; startOutboxCount: string; receiptStatus: string | null; receiptCount: string
      stepCount: string; readStepStatus: string | null; waitStepStatus: string | null; postWaitStepCount: string
    }>(
      `SELECT turn."status" AS "turnStatus", turn."leaseOwnerId", turn."rootTaskId", turn."leaseExpiresAt" > CURRENT_TIMESTAMP AS "leaseActive",
         (SELECT COUNT(*)::text FROM "agent_items" AS item WHERE item."id" = $2 AND item."sessionId" = turn."sessionId" AND item."turnId" = turn."id" AND item."type" = $3) AS "itemCount",
         (SELECT item."status" FROM "agent_items" AS item WHERE item."id" = $2 AND item."sessionId" = turn."sessionId" AND item."turnId" = turn."id" AND item."type" = $3 LIMIT 1) AS "itemStatus",
         (SELECT item."content" FROM "agent_items" AS item WHERE item."id" = $2 AND item."sessionId" = turn."sessionId" AND item."turnId" = turn."id" AND item."type" = $3 LIMIT 1) AS "itemContent",
         (SELECT COUNT(*)::text FROM "agent_events" AS event WHERE event."turnId" = turn."id" AND event."sessionId" = turn."sessionId" AND event."itemId" = $2 AND event."type" = 'item.started' AND event."actor" = 'orchestrator') AS "startEventCount",
         (SELECT COUNT(*)::text FROM "agent_events" AS event JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
           WHERE event."turnId" = turn."id" AND event."sessionId" = turn."sessionId" AND event."itemId" = $2 AND event."type" = 'item.started'
             AND outbox."topic" = 'agent.session.event' AND outbox."lastError" IS NULL) AS "startOutboxCount",
         (SELECT COUNT(*)::text FROM "agent_approvals" WHERE "id" = $4 AND "userId" = turn."userId" AND "sessionId" = turn."sessionId" AND "turnId" = turn."id") AS "receiptCount",
         (SELECT "status" FROM "agent_approvals" WHERE "id" = $4 AND "userId" = turn."userId" AND "sessionId" = turn."sessionId" AND "turnId" = turn."id" LIMIT 1) AS "receiptStatus",
         (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id") AS "stepCount",
         (SELECT "status" FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 0 LIMIT 1) AS "readStepStatus",
         (SELECT "status" FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 1 LIMIT 1) AS "waitStepStatus",
         (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" > 1) AS "postWaitStepCount"
       FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $5 AND turn."userId" = $6`,
      [ids.turnId, itemId, kind === "approval" ? "approval_request" : "question", ids.checkpointWaitId, ids.sessionId, ids.userId],
    )
    const row = result.rows[0]
    const expectedTurnStatus = kind === "approval" ? "waiting_for_approval" : "waiting_for_user"
    const content = row?.itemContent
    const contentMatches = kind === "approval"
      ? content?.waitKind === "approval" && content.approvalId === ids.checkpointWaitId && content.toolCallId === ids.readCallId
      : content?.waitKind === "question" && content.questionId === ids.checkpointWaitId && content.toolCallId === ids.readCallId
        && typeof content.question === "string" && Array.isArray(content.options) && content.answer === null && content.answerAvailable === false
    if (row?.turnStatus === expectedTurnStatus && row.leaseOwnerId && row.rootTaskId && row.leaseActive
      && row.itemCount === "1" && row.itemStatus === "started" && contentMatches
      && row.startEventCount === "1" && row.startOutboxCount === "1"
      && (kind === "question" || (row.receiptCount === "1" && row.receiptStatus === "pending"))
      && row.stepCount === "2" && row.readStepStatus === "completed" && row.waitStepStatus === "streaming" && row.postWaitStepCount === "0") return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for durable ${kind} wait rows and the actual waiting model-step boundary for ${ids.checkpointWaitId}`)
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
  const turnFixtureIds = new Set<string>()
  const fixtureSessionIds = new Set<string>()
  const auxiliaryUserIds = new Set<string>()
  const checkpointJobIds = new Set<string>()

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl!
    process.env.DATABASE_URL = databaseUrl!
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
    turnFixtureIds.add(ids.turnId)
    fixtureSessionIds.add(ids.sessionId)
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
    const workersStopped = [commandAcceptance, workerOne, workerTwo].every(child => !child || workerHasExited(child))
    if (turnQueuePaused && turnQueue) {
      if (workersStopped) {
        await attemptCleanup(cleanupFailures, "turn queue resume", async () => {
          await turnQueue!.resume()
          turnQueuePaused = false
        })
      } else cleanupFailures.push("Turn queue remains paused in disposable Redis DB 15 because a child Worker is still alive")
    }
    if (pool && workersStopped) for (const sessionId of fixtureSessionIds) await attemptCleanup(cleanupFailures, `turn fixture discovery for ${sessionId}`, async () => {
      const turns = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_turns" WHERE "sessionId" = $1`, [sessionId])
      for (const turn of turns.rows) turnFixtureIds.add(turn.id)
    })
    if (turnQueue && turnJobKey && redis && workersStopped && typeof ids !== "undefined") {
      turnFixtureIds.add(ids.turnId)
      for (const turnId of turnFixtureIds) {
        for (let generation = 0; generation <= Math.max(8, wakeupGeneration ?? 0); generation += 1) {
          await attemptCleanup(cleanupFailures, `turn fixture job ${generation} cleanup`, async () => {
            await removeTurnFixtureJobAfterWorkersExit(turnQueue!, redis!, turnJobKey!(turnId, generation))
          })
        }
      }
    } else if (turnQueue && typeof ids !== "undefined") {
      cleanupFailures.push("Turn fixture job cleanup skipped because a child Worker may still be running")
    }
    if (pool && checkpointJobIds.size > 0) await attemptCleanup(cleanupFailures, "checkpoint fixture job cleanup", async () => {
      await pool!.query(`DELETE FROM "Job" WHERE "id" = ANY($1::text[])`, [[...checkpointJobIds]])
      checkpointJobIds.clear()
    })
    if (pool && typeof ids !== "undefined") await attemptCleanup(cleanupFailures, "fixture database cleanup", async () => {
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId])
    })
    if (pool) for (const userId of auxiliaryUserIds) await attemptCleanup(cleanupFailures, `auxiliary user ${userId} cleanup`, async () => {
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
    })
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

  afterEach(async () => {
    const cleanupFailures: string[] = []
    const children = [...new Set([commandAcceptance, workerOne, workerTwo].filter((child): child is WorkerChild => child !== undefined))]
    for (const [index, child] of children.entries()) {
      if (workerHasExited(child)) continue
      const failure = await stopWorkerForCleanup(child, `process-restart-after-test-${index + 1}`)
      if (failure) cleanupFailures.push(failure)
    }
    const workersStopped = children.every(workerHasExited)
    if (turnQueuePaused && turnQueue) {
      if (workersStopped) {
        await attemptCleanup(cleanupFailures, "after-test Turn queue resume", async () => {
          await turnQueue!.resume()
          turnQueuePaused = false
        })
      } else cleanupFailures.push("after-test Turn queue remains paused because a child Worker is still alive")
    }
    if (pool && workersStopped) for (const sessionId of fixtureSessionIds) await attemptCleanup(cleanupFailures, `after-test Turn discovery for ${sessionId}`, async () => {
      const turns = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_turns" WHERE "sessionId" = $1`, [sessionId])
      for (const turn of turns.rows) turnFixtureIds.add(turn.id)
    })
    if (turnQueue && turnJobKey && redis && workersStopped) for (const turnId of turnFixtureIds) {
      for (let generation = 0; generation <= Math.max(8, wakeupGeneration ?? 0); generation += 1) {
        await attemptCleanup(cleanupFailures, `after-test Turn job ${generation} cleanup`, async () => {
          await removeTurnFixtureJobAfterWorkersExit(turnQueue!, redis!, turnJobKey!(turnId, generation))
        })
      }
    }
    if (pool && workersStopped && fixtureSessionIds.size > 0) await attemptCleanup(cleanupFailures, "after-test fixture session cleanup", async () => {
      await pool!.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [[...fixtureSessionIds]])
    })
    if (pool && workersStopped && checkpointJobIds.size > 0) await attemptCleanup(cleanupFailures, "after-test checkpoint fixture job cleanup", async () => {
      await pool!.query(`DELETE FROM "Job" WHERE "id" = ANY($1::text[])`, [[...checkpointJobIds]])
      checkpointJobIds.clear()
    })
    if (pool && workersStopped) for (const userId of auxiliaryUserIds) await attemptCleanup(cleanupFailures, `after-test auxiliary user ${userId} cleanup`, async () => {
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
    })
    if (cleanupFailures.length > 0) throw new Error(`Process-restart per-test cleanup failed:\n${cleanupFailures.join("\n")}`)
  })

  async function resumeAtDurableCheckpoint(kind: CheckpointKind): Promise<void> {
    const suffix = randomUUID()
    const userId = `checkpoint-user-${suffix}`
    const sessionId = `checkpoint-session-${suffix}`
    const jobId = `checkpoint-job-${suffix}`
    const waitId = `checkpoint-wait-${suffix}`
    const checkpointIds: FixtureIds = {
      suffix, userId, sessionId, turnId: `checkpoint-turn-pending-${suffix}`,
      checkpointKind: kind, checkpointWaitId: waitId, checkpointJobId: jobId,
      checkpointAnswer: `checkpoint-answer-${suffix}`, readCallId: `checkpoint-read-${suffix}`,
    }
    fixtureSessionIds.add(sessionId)
    auxiliaryUserIds.add(userId)
    await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Recover the same Turn after a durable checkpoint', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
    if (kind === "approval") {
      checkpointJobIds.add(jobId)
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "updatedAt")
        VALUES ($1, $2, 'Fixture Employer', 'Fixture Engineer', CURRENT_TIMESTAMP)`, [jobId, userId])
    }

    commandAcceptance = startWorker("accept-message", checkpointIds)
    const acceptedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
    await waitForExit(commandAcceptance, { stage: `checkpoint-${kind}-acceptance`, pid: commandAcceptance.pid })
    expect(commandAcceptance.exitCode).toBe(0)
    const acceptance = parseCommandAcceptance(acceptedLine)
    expect(acceptance.accepted.disposition).toBe("started")
    expect(acceptance.duplicate.disposition).toBe("duplicate")
    checkpointIds.turnId = acceptance.accepted.turnId
    turnFixtureIds.add(checkpointIds.turnId)

    workerOne = startWorker("checkpoint-worker1", checkpointIds)
    let checkpointStepBlocker: PoolClient | undefined
    let workerOnePid: number | undefined
    let beforeKill: {
      status: string; leaseOwnerId: string | null; rootTaskId: string | null; rootStatus: string | null; rootLeaseOwner: string | null
      readCalls: string; readResults: string; stepCount: string; readStepCount: string; readStepStatus: string | null
      waitStepCount: string; waitStepStatus: string | null; postCheckpointStepCount: string
    } | undefined
    try {
      if (kind === "tool-result") {
        await waitForLine(workerOne, `CHECKPOINT_TOOL_STEP_READY ${checkpointIds.readCallId}`)
        const initialStep = await pool!.query(`SELECT 1 FROM "agent_steps" WHERE "turnId" = $1 AND "ordinal" = 0`, [checkpointIds.turnId])
        expect(initialStep.rowCount).toBe(1)
        checkpointStepBlocker = await pool!.connect()
        await checkpointStepBlocker.query("BEGIN")
        await checkpointStepBlocker.query('LOCK TABLE "agent_steps" IN SHARE MODE')
        workerOne.stdin?.write("release-checkpoint-tool-call\n")
        await waitForLine(workerOne, `CHECKPOINT_READ_TOOL_EXECUTED ${checkpointIds.readCallId}`)
        await waitForCheckpointToolResult(pool!, checkpointIds.turnId, checkpointIds.readCallId!)
        expect(workerOne.output.filter(line => line.startsWith("CHECKPOINT_MODEL_REQUEST "))).toEqual(["CHECKPOINT_MODEL_REQUEST 1"])
        expect(workerOne.output).not.toContain("CHECKPOINT_NEXT_MODEL_REQUEST_STARTED")
      } else {
        await waitForLine(workerOne, `CHECKPOINT_WAIT_DURABLE ${kind}`)
        await waitForCheckpointWait(pool!, kind, checkpointIds)
        checkpointStepBlocker = await pool!.connect()
        await checkpointStepBlocker.query("BEGIN")
        await checkpointStepBlocker.query('LOCK TABLE "agent_steps" IN SHARE MODE')
        expect(workerOne.output.filter(line => line.startsWith("CHECKPOINT_MODEL_REQUEST "))).toEqual(["CHECKPOINT_MODEL_REQUEST 1", "CHECKPOINT_MODEL_REQUEST 2"])
        expect(workerOne.output).not.toContain("CHECKPOINT_POST_WAIT_MODEL_PROGRESS")
      }
      beforeKill = (await pool!.query<{
        status: string; leaseOwnerId: string | null; rootTaskId: string | null; rootStatus: string | null; rootLeaseOwner: string | null
        readCalls: string; readResults: string; stepCount: string; readStepCount: string; readStepStatus: string | null
        waitStepCount: string; waitStepStatus: string | null; postCheckpointStepCount: string
      }>(`SELECT turn."status", turn."leaseOwnerId", turn."rootTaskId", root."status" AS "rootStatus", root."leaseOwner" AS "rootLeaseOwner",
          (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_call' AND "content"->>'toolCallId' = $2) AS "readCalls",
          (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2) AS "readResults",
          (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id") AS "stepCount",
          (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 0) AS "readStepCount",
          (SELECT "status" FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 0 LIMIT 1) AS "readStepStatus",
          (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 1) AS "waitStepCount",
          (SELECT "status" FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 1 LIMIT 1) AS "waitStepStatus",
          (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" > $3) AS "postCheckpointStepCount"
        FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."turnId" = turn."id"
        WHERE turn."id" = $1`, [checkpointIds.turnId, checkpointIds.readCallId, kind === "tool-result" ? 0 : 1])).rows[0]
      expect(beforeKill).toMatchObject({
        status: kind === "approval" ? "waiting_for_approval" : kind === "question" ? "waiting_for_user" : "in_progress",
        rootStatus: "running", readCalls: "1", readResults: "1", stepCount: kind === "tool-result" ? "1" : "2", readStepCount: "1",
        readStepStatus: kind === "tool-result" ? "streaming" : "completed",
        waitStepCount: kind === "tool-result" ? "0" : "1", waitStepStatus: kind === "tool-result" ? null : "streaming",
        postCheckpointStepCount: "0",
      })
      expect(beforeKill.leaseOwnerId).toBeTruthy()
      expect(beforeKill.rootTaskId).toBeTruthy()
      expect(beforeKill.rootLeaseOwner).toBe(beforeKill.leaseOwnerId)

      if (!workerOne.pid) throw new Error("Checkpoint Worker 1 has no PID at the restart boundary")
      workerOnePid = workerOne.pid
      const killContext: ExitWaitContext = { stage: `checkpoint-${kind}-worker1-after-SIGKILL`, pid: workerOnePid, requestedSignal: "SIGKILL" }
      const killed = waitForExit(workerOne, killContext)
      killContext.signalAccepted = workerOne.kill("SIGKILL")
      await killed
      expect(killContext.signalAccepted, exitWaitDiagnostics(workerOne, killContext)).toBe(true)
      expect({ pid: workerOne.pid, signalCode: workerOne.signalCode }).toEqual({ pid: workerOnePid, signalCode: "SIGKILL" })
    } finally {
      if (checkpointStepBlocker) {
        await checkpointStepBlocker.query("ROLLBACK").catch(() => undefined)
        checkpointStepBlocker.release()
      }
    }
    if (!beforeKill) throw new Error("Checkpoint Worker 1 did not reach a verified durable restart boundary")
    if (!workerOnePid) throw new Error("Checkpoint Worker 1 PID was unavailable after its restart boundary")
    await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = $1 AND "leaseOwnerId" = $2 AND "status" IN ('in_progress', 'waiting_for_approval', 'waiting_for_user')`, [checkpointIds.turnId, beforeKill.leaseOwnerId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = $1 AND "status" = 'running' AND "leaseOwner" = $2`, [beforeKill.rootTaskId, beforeKill.leaseOwnerId])

    if (kind !== "tool-result") {
      commandAcceptance = startWorker("resolve-checkpoint", checkpointIds)
      await waitForLine(commandAcceptance, `CHECKPOINT_WAIT_RESOLVED ${kind}`)
      await waitForExit(commandAcceptance, { stage: `checkpoint-${kind}-wait-resolution`, pid: commandAcceptance.pid })
      expect(commandAcceptance.exitCode).toBe(0)
    }

    workerTwo = startWorker("checkpoint-worker2", checkpointIds)
    expect(workerTwo.pid).not.toBe(workerOnePid)
    await waitForCheckpointResume(workerTwo, kind, 60_000, kind === "tool-result" ? {
      pool: pool!, queue: turnQueue!, turnId: checkpointIds.turnId, toolCallId: checkpointIds.readCallId!, turnJobKey: turnJobKey!,
    } : undefined)
    await waitForTurnStatus(pool!, checkpointIds.turnId, "completed", 60_000, workerTwo)
    const finalState = await pool!.query<{
      finalCount: string; finalText: string | null; completedEvents: string; readCalls: string; readResults: string
      initialReadSteps: string; resumedEvents: string; wakeupEvents: string; wakeupOutbox: string; wakeupAttempts: string
      wakeupPublishedAt: string | null; publishedWakeupOutbox: string; questionAnsweredEvents: string; answerCount: string
    }>(`SELECT
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'agent_message' AND "phase" = 'final_answer') AS "finalCount",
        (SELECT "content"->>'text' FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'agent_message' AND "phase" = 'final_answer' LIMIT 1) AS "finalText",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "turnId" = turn."id" AND "type" = 'turn.completed') AS "completedEvents",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_call' AND "content"->>'toolCallId' = $2) AS "readCalls",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2) AS "readResults",
        (SELECT COUNT(*)::text FROM "agent_steps" WHERE "turnId" = turn."id" AND "ordinal" = 0) AS "initialReadSteps",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "turnId" = turn."id" AND "type" = 'turn.resumed') AS "resumedEvents",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "turnId" = turn."id" AND "type" = 'turn.wakeup') AS "wakeupEvents",
        (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.wakeup' AND "idempotencyKey" = $3) AS "wakeupOutbox",
        (SELECT COALESCE(MAX("attemptCount"), 0)::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.wakeup' AND "idempotencyKey" = $3) AS "wakeupAttempts",
        (SELECT MAX("publishedAt")::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.wakeup' AND "idempotencyKey" = $3) AS "wakeupPublishedAt",
        (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.wakeup' AND "idempotencyKey" = $3
          AND "publishedAt" IS NOT NULL AND "attemptCount" = 1 AND "lastError" IS NULL) AS "publishedWakeupOutbox",
        (SELECT COUNT(*)::text FROM "agent_events" WHERE "turnId" = turn."id" AND "type" = 'question.answered') AS "questionAnsweredEvents",
        (SELECT COUNT(*)::text FROM "agent_items" WHERE "turnId" = turn."id" AND "type" = 'question' AND "content"->>'answer' = $4) AS "answerCount"
      FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $5 AND turn."userId" = $6`,
    [checkpointIds.turnId, checkpointIds.readCallId, `agent-wait-command:checkpoint-command:${suffix}:wakeup`, checkpointIds.checkpointAnswer, sessionId, userId])
    const result = finalState.rows[0]
    expect(result).toMatchObject({ finalCount: "1", completedEvents: "1", readCalls: "1", readResults: "1", initialReadSteps: "1" })
    expect(result?.finalText).toContain(`CHECKPOINT_FINAL_${kind}_${suffix}`)
    expect(workerOne.output.filter(line => line === `CHECKPOINT_READ_TOOL_EXECUTED ${checkpointIds.readCallId}`)).toHaveLength(1)
    expect(workerTwo.output.some(line => line === `CHECKPOINT_READ_TOOL_EXECUTED ${checkpointIds.readCallId}`)).toBe(false)
    expect(workerTwo.output.filter(line => line === `CHECKPOINT_MODEL_REQUEST_STARTED ${kind} 1`)).toHaveLength(1)
    expect(workerTwo.output.filter(line => line.startsWith(`CHECKPOINT_RESUME_CONTEXT_OK ${kind} `))).toHaveLength(1)
    if (kind === "tool-result") {
      expect(result).toMatchObject({ resumedEvents: "0", wakeupEvents: "0", wakeupOutbox: "0", wakeupAttempts: "0", publishedWakeupOutbox: "0", questionAnsweredEvents: "0", answerCount: "0" })
    } else {
      expect(result).toMatchObject({ resumedEvents: "1", wakeupEvents: "1", wakeupOutbox: "1", wakeupAttempts: "1", publishedWakeupOutbox: "1" })
      expect(result?.wakeupPublishedAt).toBeTruthy()
    }
    if (kind === "question") {
      expect(result).toMatchObject({ answerCount: "1", questionAnsweredEvents: "1" })
      expect(result?.finalText).toContain(checkpointIds.checkpointAnswer)
    } else {
      expect(result?.questionAnsweredEvents).toBe("0")
    }
    if (kind === "approval") {
      const item = await pool!.query<{
        count: string; status: string | null; userId: string | null; turnUserId: string | null; sessionId: string | null
        turnId: string | null; taskId: string | null; toolCallId: string | null
      }>(`SELECT COUNT(*)::text AS "count", MAX(item."status") AS "status", MAX(session."userId") AS "userId",
          MAX(turn."userId") AS "turnUserId", MAX(item."sessionId") AS "sessionId", MAX(item."turnId") AS "turnId",
          MAX(item."taskId") AS "taskId", MAX(item."content"->>'toolCallId') AS "toolCallId"
        FROM "agent_items" AS item
        JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
        WHERE item."turnId" = $1 AND item."type" = 'approval_request' AND item."content"->>'approvalId' = $2`, [checkpointIds.turnId, waitId])
      const receipt = await pool!.query<{
        status: string; scopeHash: string | null; userId: string; sessionId: string; turnId: string; taskId: string | null; jobId: string; toolCallId: string
      }>(`SELECT "status", "scopeHash", "userId", "sessionId", "turnId", "taskId", "jobId", "toolCallId" FROM "agent_approvals" WHERE "id" = $1`, [waitId])
      expect(item.rows[0]).toEqual({ count: "1", status: "completed", userId, turnUserId: userId, sessionId, turnId: checkpointIds.turnId, taskId: null, toolCallId: checkpointIds.readCallId })
      expect(receipt.rows[0]).toMatchObject({ status: "approved", userId, sessionId, turnId: checkpointIds.turnId, taskId: null, jobId, toolCallId: checkpointIds.readCallId })
      expect(receipt.rows[0]?.scopeHash).toMatch(/^[a-f0-9]{64}$/)
    }
  }

  it.each(["approval", "question", "tool-result"] as const)(
    "recovers the same Turn after Worker 1 is killed at the durable %s checkpoint without replaying completed work",
    async kind => resumeAtDurableCheckpoint(kind),
    90_000,
  )

  it("persists a child result, kills its Worker, and resumes the parent from PostgreSQL under a new lease", async () => {
    // Exercise the Web command service against the migrated disposable database.
    // The fixture calls message() twice with the same clientMessageId, then
    // exits before any Worker consumer is started. afterEach removes fixture
    // sessions, so this case owns a fresh Session instead of reusing beforeAll's.
    ids.sessionId = `process-restart-child-result-session-${randomUUID()}`
    fixtureSessionIds.add(ids.sessionId)
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Resume a parent Turn after its child completes', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
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
    turnFixtureIds.add(ids.turnId)
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

  it("recovers an active Turn cleanly and promotes pending follow-ups FIFO into one successor at a time", async () => {
    const suffix = randomUUID()
    const followUps: FixtureFollowUp[] = [1, 2, 3].map(index => ({
      clientMessageId: `active-follow-up:${suffix}:${index}`,
      text: `Durable active-Turn follow-up ${index} ${suffix}`,
    }))
    const followUpIds: FixtureIds = {
      suffix,
      userId: ids.userId,
      sessionId: `active-follow-up-session-${suffix}`,
      turnId: `active-follow-up-pending-${suffix}`,
      followUps,
    }
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Recover an active Turn before processing accepted follow-ups', 'running', 'test', CURRENT_TIMESTAMP)`, [followUpIds.sessionId, followUpIds.userId])
    fixtureSessionIds.add(followUpIds.sessionId)

    commandAcceptance = startWorker("accept-message", followUpIds)
    const startedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
    await waitForExit(commandAcceptance, { stage: "active-follow-up-start-turn", pid: commandAcceptance.pid })
    expect(commandAcceptance.exitCode).toBe(0)
    const started = parseCommandAcceptance(startedLine)
    expect(started.accepted.disposition).toBe("started")
    expect(started.duplicate).toMatchObject({ inputId: started.accepted.inputId, disposition: "duplicate", originalDisposition: "started" })
    followUpIds.turnId = started.accepted.turnId
    turnFixtureIds.add(followUpIds.turnId)

    workerOne = startWorker("park-active-follow-up", followUpIds)
    await waitForLine(workerOne, "FIRST_PROVIDER_ACTIVE")
    const active = await pool!.query<{
      status: string; leaseOwnerId: string | null; rootTaskId: string | null; rootStatus: string | null
      rootLeaseOwner: string | null; stepStatus: string | null; consumedInputIds: string[] | null
    }>(
      `SELECT turn."status", turn."leaseOwnerId", turn."rootTaskId", root."status" AS "rootStatus", root."leaseOwner" AS "rootLeaseOwner",
         step."status" AS "stepStatus", step."consumedInputIds"
       FROM "agent_turns" AS turn
       JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."turnId" = turn."id"
       JOIN "agent_steps" AS step ON step."turnId" = turn."id" AND step."taskId" = root."id"
       WHERE turn."id" = $1 ORDER BY step."ordinal" DESC LIMIT 1`, [followUpIds.turnId],
    )
    expect(active.rows[0]).toMatchObject({ status: "in_progress", rootStatus: "running", stepStatus: "streaming" })
    expect(active.rows[0]?.leaseOwnerId).toBeTruthy()
    expect(active.rows[0]?.rootTaskId).toBeTruthy()
    expect(active.rows[0]?.rootLeaseOwner).toBe(active.rows[0]?.leaseOwnerId)
    expect(active.rows[0]?.consumedInputIds).toContain(started.accepted.inputId)

    const acceptedInputs: CommandAcceptanceResult[] = []
    for (const followUp of followUps) {
      commandAcceptance = startWorker("accept-active-follow-up", { ...followUpIds, followUpCommand: followUp })
      const acceptedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
      await waitForExit(commandAcceptance, { stage: `accepted-${followUp.clientMessageId}`, pid: commandAcceptance.pid })
      expect(commandAcceptance.exitCode).toBe(0)
      const acceptance = parseCommandAcceptance(acceptedLine)
      expect(acceptance.accepted.disposition).toBe("queued_follow_up")
      expect(acceptance.duplicate).toMatchObject({
        inputId: acceptance.accepted.inputId, turnId: followUpIds.turnId,
        disposition: "duplicate", originalDisposition: "queued_follow_up",
      })
      acceptedInputs.push(acceptance.accepted)
    }
    const acceptedBeforeRestart = await pool!.query<{
      id: string; targetTurnId: string; userId: string; status: string; delivery: string; consumedByStepId: string | null
    }>(`SELECT "id", "targetTurnId", "userId", "status", "delivery", "consumedByStepId"
        FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "acceptedSequence", "id"`,
    [acceptedInputs.map(input => input.inputId)])
    expect(acceptedBeforeRestart.rows.map(row => row.id)).toEqual(acceptedInputs.map(input => input.inputId))
    expect(acceptedBeforeRestart.rows).toEqual(acceptedInputs.map(input => expect.objectContaining({
      targetTurnId: followUpIds.turnId, userId: followUpIds.userId, status: "accepted", delivery: "follow_up", consumedByStepId: null,
    })))
    expect(acceptedInputs.every(input => !active.rows[0]?.consumedInputIds?.includes(input.inputId))).toBe(true)

    const foreignUserId = `active-follow-up-foreign-user-${suffix}`
    const foreignSessionId = `active-follow-up-foreign-session-${suffix}`
    auxiliaryUserIds.add(foreignUserId)
    fixtureSessionIds.add(foreignSessionId)
    await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [foreignUserId, `${foreignUserId}@example.invalid`])
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Foreign session follow-up fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [foreignSessionId, followUpIds.userId])
    const foreignInputSequence = await pool!.query<{ sequence: string }>(
      `SELECT (COALESCE(MAX("acceptedSequence"), 0) + 100)::text AS "sequence" FROM "agent_inputs" WHERE "sessionId" = $1`, [followUpIds.sessionId],
    )
    const foreignInputSequenceStart = BigInt(foreignInputSequence.rows[0]?.sequence ?? "100")
    const foreignInputs = [
      { id: `foreign-user-input-${suffix}`, sessionId: followUpIds.sessionId, userId: foreignUserId, clientMessageId: `foreign-user:${suffix}`, text: "Foreign user must not gate this Turn" },
      { id: `foreign-session-input-${suffix}`, sessionId: foreignSessionId, userId: followUpIds.userId, clientMessageId: `foreign-session:${suffix}`, text: "Foreign session must not gate this Turn" },
    ]
    for (const [index, foreign] of foreignInputs.entries()) {
      await pool!.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
        VALUES ($1, $2, $3, $4, $5, 'follow_up', 'accepted', $6::jsonb, $7)`, [
        foreign.id, foreign.sessionId, followUpIds.turnId, foreign.userId, foreign.clientMessageId,
        JSON.stringify([{ type: "text", text: foreign.text }]), (foreignInputSequenceStart + BigInt(index)).toString(),
      ])
    }

    if (!workerOne.pid) throw new Error("Active Worker 1 has no PID at the restart boundary")
    const workerOnePid = workerOne.pid
    const killContext: ExitWaitContext = { stage: "active-worker1-after-SIGKILL", pid: workerOnePid, requestedSignal: "SIGKILL" }
    const killed = waitForExit(workerOne, killContext)
    killContext.signalAccepted = workerOne.kill("SIGKILL")
    await killed
    expect(killContext.signalAccepted, exitWaitDiagnostics(workerOne, killContext)).toBe(true)
    expect({ pid: workerOne.pid, killed: workerOne.killed, exitCode: workerOne.exitCode, signalCode: workerOne.signalCode })
      .toEqual({ pid: workerOnePid, killed: true, exitCode: null, signalCode: "SIGKILL" })
    await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = $1 AND "status" = 'in_progress' AND "leaseOwnerId" = $2`, [followUpIds.turnId, active.rows[0]?.leaseOwnerId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = $1 AND "status" = 'running' AND "leaseOwner" = $2`, [active.rows[0]?.rootTaskId, active.rows[0]?.leaseOwnerId])

    workerTwo = startWorker("resume-active-follow-up", followUpIds)
    expect(workerTwo.pid).not.toBe(workerOnePid)
    await waitForLine(workerTwo, "ACTIVE_TURN_CONTEXT_CLEAN")
    await waitForLine(workerTwo, "ACTIVE_FINAL_CONTEXT_CLEAN")
    await turnQueue!.pause()
    turnQueuePaused = true
    workerTwo.stdin?.write("release-active-final\n")
    await waitForTurnStatus(pool!, followUpIds.turnId, "completed", 20_000, workerTwo)

    const oldTurnSteps = await pool!.query<{ consumedInputIds: string[] }>(
      `SELECT "consumedInputIds" FROM "agent_steps" WHERE "turnId" = $1 ORDER BY "ordinal"`, [followUpIds.turnId],
    )
    const oldTurnConsumed = oldTurnSteps.rows.flatMap(row => row.consumedInputIds ?? [])
    expect(acceptedInputs.every(input => !oldTurnConsumed.includes(input.inputId))).toBe(true)
    const promoted = await pool!.query<{ id: string; targetTurnId: string; status: string; consumedByStepId: string | null }>(
      `SELECT "id", "targetTurnId", "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "acceptedSequence", "id"`,
      [acceptedInputs.map(input => input.inputId)],
    )
    expect(promoted.rows).toHaveLength(3)
    const firstSuccessorId = promoted.rows[0]?.targetTurnId
    if (!firstSuccessorId || firstSuccessorId === followUpIds.turnId) throw new Error("Oldest follow-up was not promoted to a successor")
    turnFixtureIds.add(firstSuccessorId)
    expect(promoted.rows.map(row => row.id)).toEqual(acceptedInputs.map(input => input.inputId))
    expect(promoted.rows.map(row => row.targetTurnId)).toEqual([firstSuccessorId, followUpIds.turnId, followUpIds.turnId])
    expect(promoted.rows.map(row => row.status)).toEqual(["accepted", "accepted", "accepted"])
    expect(promoted.rows.every(row => row.consumedByStepId === null)).toBe(true)

    const initialSuccessors = await pool!.query<{ id: string; status: string; source: string }>(
      `SELECT "id", "status", "source" FROM "agent_turns" WHERE "sessionId" = $1 ORDER BY "createdAt", "id"`, [followUpIds.sessionId],
    )
    expect(initialSuccessors.rows).toHaveLength(2)
    expect(initialSuccessors.rows.find(turn => turn.id === followUpIds.turnId)).toMatchObject({ status: "completed" })
    expect(initialSuccessors.rows.find(turn => turn.id === firstSuccessorId)).toMatchObject({ status: "queued", source: "user" })
    const firstDispatch = await pool!.query<{ id: string; aggregateId: string; attemptCount: number; publishedAt: Date | null; payload: unknown }>(
      `SELECT "id", "aggregateId", "attemptCount", "publishedAt", "payload"
       FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`,
      [`turn-dispatch:${firstSuccessorId}`],
    )
    expect(firstDispatch.rows).toHaveLength(1)
    expect(firstDispatch.rows[0]).toMatchObject({ aggregateId: followUpIds.sessionId, payload: {
      turnId: firstSuccessorId, sessionId: followUpIds.sessionId, ownerId: `web:${firstSuccessorId}`,
    } })
    const untouchedForeign = await pool!.query<{ id: string; sessionId: string; userId: string; targetTurnId: string; status: string }>(
      `SELECT "id", "sessionId", "userId", "targetTurnId", "status" FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [foreignInputs.map(input => input.id)],
    )
    expect(untouchedForeign.rows).toEqual([
      expect.objectContaining({ id: foreignInputs[1]!.id, sessionId: foreignSessionId, userId: followUpIds.userId, targetTurnId: followUpIds.turnId, status: "accepted" }),
      expect.objectContaining({ id: foreignInputs[0]!.id, sessionId: followUpIds.sessionId, userId: foreignUserId, targetTurnId: followUpIds.turnId, status: "accepted" }),
    ])

    commandAcceptance = startWorker("replay-active-terminal", followUpIds)
    await waitForLine(commandAcceptance, "TERMINAL_REPLAY_OK")
    await waitForExit(commandAcceptance, { stage: "active-follow-up-terminal-replay", pid: commandAcceptance.pid })
    expect(commandAcceptance.exitCode).toBe(0)
    const terminalReplayState = await pool!.query<{ turnCount: string; dispatchCount: string; completedEventCount: string }>(
      `SELECT (SELECT COUNT(*)::text FROM "agent_turns" WHERE "sessionId" = $1) AS "turnCount",
         (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2) AS "dispatchCount",
         (SELECT COUNT(*)::text FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $3 AND "idempotencyKey" = $4) AS "completedEventCount"`,
      [followUpIds.sessionId, `turn-dispatch:${firstSuccessorId}`, followUpIds.turnId, `turn:${followUpIds.turnId}:event:turn-completed`],
    )
    expect(terminalReplayState.rows[0]).toEqual({ turnCount: "2", dispatchCount: "1", completedEventCount: "1" })

    const { recoverTurnQueue } = await import("../runtime/turns/recovery-scanner.js")
    await recoverTurnQueue(pool!, turnQueue!, `fixture-follow-up-recovery-${suffix}`)
    await recoverTurnQueue(pool!, turnQueue!, `fixture-follow-up-recovery-replay-${suffix}`)
    const firstWakeup = await waitForWakeupDispatch(pool!, turnQueue!, { ...followUpIds, turnId: firstSuccessorId }, turnJobKey!)
    expect(firstWakeup.dispatchBeforeRestart.rows).toHaveLength(1)
    expect(firstWakeup.dispatchBeforeRestart.rows[0]).toMatchObject({ attemptCount: 1, publishedAt: expect.any(Date) })
    expect(firstWakeup.wakeupJob?.id).toBe(turnJobKey!(firstSuccessorId, 0))
    const firstGenerationJobs = await Promise.all([0, 1, 2].map(generation => turnQueue!.getJob(turnJobKey!(firstSuccessorId, generation))))
    expect(firstGenerationJobs.filter(Boolean)).toHaveLength(1)
    const afterDispatchRecovery = await pool!.query<{ turnCount: string; dispatchCount: string }>(
      `SELECT (SELECT COUNT(*)::text FROM "agent_turns" WHERE "sessionId" = $1) AS "turnCount",
         (SELECT COUNT(*)::text FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2) AS "dispatchCount"`,
      [followUpIds.sessionId, `turn-dispatch:${firstSuccessorId}`],
    )
    expect(afterDispatchRecovery.rows[0]).toEqual({ turnCount: "2", dispatchCount: "1" })

    await turnQueue!.resume()
    turnQueuePaused = false
    expect(await turnQueue!.isPaused()).toBe(false)
    let activeSuccessorId = firstSuccessorId
    for (let index = 0; index < acceptedInputs.length; index += 1) {
      await waitForSuccessorProvider(pool!, turnQueue!, workerTwo, activeSuccessorId, index + 1, turnJobKey!(activeSuccessorId, 0))
      await turnQueue!.pause()
      turnQueuePaused = true
      workerTwo.stdin?.write(`release-successor-${index + 1}\n`)
      await waitForTurnStatus(pool!, activeSuccessorId, "completed", 20_000, workerTwo)

      const consumedInput = acceptedInputs[index]!
      const consumed = await pool!.query<{ status: string; consumedByStepId: string | null; targetTurnId: string }>(
        `SELECT "status", "consumedByStepId", "targetTurnId" FROM "agent_inputs" WHERE "id" = $1`, [consumedInput.inputId],
      )
      expect(consumed.rows[0]).toMatchObject({ status: "consumed", targetTurnId: activeSuccessorId })
      expect(consumed.rows[0]?.consumedByStepId).toBeTruthy()
      const claimingSteps = await pool!.query<{ id: string; consumedInputIds: string[] }>(
        `SELECT "id", "consumedInputIds" FROM "agent_steps" WHERE "turnId" = $1 ORDER BY "ordinal"`, [activeSuccessorId],
      )
      const claimingStepsForInput = claimingSteps.rows.filter(step => (step.consumedInputIds ?? []).includes(consumedInput.inputId))
      const claimCount = claimingSteps.rows.reduce((total, step) => total + (step.consumedInputIds ?? []).filter(inputId => inputId === consumedInput.inputId).length, 0)
      expect(claimCount).toBe(1)
      expect(claimingStepsForInput).toHaveLength(1)
      expect(consumed.rows[0]?.consumedByStepId).toBe(claimingStepsForInput[0]?.id)
      const currentDispatch = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS "count" FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`,
        [`turn-dispatch:${activeSuccessorId}`],
      )
      expect(currentDispatch.rows[0]?.count).toBe("1")

      const nextInput = acceptedInputs[index + 1]
      if (nextInput) {
        const next = await pool!.query<{ targetTurnId: string; status: string }>(
          `SELECT "targetTurnId", "status" FROM "agent_inputs" WHERE "id" = $1`, [nextInput.inputId],
        )
        const nextSuccessorId = next.rows[0]?.targetTurnId
        if (!nextSuccessorId || nextSuccessorId === followUpIds.turnId || nextSuccessorId === activeSuccessorId) {
          throw new Error(`Next FIFO follow-up ${nextInput.inputId} was not assigned its own successor`)
        }
        turnFixtureIds.add(nextSuccessorId)
        expect(next.rows[0]).toMatchObject({ status: "accepted", targetTurnId: nextSuccessorId })
        const successorRow = await pool!.query<{ status: string; count: string }>(
          `SELECT turn."status", (SELECT COUNT(*)::text FROM "agent_turns" WHERE "sessionId" = turn."sessionId" AND "status" = 'queued') AS "count"
           FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2`, [nextSuccessorId, followUpIds.sessionId],
        )
        expect(successorRow.rows[0]).toMatchObject({ status: "queued", count: "1" })
        const remaining = await pool!.query<{ id: string; targetTurnId: string; status: string }>(
          `SELECT "id", "targetTurnId", "status" FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "acceptedSequence", "id"`,
          [acceptedInputs.slice(index + 1).map(input => input.inputId)],
        )
        expect(remaining.rows[0]).toMatchObject({ id: nextInput.inputId, targetTurnId: nextSuccessorId, status: "accepted" })
        expect(remaining.rows.slice(1).map(row => row.targetTurnId)).toEqual(remaining.rows.slice(1).map(() => followUpIds.turnId))
        await recoverTurnQueue(pool!, turnQueue!, `fixture-follow-up-recovery-${suffix}-${index}`)
        await recoverTurnQueue(pool!, turnQueue!, `fixture-follow-up-recovery-replay-${suffix}-${index}`)
        const nextWakeup = await waitForWakeupDispatch(pool!, turnQueue!, { ...followUpIds, turnId: nextSuccessorId }, turnJobKey!)
        expect(nextWakeup.dispatchBeforeRestart.rows).toHaveLength(1)
        expect(nextWakeup.dispatchBeforeRestart.rows[0]).toMatchObject({ attemptCount: 1, publishedAt: expect.any(Date) })
        const nextGenerationJobs = await Promise.all([0, 1, 2].map(generation => turnQueue!.getJob(turnJobKey!(nextSuccessorId, generation))))
        expect(nextGenerationJobs.filter(Boolean)).toHaveLength(1)
        activeSuccessorId = nextSuccessorId
        await turnQueue!.resume()
        turnQueuePaused = false
      }
    }

    const finalInputs = await pool!.query<{ id: string; status: string; targetTurnId: string; consumedByStepId: string | null }>(
      `SELECT "id", "status", "targetTurnId", "consumedByStepId" FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "acceptedSequence", "id"`,
      [acceptedInputs.map(input => input.inputId)],
    )
    expect(finalInputs.rows).toHaveLength(3)
    expect(finalInputs.rows.map(input => input.status)).toEqual(["consumed", "consumed", "consumed"])
    expect(finalInputs.rows.map(input => input.targetTurnId)).not.toContain(followUpIds.turnId)
    expect(finalInputs.rows.every(input => Boolean(input.consumedByStepId))).toBe(true)
    const completedSession = await pool!.query<{ turnCount: string; queuedCount: string; completedCount: string }>(
      `SELECT COUNT(*)::text AS "turnCount", COUNT(*) FILTER (WHERE "status" = 'queued')::text AS "queuedCount",
         COUNT(*) FILTER (WHERE "status" = 'completed')::text AS "completedCount" FROM "agent_turns" WHERE "sessionId" = $1`,
      [followUpIds.sessionId],
    )
    expect(completedSession.rows[0]).toEqual({ turnCount: "4", queuedCount: "0", completedCount: "4" })
    const finalForeign = await pool!.query<{ id: string; targetTurnId: string; status: string }>(
      `SELECT "id", "targetTurnId", "status" FROM "agent_inputs" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [foreignInputs.map(input => input.id)],
    )
    expect(finalForeign.rows.every(input => input.targetTurnId === followUpIds.turnId && input.status === "accepted")).toBe(true)

    workerTwo.stdin?.write("shutdown\n")
    await waitForLine(workerTwo, "SHUTDOWN_STAGE bootstrap_close:complete", 10_000)
    await waitForExit(workerTwo, { stage: "active-follow-up-worker2-after-shutdown", pid: workerTwo.pid })
    expect(workerTwo.exitCode).toBe(0)
    if (turnQueuePaused) {
      await turnQueue!.resume()
      turnQueuePaused = false
    }
    await pool!.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [[followUpIds.sessionId, foreignSessionId]])
    await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [foreignUserId])
  }, 60_000)

  it("starts a successor when terminal commit owns the Session lock before follow-up acceptance", async () => {
    const suffix = randomUUID()
    const raceIds: FixtureIds = {
      suffix,
      userId: ids.userId,
      sessionId: `terminal-follow-up-race-session-${suffix}`,
      turnId: `terminal-follow-up-race-pending-${suffix}`,
    }
    fixtureSessionIds.add(raceIds.sessionId)
    await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Resume and report persisted child result', 'running', 'test', CURRENT_TIMESTAMP)`, [raceIds.sessionId, raceIds.userId])

    commandAcceptance = startWorker("accept-message", raceIds)
    const startedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
    await waitForExit(commandAcceptance, { stage: "terminal-race-start-turn", pid: commandAcceptance.pid })
    expect(commandAcceptance.exitCode).toBe(0)
    const started = parseCommandAcceptance(startedLine)
    expect(started.accepted.disposition).toBe("started")
    raceIds.turnId = started.accepted.turnId
    turnFixtureIds.add(raceIds.turnId)

    workerOne = startWorker("park-active-follow-up", raceIds)
    await waitForLine(workerOne, "FIRST_PROVIDER_ACTIVE")
    workerOne.stdin?.write("release-first-provider\n")
    await waitForLine(workerOne, "FINAL_PROVIDER_ACTIVE")
    const active = await pool!.query<{ rootTaskId: string | null }>(`SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1`, [raceIds.turnId])
    if (!active.rows[0]?.rootTaskId) throw new Error(`Turn ${raceIds.turnId} has no root task`)

    const rootLock = await pool!.connect()
    let lockTransactionOpen = false
    try {
      await rootLock.query("BEGIN")
      lockTransactionOpen = true
      const lockedRoot = await rootLock.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 FOR UPDATE`, [active.rows[0].rootTaskId])
      expect(lockedRoot.rows).toHaveLength(1)
      workerOne.stdin?.write("release-pending-follow-up-provider\n")
      await waitForLockWait(pool!, `SELECT "id", "status", "leaseOwner"`)

      expect(await turnQueue!.isPaused()).toBe(false)
      await turnQueue!.pause()
      turnQueuePaused = true
      expect(await turnQueue!.isPaused()).toBe(true)

      commandAcceptance = startWorker("accept-active-follow-up", raceIds)
      await waitForLockWait(pool!, `AND "status" NOT IN ('aborted', 'archived')`)
      await rootLock.query("COMMIT")
      lockTransactionOpen = false

      await waitForTurnStatus(pool!, raceIds.turnId, "completed", 20_000, workerOne)
      const oldTerminalReceipt = await pool!.query<{
        finalResponse: string | null; completedEventCount: string; finalItemCount: string
      }>(`SELECT turn."finalResponse"::text AS "finalResponse",
          (SELECT COUNT(*)::text FROM "agent_events" AS event WHERE event."sessionId" = turn."sessionId" AND event."turnId" = turn."id" AND event."idempotencyKey" = $2) AS "completedEventCount",
          (SELECT COUNT(*)::text FROM "agent_items" AS item WHERE item."sessionId" = turn."sessionId" AND item."turnId" = turn."id" AND item."type" = 'agent_message') AS "finalItemCount"
        FROM "agent_turns" AS turn WHERE turn."id" = $1`,
      [raceIds.turnId, `turn:${raceIds.turnId}:event:turn-completed`])
      expect(oldTerminalReceipt.rows[0]).toMatchObject({ completedEventCount: "1", finalItemCount: "1" })
      expect(oldTerminalReceipt.rows[0]?.finalResponse).toContain(FINAL_MARKER)

      const acceptedLine = await waitForLine(commandAcceptance, "COMMAND_ACCEPTED ")
      await waitForExit(commandAcceptance, { stage: "terminal-race-follow-up-acceptance", pid: commandAcceptance.pid })
      expect(commandAcceptance.exitCode).toBe(0)
      const accepted = parseCommandAcceptance(acceptedLine)
      turnFixtureIds.add(accepted.accepted.turnId)
      expect(accepted.accepted.disposition).toBe("started")
      expect(accepted.accepted.turnId).not.toBe(raceIds.turnId)
      expect(accepted.duplicate).toMatchObject({
        inputId: accepted.accepted.inputId,
        turnId: accepted.accepted.turnId,
        disposition: "duplicate",
        originalDisposition: "started",
      })

      const successor = await pool!.query<{
        sessionStatus: string; oldTurnStatus: string; successorStatus: string; targetTurnId: string; delivery: string; inputStatus: string
      }>(`SELECT session."status" AS "sessionStatus", oldTurn."status" AS "oldTurnStatus", successor."status" AS "successorStatus",
          input."targetTurnId", input."delivery", input."status" AS "inputStatus"
        FROM "agent_inputs" AS input
        JOIN "agent_sessions" AS session ON session."id" = input."sessionId"
        JOIN "agent_turns" AS oldTurn ON oldTurn."id" = $2 AND oldTurn."sessionId" = input."sessionId"
        JOIN "agent_turns" AS successor ON successor."id" = input."targetTurnId" AND successor."sessionId" = input."sessionId"
        WHERE input."id" = $1`, [accepted.accepted.inputId, raceIds.turnId])
      expect(successor.rows[0]).toMatchObject({
        sessionStatus: "running",
        oldTurnStatus: "completed",
        successorStatus: "queued",
        targetTurnId: accepted.accepted.turnId,
        delivery: "follow_up",
        inputStatus: "accepted",
      })

      workerOne.stdin?.write("shutdown\n")
      await waitForLine(workerOne, "SHUTDOWN_STAGE bootstrap_close:complete", 10_000)
      await waitForExit(workerOne, { stage: "terminal-race-worker-shutdown", pid: workerOne.pid })
      expect(workerOne.exitCode).toBe(0)
    } finally {
      if (lockTransactionOpen) await rootLock.query("ROLLBACK").catch(() => undefined)
      rootLock.release()
      const cleanupFailures: string[] = []
      for (const [workerName, child] of [["terminal-race-command-acceptance", commandAcceptance], ["terminal-race-worker", workerOne]] as const) {
        if (!child || workerHasExited(child)) continue
        try {
          const cleanupFailure = await stopWorkerForCleanup(child, workerName)
          if (cleanupFailure) cleanupFailures.push(cleanupFailure)
        } catch (error: unknown) {
          cleanupFailures.push(`${workerName} cleanup threw: ${cleanupError(error)}`)
        }
      }
      try {
        const sessionTurns = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_turns" WHERE "sessionId" = $1`, [raceIds.sessionId])
        for (const turn of sessionTurns.rows) turnFixtureIds.add(turn.id)
      } catch (error: unknown) {
        cleanupFailures.push(`terminal-race Turn cleanup discovery failed: ${cleanupError(error)}`)
      }
      const workersStopped = [commandAcceptance, workerOne, workerTwo].every(child => !child || workerHasExited(child))
      if (turnQueuePaused && turnQueue) {
        if (workersStopped) {
          try {
            await turnQueue.resume()
            turnQueuePaused = false
          } catch (error: unknown) {
            cleanupFailures.push(`terminal-race Turn queue resume failed: ${cleanupError(error)}`)
          }
        } else cleanupFailures.push("terminal-race Turn queue left paused because a child Worker is still alive")
      }
      if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("\n"))
    }
    await pool!.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [raceIds.sessionId])
  }, 60_000)

  it("repairs a published legacy Turn dispatch and rearms one deterministic retry generation", async () => {
    const suffix = randomUUID()
    const sessionId = `legacy-recovery-session-${suffix}`
    const turnId = `legacy-recovery-turn-${suffix}`
    const dispatchId = `legacy-recovery-dispatch-${suffix}`
    const foreignUserId = `legacy-recovery-foreign-user-${suffix}`
    const foreignTurnId = `legacy-recovery-foreign-turn-${suffix}`
    const foreignIdempotencyKey = `turn-dispatch:${foreignTurnId}`
    const idempotencyKey = `turn-dispatch:${turnId}`
    const legacyPayload = { turnId, sessionId, ownerId: "legacy-owner" }
    const foreignPayload = { turnId: foreignTurnId, sessionId, ownerId: "foreign-owner" }
    const publishedAt = new Date(Date.now() - 120_000)
    const recoveredAt = new Date()
    const retryGeneration = 5
    const retryJobId = turnJobKey!(turnId, retryGeneration)
    const generationJobIds = Array.from({ length: retryGeneration + 1 }, (_, generation) => turnJobKey!(turnId, generation))
    const recoveryQueue = new Queue(`agent-turn-recovery-${suffix}`, { connection: redis!, skipVersionCheck: true })
    const recovery = await import("../runtime/turns/recovery-scanner.js")
    fixtureSessionIds.add(sessionId)
    auxiliaryUserIds.add(foreignUserId)

    try {
      await recoveryQueue.waitUntilReady()
      await pool!.query(
        `INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
         VALUES ($1, $2, 'Repair a published legacy dispatch', 'running', 'test', CURRENT_TIMESTAMP)`,
        [sessionId, ids.userId],
      )
      await pool!.query(
        `INSERT INTO "agent_turns" (
           "id", "sessionId", "userId", "status", "source", "input",
           "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
           "leaseOwnerId", "leaseStartedAt", "leaseExpiresAt", "leaseVersion", "updatedAt"
         ) VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
           'expired-legacy-owner', $4, $5, 7, $5)`,
        [turnId, sessionId, ids.userId, new Date(recoveredAt.getTime() - 180_000), new Date(recoveredAt.getTime() - 60_000)],
      )
      await pool!.query(
        `INSERT INTO "agent_outbox" (
           "id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "attemptCount"
         ) VALUES ($1, 'agent.turn.dispatch', $2, $3, $4::jsonb, $5, 4)`,
        [dispatchId, turnId, idempotencyKey, JSON.stringify(legacyPayload), publishedAt],
      )
      await pool!.query(
        `INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        [foreignUserId, `${foreignUserId}@example.invalid`],
      )
      await pool!.query(
        `INSERT INTO "agent_turns" (
           "id", "sessionId", "userId", "status", "source", "input",
           "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt"
         ) VALUES ($1, $2, $3, 'completed', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [foreignTurnId, sessionId, foreignUserId],
      )
      await pool!.query(
        `INSERT INTO "agent_outbox" (
           "id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "attemptCount"
         ) VALUES ($1, 'agent.turn.dispatch', $2, $3, $4::jsonb, $5, 2)`,
        [`${dispatchId}-foreign`, foreignTurnId, foreignIdempotencyKey, JSON.stringify(foreignPayload), publishedAt],
      )

      // Hold every row the repair locks so SKIP LOCKED behavior is exercised deterministically.
      const blocker = await pool!.connect()
      try {
        await blocker.query("BEGIN")
        const locked = await blocker.query(
          `SELECT dispatch."id"
           FROM "agent_sessions" AS session
           JOIN "agent_turns" AS turn ON turn."sessionId" = session."id" AND turn."userId" = session."userId"
           JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = turn."id"
           WHERE session."id" = $1 AND turn."id" = $2 AND dispatch."id" = $3
           FOR UPDATE OF session, turn, dispatch`,
          [sessionId, turnId, dispatchId],
        )
        expect(locked.rows).toHaveLength(1)
        await expect(recovery.repairLegacyTurnDispatchAggregates(pool!, 50)).resolves.toBe(0)
        await blocker.query("COMMIT")
      } catch (error: unknown) {
        await blocker.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally {
        blocker.release()
      }

      await expect(recovery.repairLegacyTurnDispatchAggregates(pool!, 50)).resolves.toBe(1)
      const canonicalized = await pool!.query<{
        id: string
        topic: string
        aggregateId: string
        idempotencyKey: string
        payload: unknown
        publishedAt: Date | null
        attemptCount: number
      }>(
        `SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "attemptCount"
         FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
        [idempotencyKey],
      )
      expect(canonicalized.rows).toHaveLength(1)
      expect(canonicalized.rows[0]).toMatchObject({
        id: dispatchId,
        topic: "agent.turn.dispatch",
        aggregateId: sessionId,
        idempotencyKey,
        payload: legacyPayload,
        attemptCount: 4,
      })
      expect(canonicalized.rows[0]?.publishedAt?.getTime()).toBe(publishedAt.getTime())
      const foreignLineage = await pool!.query<{ aggregateId: string; publishedAt: Date | null; attemptCount: number; payload: unknown }>(
        `SELECT "aggregateId", "publishedAt", "attemptCount", "payload"
         FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
        [foreignIdempotencyKey],
      )
      expect(foreignLineage.rows).toHaveLength(1)
      expect(foreignLineage.rows[0]).toMatchObject({
        aggregateId: foreignTurnId,
        publishedAt,
        attemptCount: 2,
        payload: foreignPayload,
      })
      await expect(recovery.repairLegacyTurnDispatchAggregates(pool!, 50)).resolves.toBe(0)

      const report = await recovery.recoverTurnQueue(pool!, recoveryQueue, "legacy-recovery-owner", recoveredAt)
      expect(report).toMatchObject({ reclaimed: 1, dispatched: 1 })
      const retryJob = await recoveryQueue.getJob(retryJobId)
      expect(retryJob?.id).toBe(retryJobId)
      expect(retryJob?.data).toEqual({ turnId, sessionId, ownerId: "legacy-recovery-owner" })
      expect(retryJob?.opts.attempts).toBe(5)
      const presentGenerations = (await Promise.all(generationJobIds.map(async jobId =>
        (await recoveryQueue.getJob(jobId)) ? jobId : null,
      ))).filter((jobId): jobId is string => jobId !== null)
      expect(presentGenerations).toEqual([retryJobId])

      const rearmed = await pool!.query<{
        id: string
        topic: string
        aggregateId: string
        idempotencyKey: string
        payload: unknown
        publishedAt: Date | null
        attemptCount: number
      }>(
        `SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt", "attemptCount"
         FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
        [idempotencyKey],
      )
      expect(rearmed.rows).toHaveLength(1)
      expect(rearmed.rows[0]).toMatchObject({
        id: dispatchId,
        topic: "agent.turn.dispatch",
        aggregateId: sessionId,
        idempotencyKey,
        payload: { turnId, sessionId, ownerId: "legacy-recovery-owner" },
        attemptCount: retryGeneration + 1,
        publishedAt: expect.any(Date),
      })
    } finally {
      for (const jobId of generationJobIds) {
        await recoveryQueue.getJob(jobId).then(job => job?.remove()).catch(() => undefined)
      }
      await recoveryQueue.close()
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "idempotencyKey" = ANY($1::text[])`, [[idempotencyKey, foreignIdempotencyKey]])
      await pool!.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [foreignUserId])
    }
  }, 20_000)
})
