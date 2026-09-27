import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import { PLAN_LEDGER_SCHEMA_VERSION, parsePlanLedger, projectPlanLedger } from "@jobcopilot/agent-protocol"

import type { ProductionAgentFlags } from "../production-agent-flags.js"
import type { ProductionWorkerBootstrap } from "../../queue/production-bootstrap.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import { executionOwnerFence } from "../execution-owner.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { drainTaskGraphStopOutbox, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const PLAN_CALL_ID = "p3-resume-plan"
const WAIT_CALL_ID = "p3-resume-wait"
const FOLLOW_UP_PLAN_CALL_ID = "p3-resume-follow-up-plan"
const FOLLOW_UP_WAIT_CALL_ID = "p3-resume-follow-up-wait"
const RESTART_FOLLOW_UP_GOAL = "Verify the restored TaskGraph summary after restart"
const RESTART_FOLLOW_UP_KEY = "verification"
const RESULT_PREFIX = "p3-task-graph-child-result"
const FOLLOW_UP_GOAL = "Verify the completed summary with a follow-up check"
const OVERSIZED_SOURCE_GOAL = "Complete with an oversized structured summary"
const REJECTED_DEPENDENT_GOAL = "Must be cancelled when dependency evidence is oversized"
const FINAL_MARKER = "p3-task-graph-resumed-with-current-graph"
const FAILURE_PLAN_CALL_ID = "p3-failure-plan"
const FAILURE_WAIT_CALL_ID = "p3-failure-wait"
const FAILURE_GOAL = "Read a source and report a terminal failure"
const BLOCKED_GOAL = "Summarize only after the source succeeds"
const FAILURE_FINAL_MARKER = "p3-failed-prerequisite-cancelled-descendant"
const SOURCE_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "source", role: "scout", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
    candidates: [{ jobId: "fixture-job-1", source: "other", evidenceKinds: ["job"] }],
  },
} as const
const SUMMARY_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "summary", role: "analyst", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
    findings: [{ jobId: "fixture-job-1", score: 8, evidenceKinds: ["job"] }],
  },
} as const
const planLedgerTraceArtifactPath = process.env.AGENT_PLAN_LEDGER_TRACE_ARTIFACT_PATH

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
  ) throw new Error("TaskGraph resume integration requires the dedicated disposable CI PostgreSQL service URL")
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
  ) throw new Error("TaskGraph resume integration accepts only the dedicated disposable CI Redis DB 15 URL")
  return value
}

const databaseUrl = dedicatedDatabaseUrl()
const redisUrl = dedicatedRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type Fixture = { userId: string; sessionId: string; turnId: string; ownerId: string; suffix: string }
type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    suffix,
    userId: `p3-task-graph-resume-user-${suffix}`,
    sessionId: `p3-task-graph-resume-session-${suffix}`,
    turnId: `p3-task-graph-resume-turn-${suffix}`,
    ownerId: `p3-task-graph-resume-owner-${suffix}`,
  }
}

async function seed(pool: Pool, value: Fixture, turnStatus: "queued" | "waiting_for_user" = "queued"): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Resume after a TaskGraph dependency completes', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, $4, 'user', $5::jsonb, $6::jsonb, '{}'::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId,
    value.sessionId,
    value.userId,
    turnStatus,
    JSON.stringify({ goal: "Research and summarize the fixture source" }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }),
    JSON.stringify({ limits: { maxSteps: 8, maxToolCalls: 8 } }),
  ])
}

async function activateFixtureTurn(pool: Pool, value: Fixture): Promise<void> {
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [
    value.turnId, value.sessionId, value.userId,
  ])
  if (activated.rowCount !== 1) throw new Error("TaskGraph fixture turn was not parked before activation")
}

function toolResult(request: HarnessModelRequest, callId: string): unknown {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "tool_result" || part.toolUseId !== callId || typeof part.content !== "string") continue
      try { return JSON.parse(part.content) as unknown } catch { return null }
    }
  }
  return null
}

function planTaskIds(request: HarnessModelRequest, callId = PLAN_CALL_ID, expectedCount = 2): string[] {
  const output = record(toolResult(request, callId))
  if (!output || output.status !== "accepted" || !Array.isArray(output.nodes)) throw new Error("TaskGraph plan receipt missing from the next root model request")
  const ids = output.nodes.flatMap(value => {
    const node = record(value)
    return node && typeof node.taskId === "string" ? [node.taskId] : []
  })
  if (ids.length !== expectedCount) throw new Error(`Expected ${expectedCount} planned task ID(s); received ${ids.length}`)
  return ids
}

function waitOutcomeFromRequest(request: HarnessModelRequest, taskCount: number): RecordValue & { tasks: unknown[] } {
  const outcomes = request.messages.flatMap(message => message.content.flatMap(part => {
    if (part.type !== "tool_result" || !part.toolUseId.startsWith("wait:") || typeof part.content !== "string") return []
    try {
      const outcome = record(JSON.parse(part.content) as unknown)
      return outcome && Array.isArray(outcome.tasks) && outcome.tasks.length === taskCount ? [outcome] : []
    } catch { return [] }
  }))
  const outcome = outcomes[0]
  if (!outcome) throw new Error(`Expected a hydrated wait result with ${taskCount} child task(s)`)
  if (Buffer.byteLength(JSON.stringify(outcome), "utf8") > 8 * 1024) throw new Error("Hydrated child wait result exceeded its byte limit")
  return outcome as RecordValue & { tasks: unknown[] }
}

function currentGraphFromRequest(request: HarnessModelRequest): RecordValue | null {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
      const json = part.text.slice(part.text.indexOf("\n") + 1)
      try { return record(JSON.parse(json) as unknown) } catch { return null }
    }
  }
  return null
}

type ProcessFixtureChild = ChildProcess & { output: string[]; errors: string[] }
const processRestartFixturePath = fileURLToPath(new URL("./task-graph-resume-process-restart.fixture.mjs", import.meta.url))
const processRestartWorkerCwd = fileURLToPath(new URL("../../../", import.meta.url))

function startTaskGraphRestartWorker(mode: "park-parent" | "resume-parent", value: Record<string, unknown>): ProcessFixtureChild {
  const child = spawn(process.execPath, ["--import", "tsx", processRestartFixturePath, mode, JSON.stringify(value)], {
    cwd: processRestartWorkerCwd,
    env: { ...process.env, REDIS_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl! },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ProcessFixtureChild
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

function processFixtureDiagnostics(child: ProcessFixtureChild): string {
  return "pid=" + child.pid + " exitCode=" + child.exitCode + " signalCode=" + child.signalCode
    + " stdout=" + child.output.join(" | ") + " stderr=" + child.errors.join(" | ")
}

async function waitForProcessLine(child: ProcessFixtureChild, prefix: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = child.output.find(value => value.startsWith(prefix))
    if (line) return line
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Worker exited before " + prefix + "; " + processFixtureDiagnostics(child))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for " + prefix + "; " + processFixtureDiagnostics(child))
}

function waitForProcessExit(child: ProcessFixtureChild, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onExit = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once("exit", onExit)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup()
      resolve()
      return
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error("Worker process did not exit; " + processFixtureDiagnostics(child)))
    }, timeoutMs)
  })
}

function processFixtureExited(child: ProcessFixtureChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function killProcessFixture(child: ProcessFixtureChild, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (processFixtureExited(child)) return
  const exited = waitForProcessExit(child)
  if (!child.kill(signal)) throw new Error("Worker process kill was rejected; " + processFixtureDiagnostics(child))
  await exited
}

async function stopProcessFixture(child: ProcessFixtureChild): Promise<void> {
  if (processFixtureExited(child)) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
    }
    return
  }
  const exited = waitForProcessExit(child, 5_000)
  child.stdin?.write("shutdown\n")
  try {
    await exited
  } catch (gracefulError) {
    try {
      await killProcessFixture(child)
    } catch (forcedError) {
      throw new Error("Worker cleanup failed; graceful=" + String(gracefulError) + "; forced=" + String(forcedError))
    }
    throw new Error("Worker required forced termination during cleanup; graceful=" + String(gracefulError)
      + "; " + processFixtureDiagnostics(child))
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
  }
}

