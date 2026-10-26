import { createHash, randomUUID } from "node:crypto"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { claimTurnLease } from "../turns/lease.js"
import { AgentTreeManager } from "./manager.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { startDurableWaitResolver } from "./durable-wait-resolver.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy } from "./types.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const ROLLBACK_TRIGGER = "task_graph_deadline_rollback_fixture"
const ROLLBACK_FUNCTION = "public.task_graph_deadline_rollback_fixture()"
function databaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("TaskGraph deadline integration requires the disposable CI PostgreSQL service")
  return value
}
function redisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379" || url.pathname !== "/15" || url.username || url.password || url.search || url.hash) {
    throw new Error("TaskGraph deadline integration accepts only disposable Redis DB 15")
  }
  return value
}
const pgUrl = databaseUrl()
const redisConnectionUrl = redisUrl()
const withServices = pgUrl && redisConnectionUrl && process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" ? describe : describe.skip
type Fixture = { userId: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string; suffix: string }
let pool: Pool | undefined
let redis: Redis | undefined
const fixtureUsers: string[] = []

async function poll<T>(read: () => Promise<T | null>, message: string): Promise<T> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const value = await read()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

function scanBarrier(source: Pool, participants: number): Pick<Pool, "connect"> {
  let arrived = 0
  let release!: () => void
  const allScanned = new Promise<void>(resolve => { release = resolve })
  return {
    async connect() {
      const client = await source.connect()
      const original = client.query.bind(client)
      client.query = (async (...args: Parameters<typeof client.query>) => {
        const result = await original(...args)
        const first = args[0] as unknown
        const sql = typeof first === "string" ? first
          : first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : ""
        if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('"absoluteDeadlineAt" <= clock_timestamp()')) {
          arrived += 1
          if (arrived === participants) release()
          await allScanned
        }
        return result
      }) as typeof client.query
      return client
    },
  }
}

function sessionLockBarrier(source: Pool, sessionId: string): {
  pool: Pick<Pool, "connect">; locked: Promise<void>; isHeld(): boolean; release(): void
} {
  let notifyLocked!: () => void
  let continueScan!: () => void
  let held = false
  const locked = new Promise<void>(resolve => { notifyLocked = resolve })
  const continueAfterLock = new Promise<void>(resolve => { continueScan = resolve })
  return {
    locked, isHeld: () => held, release: continueScan,
    pool: {
      async connect() {
        const client = await source.connect()
        const original = client.query.bind(client)
        client.query = (async (...args: Parameters<typeof client.query>) => {
          const result = await original(...args)
          const first = args[0] as unknown
          const sql = typeof first === "string" ? first
            : first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : ""
          const values = args[1] as unknown
          if (!held && sql.includes('SELECT "userId", "status" FROM "agent_sessions"')
            && Array.isArray(values) && values[0] === sessionId) {
            held = true
            notifyLocked()
            await continueAfterLock
          }
          return result
        }) as typeof client.query
        return client
      },
    },
  }
}

