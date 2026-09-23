import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy, type PgSubagentPool } from "./types.js"

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

type TurnFixture = { readonly id: string; readonly status: string }
type TaskTreeFixture = {
  readonly sessionId: string
  readonly turns: readonly TurnFixture[]
  readonly turnId: string
  readonly rootTaskId: string
  readonly taskId: string
  readonly mismatchTurnTaskId?: string
  readonly mismatchTurnId?: string
}
type UserFixture = {
  readonly userId: string
  readonly email: string
  readonly trees: readonly TaskTreeFixture[]
}

const suffix = randomUUID()
const userA: UserFixture = {
  userId: `p1-subagent-user-a-${suffix}`,
  email: `p1-subagent-user-a-${suffix}@example.invalid`,
  trees: [
    {
      sessionId: `p1-subagent-session-a-${suffix}`,
      turns: [
        { id: `p1-subagent-turn-a-${suffix}`, status: "in_progress" },
        { id: `p1-subagent-turn-a-terminal-${suffix}`, status: "completed" },
      ],
      turnId: `p1-subagent-turn-a-${suffix}`,
      rootTaskId: `p1-subagent-root-a-${suffix}`,
      taskId: `p1-subagent-task-a-${suffix}`,
      mismatchTurnId: `p1-subagent-turn-a-terminal-${suffix}`,
      mismatchTurnTaskId: `p1-subagent-task-turn-mismatch-${suffix}`,
    },
    {
      sessionId: `p1-subagent-session-a-other-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-other-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-other-${suffix}`,
      rootTaskId: `p1-subagent-root-a-other-${suffix}`,
      taskId: `p1-subagent-task-a-other-${suffix}`,
    },
  ],
}
const userB: UserFixture = {
  userId: `p1-subagent-user-b-${suffix}`,
  email: `p1-subagent-user-b-${suffix}@example.invalid`,
  trees: [{
    sessionId: `p1-subagent-session-b-${suffix}`,
    turns: [{ id: `p1-subagent-turn-b-${suffix}`, status: "in_progress" }],
    turnId: `p1-subagent-turn-b-${suffix}`,
    rootTaskId: `p1-subagent-root-b-${suffix}`,
    taskId: `p1-subagent-task-b-${suffix}`,
  }],
}

async function seedFixture(pool: PgPool, fixture: UserFixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    fixture.userId, fixture.email,
  ])
  for (const tree of fixture.trees) {
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'P1 PostgreSQL subagent fencing test', 'running', 'test', CURRENT_TIMESTAMP)`, [
      tree.sessionId, fixture.userId,
    ])
    for (const turn of tree.turns) {
      await pool.query(`INSERT INTO "agent_turns"
        ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, $4, 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [
        turn.id, tree.sessionId, fixture.userId, turn.status,
      ])
    }
    await pool.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'P1 PostgreSQL subagent fencing test', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [
      tree.rootTaskId, tree.sessionId, tree.turnId,
    ])
    await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [tree.rootTaskId])
    await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [tree.rootTaskId, tree.turnId])
    await seedChild(pool, tree, tree.taskId, tree.turnId, "child")
    if (tree.mismatchTurnTaskId && tree.mismatchTurnId) {
      await seedChild(pool, tree, tree.mismatchTurnTaskId, tree.mismatchTurnId, "turn-mismatch")
    }
  }
}

