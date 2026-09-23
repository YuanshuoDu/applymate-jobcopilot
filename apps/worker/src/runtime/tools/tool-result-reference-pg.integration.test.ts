import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import type { TurnLease } from "../turns/lease.js"
import { createToolResultReferenceRepository } from "./tool-result-reference-repo.js"
import type { PutToolResultInput, ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const RUNTIME_ROLE = "agent_runtime_p1_test"

function dedicatedDisposableUrl(): string | null {
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
  ) {
    throw new Error("Agent runtime PostgreSQL integration tests require the dedicated disposable CI service URL")
  }
  return value
}

const databaseUrl = dedicatedDisposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip

type OwnerFixture = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly stepId: string
  readonly owner: { readonly kind: "turn"; readonly taskId: string; readonly lease: TurnLease }
}

function fixture(label: string): OwnerFixture {
  const suffix = randomUUID()
  const userId = `p1-${label}-${suffix}`
  const sessionId = `p1-session-${label}-${suffix}`
  const turnId = `p1-turn-${label}-${suffix}`
  const rootTaskId = `p1-root-${label}-${suffix}`
  const stepId = `p1-step-${label}-${suffix}`
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000)
  const leaseStartedAt = new Date(Date.now() - 1000)
  const lease = {
    turnId,
    sessionId,
    ownerId: `worker-${label}`,
    userId,
    leaseVersion: 1,
    leaseStartedAt,
    leaseExpiresAt,
  }
  return { userId, sessionId, turnId, rootTaskId, stepId, owner: { kind: "turn", taskId: rootTaskId, lease } }
}

async function seedOwner(pool: PgPool, value: OwnerFixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'P1 PostgreSQL private result test', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4, $5, $6, 1, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId, value.owner.lease.ownerId,
    value.owner.lease.leaseExpiresAt, value.owner.lease.leaseStartedAt,
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'P1 PostgreSQL private result test', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [
    value.rootTaskId, value.sessionId, value.turnId,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.rootTaskId, value.turnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 0, '[]'::jsonb, '{}'::jsonb)`, [
    value.stepId, value.sessionId, value.turnId, value.rootTaskId,
  ])
}

async function setRuntimeRole(client: PoolClient): Promise<void> {
  await client.query(`SET ROLE "${RUNTIME_ROLE}"`)
}

function runtimePool(adminPool: PgPool, backendPids: number[]): Pick<PgPool, "connect"> {
  return {
    async connect() {
      const client = await adminPool.connect()
      try {
        await setRuntimeRole(client)
        const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        backendPids.push(identity.rows[0]!.pid)
        return client
      } catch (error) {
        client.release()
        throw error
      }
    },
  }
}

describeWithPostgres("PostgreSQL private tool-result persistence (P1 slice)", () => {
  const ownerA = fixture("owner-a")
  const ownerB = fixture("owner-b")
  let adminPool: PgPool | undefined
  let writerPool: PgPool | undefined
  let readerPool: PgPool | undefined
  let writer: ToolResultReferenceRepository
  let reader: ToolResultReferenceRepository
  let resultId: string
  const writerBackendPids: number[] = []
  const readerBackendPids: number[] = []

  beforeAll(async () => {
    adminPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    await adminPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
    await adminPool.query(`ALTER ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "agent_steps", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_sessions", "agent_turns", "agent_steps", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT, INSERT ON "agent_tool_result_references" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_tool_result_references" TO ${RUNTIME_ROLE}`)
    await seedOwner(adminPool, ownerA)
    await seedOwner(adminPool, ownerB)

    writerPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    writer = createToolResultReferenceRepository(runtimePool(writerPool, writerBackendPids))
    readerPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    reader = createToolResultReferenceRepository(runtimePool(readerPool, readerBackendPids))
  })

  afterAll(async () => {
    await writerPool?.end()
    await readerPool?.end()
    if (adminPool) {
      await adminPool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[ownerA.userId, ownerB.userId]])
      await adminPool.end()
    }
  })

  it("persists across a new pool and enforces owner-scoped RLS for reads", async () => {
    const roleState = await readerPool!.connect()
    try {
      await setRuntimeRole(roleState)
      const result = await roleState.query<{
        isSuperuser: boolean
        bypassesRls: boolean
        ownsTable: boolean
        tableRlsEnabled: boolean
        rowSecurityActive: boolean
      }>(`SELECT role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          pg_get_userbyid(table.relowner) = current_user AS "ownsTable", table.relrowsecurity AS "tableRlsEnabled",
          row_security_active(table.oid) AS "rowSecurityActive"
        FROM pg_roles role CROSS JOIN pg_class table
        WHERE role.rolname = current_user AND table.oid = 'agent_tool_result_references'::regclass`)
      expect(result.rows[0]).toEqual({
        isSuperuser: false,
        bypassesRls: false,
        ownsTable: false,
        tableRlsEnabled: true,
        rowSecurityActive: true,
      })
    } finally {
      roleState.release()
    }

    const input: PutToolResultInput = {
      stepId: ownerA.stepId,
      toolCallId: `call-${randomUUID()}`,
      value: { private: "owner A durable tool result", nested: { status: "complete" } },
    }
    const stored = await writer!.put(ownerA.owner, input)
    resultId = stored.id
    await writerPool!.end()
    writerPool = undefined

    const ownerARead = await reader!.read(ownerA.owner, { referenceId: resultId })
    expect(ownerARead).toMatchObject({
      ref: resultId,
      byteCount: stored.byteCount,
      sha256: stored.sha256,
      chunk: JSON.stringify({ nested: { status: "complete" }, private: "owner A durable tool result" }),
      nextCursor: null,
    })

    const policyProbe = await readerPool!.connect()
    try {
      await setRuntimeRole(policyProbe)
      await policyProbe.query("BEGIN")
      await policyProbe.query("SELECT set_config('app.user_id', $1, true)", [ownerB.userId])
      const rows = await policyProbe.query<{ id: string }>(
        `SELECT "id" FROM "agent_tool_result_references" WHERE "id" = $1`,
        [resultId],
      )
      expect(rows.rows).toEqual([])
      await policyProbe.query("COMMIT")
    } catch (error) {
      await policyProbe.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      policyProbe.release()
    }

    const ownerBRead = await reader!.read(ownerB.owner, { referenceId: resultId })
    expect(ownerBRead).toBeNull()
    expect(writerBackendPids[0]).toBeDefined()
    expect(readerBackendPids[0]).toBeDefined()
    expect(readerBackendPids[0]).not.toBe(writerBackendPids[0])
  })
})
