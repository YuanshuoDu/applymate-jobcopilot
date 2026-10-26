import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
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
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"

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
    turnId: `deadline-turn-${suffix}`, rootTaskId: `root-deadline-turn-${suffix}`,
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
  const lease = await claimTurnLease(pool, { turnId: value.turnId, sessionId: value.sessionId, ownerId: `turn-owner-${suffix}` })
  const root = await createPgRootTaskStore(pool).ensure({ lease, goal: "TaskGraph deadline recovery",
    allowedActions: [], budgetSnapshot: { subagentPolicy: { maxConcurrency: 4, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } })
  if (root.id !== value.rootTaskId || root.status !== "running" || root.leaseOwner !== lease.ownerId) {
    throw new Error("deadline fixture root lease does not match the production Turn lease")
  }
  await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.stepId, value.sessionId, value.turnId, value.rootTaskId])
  const deadlineBefore = await pool.query<{ dbNow: Date }>(`SELECT clock_timestamp() AS "dbNow"`)
  const graph = await createPgTaskGraphCommandPort(pool).appendAndSchedule({
    scope: { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
      parentTaskId: value.rootTaskId, stepId: value.stepId, turnLeaseOwner: lease.ownerId,
      turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: root.leaseOwner!, parentAttemptCount: root.attemptCount },
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
  const deadlineAfter = await pool.query<{ dbNow: Date }>(`SELECT clock_timestamp() AS "dbNow"`)
  const insertedDeadlines = await pool.query<{ id: string; absoluteDeadlineAt: Date }>(`SELECT "id", "absoluteDeadlineAt"
    FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[])`, [graph.nodes.map(node => node.taskId)])
  expect(insertedDeadlines.rows).toHaveLength(graph.nodes.length)
  const lifetimeMs = 60 * 60 * 1000
  for (const row of insertedDeadlines.rows) {
    expect(row.absoluteDeadlineAt.getTime()).toBeGreaterThanOrEqual(deadlineBefore.rows[0]!.dbNow.getTime() + lifetimeMs - 1)
    expect(row.absoluteDeadlineAt.getTime()).toBeLessThanOrEqual(deadlineAfter.rows[0]!.dbNow.getTime() + lifetimeMs + 1)
  }
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
  for (const [key, task, ordinal] of [["paused", paused, 2], ["running", running, 3]] as const) {
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
        "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, $5, $6, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [`deadline-child-step-${key}-${suffix}`, value.sessionId, value.turnId, task.id, ordinal, task.attemptCount])
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

type FixtureGraphSnapshot = { schemaVersion: string; nodes: Record<string, unknown>[]; rootSuccessCriteria?: string[] }
async function readFixtureGraph(pool: Pool, fixture: Fixture): Promise<FixtureGraphSnapshot> {
  const result = await pool.query<{ content: unknown }>(`SELECT "content" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
  [taskGraphItemId(fixture.rootTaskId), fixture.sessionId, fixture.turnId, fixture.rootTaskId])
  const content = result.rows[0]?.content
  if (!content || typeof content !== "object" || Array.isArray(content)
    || !Array.isArray((content as Record<string, unknown>).nodes)) throw new Error("migration fixture graph is missing")
  return structuredClone(content as FixtureGraphSnapshot)
}

async function writeFixtureGraph(pool: Pool, fixture: Fixture, content: FixtureGraphSnapshot): Promise<void> {
  await pool.query(`UPDATE "agent_items" SET "content" = $2::jsonb
    WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'task_graph'`,
  [taskGraphItemId(fixture.rootTaskId), JSON.stringify(content), fixture.sessionId, fixture.turnId, fixture.rootTaskId])
}

async function insertMigrationFixtureTask(pool: Pool, input: {
  id: string; fixture: Fixture; parentTaskId: string; depth: number; role: string; taskType: string; goal: string
}): Promise<void> {
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth",
      "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [input.id, input.fixture.sessionId, input.fixture.turnId, input.fixture.rootTaskId, input.parentTaskId,
    `/root/${input.id}`, input.depth, input.role, input.taskType, input.goal])
}

async function insertMigrationFixtureGraph(pool: Pool, input: {
  id: string; fixture: Fixture; parentTaskId: string; childTaskId: string; depth: number
}): Promise<void> {
  const content = { schemaVersion: "agent-harness.v2.task-graph", nodes: [{
    dependsOn: [], depth: input.depth, goal: "Nested graph child", key: "nested-child", successCriteria: ["Finish"],
    taskId: input.childTaskId, templateId: "analyst",
  }] }
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'streaming', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [input.id, input.fixture.sessionId, input.fixture.turnId, input.parentTaskId, JSON.stringify(content)])
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

  it("backfills only current, owned, unfinished root TaskGraph children from createdAt", async () => {
    const ordinary = await seed(pool!)
    const scheduled = await seed(pool!)
    const wrongAutomationMode = await seed(pool!)
    const malformed = await seed(pool!)
    const duplicateTarget = await seed(pool!)
    const strayGraph = await seed(pool!)
    const mismatchedGraphScope = await seed(pool!)
    const mismatchedOwner = await seed(pool!)
    const entries = [ordinary, scheduled, wrongAutomationMode, malformed, duplicateTarget, strayGraph, mismatchedGraphScope, mismatchedOwner]
    const childIds = (entry: Awaited<ReturnType<typeof seed>>) => [entry.children.paused, entry.children.running, entry.children.dependent]
    const originalCreatedAt = new Date("2000-01-01T00:00:00.000Z")
    const preservedDeadline = new Date("2035-05-06T07:08:09.000Z")
    const preservedSegment = new Date("2035-05-06T07:09:09.000Z")
    for (const entry of entries) {
      await pool!.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = NULL, "createdAt" = $2,
          "leaseSegmentStartedAt" = NULL WHERE "id" = ANY($1::text[])`, [childIds(entry), originalCreatedAt])
    }
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1`, [ordinary.children.dependent])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseSegmentStartedAt" = $2 WHERE "id" = $1`,
      [ordinary.children.running, preservedSegment])

    await pool!.query(`UPDATE "agent_turns" SET "source" = 'automation', "executionMode" = 'canonical_task_graph' WHERE "id" = $1`,
      [scheduled.fixture.turnId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = $2, "leaseSegmentStartedAt" = $3 WHERE "id" = $1`,
      [scheduled.children.running, preservedDeadline, preservedSegment])
    await pool!.query(`UPDATE "agent_turns" SET "source" = 'automation', "executionMode" = 'legacy_pipeline_adapter' WHERE "id" = $1`,
      [wrongAutomationMode.fixture.turnId])

    const scoutId = `deadline-scout-${ordinary.fixture.suffix}`
    const nativeId = `deadline-native-${ordinary.fixture.suffix}`
    await insertMigrationFixtureTask(pool!, { id: scoutId, fixture: ordinary.fixture, parentTaskId: ordinary.fixture.rootTaskId,
      depth: 1, role: "scout", taskType: "research", goal: "Registered Scout graph child" })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = '["jobs.search"]'::jsonb,
        "expectedOutputSchema" = '{"schemaVersion":"${ROLE_RESULT_SCHEMA}","role":"scout"}'::jsonb WHERE "id" = $1`, [scoutId])
    await insertMigrationFixtureTask(pool!, { id: nativeId, fixture: ordinary.fixture, parentTaskId: ordinary.fixture.rootTaskId,
      depth: 1, role: "auditor", taskType: "native_verification", goal: "Native graph child" })
    const ordinaryGraph = await readFixtureGraph(pool!, ordinary.fixture)
    ordinaryGraph.nodes.push({ dependsOn: [], depth: 1, goal: "Registered Scout graph child", key: "registered-scout",
      registeredScoutEnvelope: { allowedActions: ["jobs.search"], expectedOutputSchema: { role: "scout", schemaVersion: ROLE_RESULT_SCHEMA },
        role: "scout", taskType: "research" }, successCriteria: ["Evidence found"], taskId: scoutId, templateId: "scout",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
        { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
      ] }, verificationDisposition: "typed" })
    ordinaryGraph.nodes.push({ dependsOn: [], depth: 1, goal: "Native graph child", key: "native-child", successCriteria: [],
      taskId: nativeId, templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, verificationDisposition: "legacy_unverified",
      nativeDelegation: { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn",
        operationId: `native-migration-${ordinary.fixture.suffix}`, requestFingerprint: "a".repeat(64),
        callerTaskId: ordinary.fixture.rootTaskId, role: "auditor", taskType: "native_verification", contextDigest: "b".repeat(64), contextBytes: 0 } })
    expect(parseTaskGraphSnapshot(ordinaryGraph).nodes).toHaveLength(5)
    await writeFixtureGraph(pool!, ordinary.fixture, ordinaryGraph)

    const malformedGraph = await readFixtureGraph(pool!, malformed.fixture)
    malformedGraph.nodes[0]!["verificationDisposition"] = null
    await writeFixtureGraph(pool!, malformed.fixture, malformedGraph)
    const duplicateGraph = await readFixtureGraph(pool!, duplicateTarget.fixture)
    duplicateGraph.nodes.push(structuredClone(duplicateGraph.nodes[0]!))
    await writeFixtureGraph(pool!, duplicateTarget.fixture, duplicateGraph)

    const strayContent = await readFixtureGraph(pool!, strayGraph.fixture)
    await pool!.query(`DELETE FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
      [taskGraphItemId(strayGraph.fixture.rootTaskId), strayGraph.fixture.sessionId, strayGraph.fixture.turnId])
    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'task_graph', 'streaming', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [`stray-task-graph-${strayGraph.fixture.suffix}`, strayGraph.fixture.sessionId, strayGraph.fixture.turnId,
      strayGraph.fixture.rootTaskId, JSON.stringify(strayContent)])

    const foreignTurnId = `deadline-migration-other-turn-${mismatchedGraphScope.fixture.suffix}`
    await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
        "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "updatedAt")
      VALUES ($1, $2, $3, 'completed', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, CURRENT_TIMESTAMP)`,
    [foreignTurnId, mismatchedGraphScope.fixture.sessionId, mismatchedGraphScope.fixture.userId, mismatchedGraphScope.fixture.rootTaskId])
    await pool!.query(`UPDATE "agent_items" SET "turnId" = $2 WHERE "id" = $1 AND "sessionId" = $3 AND "taskId" = $4`,
      [taskGraphItemId(mismatchedGraphScope.fixture.rootTaskId), foreignTurnId, mismatchedGraphScope.fixture.sessionId,
        mismatchedGraphScope.fixture.rootTaskId])

    const foreignUserId = `deadline-migration-other-owner-${mismatchedOwner.fixture.suffix}`
    fixtureUsers.push(foreignUserId)
    await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      [foreignUserId, `${foreignUserId}@example.invalid`])
    await pool!.query(`DELETE FROM "agent_wait_conditions" WHERE "turnId" = $1`, [mismatchedOwner.fixture.turnId])
    await pool!.query(`DELETE FROM "agent_tool_result_references" WHERE "turnId" = $1`, [mismatchedOwner.fixture.turnId])
    await pool!.query(`UPDATE "agent_turns" SET "userId" = $2 WHERE "id" = $1`, [mismatchedOwner.fixture.turnId, foreignUserId])

    const genericId = `deadline-generic-${ordinary.fixture.suffix}`
    const verifierId = `deadline-native-control-${ordinary.fixture.suffix}`
    await insertMigrationFixtureTask(pool!, { id: genericId, fixture: ordinary.fixture, parentTaskId: ordinary.fixture.rootTaskId,
      depth: 1, role: "analyst", taskType: "manual_spawn", goal: "Generic child under the same parent" })
    await insertMigrationFixtureTask(pool!, { id: verifierId, fixture: ordinary.fixture, parentTaskId: ordinary.fixture.rootTaskId,
      depth: 1, role: "auditor", taskType: "native_verification", goal: "Native verification control" })
    const nestedId = `deadline-nested-child-${ordinary.fixture.suffix}`
    await insertMigrationFixtureTask(pool!, { id: nestedId, fixture: ordinary.fixture, parentTaskId: ordinary.children.paused,
      depth: 2, role: "analyst", taskType: "research", goal: "Unsupported nested Graph child" })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "createdAt" = $2 WHERE "id" = ANY($1::text[])`,
      [[genericId, verifierId, nestedId], originalCreatedAt])
    await insertMigrationFixtureGraph(pool!, { id: taskGraphItemId(ordinary.children.paused), fixture: ordinary.fixture,
      parentTaskId: ordinary.children.paused, childTaskId: nestedId, depth: 2 })

    const rootIds = entries.map(entry => entry.fixture.rootTaskId)
    const allIds = [...rootIds, ...entries.flatMap(childIds), genericId, verifierId, nestedId, scoutId, nativeId]
    const migration = await readFile(new URL("../../../../../apps/web/prisma/migrations/20261026180000_add_task_graph_child_deadline/migration.sql", import.meta.url), "utf8")
    const client = await pool!.connect()
    try {
      await client.query("BEGIN")
      await client.query(migration)
      const first = await client.query<{ id: string; status: string; createdAt: Date; absoluteDeadlineAt: Date | null; leaseSegmentStartedAt: Date | null }>(
        `SELECT "id", "status", "createdAt", "absoluteDeadlineAt", "leaseSegmentStartedAt" FROM "sub_agent_tasks"
          WHERE "id" = ANY($1::text[]) ORDER BY "id"`, [allIds])
      await client.query(migration)
      const second = await client.query(`SELECT "id", "status", "createdAt", "absoluteDeadlineAt", "leaseSegmentStartedAt" FROM "sub_agent_tasks"
        WHERE "id" = ANY($1::text[]) ORDER BY "id"`, [allIds])
      const databaseNow = await client.query<{ dbNow: Date }>(`SELECT clock_timestamp() AS "dbNow"`)
      expect(second.rows).toEqual(first.rows)
      expect(first.rows).toHaveLength(allIds.length)
      const byId = new Map(first.rows.map(row => [row.id, row]))
      const expectBackfilled = (id: string) => {
        const row = byId.get(id)
        if (!row) throw new Error(`migration fixture task ${id} is missing`)
        expect(row.absoluteDeadlineAt?.getTime()).toBe(row.createdAt.getTime() + 60 * 60 * 1000)
      }
      for (const id of [ordinary.children.paused, ordinary.children.running, scoutId, nativeId,
        scheduled.children.paused, scheduled.children.dependent]) expectBackfilled(id)
      const overdue = byId.get(ordinary.children.paused)?.absoluteDeadlineAt
      expect(overdue?.getTime()).toBeLessThan(databaseNow.rows[0]!.dbNow.getTime())
      expect(byId.get(ordinary.children.paused)?.leaseSegmentStartedAt).toBeNull()
      expect(byId.get(ordinary.children.running)?.leaseSegmentStartedAt).toEqual(preservedSegment)
      expect(byId.get(scheduled.children.running)?.absoluteDeadlineAt).toEqual(preservedDeadline)
      expect(byId.get(scheduled.children.running)?.leaseSegmentStartedAt).toEqual(preservedSegment)
      expect(byId.get(ordinary.children.dependent)).toMatchObject({ status: "completed", absoluteDeadlineAt: null })
      for (const id of rootIds) expect(byId.get(id)).toMatchObject({ absoluteDeadlineAt: null, leaseSegmentStartedAt: null })
      for (const id of [...childIds(wrongAutomationMode), ...childIds(malformed), ...childIds(duplicateTarget),
        ...childIds(strayGraph), ...childIds(mismatchedGraphScope), ...childIds(mismatchedOwner), genericId, verifierId, nestedId]) {
        expect(byId.get(id)?.absoluteDeadlineAt).toBeNull()
      }
      expect(byId.get(genericId)?.status).toBe("queued")
      expect(byId.get(verifierId)?.status).toBe("queued")
    } finally {
      await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
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
    const usage = await pool!.query(`SELECT "status", "inputTokens", "outputTokens",
        "estimatedCostUsd" = 0.125::numeric AS "estimatedCostUsdPreserved"
      FROM "agent_turns" WHERE "id" = $1`, [fixture.fixture.turnId])
    expect(usage.rows[0]).toMatchObject({ status: "waiting_for_dependency", inputTokens: 71, outputTokens: 19, estimatedCostUsdPreserved: true })

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
      const finalUsage = await pool!.query(`SELECT "inputTokens", "outputTokens",
          "estimatedCostUsd" = 0.125::numeric AS "estimatedCostUsdPreserved"
        FROM "agent_turns" WHERE "id" = $1`, [fixture.fixture.turnId])
      expect(finalUsage.rows[0]).toMatchObject({ inputTokens: 71, outputTokens: 19, estimatedCostUsdPreserved: true })
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

  it("preserves a pre-deadline durable interrupt during paused-session lease recovery", async () => {
    const { fixture, children } = await seed(pool!)
    const store = new PgSubagentTaskStore(pool!)
    await pool!.query(`UPDATE "agent_sessions" SET "status" = 'paused' WHERE "id" = $1`, [fixture.sessionId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "id" = ANY($1::text[])`, [[children.paused, children.running]])
    const target = await pool!.query(`SELECT "path" FROM "sub_agent_tasks" WHERE "id" = $1`, [children.running])
    const targetPath = target.rows[0]?.path
    if (typeof targetPath !== "string") throw new Error("interrupt recovery fixture child path is missing")

    const actionItemId = `deadline-interrupt-action-${fixture.suffix}`
    const toolCallId = `deadline-interrupt-call-${fixture.suffix}`
    const stepId = `deadline-child-step-running-${fixture.suffix}`
    const actionContent = { toolCallId, toolName: "external_action", toolVersion: "1", input: { action: "preserve" } }
    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [actionItemId, fixture.sessionId, fixture.turnId, stepId, children.running, JSON.stringify(actionContent)])
    const sequence = await pool!.query<{ nextSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 RETURNING "eventSequence"::text AS "nextSequence"`, [fixture.sessionId])
    if (!sequence.rows[0]?.nextSequence) throw new Error("interrupt fixture could not allocate event sequence")
    const startedEventId = `deadline-interrupt-started-${fixture.suffix}`
    const startedKey = `task:${children.running}:event:tool-started:${toolCallId}`
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, 'tool_call.started', 'subagent', $7, $8, $9::jsonb)`,
    [startedEventId, fixture.sessionId, fixture.turnId, actionItemId, children.running, sequence.rows[0].nextSequence,
      toolCallId, startedKey, JSON.stringify({ taskId: children.running, toolCallId, toolName: "external_action", toolVersion: "1" })])
    const actionBefore = await pool!.query(`SELECT to_jsonb(item) AS "action" FROM "agent_items" AS item WHERE item."id" = $1`, [actionItemId])
    const startedBefore = await pool!.query(`SELECT to_jsonb(event) AS "event" FROM "agent_events" AS event WHERE event."id" = $1`, [startedEventId])
    const receiptBefore = await pool!.query(`SELECT to_jsonb(reference) AS "receipt" FROM "agent_tool_result_references" AS reference WHERE reference."id" = $1`, [children.receipt])
    expect(actionBefore.rows).toHaveLength(1)
    expect(actionBefore.rows).toMatchObject([{ action: { type: "tool_call", status: "started", content: actionContent } }])
    expect(startedBefore.rows).toMatchObject([{ event: { type: "tool_call.started", actor: "subagent", itemId: actionItemId,
      taskId: children.running, correlationId: toolCallId, idempotencyKey: startedKey } }])
    expect(receiptBefore.rows).toHaveLength(1)

    const requestedAt = new Date()
    await expect(store.interruptSubtree({ sessionId: fixture.sessionId, rootTaskId: fixture.rootTaskId,
      targetPath, now: requestedAt })).resolves.toBe(1)
    const interrupted = await pool!.query(`SELECT task."status", task."interruptRequestedAt", task."absoluteDeadlineAt",
        session."status" AS "sessionStatus"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = $1`, [children.running])
    const marker = interrupted.rows[0]?.interruptRequestedAt
    expect(interrupted.rows[0]).toMatchObject({ status: "running", sessionStatus: "paused" })
    expect(marker).toBeTruthy()
    expect(new Date(String(marker)).getTime()).toBeLessThan(new Date(String(interrupted.rows[0]?.absoluteDeadlineAt)).getTime())
    const history = await pool!.query(`SELECT "id", "idempotencyKey", "actor", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.interrupt.accepted'`, [fixture.sessionId, children.running])
    expect(history.rows).toHaveLength(1)
    expect(history.rows[0]).toMatchObject({ actor: "system", payload: { status: "accepted" } })

    await pool!.query(`UPDATE "sub_agent_tasks" SET "absoluteDeadlineAt" = clock_timestamp() + INTERVAL '300 milliseconds',
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '300 milliseconds' WHERE "id" = $1`, [children.running])
    await poll(async () => {
      const elapsed = await pool!.query(`SELECT "absoluteDeadlineAt" <= clock_timestamp() AS "deadlinePassed",
          "leaseExpiresAt" <= clock_timestamp() AS "leasePassed" FROM "sub_agent_tasks" WHERE "id" = $1`, [children.running])
      const row = elapsed.rows[0]
      return row?.deadlinePassed && row?.leasePassed ? row : null
    }, "interrupted child deadline and lease did not expire")

    await expect(store.finish({ taskId: children.running, sessionId: fixture.sessionId, ownerId: children.staleOwner,
      attemptCount: Number(children.staleAttempt), status: "completed", result: { finalText: "late finish" }, now: new Date() }))
      .resolves.toBeNull()
    const recovered = await new AgentTreeManager(store).recover(10)
    expect(recovered.rows.filter(row => row.id === children.running)).toMatchObject([{ status: "interrupted" }])
    const terminal = await pool!.query(`SELECT "status", "interruptRequestedAt", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [children.running])
    expect(terminal.rows[0]).toMatchObject({ status: "interrupted" })
    expect(String(terminal.rows[0]?.interruptRequestedAt)).toBe(String(marker))
    expect(terminal.rows[0]?.failureReason).not.toBe("task_graph_child_deadline_exceeded")
    const historyAfter = await pool!.query(`SELECT "id", "idempotencyKey", "actor", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.interrupt.accepted'`, [fixture.sessionId, children.running])
    expect(historyAfter.rows).toEqual(history.rows)
    const actionAfter = await pool!.query(`SELECT to_jsonb(item) AS "action" FROM "agent_items" AS item WHERE item."id" = $1`, [actionItemId])
    const startedAfter = await pool!.query(`SELECT to_jsonb(event) AS "event" FROM "agent_events" AS event WHERE event."id" = $1`, [startedEventId])
    const receiptAfter = await pool!.query(`SELECT to_jsonb(reference) AS "receipt" FROM "agent_tool_result_references" AS reference WHERE reference."id" = $1`, [children.receipt])
    expect(actionAfter.rows).toEqual(actionBefore.rows)
    expect(startedAfter.rows).toEqual(startedBefore.rows)
    expect(receiptAfter.rows).toEqual(receiptBefore.rows)
    const deadlineFailures = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2
      AND "type" = 'task.failed' AND "payload"->'event'->>'failureReason' = 'task_graph_child_deadline_exceeded'`,
    [fixture.sessionId, children.running])
    expect(deadlineFailures.rows).toEqual([])
    const lifecycleKey = taskGraphLifecycleKey(fixture.rootTaskId, "running", Number(children.staleAttempt), "task.interrupted")
    const lifecycle = await pool!.query(`SELECT "id", "type", "actor", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [fixture.sessionId, lifecycleKey])
    expect(lifecycle.rows).toMatchObject([{ type: "item.delta", actor: "system", idempotencyKey: lifecycleKey,
      payload: { kind: "lifecycle", event: { type: "task.interrupted", nodeKey: "running" } } }])
    const lifecycleOutbox = await pool!.query(`SELECT "idempotencyKey", "payload" FROM "agent_outbox"
      WHERE "topic" = 'agent.session.event' AND "idempotencyKey" = $1`, [`agent-event:${lifecycle.rows[0]?.id}`])
    expect(lifecycleOutbox.rows).toHaveLength(1)

    const replay = await new AgentTreeManager(store).recover(10)
    expect(replay.rows).toEqual([])
    const lifecycleAfterReplay = await pool!.query(`SELECT "id", "type", "actor", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [fixture.sessionId, lifecycleKey])
    const outboxAfterReplay = await pool!.query(`SELECT "idempotencyKey", "payload" FROM "agent_outbox"
      WHERE "topic" = 'agent.session.event' AND "idempotencyKey" = $1`, [`agent-event:${lifecycle.rows[0]?.id}`])
    const actionAfterReplay = await pool!.query(`SELECT to_jsonb(item) AS "action" FROM "agent_items" AS item WHERE item."id" = $1`, [actionItemId])
    const startedAfterReplay = await pool!.query(`SELECT to_jsonb(event) AS "event" FROM "agent_events" AS event WHERE event."id" = $1`, [startedEventId])
    const receiptAfterReplay = await pool!.query(`SELECT to_jsonb(reference) AS "receipt" FROM "agent_tool_result_references" AS reference WHERE reference."id" = $1`, [children.receipt])
    expect(lifecycleAfterReplay.rows).toEqual(lifecycle.rows)
    expect(outboxAfterReplay.rows).toEqual(lifecycleOutbox.rows)
    expect(actionAfterReplay.rows).toEqual(actionBefore.rows)
    expect(startedAfterReplay.rows).toEqual(startedBefore.rows)
    expect(receiptAfterReplay.rows).toEqual(receiptBefore.rows)
  })
})
