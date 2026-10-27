import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import { Type } from "@sinclair/typebox"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { RuntimeToolDefinition } from "../tools/types.js"

import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy, type PgSubagentPool, type SubagentJobPayload } from "./types.js"
import { parseSubagentDispatchJobId, SubagentDispatchIdentityMismatchError, subagentDispatchJobId } from "./dispatch-identity.js"
import { persistSubagentDispatch } from "../../queue/subagent-pause-dispatch.js"
import { recoverMissingPublishedSubagentDispatches } from "../../queue/subagent-published-dispatch-recovery.js"
import { createProductionChildExecutor } from "./production-child-runtime.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createPgTreeBudgetReservationStore } from "./tree-budget-store.js"
import {
  createWorkerUsageAuthorizer,
  type WorkerUsageAuthorizationInput,
  type WorkerUsageSettlementInput,
} from "../../queue/ai-usage-bridge.js"

const usageRouteMocks = vi.hoisted(() => ({
  database: null as unknown,
  resolveAiAccess: vi.fn(),
  getEffectiveEntitlements: vi.fn(),
  loadWorkerAiConfig: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: usageRouteMocks.database }))
vi.mock("@/lib/entitlements", () => ({
  resolveAiAccess: usageRouteMocks.resolveAiAccess,
  getEffectiveEntitlements: usageRouteMocks.getEffectiveEntitlements,
}))
vi.mock("@jobcopilot/shared/llm", () => ({ loadWorkerAiConfig: usageRouteMocks.loadWorkerAiConfig }))

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
type PgQueryFailure = {
  readonly code: string | null
  readonly message: string
  readonly position: string | null
  readonly sql: string
}

function queryText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const text = (value as { text?: unknown }).text
  return typeof text === "string" ? text : null
}

function pgQueryFailure(error: unknown, sql: string): PgQueryFailure {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {}
  return {
    code: typeof value.code === "string" ? value.code : null,
    message: typeof value.message === "string" ? value.message.slice(0, 500) : "Unknown PostgreSQL error",
    position: typeof value.position === "string" ? value.position : null,
    // Keep statement text only. Never retain pg's bind values or model/tool payloads.
    sql: sql.slice(0, 4_000),
  }
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
    {
      sessionId: `p1-subagent-session-a-second-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-second-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-second-${suffix}`,
      rootTaskId: `p1-subagent-root-a-second-${suffix}`,
      taskId: `p1-subagent-task-a-second-${suffix}`,
    },
    {
      sessionId: `p1-subagent-session-a-usage-one-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-usage-one-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-usage-one-${suffix}`,
      rootTaskId: `p1-subagent-root-a-usage-one-${suffix}`,
      taskId: `p1-subagent-task-a-usage-one-${suffix}`,
    },
    {
      sessionId: `p1-subagent-session-a-usage-two-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-usage-two-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-usage-two-${suffix}`,
      rootTaskId: `p1-subagent-root-a-usage-two-${suffix}`,
      taskId: `p1-subagent-task-a-usage-two-${suffix}`,
    },
    {
      sessionId: `p1-subagent-session-a-dispatch-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-dispatch-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-dispatch-${suffix}`,
      rootTaskId: `p1-subagent-root-a-dispatch-${suffix}`,
      taskId: `p1-subagent-task-a-dispatch-${suffix}`,
    },
    {
      sessionId: `p1-subagent-session-a-recovery-${suffix}`,
      turns: [{ id: `p1-subagent-turn-a-recovery-${suffix}`, status: "in_progress" }],
      turnId: `p1-subagent-turn-a-recovery-${suffix}`,
      rootTaskId: `p1-subagent-root-a-recovery-${suffix}`,
      taskId: `p1-subagent-task-a-recovery-${suffix}`,
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
    VALUES ($1, $2, $3, $4, $4, $5, 1, 'scout', 'research', 'queued', 'P1 PostgreSQL subagent fencing test', '{}'::jsonb, '[]'::jsonb, '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`, [
    taskId, tree.sessionId, turnId, tree.rootTaskId, `/root/${label}`,
  ])
}

async function installTestTenantRls(pool: PgPool): Promise<void> {
  await pool.query(`CREATE OR REPLACE FUNCTION public.app_current_user_id()
    RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$`)
  await pool.query(`ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE "agent_turns" ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE "sub_agent_tasks" ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE "agent_steps" ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY`)

  await pool.query(`DROP POLICY IF EXISTS candidate_agent_session_isolation ON "agent_sessions"`)
  await pool.query(`CREATE POLICY candidate_agent_session_isolation ON "agent_sessions"
    USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id())`)
  await pool.query(`DROP POLICY IF EXISTS candidate_agent_turn_isolation ON "agent_turns"`)
  await pool.query(`CREATE POLICY candidate_agent_turn_isolation ON "agent_turns"
    USING ("userId" = app_current_user_id() AND EXISTS (
      SELECT 1 FROM "agent_sessions" session
      WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))
    WITH CHECK ("userId" = app_current_user_id() AND EXISTS (
      SELECT 1 FROM "agent_sessions" session
      WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))`)
  await pool.query(`DROP POLICY IF EXISTS candidate_sub_agent_task_isolation ON "sub_agent_tasks"`)
  await pool.query(`CREATE POLICY candidate_sub_agent_task_isolation ON "sub_agent_tasks"
    USING (EXISTS (
      SELECT 1 FROM "agent_sessions" session
      WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))
    WITH CHECK (EXISTS (
      SELECT 1 FROM "agent_sessions" session
      WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))`)
  await pool.query(`DROP POLICY IF EXISTS candidate_agent_step_isolation ON "agent_steps"`)
  await pool.query(`CREATE POLICY candidate_agent_step_isolation ON "agent_steps"
    USING (EXISTS (
      SELECT 1 FROM "agent_turns" turn
      WHERE turn."id" = "turnId" AND turn."userId" = app_current_user_id()))
    WITH CHECK (EXISTS (
      SELECT 1 FROM "agent_turns" turn
      WHERE turn."id" = "turnId" AND turn."userId" = app_current_user_id()))`)
  await pool.query(`DROP POLICY IF EXISTS candidate_ai_usage_event_isolation ON ai_usage_events`)
  await pool.query(`CREATE POLICY candidate_ai_usage_event_isolation ON ai_usage_events
    USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id())`)
  await pool.query(`DROP POLICY IF EXISTS candidate_ai_budget_isolation ON ai_budgets`)
  await pool.query(`CREATE POLICY candidate_ai_budget_isolation ON ai_budgets
    USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id())`)
}