function structuredChildResult(role: "scout" | "analyst", summary: string): RecordValue {
  const jobId = "fixture-job-1"
  const evidence = [{ id: "fixture-job-evidence", kind: "job", ref: jobId, source: "fixture" }]
  const structuredResult = role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId, source: "fixture", url: null, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId, score: 8, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "fixture-final-item", finalText: summary, structuredResult }
}

async function waitForSuspendedParent(pool: Pool, turnId: string, minimumWaitCount = 1, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ turnStatus: string; waitStatus: string | null; suspendedAt: Date | null; waitCount: string }>(
      `SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt",
         (SELECT COUNT(*)::text FROM "agent_wait_conditions" AS all_waits
          WHERE all_waits."turnId" = turn."id" AND all_waits."parentTaskId" = turn."rootTaskId") AS "waitCount"
       FROM "agent_turns" AS turn LEFT JOIN "agent_wait_conditions" AS wait
         ON wait."turnId" = turn."id" AND wait."parentTaskId" = turn."rootTaskId"
       WHERE turn."id" = $1 ORDER BY wait."createdAt" DESC LIMIT 1`,
      [turnId],
    )
    const row = result.rows[0]
    if (row?.turnStatus === "waiting_for_dependency" && row.waitStatus === "waiting" && row.suspendedAt
      && Number(row.waitCount) >= minimumWaitCount) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("TaskGraph parent wait was not durably suspended before child completion")
}

async function turnProgressDiagnostics(pool: Pool, turnId: string, diagnosticToolCallId?: string): Promise<string> {
  const turnResult = await pool.query<{
    id: string
    sessionId: string
    status: string
    error: string | null
    rootTaskId: string | null
    revision: number
    leaseOwnerId: string | null
    leaseVersion: number
    leaseExpiresAt: Date | null
  }>(`SELECT "id", "sessionId", "status", "error", "rootTaskId", "revision", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
    FROM "agent_turns" WHERE "id" = $1`, [turnId])
  const turn = turnResult.rows[0]
  if (!turn) return JSON.stringify({ turnId, missing: true })

  const [tasks, waits, events, dispatches] = await Promise.all([
    pool.query<{
      id: string; goal: string; status: string; failureReason: string | null; attemptCount: number
      leaseOwner: string | null; leaseExpiresAt: Date | null
    }>(`SELECT "id", "goal", "status", "failureReason", "attemptCount", "leaseOwner", "leaseExpiresAt"
      FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      id: string; idempotencyKey: string; status: string; targetTaskIds: unknown; matchedTaskIds: unknown
      deadlineAt: Date; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
    }>(`SELECT "id", "idempotencyKey", "status", "targetTaskIds", "matchedTaskIds", "deadlineAt", "suspendedAt", "resolvedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      sequence: string; type: string; actor: string; taskId: string | null; idempotencyKey: string | null; payload: unknown
    }>(`SELECT "sequence"::text, "type", "actor", "taskId", "idempotencyKey", "payload"
      FROM "agent_events" WHERE "turnId" = $1 ORDER BY "sequence" DESC LIMIT 20`, [turnId]),
    pool.query<{
      topic: string; idempotencyKey: string; publishedAt: Date | null; attemptCount: number; lastError: string | null
    }>(`SELECT "topic", "idempotencyKey", "publishedAt", "attemptCount", "lastError"
      FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "createdAt" DESC LIMIT 30`, [turn.sessionId]),
  ])
  const toolResults = diagnosticToolCallId
    ? await pool.query<{ errorCode: string | null; failureDetail: string | null }>(
      `SELECT "content"->>'errorCode' AS "errorCode", "content"->'output'->>'message' AS "failureDetail"
        FROM "agent_items"
        WHERE "turnId" = $1 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2
        ORDER BY "createdAt", "id"`,
      [turnId, diagnosticToolCallId],
    )
    : null
  const toolFailure = toolResults?.rows.find(row => typeof row.failureDetail === "string" && row.failureDetail.length > 0)
    ?? toolResults?.rows[0]
  const recentEvents = events.rows.map(({ payload, ...event }) => {
    const value = record(payload)
    if (!diagnosticToolCallId || value?.toolCallId !== diagnosticToolCallId || value.status !== "failed") return event
    return {
      ...event,
      failure: {
        errorCode: typeof toolFailure?.errorCode === "string" ? toolFailure.errorCode.slice(0, 128) : null,
        failureDetail: typeof toolFailure?.failureDetail === "string" && toolFailure.failureDetail.length > 0
          ? toolFailure.failureDetail.slice(0, 500)
          : "not persisted",
      },
    }
  })
  return JSON.stringify({ turn, tasks: tasks.rows, waits: waits.rows, recentEvents, recentOutbox: dispatches.rows })
}

async function waitForTurnStatus(pool: Pool, turnId: string, wanted: string, timeoutMs = 50_000, diagnosticToolCallId?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string; error: string | null }>(
      `SELECT "status", "error" FROM "agent_turns" WHERE "id" = $1`, [turnId],
    )
    const status = result.rows[0]?.status
    if (status === wanted) return
    if (status && ["failed", "interrupted", "cancelled"].includes(status)) {
      throw new Error(`TaskGraph root turn entered ${status}; error=${result.rows[0]?.error ?? "<none>"}; progress=${await turnProgressDiagnostics(pool, turnId, diagnosticToolCallId)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`TaskGraph root turn did not reach ${wanted}; progress=${await turnProgressDiagnostics(pool, turnId)}`)
}

async function waitForPersistedTaskWait(pool: Pool, turnId: string, idempotencyKey: string, timeoutMs = 20_000): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string; status: string; suspendedAt: Date | null }>(
      `SELECT "id", "status", "suspendedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "idempotencyKey" = $2`,
      [turnId, idempotencyKey],
    )
    const row = result.rows[0]
    if (row?.status === "waiting" && row.suspendedAt instanceof Date) return { id: row.id }
    if (row?.status === "ready") throw new Error("Follow-up child completed before its durable parent wait suspended")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Follow-up parent wait was not durably suspended")
}

