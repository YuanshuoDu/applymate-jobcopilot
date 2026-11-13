import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"

const DATABASE_NAME = "applymate_nested_delegation_ci"
const PROCESS_FIXTURE = fileURLToPath(new URL("./nested-scout-delegation-worker.fixture.mjs", import.meta.url))

type FixtureIds = Readonly<{ userId: string; sessionId: string; turnId: string; alphaJobId: string; betaJobId: string; foreignJobId: string }>
type FixtureProcess = { child: ChildProcess; waitForLine(marker: string, timeoutMs: number): Promise<void>; output: string[] }

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required disposable PostgreSQL URL is missing")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "nested_fixture"
    || url.password !== "nested_fixture_only" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Nested Scout delegation requires the dedicated disposable PostgreSQL service")
  }
  const redis = new URL(process.env.AGENT_TURN_REDIS_TEST_URL ?? "")
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || redis.protocol !== "redis:"
    || redis.hostname !== "127.0.0.1" || redis.port !== "6379" || redis.pathname !== "/15"
    || redis.username || redis.password || redis.search || redis.hash || process.env.REDIS_URL !== redis.href) {
    throw new Error("Nested Scout delegation requires the dedicated disposable Redis service")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
let pool: Pool

function launch(mode: "park" | "resume", ids: FixtureIds): FixtureProcess {
  const child = spawn(process.execPath, ["--import", "tsx", PROCESS_FIXTURE, mode, JSON.stringify(ids)], {
    cwd: process.cwd(), env: { ...process.env, BULLMQ_STALLED_INTERVAL_MS: "30000" }, stdio: ["pipe", "pipe", "pipe"],
  })
  const output: string[] = []
  let buffer = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", (chunk: string) => {
    const text = String(chunk)
    if (/P1143_FIXTURE_FAILURE/.test(text)) output.push("P1143_FIXTURE_FAILURE")
  })
  return {
    child, output,
    async waitForLine(marker, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (output.includes(marker)) return
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker fixture exited before ${marker}`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Worker fixture did not reach ${marker}`)
    },
  }
}

function waitForClose(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker fixture did not close")), timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = waitForClose(child)
  child.kill("SIGKILL")
  await closed
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = waitForClose(child)
  child.stdin?.write("shutdown\n")
  try { await closed } catch { await killAndWait(child) }
}

async function seed(ids: FixtureIds): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [ids.userId, `${ids.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Read matching Dublin engineering roles', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, '{}'::jsonb, $6::jsonb, CURRENT_TIMESTAMP)`, [
    ids.turnId, ids.sessionId, ids.userId,
    JSON.stringify({ goal: "Find matching Dublin engineering roles" }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }), JSON.stringify({ limits: { maxSteps: 32, maxToolCalls: 40 } }),
  ])
  for (const [jobId, company, source] of [
    [ids.alphaJobId, "Fixture Alpha", "greenhouse"], [ids.betaJobId, "Fixture Beta", "greenhouse"], [ids.foreignJobId, "Fixture Other Source", "lever"],
  ] as const) {
    await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, $3, 'Software Engineer', 'Dublin', 'saved', $4, 'Build reliable software', $5, CURRENT_TIMESTAMP)`,
    [jobId, ids.userId, company, `https://jobs.example.invalid/${jobId}`, source])
  }
}