async function seed(pool: Pool): Promise<{ fixture: Fixture; children: Record<string, string> }> {
  const suffix = randomUUID()
  const value = {
    userId: `deadline-user-${suffix}`, sessionId: `deadline-session-${suffix}`,
    turnId: `deadline-turn-${suffix}`, rootTaskId: `deadline-root-${suffix}`,
    stepId: `deadline-step-${suffix}`, suffix,
  }
  fixtureUsers.push(value.userId)
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [value.userId, `${value.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'TaskGraph deadline recovery', 'running', 'test', CURRENT_TIMESTAMP)`, [value.sessionId, value.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "inputTokens", "outputTokens", "estimatedCostUsd", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 71, 19, 0.125, CURRENT_TIMESTAMP)`,
  [value.turnId, value.sessionId, value.userId])
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "path", "depth", "role", "taskType",
      "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, '/root', 0, 'orchestrator', 'root', 'running', 'TaskGraph deadline recovery',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":4,"maxDepth":4,"maxFanOut":4,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [value.rootTaskId, value.sessionId, value.turnId, `root-owner-${suffix}`])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = "id" WHERE "id" = $1`, [value.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1`, [value.turnId, value.rootTaskId])
  const lease = await claimTurnLease(pool, { turnId: value.turnId, sessionId: value.sessionId, ownerId: `turn-owner-${suffix}` })
  await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.stepId, value.sessionId, value.turnId, value.rootTaskId])
  const graph = await createPgTaskGraphCommandPort(pool).appendAndSchedule({
    scope: { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
      parentTaskId: value.rootTaskId, stepId: value.stepId, turnLeaseOwner: lease.ownerId,
      turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: `root-owner-${suffix}`, parentAttemptCount: 1 },
    proposal: { expectedRevision: 0, nodes: [
      { key: "paused", templateId: "analyst", goal: "Wait for a user decision", successCriteria: ["Wait"], dependsOn: [], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
      } },
      { key: "running", templateId: "analyst", goal: "Keep a running attempt", successCriteria: ["Finish once"], dependsOn: [], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
      } },
      { key: "dependent", templateId: "analyst", goal: "Wait for the prerequisite", successCriteria: ["Wait for proof"], dependsOn: ["paused"], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
      } },
    ] }, templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  })
  const ids = Object.fromEntries(graph.nodes.map(node => [node.key, node.taskId]))
  const tasks = new PgSubagentTaskStore(pool)
  const claim = async (key: string) => {
    const ownerId = `child-owner-${key}-${suffix}`
    const task = await tasks.claim({ taskId: ids[key]!, sessionId: value.sessionId, ownerId, policy: defaultSubagentPolicy(), now: new Date() })
    if (!task?.leaseOwner || !task.leaseExpiresAt) throw new Error(`deadline fixture could not claim ${key}`)
    return task
  }
  const paused = await claim("paused")
  const running = await claim("running")
  for (const [key, task] of [["paused", paused], ["running", running]] as const) {
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
        "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 0, $5, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [`deadline-child-step-${key}-${suffix}`, value.sessionId, value.turnId, task.id, task.attemptCount])
  }
  const pausedOwner = paused.leaseOwner!
  await tasks.finish({ taskId: paused.id, sessionId: value.sessionId, ownerId: pausedOwner,
    attemptCount: paused.attemptCount, status: "waiting_for_user", result: { status: "waiting_for_user", finalText: "Waiting" }, now: new Date() })
  const receiptJson = JSON.stringify({ receipt: "committed-before-deadline" })
  await pool.query(`INSERT INTO "agent_tool_result_references" ("id", "userId", "sessionId", "turnId", "stepId", "taskId",
      "toolCallId", "sanitizedJson", "sha256", "byteCount", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [`deadline-receipt-${suffix}`, value.userId, value.sessionId, value.turnId, `deadline-child-step-running-${suffix}`, running.id,
    `deadline-call-${suffix}`, receiptJson, createHash("sha256").update(receiptJson).digest("hex"), Buffer.byteLength(receiptJson)])
  await pool.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP
    WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
  [value.sessionId, `subagent-dispatch:${running.id}`])
  const waitPort = createPgDurableWaitPort(pool)
  await pool.query(`UPDATE "agent_steps" SET "status" = 'waiting_for_tool' WHERE "id" = $1`, [value.stepId])
  const wait = await waitPort.wait({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    taskId: value.rootTaskId, rootTaskId: value.rootTaskId, stepId: value.stepId,
    targetTaskIds: [paused.id, running.id], mode: "any", timeoutMs: 60_000, idempotencyKey: `deadline-wait-${suffix}` })
  await createPgRootTaskStore(pool).finish({ lease, rootTaskId: value.rootTaskId,
    result: { status: "waiting_for_dependency", stepCount: 1, toolCallCount: 1, waitId: wait.waitId } })
  await waitPort.suspendAndRelease({ lease, waitId: wait.waitId, now: new Date() })
  await pool.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() - INTERVAL '1 millisecond'
    WHERE "id" = ANY($1::text[]) AND "sessionId" = $2`, [[paused.id, running.id], value.sessionId])
  return { fixture: value, children: { paused: paused.id, running: running.id, dependent: ids.dependent!, receipt: `deadline-receipt-${suffix}`, waitId: wait.waitId,
    staleOwner: running.leaseOwner!, staleAttempt: String(running.attemptCount), publishedDispatch: `subagent-dispatch:${running.id}` } }
}

async function dropRollbackTrigger(): Promise<void> {
  if (!pool) return
  await pool.query(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER} ON "agent_outbox"`)
  await pool.query(`DROP FUNCTION IF EXISTS ${ROLLBACK_FUNCTION}`)
}