async function seedChild(pool: PgPool, tree: TaskTreeFixture, taskId: string, turnId: string, label: string): Promise<void> {
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, $5, 1, 'scout', 'research', 'queued', 'P1 PostgreSQL subagent fencing test', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`, [
    taskId, tree.sessionId, turnId, tree.rootTaskId, `/root/${label}`,
  ])
}

async function setRuntimeIdentity(client: PoolClient, userId: string): Promise<void> {
  await client.query(`SET ROLE "${RUNTIME_ROLE}"`)
  await client.query("SELECT set_config('app.user_id', $1, false)", [userId])
}

function runtimePool(basePool: PgPool, userId: string): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      try {
        await setRuntimeIdentity(client, userId)
        return client
      } catch (error) {
        client.release()
        throw error
      }
    },
  }
}

describeWithPostgres("PostgreSQL subagent claim and attempt fencing (P1 acceptance slice)", () => {
  const policy = { ...defaultSubagentPolicy(), maxConcurrency: 8 }
  const [treeA, treeAOther] = userA.trees
  const [treeB] = userB.trees
  let adminPool: PgPool | undefined
  let ownerAPool: PgPool | undefined
  let ownerBPool: PgPool | undefined
  let ownerAStore: PgSubagentTaskStore
  let ownerBStore: PgSubagentTaskStore

  beforeAll(async () => {
    adminPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    await adminPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
    await adminPool.query(`ALTER ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT EXECUTE ON FUNCTION app_current_user_id() TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("status", "leaseOwner", "leaseExpiresAt", "attemptCount", "startedAt", "updatedAt", "result", "failureReason", "nextAttemptAt", "completedAt") ON "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ON "agent_outbox" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("publishedAt", "attemptCount", "lastError") ON "agent_outbox" TO ${RUNTIME_ROLE}`)
    await seedFixture(adminPool, userA)
    await seedFixture(adminPool, userB)

    ownerAPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    ownerBPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    ownerAStore = new PgSubagentTaskStore(runtimePool(ownerAPool, userA.userId), 60_000)
    ownerBStore = new PgSubagentTaskStore(runtimePool(ownerBPool, userB.userId), 60_000)
  })

  afterAll(async () => {
    await ownerAPool?.end()
    await ownerBPool?.end()
    if (adminPool) {
      await adminPool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[userA.userId, userB.userId]])
      await adminPool.end()
    }
  })

  it("claims only the matching owner, session, and turn, then rejects stale owner and attempt finishes", async () => {
    const roleProbe = await ownerAPool!.connect()
    try {
      await setRuntimeIdentity(roleProbe, userA.userId)
      const result = await roleProbe.query<{
        isSuperuser: boolean
        bypassesRls: boolean
        ownsTable: boolean
        tableRlsEnabled: boolean
        rowSecurityActive: boolean
      }>(`SELECT role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          pg_get_userbyid(relation.relowner) = current_user AS "ownsTable", relation.relrowsecurity AS "tableRlsEnabled",
          row_security_active(relation.oid) AS "rowSecurityActive"
        FROM pg_roles role CROSS JOIN pg_class AS relation
        WHERE role.rolname = current_user AND relation.oid = 'sub_agent_tasks'::regclass`)
      expect(result.rows[0]).toEqual({
        isSuperuser: false,
        bypassesRls: false,
        ownsTable: false,
        tableRlsEnabled: true,
        rowSecurityActive: true,
      })
    } finally {
      roleProbe.release()
    }

    expect(await ownerAStore.get(treeA!.taskId, treeAOther!.sessionId)).toBeNull()
    await expect(ownerAStore.claim({ taskId: treeA!.taskId, sessionId: treeAOther!.sessionId, ownerId: "wrong-session-worker", policy, now: new Date() })).resolves.toBeNull()
    await expect(ownerAStore.claim({ taskId: treeA!.mismatchTurnTaskId!, sessionId: treeA!.sessionId, ownerId: "wrong-turn-worker", policy, now: new Date() })).resolves.toBeNull()
    await expect(ownerBStore.get(treeA!.taskId, treeA!.sessionId)).resolves.toBeNull()
    await expect(ownerBStore.claim({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "foreign-owner-worker", policy, now: new Date() })).resolves.toBeNull()

    const firstLease = await ownerAStore.claim({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-before-release", policy, now: new Date() })
    expect(firstLease).toMatchObject({ status: "running", leaseOwner: "worker-before-release", attemptCount: 1 })
    await expect(ownerBStore.finish({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-before-release", attemptCount: 1, status: "completed", result: { source: "foreign-owner" }, now: new Date() })).resolves.toBeNull()

    await expect(ownerAStore.release({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-before-release", attemptCount: 1, now: new Date() })).resolves.toBe(true)
    const secondLease = await ownerAStore.claim({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-after-release", policy, now: new Date() })
    expect(secondLease).toMatchObject({ status: "running", leaseOwner: "worker-after-release", attemptCount: 2 })

    await expect(ownerAStore.finish({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-before-release", attemptCount: 1, status: "completed", result: { source: "stale-owner-and-attempt" }, now: new Date() })).resolves.toBeNull()
    await expect(ownerAStore.finish({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-after-release", attemptCount: 1, status: "completed", result: { source: "stale-attempt" }, now: new Date() })).resolves.toBeNull()
    const unchanged = await adminPool!.query<{ status: string; leaseOwner: string; attemptCount: number; result: unknown }>(
      `SELECT "status", "leaseOwner", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [treeA!.taskId, treeA!.sessionId],
    )
    expect(unchanged.rows[0]).toMatchObject({ status: "running", leaseOwner: "worker-after-release", attemptCount: 2, result: null })

    await expect(ownerAStore.finish({ taskId: treeA!.taskId, sessionId: treeA!.sessionId, ownerId: "worker-after-release", attemptCount: 2, status: "completed", result: { source: "current-attempt" }, now: new Date() })).resolves.toBe("completed")
    const completed = await adminPool!.query<{ status: string; attemptCount: number; result: unknown }>(
      `SELECT "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [treeA!.taskId, treeA!.sessionId],
    )
    expect(completed.rows[0]).toMatchObject({ status: "completed", attemptCount: 2, result: { source: "current-attempt" } })
  })
})