async function setRuntimeIdentity(client: PoolClient, userId: string): Promise<void> {
  await client.query(`SET ROLE "${RUNTIME_ROLE}"`)
  await client.query("SELECT set_config('app.user_id', $1, false)", [userId])
}

function runtimePool(basePool: PgPool, userId: string, failures: PgQueryFailure[] = [], statements: string[] = []): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      const tracedClient = new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return (...args: unknown[]) => {
              const sql = queryText(args[0])
              if (sql) statements.push(sql)
              try {
                const result: unknown = Reflect.apply(target.query, target, args)
                return Promise.resolve(result).catch(error => {
                  if (sql) failures.push(pgQueryFailure(error, sql))
                  throw error
                })
              } catch (error) {
                if (sql) failures.push(pgQueryFailure(error, sql))
                throw error
              }
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      try {
        await setRuntimeIdentity(tracedClient, userId)
        return tracedClient
      } catch (error) {
        client.release()
        throw error
      }
    },
  }
}

type PrismaSqlShape = { readonly text: string; readonly values: readonly unknown[] }

function prismaSqlShape(query: unknown): PrismaSqlShape {
  if (!query || typeof query !== "object") throw new TypeError("Usage broker query was not a Prisma SQL object")
  const row = query as { text?: unknown; values?: unknown }
  if (typeof row.text !== "string" || !Array.isArray(row.values)) throw new TypeError("Usage broker query omitted parameterized SQL fields")
  return { text: row.text, values: row.values }
}

