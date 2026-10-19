import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import type { LeasePool } from "../runtime/turns/lease.js"
import { pinAgentRunMode } from "./agent-run-mode.js"

const CI_DATABASE = "applymate_agent_brain_ci"
const LOCAL_DATABASE = "applymate_agent_run_mode_885_test"

function disposableDatabaseUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Required AgentRun mode PostgreSQL integration needs its explicitly disposable service URL")
    return null
  }
  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.slice(1))
  const expectedDatabase = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || database !== expectedDatabase || url.search || url.hash) {
    throw new Error("AgentRun mode PostgreSQL integration accepts only its named loopback disposable database")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const schema = `agent_run_mode_885_${randomUUID().replaceAll("-", "")}`
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null
let testPool: LeasePool | null = null

function scopedPool(pool: Pool): LeasePool {
  return {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO "${schema}"`)
        return client
      } catch (error: unknown) {
        client.release()
        throw error
      }
    },
  } as LeasePool
}

async function insertTurn(turnId: string): Promise<void> {
  await testPool!.connect().then(async client => {
    try {
      await client.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId") VALUES ($1, 'session-1', 'user-1')`, [turnId])
    } finally { client.release() }
  })
}

describeWithPostgres("AgentRun mode pin on disposable PostgreSQL", () => {
  beforeAll(async () => {
    testPool = scopedPool(admin!)
    await admin!.query(`CREATE SCHEMA "${schema}"`)
    const ddl = [
      `CREATE TABLE "agent_sessions" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, UNIQUE ("id", "userId")
      )`,
      `CREATE TABLE "agent_turns" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL,
        "executionMode" text NULL CHECK ("executionMode" IS NULL OR "executionMode" IN ('canonical_task_graph', 'legacy_pipeline_adapter'))
      )`,
      `CREATE TABLE "agent_outbox" (
        "topic" text NOT NULL, "aggregateId" text NOT NULL, "idempotencyKey" text NOT NULL UNIQUE, "payload" jsonb NOT NULL
      )`,
      `CREATE TABLE "agent_items" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "type" text NOT NULL, "content" jsonb NOT NULL
      )`,
    ]
    for (const statement of ddl) await admin!.query(statement)
    await testPool.connect().then(async client => {
      try {
        await client.query(`INSERT INTO "agent_sessions" ("id", "userId") VALUES ('session-1', 'user-1')`)
      } finally { client.release() }
    })
    await insertTurn("turn-concurrent")
    await insertTurn("turn-canonical-evidence")
    await insertTurn("turn-legacy-evidence")
    await insertTurn("turn-isolated-a")
    await insertTurn("turn-isolated-b")
    await testPool.connect().then(async client => {
      try {
        await client.query(`INSERT INTO "agent_outbox" VALUES ('agent.turn.dispatch', 'session-1', 'turn-dispatch:turn-canonical-evidence', $1::jsonb)`, [JSON.stringify({ turnId: "turn-canonical-evidence", sessionId: "session-1", ownerId: "agent-run:turn-canonical-evidence" })])
        await client.query(`INSERT INTO "agent_items" VALUES ('item-legacy', 'session-1', 'turn-legacy-evidence', 'tool_call', $1::jsonb)`, [JSON.stringify({ toolCallId: "pipeline.run", toolName: "pipeline.run", toolVersion: "1" })])
      } finally { client.release() }
    })
  })

  afterAll(async () => {
    try { if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin?.end() }
  })

  it("serializes concurrent first pins and resolves durable evidence before the flag", async () => {
    const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-concurrent" }
    const firstWrite = pinAgentRunMode(testPool!, identity, true)
    const competingWrite = pinAgentRunMode(testPool!, identity, false)
    const [first, second] = await Promise.all([firstWrite, competingWrite])
    expect(first).toBe(second)

    await expect(pinAgentRunMode(testPool!, { ...identity, turnId: "turn-canonical-evidence" }, false)).resolves.toBe("canonical_task_graph")
    await expect(pinAgentRunMode(testPool!, { ...identity, turnId: "turn-legacy-evidence" }, true)).resolves.toBe("legacy_pipeline_adapter")
  })

  it("pins separate Turns in one session independently and rejects an owner mismatch", async () => {
    const base = { userId: "user-1", sessionId: "session-1" }
    await expect(pinAgentRunMode(testPool!, { ...base, turnId: "turn-isolated-a" }, true)).resolves.toBe("canonical_task_graph")
    await expect(pinAgentRunMode(testPool!, { ...base, turnId: "turn-isolated-b" }, false)).resolves.toBe("legacy_pipeline_adapter")
    await expect(pinAgentRunMode(testPool!, { ...base, userId: "other-user", turnId: "turn-isolated-a" }, true))
      .rejects.toMatchObject({ code: "owner_mismatch" })
  })
})