withServices("TaskGraph deadline recovery on disposable PostgreSQL and Redis", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: pgUrl!, max: 12 })
    redis = new Redis(redisConnectionUrl!, { connectTimeout: 2_000, maxRetriesPerRequest: 1, retryStrategy: () => null })
    await redis.ping()
  })

  afterAll(async () => {
    await dropRollbackTrigger().catch(() => undefined)
    if (pool && fixtureUsers.length) {
      const sessions = await pool.query<{ id: string }>(`SELECT "id" FROM "agent_sessions" WHERE "userId" = ANY($1::text[])`, [fixtureUsers])
      if (sessions.rows.length) await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [sessions.rows.map(row => row.id)])
      await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUsers])
    }
    await redis?.quit()
    await pool?.end()
  })

  it("recovers once under concurrent scans, rolls back atomically, and wakes the durable parent", async () => {
    const fixture = await seed(pool!)
    const children = fixture.children
    const before = await pool!.query<{ revision: number }>(`SELECT "revision" FROM "agent_items" WHERE "taskId" = $1 AND "type" = 'task_graph'`, [fixture.fixture.rootTaskId])
    await pool!.query(`CREATE OR REPLACE FUNCTION ${ROLLBACK_FUNCTION} RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.topic = 'agent.session.event' AND NEW.payload->'payload'->'event'->>'failureReason' = 'task_graph_child_deadline_exceeded' THEN
          RAISE EXCEPTION 'deadline_recovery_rollback_fixture';
        END IF;
        RETURN NEW;
      END; $$`)
    await pool!.query(`CREATE TRIGGER ${ROLLBACK_TRIGGER} BEFORE INSERT ON "agent_outbox"
      FOR EACH ROW EXECUTE FUNCTION ${ROLLBACK_FUNCTION}`)
    const failingManager = new AgentTreeManager(new PgSubagentTaskStore(pool!))
    await expect(failingManager.recover(10)).rejects.toThrow("deadline_recovery_rollback_fixture")
    const rolledBack = await pool!.query(`SELECT task."id", task."status", item."revision" FROM "sub_agent_tasks" AS task
      JOIN "agent_items" AS item ON item."taskId" = task."rootTaskId" AND item."type" = 'task_graph'
      WHERE task."id" = ANY($1::text[]) ORDER BY task."id"`, [[children.paused, children.running]])
    expect(rolledBack.rows.map(row => row.status).sort()).toEqual(["running", "waiting_for_user"])
    expect(new Set(rolledBack.rows.map(row => row.revision))).toEqual(new Set([before.rows[0]?.revision]))
    await dropRollbackTrigger()

    const racingPool = scanBarrier(pool!, 2) as never
    const managers = [new AgentTreeManager(new PgSubagentTaskStore(racingPool)), new AgentTreeManager(new PgSubagentTaskStore(racingPool))]
    const reports = await Promise.all(managers.map(manager => manager.recover(10)))
    expect(reports.reduce((sum, report) => sum + report.terminal, 0)).toBe(2)
    expect(reports.reduce((sum, report) => sum + report.rows.length, 0)).toBe(2)
    const replay = await managers[0]!.recover(10)
    expect(replay.rows).toEqual([])

    const terminal = await pool!.query(`SELECT "id", "status", "failureReason", "attemptCount", "absoluteDeadlineAt",
        "leaseOwner", "leaseExpiresAt", "leaseSegmentStartedAt", "nextAttemptAt", "completedAt", "result"
      FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`, [[children.paused, children.running]])
    expect(terminal.rows).toHaveLength(2)
    for (const row of terminal.rows) {
      expect(row).toMatchObject({ status: "failed", failureReason: "task_graph_child_deadline_exceeded", attemptCount: 1,
        leaseOwner: null, leaseExpiresAt: null, leaseSegmentStartedAt: null, nextAttemptAt: null })
      expect(row.completedAt).toBeTruthy()
      expect(row.absoluteDeadlineAt).toBeTruthy()
      expect(row.result).toMatchObject({ taskGraphVerificationReport: { status: "unverified", reasonCode: "result_invalid" } })
    }
    const events = await pool!.query(`SELECT "taskId", "actor", "payload" FROM "agent_events"
      WHERE "turnId" = $1 AND "payload"->'event'->>'type' = 'task.failed'
        AND "payload"->'event'->>'failureReason' = 'task_graph_child_deadline_exceeded'`, [fixture.fixture.turnId])
    expect(events.rows).toHaveLength(2)
    expect(events.rows.every(row => row.actor === "system")).toBe(true)
    const failedOutbox = await pool!.query(`SELECT "idempotencyKey", "payload" FROM "agent_outbox"
      WHERE "topic" = 'agent.session.event' AND "aggregateId" = $1
        AND "payload"->'payload'->'event'->>'failureReason' = 'task_graph_child_deadline_exceeded'`, [fixture.fixture.sessionId])
    expect(failedOutbox.rows).toHaveLength(2)
    const dispatches = await pool!.query(`SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox"
      WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = ANY($2::text[])`,
    [fixture.fixture.sessionId, [`subagent-dispatch:${children.paused}`, children.publishedDispatch]])
    expect(dispatches.rows).toEqual([{ idempotencyKey: children.publishedDispatch, publishedAt: expect.any(Date) }])
    const receipt = await pool!.query(`SELECT "sanitizedJson", "sha256" FROM "agent_tool_result_references" WHERE "id" = $1`, [children.receipt])
    expect(receipt.rows).toEqual([{ sanitizedJson: { receipt: "committed-before-deadline" }, sha256: expect.any(String) }])
    await expect(new PgSubagentTaskStore(pool!).finish({ taskId: children.running, sessionId: fixture.fixture.sessionId,
      ownerId: children.staleOwner, attemptCount: Number(children.staleAttempt), status: "completed", result: { finalText: "late" }, now: new Date() }))
      .resolves.toBeNull()
    const dependent = await pool!.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [children.dependent])
    expect(dependent.rows[0]?.status).toBe("cancelled")
    const usage = await pool!.query(`SELECT "status", "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_turns" WHERE "id" = $1`, [fixture.fixture.turnId])
    expect(usage.rows[0]).toMatchObject({ status: "waiting_for_dependency", inputTokens: 71, outputTokens: 19, estimatedCostUsd: "0.125" })

    const resolver = startDurableWaitResolver(pool!, { intervalMs: 10, batchSize: 10, ownerId: `deadline-wake-${fixture.fixture.suffix}` })
    try {
      const resumed = await poll(async () => {
        const result = await pool!.query(`SELECT wait."status" AS "waitStatus", wait."matchedTaskIds", turn."status" AS "turnStatus"
          FROM "agent_wait_conditions" AS wait JOIN "agent_turns" AS turn ON turn."id" = wait."turnId"
          WHERE wait."id" = $1`, [children.waitId])
        const row = result.rows[0]
        return row?.waitStatus === "ready" && row?.turnStatus === "queued" ? row : null
      }, "TaskGraph deadline did not settle and wake its durable parent")
      expect(resumed.matchedTaskIds.sort()).toEqual([children.paused, children.running].sort())
      const wake = await pool!.query(`SELECT event."actor", event."type", outbox."idempotencyKey"
        FROM "agent_events" AS event JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
        WHERE event."turnId" = $1 AND event."type" = 'turn.resumed' AND event."causationId" = $2`, [fixture.fixture.turnId, children.waitId])
      expect(wake.rows).toMatchObject([{ actor: "system", type: "turn.resumed" }])
      const finalUsage = await pool!.query(`SELECT "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_turns" WHERE "id" = $1`, [fixture.fixture.turnId])
      expect(finalUsage.rows[0]).toMatchObject({ inputTokens: 71, outputTokens: 19, estimatedCostUsd: "0.125" })
    } finally { await resolver.close() }
  })

  it("releases each Session lock before deadline order can invert sorted recovery order", async () => {
    const fixtures = [await seed(pool!), await seed(pool!)]
    const [low, high] = fixtures.sort((left, right) =>
      left.fixture.sessionId < right.fixture.sessionId ? -1 : 1)
    const ids = fixtures.flatMap(item => [item.children.paused, item.children.running])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = CASE
        WHEN "sessionId" = $1 THEN clock_timestamp() - INTERVAL '2 seconds'
        ELSE clock_timestamp() - INTERVAL '1 second' END WHERE "id" = ANY($2::text[])`,
    [high!.fixture.sessionId, ids])

    const competitor = await pool!.connect()
    const appName = `deadline-lock-${high!.fixture.suffix.slice(0, 8)}`
    let recovery: Promise<Awaited<ReturnType<AgentTreeManager["recover"]>>> | undefined
    let competingLock: Promise<unknown> | undefined
    const barrier = sessionLockBarrier(pool!, high!.fixture.sessionId)
    try {
      await competitor.query("BEGIN")
      await competitor.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [low!.fixture.sessionId])
      await competitor.query(`SELECT set_config('application_name', $1, true)`, [appName])
      const manager = new AgentTreeManager(new PgSubagentTaskStore(barrier.pool as never))
      recovery = manager.recover(4)
      await poll(async () => barrier.isHeld() ? true : null, "deadline scan did not lock the earlier-deadline Session first")

      competingLock = competitor.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [high!.fixture.sessionId])
      await poll(async () => {
        const waiting = await pool!.query(`SELECT "pid" FROM pg_stat_activity
          WHERE "application_name" = $1 AND "wait_event_type" = 'Lock'`, [appName])
        return waiting.rows[0] ? true : null
      }, "competing sorted Session recovery did not queue behind the deadline lock")
      barrier.release()
      const competingRecovery = competingLock.then(async () => competitor.query("COMMIT"))
      const [report] = await Promise.all([recovery, competingRecovery])
      expect(report?.terminal).toBe(4)
      const states = await pool!.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[])`, [ids])
      expect(states.rows).toHaveLength(4)
      expect(states.rows.every(row => row.status === "failed")).toBe(true)
    } finally {
      barrier.release()
      await Promise.allSettled([...(recovery ? [recovery] : []), ...(competingLock ? [competingLock] : [])])
      await competitor.query("ROLLBACK").catch(() => undefined)
      competitor.release()
    }
  })
})