describeWithServices("production TaskGraph lifecycle and root resume (disposable PostgreSQL + Redis)", () => {
  const owner = fixture()
  const failureOwner = fixture()
  const stopOwner = fixture()
  const restartOwner = fixture()
  let pool: Pool | undefined
  let redis: Redis | undefined
  let bootstrap: ProductionWorkerBootstrap | undefined
  let turnQueueName: string | undefined
  let childQueueName: string | undefined

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 })
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
      connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await redis.ping()
    vi.doMock("../../redis.js", () => ({
      redisConnection: redis,
      redisCommandConnection: redis,
      closeSharedRedisConnections: async () => undefined,
    }))
    // Each production bootstrap runs database-wide turn recovery; keep inactive fixtures out of its queue scan.
    await seed(pool, owner)
    await seed(pool, failureOwner, "waiting_for_user")
    await seed(pool, stopOwner, "waiting_for_user")
    await seed(pool, restartOwner, "waiting_for_user")
  }, 15_000)

  afterEach(async () => {
    if (bootstrap) await bootstrap.close()
    bootstrap = undefined
  })

  afterAll(async () => {
    const cleanupFailures: string[] = []
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try { await action() } catch (error: unknown) {
        cleanupFailures.push(label + ": " + (error instanceof Error ? error.stack ?? error.message : String(error)))
      }
    }
    await attempt("bootstrap close", async () => { await bootstrap?.close() })
    if (pool) for (const current of [owner, failureOwner, stopOwner, restartOwner]) {
      await attempt("delete outbox for " + current.sessionId, () => pool!.query(
        "DELETE FROM \"agent_outbox\" WHERE \"aggregateId\" = $1", [current.sessionId],
      ))
      await attempt("delete user " + current.userId, () => pool!.query(
        "DELETE FROM \"User\" WHERE \"id\" = $1", [current.userId],
      ))
    }
    if (redis && turnQueueName && childQueueName) {
      const queueSpecs = [
        { name: turnQueueName, label: "turn queue" },
        { name: childQueueName, label: "subagent queue" },
      ]
      const queues: Array<{ name: string; label: string; queue: Queue }> = []
      for (const spec of queueSpecs) {
        await attempt("create " + spec.label, async () => {
          queues.push({ ...spec, queue: new Queue(spec.name, { connection: redis!, skipVersionCheck: true }) })
        })
      }
      for (const currentQueue of queues) {
        const { queue, label } = currentQueue
        await attempt("wait for " + label, () => queue.waitUntilReady())
        let jobs: Awaited<ReturnType<typeof queue.getJobs>> = []
        await attempt("list jobs from " + label, async () => {
          jobs = await queue.getJobs(["completed", "failed", "waiting", "delayed", "paused", "waiting-children", "active"])
        })
        for (const job of jobs) {
          if ([owner, failureOwner, stopOwner, restartOwner].some(current => job.data?.turnId === current.turnId || job.data?.sessionId === current.sessionId)) {
            await attempt("remove " + label + " job " + job.id, () => job.remove())
          }
        }
        await attempt("close " + label, () => queue.close())
      }
    }
    await attempt("PostgreSQL pool close", async () => { await pool?.end() })
    if (redis && redis.status !== "end") await attempt("Redis connection close", async () => {
      try { await redis!.quit() } catch (error: unknown) { redis!.disconnect(); throw error }
    })
    vi.doUnmock("../../redis.js")
    if (cleanupFailures.length > 0) throw new Error("TaskGraph integration cleanup failed:\n" + cleanupFailures.join("\n"))
  })

  it("plans, waits, promotes dependencies, resumes with bounded evidence, appends a follow-up plan, and resumes again", async () => {
    const [
      { createProductionWorkerBootstrap },
      { enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId, taskGraphProposalKey },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      cognitiveLoopEnabled: false,
      planningEnabled: true,
      planningExecutionEnabled: true,
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let resumedGraphReachedModel = false
    let followUpGraphReachedModel = false
    let followUpExpectedRevision: number | undefined
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: owner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        ...TASK_GRAPH_TEMPLATES,
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 2) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "rejected"])
              expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled"])
              expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal"])
              const largeSourceProjection = nodes.find(node => node?.key === "large-source")?.resultProjection
              expect(largeSourceProjection).toMatchObject({
                trust: "untrusted", availability: "available", role: "scout", status: "completed",
                candidateCount: 1, evidenceCount: 1,
                candidates: [{ jobId: "fixture-job-1", source: "other", evidenceKinds: ["job"] }],
              })
              expect(JSON.stringify(largeSourceProjection)).not.toContain("x".repeat(100))
              resumedGraphReachedModel = true
              const waitOutcome = waitOutcomeFromRequest(request, 4)
              const waitTasks = waitOutcome.tasks.map(record)
              expect(waitOutcome.status).toBe("ready")
              expect(waitTasks.map(task => task?.status)).toEqual(["completed", "completed", "completed", "cancelled"])
              expect(waitTasks.slice(0, 2).map(task => record(record(task?.result)?.structuredResult)?.summary)).toEqual([
                "Read the fixture source", "Summarize the fixture source",
              ])
              if (modelRounds === 1) {
                const revision = graph?.revision
                if (typeof revision !== "number" || !Number.isSafeInteger(revision)) throw new Error("Resumed current graph revision is invalid")
                followUpExpectedRevision = revision
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_PLAN_CALL_ID, name: "agent.plan",
                  arguments: {
                    expectedRevision: followUpExpectedRevision,
                    nodes: [{
                      key: "verification", templateId: "analyst", goal: FOLLOW_UP_GOAL,
                      successCriteria: ["Verify the completed summary evidence"], dependsOn: ["summary"],
                    }],
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (modelRounds === 2) {
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_WAIT_CALL_ID, name: "agent.wait",
                  arguments: {
                    idempotencyKey: `p3-task-graph-follow-up-wait:${owner.turnId}`,
                    taskIds: planTaskIds(request, FOLLOW_UP_PLAN_CALL_ID, 1), mode: "all", timeoutMs: 20_000,
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              throw new Error("Unexpected model round before the follow-up TaskGraph wait")
            }
            if (execution === 3) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "rejected", "verification"])
              expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "completed", "cancelled", "completed"])
              expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"])
              followUpGraphReachedModel = true
              const waitOutcome = waitOutcomeFromRequest(request, 1)
              const waitTasks = waitOutcome.tasks.map(record)
              expect(waitOutcome.status).toBe("ready")
              expect(waitTasks.map(task => task?.status)).toEqual(["completed"])
              expect(record(record(waitTasks[0]?.result)?.structuredResult)?.summary).toBe(FOLLOW_UP_GOAL)
              yield { type: "text_delta", text: FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            if (execution === 1 && modelRounds === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "source", templateId: "scout", goal: "Read the fixture source", successCriteria: ["Capture source evidence"], dependsOn: [] },
                    { key: "summary", templateId: "analyst", goal: "Summarize the fixture source", successCriteria: ["Write a source summary"], dependsOn: ["source"] },
                    { key: "large-source", templateId: "scout", goal: OVERSIZED_SOURCE_GOAL, successCriteria: ["Return structured source evidence"], dependsOn: [] },
                    { key: "rejected", templateId: "analyst", goal: REJECTED_DEPENDENT_GOAL, successCriteria: ["Never dispatch oversized evidence"], dependsOn: ["large-source"] },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              yield {
                type: "tool_call_completed", callId: WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-wait:${owner.turnId}`,
                  taskIds: planTaskIds(request, PLAN_CALL_ID, 4), mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            throw new Error("Unexpected root model execution or round in the TaskGraph resume fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: owner.ownerId,
      turnRecoveryIntervalMs: 60_000,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-wait-resolver-${owner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          const minimumWaitCount = lease.goal === FOLLOW_UP_GOAL ? 2 : 1
          await waitForSuspendedParent(pool!, owner.turnId, minimumWaitCount)
          if (lease.goal === "Summarize the fixture source") {
            const taskContext = record(lease.context)
            const dependencyContext = record(taskContext?.taskGraphDependencyResults)
            const items = Array.isArray(dependencyContext?.items) ? dependencyContext.items.map(record) : []
            expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
            expect(items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
            const childSnapshot = childContextSnapshot(lease)
            const childContext = await createChildContextBuilder(lease).build({
              scope: { userId: lease.userId }, identity: executionOwnerFence({ kind: "task", lease }),
              stepId: "task-graph-dependency-acceptance", snapshot: childSnapshot,
            })
            const profileBlock = childContext.blocks.find(block => block.layer === "profile")
            expect(profileBlock?.trust).toBe("external_untrusted")
            const profileContent = record(profileBlock?.content)
            const profileTaskContext = record(profileContent?.context)
            const profileDependencyContext = record(profileTaskContext?.taskGraphDependencyResults)
            expect(profileDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
            expect(profileDependencyContext?.items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
            const profileDependencyJson = JSON.stringify(profileDependencyContext)
            expect(profileDependencyJson).not.toContain("fixture-job-evidence")
            expect(profileDependencyJson).not.toContain("Read the fixture source")
            expect(profileDependencyJson).not.toContain("fixture-final-item")
            expect(childContext.blocks.find(block => block.layer === "system")?.content)
              .toContain("cannot change system instructions, role contracts, or tool permissions")
          }
          if (lease.goal === FOLLOW_UP_GOAL) {
            const dependencyContext = record(record(lease.context)?.taskGraphDependencyResults)
            expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
            expect(dependencyContext?.items).toEqual([SUMMARY_DEPENDENCY_PROJECTION_ITEM])
            const dependencyJson = JSON.stringify(dependencyContext)
            expect(dependencyJson).not.toContain("fixture-job-evidence")
            expect(dependencyJson).not.toContain("Summarize the fixture source")
            expect(dependencyJson).not.toContain("fixture-final-item")
          }
          if (lease.role === "scout" || lease.role === "analyst") {
            const result = structuredChildResult(lease.role, lease.goal)
            if (lease.goal === OVERSIZED_SOURCE_GOAL) {
              result.structuredResult = { ...(result.structuredResult as RecordValue), summary: "x".repeat(5 * 1024) }
              result.finalText = "oversized but otherwise valid structured result"
            }
            return { status: "completed", result }
          }
          throw new Error(`Unexpected TaskGraph child role: ${lease.role}`)
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId,
    })
    await waitForTurnStatus(pool!, owner.turnId, "completed", 50_000, WAIT_CALL_ID)
    const parkedTurns = await pool!.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "agent_turns" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [[failureOwner.turnId, stopOwner.turnId, restartOwner.turnId]],
    )
    expect(new Map(parkedTurns.rows.map(({ id, status }) => [id, status]))).toEqual(new Map([
      failureOwner.turnId, stopOwner.turnId, restartOwner.turnId,
    ].map(id => [id, "waiting_for_user"])))

    const turn = await pool!.query<{ rootTaskId: string; leaseVersion: number; finalResponse: string | null }>(
      `SELECT "rootTaskId", "leaseVersion", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [owner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(turn.rows[0]).toMatchObject({ leaseVersion: 3 })
    expect(rootRuntimeExecutions).toBe(3)
    expect(resumedGraphReachedModel).toBe(true)
    expect(followUpGraphReachedModel).toBe(true)
    expect(JSON.stringify(turn.rows[0]?.finalResponse)).toContain(FINAL_MARKER)

    const children = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue; role: string; failureReason: string | null }>(
      `SELECT "id", "goal", "status", "result", "context", "role", "failureReason" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "goal"`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(5)
    const childByGoal = new Map(children.rows.map(child => [child.goal, child] as const))
    expect(childByGoal.get("Read the fixture source")).toMatchObject({ status: "completed", role: "scout" })
    expect(record(childByGoal.get("Read the fixture source")?.result?.structuredResult)?.candidates).toMatchObject([{ jobId: "fixture-job-1" }])
    expect(childByGoal.get("Summarize the fixture source")).toMatchObject({ status: "completed", role: "analyst" })
    expect(record(childByGoal.get("Summarize the fixture source")?.result?.structuredResult)?.findings).toMatchObject([{ jobId: "fixture-job-1", score: 8 }])
    expect(childByGoal.get(FOLLOW_UP_GOAL)).toMatchObject({ status: "completed", role: "analyst" })
    expect(childByGoal.get(OVERSIZED_SOURCE_GOAL)).toMatchObject({ status: "completed", role: "scout" })
    expect(Buffer.byteLength(JSON.stringify(childByGoal.get(OVERSIZED_SOURCE_GOAL)?.result ?? {}), "utf8")).toBeGreaterThan(2 * 1024)
    expect(childByGoal.get(REJECTED_DEPENDENT_GOAL)).toMatchObject({
      status: "cancelled", failureReason: "Prerequisite results could not be safely materialized.",
    })
    const summarizeDependencyContext = record(childByGoal.get("Summarize the fixture source")?.context.taskGraphDependencyResults)
    expect(summarizeDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expect(summarizeDependencyContext?.items).toEqual([SOURCE_DEPENDENCY_PROJECTION_ITEM])
    const summarizeDependencyJson = JSON.stringify(summarizeDependencyContext)
    expect(summarizeDependencyJson).not.toContain("fixture-job-evidence")
    expect(summarizeDependencyJson).not.toContain("Read the fixture source")
    expect(summarizeDependencyJson).not.toContain("fixture-final-item")

    const followUpDependencyContext = record(childByGoal.get(FOLLOW_UP_GOAL)?.context.taskGraphDependencyResults)
    expect(followUpDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expect(followUpDependencyContext?.items).toEqual([SUMMARY_DEPENDENCY_PROJECTION_ITEM])
    const followUpDependencyJson = JSON.stringify(followUpDependencyContext)
    expect(followUpDependencyJson).not.toContain("fixture-job-evidence")
    expect(followUpDependencyJson).not.toContain("Summarize the fixture source")
    expect(followUpDependencyJson).not.toContain("fixture-final-item")
    const childDispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' ORDER BY "createdAt"`,
      [owner.sessionId],
    )
    expect(childDispatches.rows).toHaveLength(4)
    expect(childDispatches.rows.map(row => row.payload.taskId)).toEqual(expect.arrayContaining(
      children.rows.filter(child => child.status === "completed").map(child => child.id),
    ))
    expect(childDispatches.rows.map(row => row.payload.taskId)).not.toContain(childByGoal.get(REJECTED_DEPENDENT_GOAL)?.id)
    expect(childDispatches.rows.every(row => row.publishedAt instanceof Date)).toBe(true)

    const item = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(item.rows[0]?.revision).toBeGreaterThanOrEqual(6)
    const graphEvents = await pool!.query<{ idempotencyKey: string; payload: RecordValue }>(
      `SELECT "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`,
      [owner.sessionId, owner.turnId, taskGraphItemId(rootTaskId!)],
    )
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, 0))).toBe(true)
    expect(followUpExpectedRevision).toEqual(expect.any(Number))
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, followUpExpectedRevision!))).toBe(true)
    const lifecycleTypes = graphEvents.rows.flatMap(event => {
      const payload = record(event.payload)
      const lifecycle = record(payload?.event)
      return payload?.kind === "lifecycle" && typeof lifecycle?.type === "string" ? [lifecycle.type] : []
    })
    expect(lifecycleTypes).toEqual(expect.arrayContaining(["task.started", "task.queued", "task.completed"]))

    const wait = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; matchedTaskIds: string[] }>(
      `SELECT "id", "status", "suspendedAt", "consumedAt", "matchedTaskIds" FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt" ASC`,
      [owner.turnId],
    )
    expect(wait.rows).toHaveLength(2)
    expect(wait.rows.every(row => row.status === "ready" && row.suspendedAt instanceof Date && row.consumedAt instanceof Date)).toBe(true)
    expect(wait.rows.map(row => row.matchedTaskIds.length)).toEqual([2, 1])
    for (const row of wait.rows) {
      const wakeEvents = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
        [owner.sessionId, `agent-wait:${row.id}:resumed`],
      )
      expect(wakeEvents.rows[0]?.count).toBe("1")
    }
    const wakeDispatch = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2`,
      [owner.sessionId, `turn-dispatch:${owner.turnId}`],
    )
    expect(wakeDispatch.rows).toHaveLength(1)
    expect(wakeDispatch.rows[0]).toMatchObject({
      idempotencyKey: `turn-dispatch:${owner.turnId}`,
      publishedAt: expect.any(Date),
      payload: { turnId: owner.turnId, sessionId: owner.sessionId },
    })
  }, 90_000)

  it("restores the TaskGraph after a real Worker restart and completes a follow-up plan", async () => {
    if (planLedgerTraceArtifactPath) await rm(planLedgerTraceArtifactPath, { force: true })
    const [turnModule, subagentModule] = await Promise.all([
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
    ])
    turnQueueName = turnModule.TURN_QUEUE_NAME
    childQueueName = subagentModule.SUBAGENT_QUEUE_NAME
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    try {
      await activateFixtureTurn(pool!, restartOwner)
      workerOne = startTaskGraphRestartWorker("park-parent", restartOwner)
      const suspendedLine = await waitForProcessLine(workerOne, "P3_PARENT_SUSPENDED ")
      if (workerOne.pid === undefined) throw new Error("P3 first Worker has no OS process ID")
      expect(suspendedLine).toContain("p3-process-restart-worker-" + workerOne.pid)

      const beforeTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number; rootTaskId: string | null }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\", \"rootTaskId\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(beforeTurn.rows[0]).toMatchObject({
        status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1,
      })
      const rootTaskId = beforeTurn.rows[0]?.rootTaskId
      expect(rootTaskId).toBeTruthy()

      const graphBefore = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphBefore.rows).toHaveLength(1)
      const graphSnapshot = record(graphBefore.rows[0]?.content)
      const graphNodes = Array.isArray(graphSnapshot?.nodes) ? graphSnapshot.nodes.map(record) : []
      expect(graphSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphNodes.map(node => node?.key)).toEqual(["source", "summary"])
      expect(graphBefore.rows[0]?.revision).toBeGreaterThan(0)

      const waitsBefore = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitsBefore.rows).toHaveLength(1)
      expect(waitsBefore.rows[0]).toMatchObject({ status: "waiting", consumedAt: null })
      expect(waitsBefore.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const targetTaskIds = Array.isArray(waitsBefore.rows[0]?.targetTaskIds)
        ? waitsBefore.rows[0]?.targetTaskIds as string[]
        : JSON.parse(String(waitsBefore.rows[0]?.targetTaskIds)) as string[]
      expect(targetTaskIds).toHaveLength(2)
      const pendingTasks = await pool!.query<{ goal: string; status: string }>(
        "SELECT \"goal\", \"status\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(pendingTasks.rows).toEqual([
        { goal: "Read the durable TaskGraph source", status: "queued" },
        { goal: "Summarize the restored TaskGraph source", status: "waiting" },
      ])

      const firstWorkerPid = workerOne.pid
      const firstExit = waitForProcessExit(workerOne)
      const killAccepted = workerOne.kill("SIGKILL")
      await firstExit
      expect(killAccepted).toBe(true)
      expect(workerOne.signalCode).toBe("SIGKILL")
      expect(workerOne.exitCode).toBeNull()

      const afterKillTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(afterKillTurn.rows[0]).toEqual({ status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1 })
      const graphAfterKill = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterKill.rows).toEqual(graphBefore.rows)
      const waitAfterKill = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitAfterKill.rows).toEqual(waitsBefore.rows)

      workerTwo = startTaskGraphRestartWorker("resume-parent", {
        ...restartOwner,
        expectedRevision: graphBefore.rows[0]!.revision,
        expectedSnapshot: graphSnapshot,
      })
      expect(workerTwo.pid).not.toBe(firstWorkerPid)
      const readyLine = await waitForProcessLine(workerTwo, "P3_SECOND_WORKER_READY ")
      expect(readyLine).toContain("p3-process-restart-worker-" + workerTwo.pid)
      try {
        await waitForProcessLine(workerTwo, "P3_DEPENDENCY_CONTEXT_OK")
      } catch (error) {
        const children = await pool!.query<{ goal: string; status: string; failureReason: string | null; dependencies: unknown }>(
          `SELECT "goal", "status", "failureReason", "context"->'taskGraphDependencyResults' AS "dependencies"
           FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt"`, [restartOwner.turnId],
        )
        throw new Error(`${String(error)}; restartProgress=${await turnProgressDiagnostics(pool!, restartOwner.turnId)}; childContexts=${JSON.stringify(children.rows)}`)
      }
      await waitForProcessLine(workerTwo, "P3_RESTORED_GRAPH_OK")
      await waitForProcessLine(workerTwo, "P3_PARENT_RESUME_CONTEXT_OK")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK")
      const persistedFollowUpWait = await waitForPersistedTaskWait(
        pool!, restartOwner.turnId, "p3-process-restart-follow-up-wait:" + restartOwner.turnId,
      )
      expect(persistedFollowUpWait.id).toBeTruthy()
      workerTwo.stdin?.write("complete-follow-up-child\n")
      const followUpReadyLine = await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_READY ")

      const preFinalGraph = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalGraph.rows).toHaveLength(1)
      const preFinalSnapshot = record(preFinalGraph.rows[0]?.content)
      const preFinalNodes = Array.isArray(preFinalSnapshot?.nodes) ? preFinalSnapshot.nodes.map(record) : []
      expect(preFinalNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      const preFinalFollowUpId = preFinalNodes[2]?.taskId
      expect(typeof preFinalFollowUpId).toBe("string")
      expect(followUpReadyLine).toContain(String(preFinalFollowUpId))

      const preFinalChildResult = await pool!.query<{ status: string; role: string; result: RecordValue | null; context: RecordValue | null }>(
        "SELECT \"status\", \"role\", \"result\", \"context\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"rootTaskId\" = $4 AND \"parentTaskId\" = $4",
        [preFinalFollowUpId, restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalChildResult.rows[0]).toMatchObject({ status: "completed", role: "analyst" })
      expect(JSON.stringify(preFinalChildResult.rows[0]?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const preFinalContext = record(record(preFinalChildResult.rows[0]?.context)?.taskGraphDependencyResults)
      const preFinalDependencies = Array.isArray(preFinalContext?.items) ? preFinalContext.items.map(record) : []
      expect(preFinalDependencies[0]).toMatchObject({ dependencyKey: "summary", role: "analyst", taskStatus: "completed" })
      expect(record(preFinalDependencies[0]?.result)).toMatchObject({ availability: "available", role: "analyst" })

      const preFinalEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
        "SELECT \"taskId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, preFinalGraph.rows[0]!.id],
      )
      const preFinalProposal = preFinalEvents.rows.find(event => {
        const payload = record(event.payload)
        const receipt = record(payload?.receipt)
        const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes.map(record) : []
        return payload?.kind === "proposal" && receiptNodes.some(node => node?.key === RESTART_FOLLOW_UP_KEY && node.taskId === preFinalFollowUpId)
      })
      expect(record(record(preFinalProposal?.payload)?.receipt)).toMatchObject({
        status: "accepted", nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: preFinalFollowUpId, status: "queued" }],
      })
      expect(preFinalEvents.rows.some(event => event.taskId === preFinalFollowUpId
        && record(event.payload)?.kind === "lifecycle"
        && record(record(event.payload)?.event)?.type === "task.completed")).toBe(true)
      const preFinalWaits = await pool!.query<{ status: string; consumedAt: Date | null; targetTaskIds: unknown; result: unknown }>(
        "SELECT \"status\", \"consumedAt\", \"targetTaskIds\", \"result\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2",
        [restartOwner.turnId, rootTaskId],
      )
      const preFinalFollowUpWait = preFinalWaits.rows.find(row => {
        const ids = Array.isArray(row.targetTaskIds) ? row.targetTaskIds : JSON.parse(String(row.targetTaskIds)) as unknown[]
        return ids.includes(preFinalFollowUpId)
      })
      expect(preFinalFollowUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(JSON.stringify(preFinalFollowUpWait?.result)).toContain(RESTART_FOLLOW_UP_GOAL)

      workerTwo.stdin?.write("finalize-parent\n")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_OK ")
      await waitForTurnStatus(pool!, restartOwner.turnId, "completed", 60_000)

      const resumedTurn = await pool!.query<{ status: string; leaseVersion: number; rootTaskId: string | null; finalResponse: string | null }>(
        "SELECT \"status\", \"leaseVersion\", \"rootTaskId\", \"finalResponse\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(resumedTurn.rows[0]).toMatchObject({ status: "completed", leaseVersion: 3, rootTaskId })
      expect(resumedTurn.rows[0]?.finalResponse).toContain("p3-process-restart-parent-resumed-after-follow-up")

      const graphAfterResume = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterResume.rows).toHaveLength(1)
      expect(graphAfterResume.rows[0]?.id).toBe(graphBefore.rows[0]?.id)
      const graphAfterSnapshot = record(graphAfterResume.rows[0]?.content)
      const graphAfterNodes = Array.isArray(graphAfterSnapshot?.nodes) ? graphAfterSnapshot.nodes.map(record) : []
      expect(graphAfterSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphAfterNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      expect(graphAfterNodes.slice(0, 2)).toEqual(graphNodes)
      expect(graphAfterNodes[2]).toMatchObject({
        key: RESTART_FOLLOW_UP_KEY,
        templateId: "analyst",
        goal: RESTART_FOLLOW_UP_GOAL,
        successCriteria: ["Verify the restored summary evidence"],
        dependsOn: ["summary"],
        depth: 2,
      })
      expect(graphAfterResume.rows[0]?.revision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const resumedWaits = await pool!.query<{ id: string; status: string; consumedAt: Date | null; result: unknown; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"consumedAt\", \"result\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 ORDER BY \"createdAt\" ASC",
        [restartOwner.turnId],
      )
      expect(resumedWaits.rows).toHaveLength(2)
      const originalWaitAfterResume = resumedWaits.rows.find(row => row.id === waitsBefore.rows[0]?.id)
      expect(originalWaitAfterResume).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(JSON.stringify(originalWaitAfterResume?.result)).toContain("p3-process-restart-source-result")
      const followUpTaskId = graphAfterNodes[2]?.taskId
      expect(typeof followUpTaskId).toBe("string")
      const targetIds = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
        try {
          const parsed = JSON.parse(String(value)) as unknown
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
        } catch { return [] }
      }
      const followUpWait = resumedWaits.rows.find(row => targetIds(row.targetTaskIds).includes(String(followUpTaskId)))
      expect(followUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(followUpWait?.id).not.toBe(originalWaitAfterResume?.id)
      expect(JSON.stringify(followUpWait?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const childrenAfterResume = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue | null; role: string }>(
        "SELECT \"id\", \"goal\", \"status\", \"result\", \"context\", \"role\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(childrenAfterResume.rows.map(row => [row.goal, row.status])).toEqual([
        ["Read the durable TaskGraph source", "completed"],
        ["Summarize the restored TaskGraph source", "completed"],
        [RESTART_FOLLOW_UP_GOAL, "completed"],
      ])
      // Match Worker 2's projection query, including its root row and public goal.
      const persistedPlanLedgerTasks = await pool!.query<{ id: string; sessionId: string; status: string; role: string; goal: string; result: RecordValue | null; updatedAt: Date }>(
        `SELECT "id", "sessionId", "status", "role", "goal", "result", "updatedAt" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)`,
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(persistedPlanLedgerTasks.rows.map(row => row.id)).toContain(rootTaskId)
      const fixtureLedgerLine = await waitForProcessLine(workerTwo, "P3_PLAN_LEDGER_PROJECTION ")
      const fixtureLedger = parsePlanLedger(fixtureLedgerLine.slice("P3_PLAN_LEDGER_PROJECTION ".length))
      const persistedLedger = projectPlanLedger({
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        rootTaskId,
        graph: graphAfterResume.rows[0]!.content,
        tasks: persistedPlanLedgerTasks.rows,
      })
      expect(fixtureLedger).not.toBeNull()
      expect(persistedLedger).toEqual(fixtureLedger)
      expect(persistedLedger).toMatchObject({
        schemaVersion: PLAN_LEDGER_SCHEMA_VERSION,
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        nodes: [
          { key: "source", status: "completed", readiness: "terminal", evidencePreview: { role: "scout", itemCount: 1 } },
          { key: "summary", status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
          { key: RESTART_FOLLOW_UP_KEY, status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
        ],
      })
      const publicLedgerJson = JSON.stringify(persistedLedger)
      for (const secret of ["fixture-job-restart", "p3-process-restart-source-result", "p3-process-restart-final", "jobId", "score", "url", "task-graph.result-projection"]) {
        expect(publicLedgerJson).not.toContain(secret)
      }
      expect(parsePlanLedger(publicLedgerJson)).toEqual(persistedLedger)
      expect(JSON.stringify(childrenAfterResume.rows[0]?.result)).toContain("p3-process-restart-source-result")
      const followUpChild = childrenAfterResume.rows.find(row => row.id === followUpTaskId)
      expect(followUpChild).toMatchObject({ goal: RESTART_FOLLOW_UP_GOAL, status: "completed", role: "analyst" })
      expect(JSON.stringify(followUpChild?.result)).toContain(RESTART_FOLLOW_UP_GOAL)
      const followUpDependency = record(record(followUpChild?.context)?.taskGraphDependencyResults)
      const followUpDependencyItems = Array.isArray(followUpDependency?.items) ? followUpDependency.items.map(record) : []
      expect(followUpDependencyItems[0]).toMatchObject({
        dependencyKey: "summary",
        role: "analyst",
        taskStatus: "completed",
        result: {
          schemaVersion: "agent-harness.v2.task-graph.result-projection",
          trust: "untrusted",
          availability: "available",
          role: "analyst",
          findings: [{ jobId: "fixture-job-restart", score: 8, evidenceKinds: ["job"] }],
        },
      })
      const graphEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
        "SELECT \"taskId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, graphAfterResume.rows[0]!.id],
      )
      const proposalEvents = graphEvents.rows.filter(event => record(event.payload)?.kind === "proposal")
      expect(proposalEvents).toHaveLength(2)
      const followUpReceiptEvent = proposalEvents[1]!
      const followUpReceiptPayload = record(followUpReceiptEvent.payload)
      const followUpReceipt = record(followUpReceiptPayload?.receipt)
      expect(followUpReceipt).toMatchObject({
        status: "accepted",
        nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: followUpTaskId, status: "queued" }],
        readyTaskIds: [followUpTaskId],
      })
      const proposalKeyPrefix = graphAfterResume.rows[0]!.id + ":proposal:"
      expect(followUpReceiptEvent.idempotencyKey.startsWith(proposalKeyPrefix)).toBe(true)
      const expectedRevision = Number(followUpReceiptEvent.idempotencyKey.slice(proposalKeyPrefix.length))
      expect(Number.isSafeInteger(expectedRevision)).toBe(true)
      expect(followUpReceiptPayload?.revision).toBe(expectedRevision + 1)
      expect(expectedRevision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const followUpLifecycle = graphEvents.rows.flatMap(event => {
        if (event.taskId !== followUpTaskId) return []
        const payload = record(event.payload)
        const lifecycle = record(payload?.event)
        return payload?.kind === "lifecycle" && lifecycle?.nodeKey === RESTART_FOLLOW_UP_KEY
          && typeof lifecycle.type === "string" ? [lifecycle.type] : []
      })
      expect(followUpLifecycle).toEqual(expect.arrayContaining(["task.started", "task.completed"]))
      const resumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + waitsBefore.rows[0]!.id + ":resumed"],
      )
      expect(resumedEvents.rows[0]?.count).toBe("1")
      const followUpResumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + followUpWait?.id + ":resumed"],
      )
      expect(followUpResumedEvents.rows[0]?.count).toBe("1")
      if (planLedgerTraceArtifactPath) {
        expect(Buffer.byteLength(publicLedgerJson, "utf8")).toBeLessThanOrEqual(16_000)
        await writeFile(planLedgerTraceArtifactPath, publicLedgerJson, "utf8")
      }
    } finally {
      const teardownFailures: string[] = []
      if (workerOne && !processFixtureExited(workerOne)) {
        try { await killProcessFixture(workerOne) } catch (error) { teardownFailures.push("Worker 1: " + String(error)) }
      }
      if (workerTwo) {
        try { await stopProcessFixture(workerTwo) } catch (error) { teardownFailures.push("Worker 2: " + String(error)) }
      }
      if (teardownFailures.length > 0) throw new Error("P3 Worker process teardown failed:\n" + teardownFailures.join("\n"))
    }
  }, 240_000)

  it("cancels a dependent node after prerequisite failure without dispatching it", async () => {
    const [
      { createProductionWorkerBootstrap },
      { enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      cognitiveLoopEnabled: false,
      planningEnabled: true,
      planningExecutionEnabled: true,
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let descendantExecuted = false
    let resumedAfterFailure = false
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: failureOwner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        analyst: { role: "analyst", taskType: "research", allowedActions: ["jobs.search"] },
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-failure-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 1 && modelRounds === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: FAILURE_PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "prerequisite", templateId: "analyst", goal: FAILURE_GOAL, successCriteria: ["Record a terminal failure"], dependsOn: [] },
                    { key: "dependent", templateId: "analyst", goal: BLOCKED_GOAL, successCriteria: ["Do not execute after source failure"], dependsOn: ["prerequisite"] },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              yield {
                type: "tool_call_completed", callId: FAILURE_WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-failure-wait:${failureOwner.turnId}`,
                  taskIds: planTaskIds(request, FAILURE_PLAN_CALL_ID), mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && modelRounds === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([
                ["prerequisite", "failed"], ["dependent", "cancelled"],
              ])
              const outcome = waitOutcomeFromRequest(request, 2)
              expect(outcome.status).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status).sort()).toEqual(["cancelled", "failed"])
              resumedAfterFailure = true
              yield { type: "text_delta", text: FAILURE_FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error("Unexpected model execution or round in the failed-prerequisite fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    await activateFixtureTurn(pool!, failureOwner)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: failureOwner.ownerId,
      // The resume intent is durably queued by the wait resolver and delivered
      // by turn recovery; poll promptly so this acceptance does not outwait it.
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-failure-wait-resolver-${failureOwner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, failureOwner.turnId)
          if (lease.goal === FAILURE_GOAL) {
            return { status: "failed", failureReason: "Fixture prerequisite failed permanently.", retryDisposition: "terminal" }
          }
          if (lease.goal === BLOCKED_GOAL) descendantExecuted = true
          return { status: "completed", result: { proof: `unexpected execution: ${lease.goal}` } }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: failureOwner.turnId, sessionId: failureOwner.sessionId, ownerId: failureOwner.ownerId,
    })
    await waitForTurnStatus(pool!, failureOwner.turnId, "completed", 50_000, FAILURE_WAIT_CALL_ID)

    const turn = await pool!.query<{ rootTaskId: string; finalResponse: string | null }>(
      `SELECT "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [failureOwner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(rootRuntimeExecutions).toBe(2)
    expect(resumedAfterFailure).toBe(true)
    expect(descendantExecuted).toBe(false)
    expect(turn.rows[0]?.finalResponse).toContain(FAILURE_FINAL_MARKER)

    const children = await pool!.query<{ id: string; goal: string; status: string }>(
      `SELECT "id", "goal", "status" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "id"`,
      [failureOwner.sessionId, failureOwner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(2)
    const prerequisite = children.rows.find(child => child.goal === FAILURE_GOAL)
    const dependent = children.rows.find(child => child.goal === BLOCKED_GOAL)
    expect(prerequisite?.status).toBe("failed")
    expect(dependent?.status).toBe("cancelled")

    const graphItemId = taskGraphItemId(rootTaskId!)
    const cancellationEvidence = await pool!.query<{ itemId: string; taskId: string; payload: RecordValue }>(
      `SELECT "itemId", "taskId", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4`,
      [failureOwner.sessionId, failureOwner.turnId, graphItemId, dependent?.id],
    )
    expect(cancellationEvidence.rows).toHaveLength(1)
    expect(cancellationEvidence.rows[0]).toMatchObject({
      itemId: graphItemId,
      taskId: dependent?.id,
      payload: { kind: "lifecycle", event: { type: "task.cancelled", nodeKey: "dependent" } },
    })
    const descendantDispatch = await pool!.query(
      `SELECT 1 FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
       AND "idempotencyKey" = $2`,
      [failureOwner.sessionId, `subagent-dispatch:${dependent?.id}`],
    )
    expect(descendantDispatch.rowCount).toBe(0)
  }, 90_000)

  it("stops an exact TaskGraph Turn, projects interrupted receipts, and removes every unpublished graph dispatch", async () => {
    const { taskGraphItemId } = await import("./task-graph-snapshot.js")
    const rootTaskId = "p3-task-graph-stop-root-" + stopOwner.suffix
    const stepId = "p3-task-graph-stop-step-" + stopOwner.suffix
    const runningOwnerId = "p3-task-graph-stop-child-owner-" + stopOwner.suffix
    const now = new Date()
    const unrelatedTurnBefore = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnBefore.rowCount).toBe(1)
    await activateFixtureTurn(pool!, stopOwner)

    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Stop acceptance root',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
        1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [rootTaskId, stopOwner.sessionId, stopOwner.turnId, stopOwner.ownerId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [rootTaskId])
    const activeTurn = await pool!.query<{ revision: number }>(
      `UPDATE "agent_turns" SET "status" = 'in_progress', "rootTaskId" = $4, "leaseOwnerId" = $5,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "leaseStartedAt" = CURRENT_TIMESTAMP,
        "leaseVersion" = 1, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'queued'
       RETURNING "revision"`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, rootTaskId, stopOwner.ownerId],
    )
    expect(activeTurn.rowCount).toBe(1)
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [stepId, stopOwner.sessionId, stopOwner.turnId, rootTaskId])

    const commandPort = createPgTaskGraphCommandPort(pool!)
    const receipt = await commandPort.appendAndSchedule({
      scope: {
        userId: stopOwner.userId, sessionId: stopOwner.sessionId, turnId: stopOwner.turnId,
        rootTaskId, parentTaskId: rootTaskId, stepId,
        turnLeaseOwner: stopOwner.ownerId, turnLeaseVersion: 1,
        parentLeaseOwner: stopOwner.ownerId, parentAttemptCount: 1,
      },
      proposal: {
        expectedRevision: 0,
        nodes: [
          { key: "running", templateId: "analyst", goal: "Run until the Turn is stopped", successCriteria: ["Observe the Stop marker"], dependsOn: [] },
          { key: "pending-root", templateId: "analyst", goal: "Start a pending dependency chain", successCriteria: ["Remain queued"], dependsOn: [] },
          { key: "pending-child", templateId: "analyst", goal: "Wait for the chain root", successCriteria: ["Remain waiting"], dependsOn: ["pending-root"] },
          { key: "pending-grandchild", templateId: "analyst", goal: "Wait for the chain child", successCriteria: ["Remain waiting"], dependsOn: ["pending-child"] },
        ],
      },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    })
    expect(receipt.status).toBe("accepted")
    expect(receipt.nodes.map(node => [node.key, node.status])).toEqual([
      ["running", "queued"], ["pending-root", "queued"], ["pending-child", "waiting"], ["pending-grandchild", "waiting"],
    ])
    const graphTaskIds = receipt.nodes.map(node => node.taskId)
    const taskIdByKey = new Map(receipt.nodes.map(node => [node.key, node.taskId] as const))

    const subagents = new PgSubagentTaskStore(pool!)
    const runningTask = await subagents.claim({
      taskId: taskIdByKey.get("running")!, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now,
    })
    expect(runningTask).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: runningOwnerId })

    const unrelatedOutboxIds = [
      "p3-stop-unrelated-same-session-" + stopOwner.suffix,
      "p3-stop-unrelated-other-session-" + stopOwner.suffix,
    ]
    await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb), ($5, 'agent.subagent.dispatch', $6, $7, $8::jsonb)`,
    [
      unrelatedOutboxIds[0], stopOwner.sessionId, "subagent-dispatch:unrelated-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-" + stopOwner.suffix, sessionId: stopOwner.sessionId, rootTaskId, ownerId: "fixture-owner" }),
      unrelatedOutboxIds[1], owner.sessionId, "subagent-dispatch:unrelated-other-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-other-" + stopOwner.suffix, sessionId: owner.sessionId, rootTaskId: "other-root", ownerId: "fixture-owner" }),
    ])

    const client = await pool!.connect()
    const requestedAt = new Date()
    let priorTurnRevision = 0
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.user_id', $1, true)", [stopOwner.userId])
      const current = await client.query<{ revision: number }>(
        `SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
      )
      expect(current.rowCount).toBe(1)
      priorTurnRevision = Number(current.rows[0]?.revision)
      const interruptedTurn = await client.query(
        `UPDATE "agent_turns" SET "status" = 'interrupted', "revision" = "revision" + 1,
          "completedAt" = $5, "updatedAt" = $5
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
           AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
           AND "revision" = $4`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, priorTurnRevision, requestedAt],
      )
      expect(interruptedTurn.rowCount).toBe(1)
      const markedTasks = await client.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
        `UPDATE "sub_agent_tasks" AS task
         SET "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", $4),
             "status" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE task."status" END,
             "nextAttemptAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE task."nextAttemptAt" END,
             "completedAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE task."completedAt" END,
             "updatedAt" = $4
         WHERE task."sessionId" = $1 AND task."turnId" = $2
           AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
           AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = task."sessionId" AND session."userId" = $3)
           AND EXISTS (SELECT 1 FROM "agent_turns" AS turn
             WHERE turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = $3)
         RETURNING task."id", task."status", task."interruptRequestedAt"`,
        [stopOwner.sessionId, stopOwner.turnId, stopOwner.userId, requestedAt],
      )
      expect(markedTasks.rows).toHaveLength(graphTaskIds.length + 1)
      const stopIntent = await client.query<{ id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue }>(
        `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING
         RETURNING "id", "topic", "aggregateId", "idempotencyKey", "payload"`,
        [
          "task-graph-stop-" + stopOwner.turnId, TASK_GRAPH_STOP_OUTBOX_TOPIC, stopOwner.sessionId,
          "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
          JSON.stringify({ sessionId: stopOwner.sessionId, turnId: stopOwner.turnId }),
        ],
      )
      expect(stopIntent.rows).toEqual([{
        id: "task-graph-stop-" + stopOwner.turnId,
        topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
        aggregateId: stopOwner.sessionId,
        idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
        payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      }])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    expect(await drainTaskGraphStopOutbox(pool!, 10)).toBe(1)
    const stopIntentState = await pool!.query<{ topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue; publishedAt: Date | null }>(
      `SELECT "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt" FROM "agent_outbox"
       WHERE "id" = $1`,
      ["task-graph-stop-" + stopOwner.turnId],
    )
    expect(stopIntentState.rows[0]).toMatchObject({
      topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
      aggregateId: stopOwner.sessionId,
      idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
      payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      publishedAt: expect.any(Date),
    })

    expect(runningTask).not.toBeNull()
    await expect(subagents.heartbeat({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, now: new Date(),
    })).resolves.toBe("interrupted")
    await expect(subagents.finish({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, status: "completed", result: { proof: "stop marker observed" }, now: new Date(),
    })).resolves.toBe("interrupted")

    const turn = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
    )
    expect(turn.rows[0]).toEqual({ status: "interrupted", revision: priorTurnRevision + 1 })
    const stoppedTasks = await pool!.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
      `SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
       WHERE "id" = ANY($1::text[]) AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
       ORDER BY "id"`,
      [graphTaskIds, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(stoppedTasks.rows).toHaveLength(graphTaskIds.length)
    expect(stoppedTasks.rows.every(task => task.status === "interrupted" && task.interruptRequestedAt instanceof Date)).toBe(true)
    const rootMarker = await pool!.query<{ status: string; interruptRequestedAt: Date | null }>(
      `SELECT "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
      [rootTaskId, stopOwner.sessionId, stopOwner.turnId],
    )
    expect(rootMarker.rows[0]?.status).toBe("running")
    expect(rootMarker.rows[0]?.interruptRequestedAt).toBeInstanceOf(Date)
    const unrelatedTurnAfter = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnAfter.rows).toEqual(unrelatedTurnBefore.rows)

    const graphItemId = taskGraphItemId(rootTaskId)
    const graphItem = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
      [graphItemId, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(graphItem.rows[0]?.revision).toBe(receipt.revision + 1 + graphTaskIds.length)
    const graphEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
      `SELECT "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "type" = 'item.delta'
       ORDER BY "sequence" ASC`,
      [stopOwner.sessionId, stopOwner.turnId, graphItemId],
    )
    const interruptedReceipts = graphEvents.rows.flatMap(row => {
      const payload = record(row.payload)
      const event = record(payload?.event)
      return payload?.kind === "lifecycle" && event?.type === "task.interrupted"
        ? [{ taskId: row.taskId, idempotencyKey: row.idempotencyKey, revision: payload.revision, expectedRevision: event.expectedRevision, nodeKey: event.nodeKey }]
        : []
    })
    expect(interruptedReceipts).toHaveLength(graphTaskIds.length)
    expect(interruptedReceipts.map(receipt => receipt.nodeKey)).toEqual(["pending-root", "pending-child", "pending-grandchild", "running"])
    expect(interruptedReceipts.map(receipt => receipt.expectedRevision)).toEqual([
      receipt.revision + 1, receipt.revision + 2, receipt.revision + 3, receipt.revision + 4,
    ])
    expect(interruptedReceipts.map(receipt => receipt.revision)).toEqual([
      receipt.revision + 2, receipt.revision + 3, receipt.revision + 4, receipt.revision + 5,
    ])
    expect(interruptedReceipts.map(receipt => receipt.idempotencyKey)).toEqual([
      taskGraphLifecycleKey(rootTaskId, "pending-root", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-child", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-grandchild", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "running", 1, "task.interrupted"),
    ])

    const graphDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
       AND "aggregateId" = $1 AND "idempotencyKey" = ANY($2::text[]) AND "publishedAt" IS NULL`,
      [stopOwner.sessionId, graphTaskIds.map(taskId => "subagent-dispatch:" + taskId)],
    )
    expect(graphDispatches.rowCount).toBe(0)
    const unrelatedOutbox = await pool!.query<{ id: string; aggregateId: string; publishedAt: Date | null }>(
      `SELECT "id", "aggregateId", "publishedAt" FROM "agent_outbox" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [unrelatedOutboxIds],
    )
    expect(unrelatedOutbox.rows).toHaveLength(unrelatedOutboxIds.length)
    expect(unrelatedOutbox.rows.map(row => row.id)).toEqual([...unrelatedOutboxIds].sort())
    expect(unrelatedOutbox.rows.every(row => row.publishedAt === null)).toBe(true)
    const unrelatedAggregateById = new Map(unrelatedOutbox.rows.map(row => [row.id, row.aggregateId] as const))
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[0]!)).toBe(stopOwner.sessionId)
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[1]!)).toBe(owner.sessionId)
  }, 30_000)
})