describePg("nested Scout delegation: disposable Worker and PostgreSQL", () => {
  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 8 }) })
  afterAll(async () => { await pool.end() })

  it("waits for two source-bound Scout children across Worker restart in an ordinary user TaskGraph", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `nested-scout-user-${suffix}`, sessionId: `nested-scout-session-${suffix}`,
      turnId: `nested-scout-turn-${suffix}`, alphaJobId: `nested-scout-alpha-${suffix}`,
      betaJobId: `nested-scout-beta-${suffix}`, foreignJobId: `nested-scout-foreign-${suffix}`,
    }
    let first: FixtureProcess | undefined, restarted: FixtureProcess | undefined
    try {
      await seed(ids)
      first = launch("park", ids)
      await first.waitForLine("P1143_SOURCE_ESCALATION_REJECTED", 45_000)
      await first.waitForLine("P1143_CLOSED_STEP_REPLAY_REJECTED", 45_000)
      await first.waitForLine("P1143_FOREIGN_CALL_STEP_REJECTED", 45_000)
      await first.waitForLine("P1143_PARENT_WAITING", 45_000)

      const parent = await pool.query<{ id: string; rootTaskId: string; status: string; leaseOwner: string | null }>(
        `SELECT "id", "rootTaskId", "status", "leaseOwner" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "parentTaskId" = "rootTaskId" AND "depth" = 1 AND "role" = 'scout'`, [ids.sessionId])
      expect(parent.rows).toHaveLength(1)
      expect(parent.rows[0]).toMatchObject({ status: "waiting", leaseOwner: null })
      const deniedSource = await pool.query<{ status: string; errorCode: string | null; input: unknown }>(
        `SELECT status, content->>'errorCode' AS "errorCode", content->'input' AS input FROM "agent_items"
         WHERE "taskId" = $1 AND "type" = 'tool_call' AND content->>'toolCallId' = $2`,
        [parent.rows[0]!.id, `p1143-delegate-lever:${parent.rows[0]!.id}`])
      expect(deniedSource.rows).toHaveLength(1)
      expect(deniedSource.rows[0]).toMatchObject({ status: "failed", errorCode: "nested_scout_source_scope_unavailable" })
      const deniedInput = deniedSource.rows[0]!.input as Record<string, unknown>
      expect(deniedInput.sourceSlice).toEqual(["lever"])
      const nested = await pool.query<{ id: string; status: string; depth: number; goal: string; attemptCount: number }>(
        `SELECT "id", "status", "depth", "goal", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(nested.rows).toHaveLength(2)
      expect(nested.rows.map(row => row.depth)).toEqual([2, 2])
      expect(nested.rows.every(row => row.status === "queued" && row.attemptCount === 0)).toBe(true)
      const expectedJobByChild = new Map(nested.rows.map(row => [row.id, row.goal.includes("Alpha") ? ids.alphaJobId : ids.betaJobId] as const))
      const initialAttempts = new Map(nested.rows.map(row => [row.id, row.attemptCount] as const))
      const wait = await pool.query<{ status: string; suspendedAt: Date | null; targetTaskIds: unknown }>(
        `SELECT "status", "suspendedAt", "targetTaskIds" FROM "agent_wait_conditions"
         WHERE "turnId" = $1 AND "parentTaskId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [ids.turnId, parent.rows[0]!.id])
      expect(wait.rows).toHaveLength(1)
      expect(wait.rows[0]?.status).toBe("waiting")
      expect(wait.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const targets = Array.isArray(wait.rows[0]?.targetTaskIds) ? wait.rows[0]!.targetTaskIds as string[] : []
      expect([...targets].sort()).toEqual(nested.rows.map(row => row.id).sort())
      const premature = await pool.query(`SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.completed'`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(premature.rowCount).toBe(0)

      await killAndWait(first.child)
      first = undefined
      restarted = launch("resume", ids)
      await restarted.waitForLine("P1143_TWO_CHILDREN_RUNNING_IN_PARALLEL", 240_000)
      await restarted.waitForLine("P1143_ROOT_GRAPH_COMPLETED", 240_000)

      const turn = await pool.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [ids.turnId, ids.sessionId])
      expect(turn.rows[0]?.status).toBe("completed")
      const finalParent = await pool.query<{ id: string; status: string; result: unknown }>(
        `SELECT "id", "status", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [parent.rows[0]!.id])
      expect(finalParent.rows[0]?.status).toBe("completed")
      const finalChildren = await pool.query<{ id: string; status: string; result: unknown; attemptCount: number }>(
        `SELECT "id", "status", "result", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(finalChildren.rows).toHaveLength(2)
      expect(finalChildren.rows.every(row => row.status === "completed")).toBe(true)
      expect(finalChildren.rows.every(row => row.attemptCount > initialAttempts.get(row.id)!)).toBe(true)
      for (const child of finalChildren.rows) {
        const result = child.result as Record<string, unknown>
        const structured = result.structuredResult as Record<string, unknown>
        expect(structured).toMatchObject({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed" })
        const candidates = structured.candidates as Array<Record<string, unknown>>
        expect(candidates).toHaveLength(1)
        expect(candidates[0]?.jobId).toBe(expectedJobByChild.get(child.id))
        expect(candidates[0]?.source).toBe("greenhouse")
        expect(candidates[0]?.jobId).not.toBe(ids.foreignJobId)
        expect(JSON.stringify(structured.evidence)).toContain(String(candidates[0]?.jobId))
      }
      const taskGraph = await pool.query<{ content: unknown }>(
        `SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'task_graph' ORDER BY "revision" DESC LIMIT 1`,
        [ids.sessionId, ids.turnId])
      const graph = taskGraph.rows[0]?.content as Record<string, unknown>
      const nodes = graph.nodes as Array<Record<string, unknown>>
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({ templateId: "scout", status: "completed", readiness: "terminal" })
      expect((nodes[0]?.verificationReport as Record<string, unknown>)?.status).toBe("passed")
      expect(nodes[0]?.resultProjection).toBeDefined()
      const parentReads = await pool.query<{ toolCallId: string; input: unknown; status: string }>(
        `SELECT content->>'toolCallId' AS "toolCallId", content->'input' AS input, status FROM "agent_items"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'
           AND content->>'toolName' = 'jobs.get' ORDER BY "createdAt"`, [ids.sessionId, ids.turnId, parent.rows[0]!.id])
      const readIds = parentReads.rows.map(row => (row.input as Record<string, unknown>)?.jobId)
      expect(parentReads.rows).toHaveLength(2)
      expect(parentReads.rows.every(row => row.status === "completed")).toBe(true)
      expect(new Set(readIds)).toEqual(new Set([ids.alphaJobId, ids.betaJobId]))
      for (const child of finalChildren.rows) {
        const counts = await pool.query<{ spawnCount: string; dispatchCount: string }>(
          `SELECT count(*) FILTER (WHERE "topic" = 'agent.subagent.spawn') AS "spawnCount",
                  count(*) FILTER (WHERE "topic" = 'agent.subagent.dispatch') AS "dispatchCount"
           FROM "agent_outbox" WHERE "aggregateId" = $1 AND payload->>'taskId' = $2`, [ids.sessionId, child.id])
        expect(counts.rows[0]).toMatchObject({ spawnCount: "1", dispatchCount: "1" })
      }
    } finally {
      if (first) await killAndWait(first.child)
      if (restarted) await stop(restarted.child)
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId])
    }
  }, 300_000)
})