function createPgUsageDatabase(pool: PgSubagentPool) {
  return {
    async $transaction<T>(work: (tx: { $queryRaw<T>(query: unknown): Promise<T> }) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const result = await work({
          async $queryRaw<Row>(query: unknown): Promise<Row> {
            const statement = prismaSqlShape(query)
            const response = await client.query(statement.text, statement.values as never)
            return response.rows as Row
          },
        })
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}

type UsageSnapshot = {
  readonly ledger: readonly {
    id: string
    userId: string | null
    featureKey: string
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    status: string
    errorCode: string | null
    credentialSource: string
    runtime: string
  }[]
  readonly budgets: readonly { month: string; used: number; limit: number }[]
}

async function usageSnapshot(pool: PgPool, userId: string, month: string): Promise<UsageSnapshot> {
  const [ledger, budgets] = await Promise.all([
    pool.query<UsageSnapshot["ledger"][number]>(`SELECT id, user_id AS "userId", feature_key AS "featureKey",
      provider, model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
      estimated_cost_usd AS "estimatedCostUsd", status, error_code AS "errorCode",
      credential_source AS "credentialSource", runtime FROM ai_usage_events
      WHERE user_id = $1 ORDER BY id`, [userId]),
    pool.query<UsageSnapshot["budgets"][number]>(`SELECT month, used, "limit" FROM ai_budgets
      WHERE user_id = $1 AND month = $2 ORDER BY month`, [userId, month]),
  ])
  return { ledger: ledger.rows, budgets: budgets.rows }
}

function utcMonth(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

describeWithPostgres("PostgreSQL subagent claim and attempt fencing (P1 acceptance slice)", () => {
  const policy = { ...defaultSubagentPolicy(), maxConcurrency: 8 }
  const [fenceTree, treeA, treeAOther, usageTreeA, usageTreeB] = userA.trees
  const dispatchTree = userA.trees[5]
  const recoveryTree = userA.trees[6]
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
    await installTestTenantRls(adminPool)
    await adminPool.query(`GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ("id", "sessionId", "toTaskId", "turnId", "consumedAt", "targetAttemptCount", "kind", "createdAt") ON "agent_mailbox_messages" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("consumedAt") ON "agent_mailbox_messages" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ON "agent_wait_conditions" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("status", "leaseOwner", "leaseExpiresAt", "leaseSegmentStartedAt", "attemptCount", "startedAt", "updatedAt", "result", "failureReason", "nextAttemptAt", "completedAt") ON "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT ON "agent_outbox" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("publishedAt", "attemptCount", "lastError", "payload") ON "agent_outbox" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON "agent_steps", "agent_items", "agent_events", "agent_tree_budget_reservations" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE ON ai_usage_events, ai_budgets TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT INSERT ON "agent_outbox" TO ${RUNTIME_ROLE}`)
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
      await adminPool.query(`DELETE FROM ai_usage_events WHERE user_id = ANY($1::text[])`, [[userA.userId, userB.userId]])
      await adminPool.query(`DELETE FROM ai_budgets WHERE user_id = ANY($1::text[])`, [[userA.userId, userB.userId]])
      await adminPool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[userA.userId, userB.userId]])
      await adminPool.end()
    }
  })

  it("claims only the matching owner, session, and turn, then rejects stale owner and attempt finishes", async () => {
    const roleProbe = await ownerAPool!.connect()
    try {
      await setRuntimeIdentity(roleProbe, userA.userId)
      const result = await roleProbe.query<{
        tableName: string
        isSuperuser: boolean
        bypassesRls: boolean
        ownsTable: boolean
        tableRlsEnabled: boolean
        rowSecurityActive: boolean
      }>(`SELECT role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          relation.relname AS "tableName", pg_get_userbyid(relation.relowner) = current_user AS "ownsTable",
          relation.relrowsecurity AS "tableRlsEnabled", row_security_active(relation.oid) AS "rowSecurityActive"
        FROM pg_roles role CROSS JOIN pg_class AS relation
        WHERE role.rolname = current_user AND relation.oid = ANY(ARRAY[
          'agent_sessions'::regclass, 'agent_turns'::regclass, 'agent_wait_conditions'::regclass, 'sub_agent_tasks'::regclass,
          'agent_steps'::regclass, 'ai_usage_events'::regclass, 'ai_budgets'::regclass
        ]) ORDER BY relation.relname`)
      expect(result.rows).toEqual(["agent_sessions", "agent_turns", "agent_wait_conditions", "sub_agent_tasks", "agent_steps", "ai_usage_events", "ai_budgets"].sort().map(tableName => ({
        tableName,
        isSuperuser: false,
        bypassesRls: false,
        ownsTable: false,
        tableRlsEnabled: true,
        rowSecurityActive: true,
      })))
      const deadlinePrivileges = await roleProbe.query<{ leaseSegmentUpdate: boolean; absoluteDeadlineUpdate: boolean }>(`SELECT
          has_column_privilege(current_user, 'public."sub_agent_tasks"', 'leaseSegmentStartedAt', 'UPDATE') AS "leaseSegmentUpdate",
          has_column_privilege(current_user, 'public."sub_agent_tasks"', 'absoluteDeadlineAt', 'UPDATE') AS "absoluteDeadlineUpdate"`)
      expect(deadlinePrivileges.rows[0]).toEqual({ leaseSegmentUpdate: true, absoluteDeadlineUpdate: false })
    } finally {
      roleProbe.release()
    }

    expect(await ownerAStore.get(treeA!.taskId, treeAOther!.sessionId)).toBeNull()
    await expect(ownerAStore.claim({ taskId: treeA!.taskId, sessionId: treeAOther!.sessionId, ownerId: "wrong-session-worker", policy, now: new Date() })).resolves.toBeNull()
    await expect(ownerAStore.claim({ taskId: fenceTree!.mismatchTurnTaskId!, sessionId: fenceTree!.sessionId, ownerId: "wrong-turn-worker", policy, now: new Date() })).resolves.toBeNull()
    const mismatchedTurn = await adminPool!.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null }>(
      `SELECT "status", "attemptCount", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [fenceTree!.mismatchTurnTaskId, fenceTree!.sessionId],
    )
    expect(mismatchedTurn.rows[0]).toMatchObject({ status: "queued", attemptCount: 0, leaseOwner: null, leaseExpiresAt: null })
    await expect(ownerBStore.get(fenceTree!.taskId, fenceTree!.sessionId)).resolves.toBeNull()
    await expect(ownerBStore.claim({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "foreign-owner-worker", policy, now: new Date() })).resolves.toBeNull()

    const firstLease = await ownerAStore.claim({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-before-release", policy, now: new Date() })
    expect(firstLease).toMatchObject({ status: "running", leaseOwner: "worker-before-release", attemptCount: 1 })
    await expect(ownerBStore.finish({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-before-release", attemptCount: 1, status: "completed", result: { source: "foreign-owner" }, now: new Date() })).resolves.toBeNull()

    await expect(ownerAStore.release({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-before-release", attemptCount: 1, now: new Date() })).resolves.toBe(true)
    const secondLease = await ownerAStore.claim({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-after-release", policy, now: new Date() })
    expect(secondLease).toMatchObject({ status: "running", leaseOwner: "worker-after-release", attemptCount: 2 })

    await expect(ownerAStore.finish({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-before-release", attemptCount: 1, status: "completed", result: { source: "stale-owner-and-attempt" }, now: new Date() })).resolves.toBeNull()
    await expect(ownerAStore.finish({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-after-release", attemptCount: 1, status: "completed", result: { source: "stale-attempt" }, now: new Date() })).resolves.toBeNull()
    const unchanged = await adminPool!.query<{ status: string; leaseOwner: string; attemptCount: number; result: unknown }>(
      `SELECT "status", "leaseOwner", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [fenceTree!.taskId, fenceTree!.sessionId],
    )
    expect(unchanged.rows[0]).toMatchObject({ status: "running", leaseOwner: "worker-after-release", attemptCount: 2, result: null })

    await expect(ownerAStore.finish({ taskId: fenceTree!.taskId, sessionId: fenceTree!.sessionId, ownerId: "worker-after-release", attemptCount: 2, status: "completed", result: { source: "current-attempt" }, now: new Date() })).resolves.toBe("completed")
    const completed = await adminPool!.query<{ status: string; attemptCount: number; result: unknown }>(
      `SELECT "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [fenceTree!.taskId, fenceTree!.sessionId],
    )
    expect(completed.rows[0]).toMatchObject({ status: "completed", attemptCount: 2, result: { source: "current-attempt" } })
  })

  it("binds claims to the currently published Bull generation and exact outbox owner tuple", async () => {
    const tree = dispatchTree!
    const ownerId = `dispatch-owner-${suffix}`
    const payload: SubagentJobPayload = { taskId: tree.taskId, sessionId: tree.sessionId, rootTaskId: tree.rootTaskId, ownerId }
    const publicationPool = runtimePool(ownerAPool!, userA.userId)
    const dispatchKey = `subagent-dispatch:${tree.taskId}`
    const publishPersistedGeneration = async () => {
      const published = await adminPool!.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
        "attemptCount" = "attemptCount" + 1, "lastError" = NULL
        WHERE "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`, [tree.sessionId, dispatchKey])
      expect(published.rowCount).toBe(1)
      const current = await adminPool!.query<{ attemptCount: number }>(`SELECT "attemptCount" FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey])
      const attemptCount = Number(current.rows[0]?.attemptCount)
      const identity = parseSubagentDispatchJobId(subagentDispatchJobId(tree.taskId, attemptCount - 1), tree.taskId)
      if (!identity) throw new Error("The persisted published generation did not parse")
      return identity
    }
    try {
      await persistSubagentDispatch(publicationPool, payload)
      const firstIdentity = await publishPersistedGeneration()
      expect(firstIdentity).toEqual({ jobId: subagentDispatchJobId(tree.taskId, 0), taskId: tree.taskId, generation: 0 })

      const firstLease = await ownerAStore.claim({ ...payload, dispatchIdentity: firstIdentity, policy, now: new Date() })
      expect(firstLease).toMatchObject({ status: "running", leaseOwner: ownerId, attemptCount: 1 })
      await expect(ownerAStore.release({ taskId: tree.taskId, sessionId: tree.sessionId, ownerId, attemptCount: 1, now: new Date() })).resolves.toBe(true)
      const currentIdentity = await publishPersistedGeneration()
      expect(currentIdentity).toEqual({ jobId: subagentDispatchJobId(tree.taskId, 2), taskId: tree.taskId, generation: 2 })

      const readState = async () => {
        const [task, dispatch, graphEvents] = await Promise.all([
          adminPool!.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null }>(`SELECT "status", "attemptCount", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [tree.taskId, tree.sessionId]),
          adminPool!.query<{ payload: unknown; publishedAt: Date | null; attemptCount: number; lastError: string | null }>(`SELECT "payload", "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey]),
          adminPool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`, [tree.sessionId, tree.turnId, tree.taskId]),
        ])
        return { task: task.rows[0], dispatch: dispatch.rows[0], graphEventCount: graphEvents.rows[0]?.count }
      }

      const beforeStale = await readState()
      expect(beforeStale.task).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null })
      expect(beforeStale.dispatch).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 3, lastError: null, payload })
      await expect(ownerAStore.claim({ ...payload, dispatchIdentity: firstIdentity, policy, now: new Date() }))
        .rejects.toBeInstanceOf(SubagentDispatchIdentityMismatchError)
      await expect(ownerAStore.claim({ ...payload, ownerId: "wrong-owner", dispatchIdentity: currentIdentity, policy, now: new Date() }))
        .rejects.toBeInstanceOf(SubagentDispatchIdentityMismatchError)
      await expect(readState()).resolves.toEqual(beforeStale)

      const publishedAt = beforeStale.dispatch?.publishedAt
      await adminPool!.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey])
      const unpublishedBefore = await readState()
      await expect(ownerAStore.claim({ ...payload, dispatchIdentity: currentIdentity, policy, now: new Date() }))
        .rejects.toBeInstanceOf(SubagentDispatchIdentityMismatchError)
      await expect(readState()).resolves.toEqual(unpublishedBefore)
      await adminPool!.query(`UPDATE "agent_outbox" SET "publishedAt" = $3 WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey, publishedAt])

      const validPayload = beforeStale.dispatch?.payload
      await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = $3::jsonb WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey, JSON.stringify({ ...payload, extra: true })])
      const malformedBefore = await readState()
      await expect(ownerAStore.claim({ ...payload, dispatchIdentity: currentIdentity, policy, now: new Date() }))
        .rejects.toBeInstanceOf(SubagentDispatchIdentityMismatchError)
      await expect(readState()).resolves.toEqual(malformedBefore)
      await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = $3::jsonb WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey, JSON.stringify(validPayload)])

      await expect(ownerAStore.claim({ ...payload, dispatchIdentity: currentIdentity, policy, now: new Date() }))
        .resolves.toMatchObject({ status: "running", leaseOwner: ownerId, attemptCount: 2 })
    } finally {
      await adminPool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey])
    }
  })

  it("clears only an old publication whose exact Bull job is missing and whose owner fence stays current", async () => {
    const tree = recoveryTree!
    const ownerId = `missing-job-owner-${suffix}`
    const dispatchKey = `subagent-dispatch:${tree.taskId}`
    const pauseKey = `missing-job-pause-${suffix}`
    const payload: SubagentJobPayload = { taskId: tree.taskId, sessionId: tree.sessionId, rootTaskId: tree.rootTaskId, ownerId }
    const workerStatements: string[] = []
    const recoveryPool = runtimePool(ownerAPool!, userA.userId, [], workerStatements)

    const resetCandidate = async () => {
      await adminPool!.query(`DELETE FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [tree.sessionId, tree.turnId, pauseKey])
      await adminPool!.query(`UPDATE "agent_sessions" SET "userId" = $2, "status" = 'running' WHERE "id" = $1`, [tree.sessionId, userA.userId])
      await adminPool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $3, "status" = 'in_progress' WHERE "id" = $1 AND "sessionId" = $2`, [tree.turnId, tree.sessionId, tree.rootTaskId])
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "interruptRequestedAt" = NULL WHERE "id" = $1`, [tree.rootTaskId])
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "attemptCount" = 0, "startedAt" = NULL,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "interruptRequestedAt" = NULL, "nextAttemptAt" = NULL,
        "result" = NULL, "failureReason" = NULL WHERE "id" = $1 AND "sessionId" = $2`, [tree.taskId, tree.sessionId])
      const dispatch = await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = $3::jsonb,
        "publishedAt" = CURRENT_TIMESTAMP - INTERVAL '31 seconds', "attemptCount" = 1, "lastError" = NULL
        WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey, JSON.stringify(payload)])
      expect(dispatch.rowCount).toBe(1)
    }
    const readState = async () => {
      const [session, turn, tasks, dispatch, events] = await Promise.all([
        adminPool!.query(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1`, [tree.sessionId]),
        adminPool!.query(`SELECT "rootTaskId", "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [tree.turnId, tree.sessionId]),
        adminPool!.query(`SELECT "id", "status", "attemptCount", "startedAt", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "result", "failureReason"
          FROM "sub_agent_tasks" WHERE "sessionId" = $1 ORDER BY "id"`, [tree.sessionId]),
        adminPool!.query(`SELECT "payload", "publishedAt", "attemptCount", "lastError" FROM "agent_outbox"
          WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey]),
        adminPool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2`, [tree.sessionId, tree.turnId]),
      ])
      return { session: session.rows[0], turn: turn.rows[0], tasks: tasks.rows, dispatch: dispatch.rows[0], eventCount: events.rows[0]?.count }
    }

    try {
      await persistSubagentDispatch(recoveryPool, payload)
      await resetCandidate()
      const before = await readState()
      expect(before.turn).toEqual({ rootTaskId: tree.rootTaskId, status: "in_progress" })
      expect(before.dispatch).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, payload })
      let probeWasOutsideTransaction = false
      const probes: string[] = []
      const cleared = await recoverMissingPublishedSubagentDispatches(recoveryPool, {
        getJob: async jobId => {
          probes.push(jobId)
          probeWasOutsideTransaction = workerStatements.at(-1) === "COMMIT"
          return null
        },
      })
      expect(cleared).toBe(1)
      expect(probes).toEqual([subagentDispatchJobId(tree.taskId, 0)])
      expect(probeWasOutsideTransaction).toBe(true)
      expect(workerStatements.filter(sql => sql.startsWith('UPDATE "agent_outbox" AS dispatch SET "publishedAt" = NULL'))).toHaveLength(1)
      const after = await readState()
      expect(after).toEqual({ ...before, dispatch: { ...before.dispatch, publishedAt: null } })

      const raceCases: Array<{ name: string; mutate: () => Promise<void> }> = [
        { name: "payload owner", mutate: async () => { await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = jsonb_set("payload", '{ownerId}', to_jsonb('new-owner'::text)) WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey]) } },
        { name: "generation", mutate: async () => { await adminPool!.query(`UPDATE "agent_outbox" SET "attemptCount" = 2 WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey]) } },
        { name: "publication", mutate: async () => { await adminPool!.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey]) } },
        { name: "started", mutate: async () => { await adminPool!.query(`UPDATE "sub_agent_tasks" SET "startedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [tree.taskId]) } },
        { name: "attempt", mutate: async () => { await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1 WHERE "id" = $1`, [tree.taskId]) } },
        { name: "running", mutate: async () => { await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`, [tree.taskId]) } },
        { name: "paused session", mutate: async () => { await adminPool!.query(`UPDATE "agent_sessions" SET "status" = 'paused' WHERE "id" = $1`, [tree.sessionId]) } },
        { name: "session owner", mutate: async () => { await adminPool!.query(`UPDATE "agent_sessions" SET "userId" = $2 WHERE "id" = $1`, [tree.sessionId, userB!.userId]) } },
        { name: "terminal root", mutate: async () => { await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed' WHERE "id" = $1`, [tree.rootTaskId]) } },
        { name: "root interrupt", mutate: async () => { await adminPool!.query(`UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [tree.rootTaskId]) } },
        { name: "terminal Turn", mutate: async () => { await adminPool!.query(`UPDATE "agent_turns" SET "status" = 'completed' WHERE "id" = $1`, [tree.turnId]) } },
        { name: "Turn root binding", mutate: async () => { await adminPool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $3 WHERE "id" = $1 AND "sessionId" = $2`, [tree.turnId, tree.sessionId, tree.taskId]) } },
        { name: "pause request", mutate: async () => {
          const sequence = await adminPool!.query<{ sequence: string }>(`SELECT (COALESCE(MAX("sequence"), 0) + 1)::text AS "sequence" FROM "agent_events" WHERE "sessionId" = $1`, [tree.sessionId])
          await adminPool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
            VALUES ($1, $2, $3, NULL, NULL, $4, 'session.pause_requested', 'user', $3, $5, '{}'::jsonb)`,
          [randomUUID(), tree.sessionId, tree.turnId, sequence.rows[0]!.sequence, pauseKey])
        } },
      ]
      for (const race of raceCases) {
        await resetCandidate()
        const calls: string[] = []
        let stateAtProbe: unknown
        let outsideTransaction = false
        workerStatements.length = 0
        const result = await recoverMissingPublishedSubagentDispatches(recoveryPool, {
          getJob: async jobId => {
            calls.push(jobId)
            outsideTransaction = workerStatements.at(-1) === "COMMIT"
            await race.mutate()
            stateAtProbe = await readState()
            return null
          },
        })
        expect(result, race.name).toBe(0)
        expect(calls, race.name).toEqual([subagentDispatchJobId(tree.taskId, 0)])
        expect(outsideTransaction, race.name).toBe(true)
        expect(stateAtProbe, race.name).toBeDefined()
        expect(await readState(), race.name).toEqual(stateAtProbe)
        expect(workerStatements.filter(sql => sql.startsWith('UPDATE "agent_outbox" AS dispatch SET "publishedAt" = NULL')), race.name).toHaveLength(0)
      }
    } finally {
      await adminPool!.query(`DELETE FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [tree.sessionId, tree.turnId, pauseKey])
      await adminPool!.query(`UPDATE "agent_sessions" SET "userId" = $2, "status" = 'running' WHERE "id" = $1`, [tree.sessionId, userA.userId])
      await adminPool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $3, "status" = 'in_progress' WHERE "id" = $1 AND "sessionId" = $2`, [tree.turnId, tree.sessionId, tree.rootTaskId])
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "interruptRequestedAt" = NULL WHERE "id" = $1`, [tree.rootTaskId])
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "attemptCount" = 0, "startedAt" = NULL,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "interruptRequestedAt" = NULL, "nextAttemptAt" = NULL,
        "result" = NULL, "failureReason" = NULL WHERE "id" = $1 AND "sessionId" = $2`, [tree.taskId, tree.sessionId])
      await adminPool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [tree.sessionId, dispatchKey])
    }
  })

  it("executes two real PostgreSQL child leases and preserves their separate root lineage", async () => {
    const executionTrees = [treeA!, treeAOther!]
    const expectedFinalTexts = new Map(executionTrees.map((tree, index) => [
      tree.taskId,
      `Found deterministic evidence for child ${index === 0 ? "A" : "B"}.`,
    ] as const))
    const queryFailures: PgQueryFailure[] = []
    const executionPool = runtimePool(ownerAPool!, userA.userId, queryFailures)
    const modelProfile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
      supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
    }
    const modelCalls = new Map<string, number>()
    const modelVisibleToolCatalogs = new Map<string, string[][]>()
    const searchTool: RuntimeToolDefinition = {
      schemaVersion, name: "jobs.search", version: "1", description: "Read fixture jobs",
      capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: true }),
      outputSchema: Type.Object({}, { additionalProperties: true }), risk: "read", domain: "jobs",
      idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: ["read"],
      async execute() { return { jobs: [{ id: "fixture-job" }] } },
    }
    const toolCalls: string[] = []
    const executor = createProductionChildExecutor({
      pool: executionPool as unknown as PgPool,
      turnStore: createPgTurnEngineStore(executionPool as never),
      treeBudget: createPgTreeBudgetReservationStore(executionPool as never),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => ({
        id: `pg-child-fixture-model-${task.id}`, profile: modelProfile,
        async *stream(request: HarnessModelRequest) {
          const calls = (modelCalls.get(task.id) ?? 0) + 1
          modelCalls.set(task.id, calls)
          const toolNames = request.tools.flatMap(tool => {
            if (!tool || typeof tool !== "object" || Array.isArray(tool)) return []
            const name = (tool as { name?: unknown }).name
            return typeof name === "string" ? [name] : []
          })
          modelVisibleToolCatalogs.set(task.id, [...(modelVisibleToolCatalogs.get(task.id) ?? []), toolNames])
          if (calls === 1) {
            yield { type: "tool_call_completed", callId: `pg-child-read-${task.id}`, name: "jobs.search", arguments: {} }
            yield { type: "completed", finishReason: "tool_calls" }
          } else {
            const finalText = expectedFinalTexts.get(task.id)
            if (!finalText) throw new Error("Unexpected child task in PostgreSQL fixture")
            yield { type: "text_delta", text: finalText }
            yield { type: "completed", finishReason: "stop" }
          }
        },
      }),
      toolRuntimeFactory: ({ task }) => ({
        definitions: [searchTool],
        router: { async execute(_context, request) {
          toolCalls.push(`${task.id}:${request.toolName}`)
          return { ...request, status: "completed", output: { jobs: [{ id: `fixture-job-${task.id}` }] }, errorCode: null }
        } },
        validateArguments: () => true,
      }),
      resumeLoader: async () => undefined,
    })
    const manager = new (await import("./manager.js")).AgentTreeManager(ownerAStore)
    const payloads = executionTrees.map((tree, index) => ({ taskId: tree.taskId, sessionId: tree.sessionId, rootTaskId: tree.rootTaskId, ownerId: `pg-production-child-worker-${index + 1}` }))
    try {
      for (const payload of payloads) {
        const outcome = await manager.run(payload, executor)
        const task = await ownerAStore.get(payload.taskId, payload.sessionId)
        const diagnostic = {
          taskId: payload.taskId,
          outcomeStatus: outcome.status,
          taskStatus: task?.status,
          failureReason: task?.failureReason,
          attemptCount: task?.attemptCount,
          modelCalls: modelCalls.get(payload.taskId) ?? 0,
          toolCalls: toolCalls.filter(call => call.startsWith(`${payload.taskId}:`)).length,
          pgQueryFailures: queryFailures.slice(-2),
        }
        expect(outcome, JSON.stringify(diagnostic)).toMatchObject({ taskId: payload.taskId, status: "completed" })
      }
      const storedTasks = await Promise.all(executionTrees.map(tree => ownerAStore.get(tree.taskId, tree.sessionId)))
      expect(storedTasks).toEqual(executionTrees.map(tree => expect.objectContaining({
        id: tree.taskId, status: "completed", attemptCount: 1,
        result: expect.objectContaining({
          status: "completed", stepCount: 2, toolCallCount: 1, finalText: expectedFinalTexts.get(tree.taskId),
        }),
      })))
      expect(modelCalls).toEqual(new Map(executionTrees.map(tree => [tree.taskId, 2])))
      for (const tree of executionTrees) {
        expect(modelVisibleToolCatalogs.get(tree.taskId)).toEqual([["jobs.search"], ["jobs.search"]])
      }
      expect(toolCalls).toEqual(executionTrees.map(tree => `${tree.taskId}:jobs.search`))
      for (let index = 0; index < executionTrees.length; index += 1) {
        const tree = executionTrees[index]!
        expect(await ownerBStore.get(tree.taskId, tree.sessionId)).toBeNull()
        await expect(ownerBStore.claim({ taskId: tree.taskId, sessionId: tree.sessionId, ownerId: `foreign-child-worker-${index + 1}`, policy, now: new Date() })).resolves.toBeNull()
      }
      await expect(ownerBStore.finish({ taskId: executionTrees[0]!.taskId, sessionId: executionTrees[0]!.sessionId, ownerId: payloads[0]!.ownerId, attemptCount: 1, status: "completed", result: { source: "foreign-owner" }, now: new Date() })).resolves.toBeNull()

      for (const tree of executionTrees) {
        const taskId = tree.taskId
        const steps = await adminPool!.query<{ id: string; taskId: string; attempt: number; status: string }>(
          `SELECT "id", "taskId", "attempt", "status" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "ordinal"`,
          [tree.sessionId, tree.turnId, taskId],
        )
        expect(steps.rows).toHaveLength(2)
        expect(steps.rows.every(step => step.taskId === taskId && step.attempt === 1 && step.status === "completed")).toBe(true)
        const stepIds = new Set(steps.rows.map(step => step.id))
        expect(stepIds.size).toBe(2)

        const items = await adminPool!.query<{ id: string; stepId: string; taskId: string; type: string; status: string }>(
          `SELECT "id", "stepId", "taskId", "type", "status" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "createdAt", "id"`,
          [tree.sessionId, tree.turnId, taskId],
        )
        expect(items.rows.length).toBeGreaterThanOrEqual(3)
        expect(items.rows.every(item => item.taskId === taskId && stepIds.has(item.stepId) && item.status === "completed")).toBe(true)
        expect([...new Set(items.rows.map(item => item.stepId))].sort()).toEqual([...stepIds].sort())
        expect(items.rows.map(item => item.type)).toEqual(expect.arrayContaining(["tool_call", "tool_result", "agent_message"]))

        const events = await adminPool!.query<{ taskId: string; type: string; actor: string }>(
          `SELECT "taskId", "type", "actor" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3`,
          [tree.sessionId, tree.turnId, taskId],
        )
        expect(events.rows.length).toBeGreaterThan(0)
        expect(events.rows.every(event => event.taskId === taskId && event.actor === "subagent")).toBe(true)

        const reservations = await adminPool!.query<{ status: string; taskId: string; stepId: string; attempt: number }>(
          `SELECT "status", "taskId", "stepId", "attempt" FROM "agent_tree_budget_reservations" WHERE "sessionId" = $1 AND "rootTaskId" = $2 AND "taskId" = $3`,
          [tree.sessionId, tree.rootTaskId, taskId],
        )
        expect(reservations.rows).toHaveLength(2)
        expect(reservations.rows.every(reservation => reservation.status === "consumed"
          && reservation.taskId === taskId && stepIds.has(reservation.stepId) && reservation.attempt === 1)).toBe(true)
        expect([...new Set(reservations.rows.map(reservation => reservation.stepId))].sort()).toEqual([...stepIds].sort())

        const root = await adminPool!.query<{ status: string; result: unknown }>(
          `SELECT "status", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
          [tree.rootTaskId, tree.sessionId],
        )
        expect(root.rows[0]).toMatchObject({ status: "running", result: null })
      }
    } finally {
      await manager.shutdown()
    }
  }, 30_000)

  it("admits trusted Worker child usage through the real route and settles account credits idempotently", async () => {
    const executionPool = runtimePool(ownerAPool!, userA.userId)
    const usageMonth = utcMonth()
    const initialUserA = await usageSnapshot(adminPool!, userA.userId, usageMonth)
    const initialUserB = await usageSnapshot(adminPool!, userB.userId, usageMonth)
    expect(initialUserA).toEqual({ ledger: [], budgets: [] })
    expect(initialUserB).toEqual({ ledger: [], budgets: [] })

    usageRouteMocks.database = createPgUsageDatabase(executionPool)
    usageRouteMocks.resolveAiAccess.mockResolvedValue("allowed")
    usageRouteMocks.getEffectiveEntitlements.mockResolvedValue({ limits: { ai_credits: 10 } })
    usageRouteMocks.loadWorkerAiConfig.mockResolvedValue({
      provider: "fixture", model: "fixture-model", apiKey: "server-only-fixture-key",
    })
    vi.stubEnv("AGENT_WORKER_SECRET", "fixture-worker-secret")
    // @ts-expect-error The Worker Vitest alias resolves this allowlisted Web route at runtime.
    const { POST } = await import("@/app/api/internal/agent-runtime/usage/route")

    type BridgeBody = { operation?: string; input?: Record<string, unknown> }
    const requests: { body: BridgeBody; status: number; response: unknown }[] = []
    const operationIdByStep = new Map<string, string>()
    const bridge = createWorkerUsageAuthorizer({
      endpointUrl: "http://agent-fixture/api/internal/agent-runtime/usage",
      secret: "fixture-worker-secret",
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as BridgeBody
        const response = await POST(new Request(String(input), init) as never)
        const payload: unknown = await response.clone().json().catch(() => null)
        requests.push({ body, status: response.status, response: payload })
        if (body.operation === "authorize" && response.ok && typeof body.input?.stepId === "string" &&
            payload && typeof payload === "object" && "operationId" in payload && typeof payload.operationId === "string") {
          operationIdByStep.set(body.input.stepId, payload.operationId)
        }
        return response
      },
    })

    type CapturedUsage = {
      readonly input: WorkerUsageAuthorizationInput
      readonly operationId: string
      readonly reservation: Awaited<ReturnType<typeof bridge>>
      settlement?: WorkerUsageSettlementInput
    }
    const captured: CapturedUsage[] = []
    const inputByTask = new Map<string, WorkerUsageAuthorizationInput>()
    const staleFenceChecks = new Set<string>()
    const authorizeUsage = async (input: WorkerUsageAuthorizationInput) => {
      const owner = input.executionOwner
      if (!owner || owner.kind !== "task") throw new Error("Expected the production child task owner envelope")
      inputByTask.set(owner.taskId, input)
      // This untrusted field must be ignored: the route derives credential source
      // from the server-side config loaded for the user.
      const callerInput = Object.assign({}, input, { credentialSource: "platform" })
      const reservation = await bridge(callerInput)
      const operationId = operationIdByStep.get(input.stepId)
      if (!operationId) throw new Error("The real usage route returned no operation identity")
      const reserved = await adminPool!.query<{ status: string; userId: string | null; credentialSource: string; runtime: string }>(
        `SELECT status, user_id AS "userId", credential_source AS "credentialSource", runtime
          FROM ai_usage_events WHERE id = $1`, [operationId],
      )
      expect(reserved.rows).toEqual([{
        status: "reserved", userId: userA.userId, credentialSource: "user", runtime: "worker",
      }])
      const reservationCount = captured.length + 1
      const snapshot = await usageSnapshot(adminPool!, userA.userId, usageMonth)
      expect(snapshot.ledger.filter(row => row.status === "reserved")).toHaveLength(1)
      expect(snapshot.budgets).toEqual([{ month: usageMonth, used: reservationCount, limit: 10 }])
      const entry: CapturedUsage = { input, operationId, reservation }
      captured.push(entry)
      return {
        settle: async (settlement: WorkerUsageSettlementInput) => {
          await reservation.settle(settlement)
          entry.settlement = settlement
          const settled = await adminPool!.query<{
            status: string; userId: string | null; inputTokens: number; outputTokens: number; estimatedCostUsd: number
          }>(`SELECT status, user_id AS "userId", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              estimated_cost_usd AS "estimatedCostUsd" FROM ai_usage_events WHERE id = $1`, [operationId])
          expect(settled.rows).toEqual([{
            status: "success", userId: userA.userId, inputTokens: settlement.inputTokens,
            outputTokens: settlement.outputTokens, estimatedCostUsd: settlement.estimatedCostUsd,
          }])
        },
      }
    }

    const modelProfile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
      supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
    }
    const modelCalls = new Map<string, number>()
    const searchTool: RuntimeToolDefinition = {
      schemaVersion, name: "jobs.search", version: "1", description: "Read fixture jobs",
      capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: true }),
      outputSchema: Type.Object({}, { additionalProperties: true }), risk: "read", domain: "jobs",
      idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: ["read"],
      async execute() { return { jobs: [{ id: "usage-fixture-job" }] } },
    }
    const executor = createProductionChildExecutor({
      pool: executionPool as unknown as PgPool,
      turnStore: createPgTurnEngineStore(executionPool as never),
      treeBudget: createPgTreeBudgetReservationStore(executionPool as never),
      authorizeUsage,
      modelRuntimeFactory: ({ task }) => ({
        id: `usage-fixture-model-${task.id}`, profile: modelProfile,
        async *stream(_request: HarnessModelRequest) {
          const calls = (modelCalls.get(task.id) ?? 0) + 1
          modelCalls.set(task.id, calls)
          if (calls === 1 && staleFenceChecks.size === 0) {
            const current = inputByTask.get(task.id)
            if (!current?.executionOwner || current.executionOwner.kind !== "task") throw new Error("Missing current child usage owner")
            const before = await usageSnapshot(adminPool!, userA.userId, usageMonth)
            await expect(bridge({
              ...current,
              executionOwner: { ...current.executionOwner, attemptCount: current.executionOwner.attemptCount + 1 },
            })).rejects.toMatchObject({ code: "usage_fence_rejected" })
            expect(await usageSnapshot(adminPool!, userA.userId, usageMonth)).toEqual(before)
            staleFenceChecks.add(task.id)
          }
          if (calls === 1) {
            yield { type: "tool_call_completed", callId: `usage-child-read-${task.id}`, name: "jobs.search", arguments: {} }
            yield { type: "usage", inputTokens: 21, outputTokens: 4, estimatedCostUsd: 0.002 }
            yield { type: "completed", finishReason: "tool_calls" }
          } else {
            yield { type: "text_delta", text: `Trusted usage recorded for ${task.id}.` }
            yield { type: "usage", inputTokens: 22, outputTokens: 5, estimatedCostUsd: 0.003 }
            yield { type: "completed", finishReason: "stop" }
          }
        },
      }),
      toolRuntimeFactory: ({ task }) => ({
        definitions: [searchTool],
        router: { async execute(_context, request) {
          return { ...request, status: "completed", output: { jobs: [{ id: `usage-fixture-${task.id}` }] }, errorCode: null }
        } },
        validateArguments: () => true,
      }),
      resumeLoader: async () => undefined,
    })
    const manager = new (await import("./manager.js")).AgentTreeManager(ownerAStore)
    const executionTrees = [usageTreeA!, usageTreeB!]
    const payloads = executionTrees.map((tree, index) => ({
      taskId: tree.taskId, sessionId: tree.sessionId, rootTaskId: tree.rootTaskId,
      ownerId: `pg-usage-child-worker-${index + 1}`,
    }))

    try {
      for (const payload of payloads) {
        await expect(manager.run(payload, executor)).resolves.toMatchObject({ taskId: payload.taskId, status: "completed" })
      }
      expect(modelCalls).toEqual(new Map(executionTrees.map(tree => [tree.taskId, 2])))
      expect(staleFenceChecks).toEqual(new Set([executionTrees[0]!.taskId]))
      expect(captured).toHaveLength(4)
      expect(new Set(captured.map(value => value.input.stepId)).size).toBe(4)
      expect(new Set(captured.map(value => value.operationId)).size).toBe(4)
      expect(captured.map(value => value.settlement)).toEqual(expect.arrayContaining([
        { status: "success", inputTokens: 21, outputTokens: 4, estimatedCostUsd: 0.002 },
        { status: "success", inputTokens: 22, outputTokens: 5, estimatedCostUsd: 0.003 },
      ]))

      const completedSnapshot = await usageSnapshot(adminPool!, userA.userId, usageMonth)
      expect(completedSnapshot.ledger).toHaveLength(4)
      expect(completedSnapshot.ledger.map(row => row.id).sort()).toEqual(captured.map(value => value.operationId).sort())
      expect(completedSnapshot.ledger.every(row => row.status === "success" && row.userId === userA.userId &&
        row.featureKey === "autoApply" && row.provider === "fixture" && row.model === "fixture-model" &&
        row.credentialSource === "user" && row.runtime === "worker" && row.errorCode === null)).toBe(true)
      expect(completedSnapshot.budgets).toEqual([{ month: usageMonth, used: 4, limit: 10 }])

      const replay = captured[0]!
      expect(replay.settlement).toBeDefined()
      const beforeReplay = await usageSnapshot(adminPool!, userA.userId, usageMonth)
      await replay.reservation.settle(replay.settlement!)
      expect(await usageSnapshot(adminPool!, userA.userId, usageMonth)).toEqual(beforeReplay)

      const beforeForeign = await Promise.all([
        usageSnapshot(adminPool!, userA.userId, usageMonth), usageSnapshot(adminPool!, userB.userId, usageMonth),
      ])
      await expect(bridge({ ...captured[0]!.input, userId: userB.userId })).rejects.toMatchObject({ code: "usage_fence_rejected" })
      await expect(bridge({ ...captured[0]!.input, provider: "caller-provider", model: "caller-model" }))
        .rejects.toMatchObject({ code: "model_not_authorized" })
      expect(await Promise.all([
        usageSnapshot(adminPool!, userA.userId, usageMonth), usageSnapshot(adminPool!, userB.userId, usageMonth),
      ])).toEqual(beforeForeign)

      const authorizeRequests = requests.filter(request => request.body.operation === "authorize")
      expect(authorizeRequests.filter(request => request.status === 200)).toHaveLength(4)
      expect(authorizeRequests.filter(request => request.status === 409).map(request => request.response)).toEqual([
        expect.objectContaining({ code: "usage_fence_rejected" }),
        expect.objectContaining({ code: "usage_fence_rejected" }),
      ])
      expect(authorizeRequests.filter(request => request.status === 403).map(request => request.response)).toEqual([
        expect.objectContaining({ code: "model_not_authorized" }),
      ])
      expect(requests.filter(request => request.body.operation === "settle")).toHaveLength(5)
      expect(authorizeRequests.filter(request => request.status === 200).every(request => request.body.input?.credentialSource === "platform")).toBe(true)
      expect(requests.every(request => !Object.prototype.hasOwnProperty.call(request.body.input ?? {}, "apiKey"))).toBe(true)
      expect(JSON.stringify(requests)).not.toContain("server-only-fixture-key")
    } finally {
      await manager.shutdown()
      vi.unstubAllEnvs()
    }
  }, 60_000)
})
