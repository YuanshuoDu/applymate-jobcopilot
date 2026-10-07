import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"

import { SessionPauseRequestedError } from "../session-gate.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy } from "./types.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native TaskGraph PostgreSQL tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native TaskGraph PostgreSQL tests require the dedicated disposable CI URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `native-command-user-${suffix}`, session: `native-command-session-${suffix}`,
  turn: `native-command-turn-${suffix}`, root: `native-command-root-${suffix}`,
  foreignTurn: `native-command-foreign-turn-${suffix}`, foreignRoot: `native-command-foreign-root-${suffix}`,
  step: `native-command-step-${suffix}`, turnOwner: `native-turn-owner-${suffix}`,
  taskOwner: `native-task-owner-${suffix}`,
}
const commandRole = `replacement_command_${suffix.replaceAll("-", "")}`
const claimRole = `replacement_claim_test_${suffix.replaceAll("-", "")}`
const rlsPrefix = `replacement_${suffix.replaceAll("-", "").slice(0, 18)}`
const commandApplicationName = `repl_cmd_${suffix}`
const claimApplicationName = `repl_claim_${suffix}`
const scope: TaskGraphNativeCommandInput["scope"] = {
  userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
  stepId: ids.step, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
  parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
}
let pool: PgPool | undefined
let commandBasePool: PgPool | undefined
let claimBasePool: PgPool | undefined
const originalRls = new Map<string, boolean>()
const createdRoles: string[] = []
let dropUserIdFunction = false
let overflowCandidateId: string | undefined
const command = () => createPgTaskGraphCommandPort(pool as unknown as PgSubagentPool)
const restrictedCommand = () => createPgTaskGraphCommandPort(restrictedTransactionPool(commandBasePool!, commandRole, ids.user))
const restrictedClaimStore = () => new PgSubagentTaskStore(restrictedTransactionPool(claimBasePool!, claimRole, ids.user))
const spawn = (key: string): TaskGraphNativeCommandInput => ({
  scope, request: {
    kind: "spawn", idempotencyKey: key, role: "auditor", taskType: "audit",
    goal: `Inspect ${key}`, constraints: ["read only"], successCriteria: ["record findings"],
    context: { privateCallerContext: key },
  },
})

const TENANT_TABLES = ["agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox"] as const
const TENANT_POLICIES: ReadonlyArray<readonly [typeof TENANT_TABLES[number], string]> = [
  ["agent_sessions", `"userId" = public.app_current_user_id()`],
  ["agent_turns", `"userId" = public.app_current_user_id() AND EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["sub_agent_tasks", `EXISTS (SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_steps", `EXISTS (SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_items", `EXISTS (SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_events", `EXISTS (SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_outbox", `EXISTS (SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "aggregateId" AND session."userId" = public.app_current_user_id())`],
]

async function installRestrictedRoles(): Promise<void> {
  const rls = await pool!.query<{ tableName: string; enabled: boolean }>(`SELECT relname AS "tableName", relrowsecurity AS enabled
    FROM pg_class WHERE oid = ANY(ARRAY[${TENANT_TABLES.map(table => `'public."${table}"'::regclass`).join(",")}])`)
  for (const table of TENANT_TABLES) {
    const enabled = rls.rows.find(row => row.tableName === table)?.enabled
    if (enabled === undefined) throw new Error(`replacement fixture could not read RLS state for ${table}`)
    originalRls.set(table, enabled)
    await pool!.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)
  }
  const functionExists = (await pool!.query<{ exists: boolean }>(`SELECT to_regprocedure('public.app_current_user_id()') IS NOT NULL AS exists`)).rows[0]?.exists
  if (functionExists === undefined) throw new Error("replacement fixture could not inspect app_current_user_id")
  dropUserIdFunction = !functionExists
  if (dropUserIdFunction) await pool!.query(`CREATE FUNCTION public.app_current_user_id() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$`)
  for (const role of [commandRole, claimRole]) {
    await pool!.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    createdRoles.push(role)
    await pool!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await pool!.query(`GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO "${role}"`)
  }
  for (const [table, predicate] of TENANT_POLICIES) {
    const policy = `${rlsPrefix}_${table.replace("agent_", "").replace("sub_", "")}`
    await pool!.query(`CREATE POLICY "${policy}" ON public."${table}" TO "${commandRole}", "${claimRole}"
      USING (${predicate}) WITH CHECK (${predicate})`)
  }
  await pool!.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox" TO "${commandRole}"`)
  await pool!.query(`GRANT UPDATE ("id") ON "agent_turns", "agent_steps" TO "${commandRole}"`)
  await pool!.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${commandRole}"`)
  await pool!.query(`GRANT INSERT ON "sub_agent_tasks" TO "${commandRole}"`)
  await pool!.query(`GRANT UPDATE ("status", "updatedAt") ON "sub_agent_tasks" TO "${commandRole}"`)
  await pool!.query(`GRANT INSERT ON "agent_items" TO "${commandRole}"`)
  await pool!.query(`GRANT UPDATE ("stepId", "revision", "content", "status", "completedAt", "updatedAt") ON "agent_items" TO "${commandRole}"`)
  await pool!.query(`GRANT INSERT ON "agent_events", "agent_outbox" TO "${commandRole}"`)

  await pool!.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks" TO "${claimRole}"`)
  await pool!.query(`GRANT UPDATE ("id") ON "agent_turns" TO "${claimRole}"`)
  await pool!.query(`GRANT UPDATE ("status", "leaseOwner", "leaseExpiresAt", "attemptCount", "startedAt", "updatedAt", "result", "failureReason", "nextAttemptAt", "completedAt") ON "sub_agent_tasks" TO "${claimRole}"`)
  await pool!.query(`GRANT SELECT ON "agent_outbox" TO "${claimRole}"`)
  await pool!.query(`GRANT UPDATE ("publishedAt", "attemptCount", "lastError", "payload") ON "agent_outbox" TO "${claimRole}"`)
  await pool!.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${claimRole}"`)
  await pool!.query(`GRANT SELECT, INSERT, UPDATE ON "agent_steps", "agent_items", "agent_events", "agent_tree_budget_reservations" TO "${claimRole}"`)
  await pool!.query(`GRANT SELECT, INSERT, UPDATE ON ai_usage_events, ai_budgets TO "${claimRole}"`)
  await pool!.query(`GRANT INSERT ON "agent_outbox" TO "${claimRole}"`)
}

function restrictedTransactionPool(basePool: PgPool, role: string, userId: string): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") return (...args: unknown[]) => {
            const result: unknown = Reflect.apply(target.query, target, args)
            const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
            return Promise.resolve(result).then(async value => {
              if (sql === "BEGIN") {
                await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${role}"`])
                await Reflect.apply(target.query, target, ["SELECT set_config('app.user_id', $1, true)", [userId]])
              }
              return value
            })
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
}

function replaceRequest(sourceTaskId: string, idempotencyKey: string, expectedRevision: number): TaskGraphNativeCommandInput {
  return {
    scope,
    request: {
      kind: "followup", idempotencyKey, sourceTaskId, goal: "Refine the bounded audit", context: { replacementContext: "kept" },
      mode: "replace_unstarted", expectedRevision,
    },
  }
}

async function waitForLockWait(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = (await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock'`, [applicationName])).rows[0]?.count ?? 0
    if (waiting > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("replacement race did not reach the session-lock fence")
}

async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'native command integration', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [ids.turn, ids.session, ids.user, ids.turnOwner])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'native command integration',
      '[]'::jsonb, '[]'::jsonb, '["jobs.search","jobs.get"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":64,"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [ids.root, ids.session, ids.turn, ids.taskOwner])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.step, ids.session, ids.turn, ids.root])
}

async function event(type: "session.pause_requested" | "session.resume_requested"): Promise<void> {
  const updated = await pool!.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [ids.session])
  await pool!.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, 'system', $3, $7, '{}'::jsonb)`, [randomUUID(), ids.session, ids.turn, ids.root,
    updated.rows[0]!.eventSequence, type, `test:${type}:${randomUUID()}`])
}

describePg("native TaskGraph PostgreSQL command durability", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 6 })
    await seed()
    await installRestrictedRoles()
    commandBasePool = new PgPool({ connectionString: databaseUrl!, max: 2, application_name: commandApplicationName })
    claimBasePool = new PgPool({ connectionString: databaseUrl!, max: 2, application_name: claimApplicationName })
  })
  afterAll(async () => {
    if (!pool) return
    await commandBasePool?.end()
    await claimBasePool?.end()
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    for (const table of TENANT_TABLES) {
      const name = `${rlsPrefix}_${table.replace("agent_", "").replace("sub_", "")}`
      await pool.query(`DROP POLICY IF EXISTS "${name}" ON public."${table}"`)
      const wasEnabled = originalRls.get(table)
      if (wasEnabled !== undefined) await pool.query(`ALTER TABLE public."${table}" ${wasEnabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`)
    }
    for (const role of createdRoles) {
      await pool.query(`DROP OWNED BY "${role}"`)
      await pool.query(`DROP ROLE IF EXISTS "${role}"`)
    }
    if (dropUserIdFunction) await pool.query(`DROP FUNCTION IF EXISTS public.app_current_user_id()`)
    await pool.end()
  })

  it("serializes independent commands, replays across revisions, and reads safe native receipts", async () => {
    const port = command(), a = spawn("race-a"), b = spawn("race-b")
    const [first, second] = await Promise.all([port.appendNativeCoordination!(a), port.appendNativeCoordination!(b)])
    expect([first.graphRevision, second.graphRevision].sort()).toEqual([1, 2])
    expect(first.child.taskId).not.toBe(second.child.taskId)
    const replay = await port.appendNativeCoordination!(a)
    expect(replay).toMatchObject({ status: "duplicate", replay: true, graphRevision: first.graphRevision, child: first.child })

    const changedKind: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "race-a", sourceTaskId: "missing-source", goal: "Refine" },
    }
    await expect(port.appendNativeCoordination!(changedKind)).rejects.toMatchObject({ code: "idempotency_conflict" })
    const current = await port.readCurrent(scope)
    expect(current.revision).toBe(2)
    expect(current.nodes.map(node => node.native?.operationId)).toContain(first.operationId)
    expect(current.nodes.find(node => node.native?.operationId === first.operationId)?.nativeResult)
      .toMatchObject({ role: "auditor", taskStatus: "queued", disposition: "missing", resultDigest: null })

    const stored = await pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])
    const serialized = JSON.stringify(stored.rows[0]?.content)
    expect(serialized).not.toContain("privateCallerContext")
    const rows = await pool!.query(`SELECT event."type", event."idempotencyKey", event."payload"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."payload"->>'kind' = 'native_command'`, [ids.session])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.map(row => row.type).sort()).toEqual(["item.delta", "item.started"])
    expect(rows.rows.every(row => String(row.idempotencyKey).includes(":native:") && !String(row.idempotencyKey).includes(":spawn:"))).toBe(true)
    expect(await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1`, [ids.session]))
      .toMatchObject({ rows: expect.arrayContaining([expect.any(Object), expect.any(Object)]) })
  }, 60_000)

  it("uses terminal same-root follow-up provenance, rejects foreign and malformed sources, and honors pause fences", async () => {
    const sourceId = `native-source-${suffix}`
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '["jobs.search"]'::jsonb, '{"sourceContext":"keep"}'::jsonb, '{}'::jsonb, '{"summary":"finished"}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [sourceId, ids.session, ids.turn, ids.root])
    const followup: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "followup-good", sourceTaskId: sourceId, goal: "Refine audit", context: { caller: "kept" } },
    }
    const accepted = await command().appendNativeCoordination!(followup)
    expect(accepted.source).toMatchObject({ taskId: sourceId, origin: "native_legacy", status: "completed", attemptCount: 0 })
    expect(accepted.child.role).toBe("auditor")
    const child = await pool!.query<{ context: unknown; allowedActions: unknown }>(`SELECT "context", "allowedActions" FROM "sub_agent_tasks" WHERE "id" = $1`, [accepted.child.taskId])
    expect(child.rows[0]?.context).toMatchObject({ callerContext: { caller: "kept" }, sourceContext: { sourceContext: "keep" }, provenance: { sourceTaskId: sourceId } })
    expect(child.rows[0]?.allowedActions).toEqual(["jobs.search"])

    const foreignId = `native-foreign-source-${suffix}`
    await pool!.query(`INSERT INTO "agent_turns"
      ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
       "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, 'completed', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [ids.foreignTurn, ids.session, ids.user])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
       "budgetSnapshot", "attemptCount", "maxAttempts", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'completed', 'foreign root',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":64,"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb,
        1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.foreignRoot, ids.session, ids.foreignTurn])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.foreignRoot])
    await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.foreignRoot, ids.foreignTurn])
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [foreignId, ids.session, ids.foreignTurn, ids.foreignRoot])
    const foreignLineage = await pool!.query<{ sourceTaskId: string; sourceRootTaskId: string; rootTaskId: string; sourceTurnId: string; rootTurnId: string }>(
      `SELECT source."id" AS "sourceTaskId", source."rootTaskId" AS "sourceRootTaskId", root."id" AS "rootTaskId",
        source."turnId" AS "sourceTurnId", root."turnId" AS "rootTurnId"
       FROM "sub_agent_tasks" AS source JOIN "sub_agent_tasks" AS root
         ON root."id" = source."rootTaskId" AND root."sessionId" = source."sessionId"
       WHERE source."id" = $1`, [foreignId])
    expect(foreignLineage.rows[0]).toEqual({ sourceTaskId: foreignId, sourceRootTaskId: ids.foreignRoot, rootTaskId: ids.foreignRoot, sourceTurnId: ids.foreignTurn, rootTurnId: ids.foreignTurn })
    await expect(command().appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: "followup-foreign", sourceTaskId: foreignId, goal: "Must not cross root" },
    })).rejects.toMatchObject({ code: "native_source_unavailable" })

    const malformedId = `native-malformed-source-${suffix}`
    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/root/bad-source', 1, 'auditor', 'audit', 'completed', 'source', '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{"subagentPolicy":{"maxDepth":8,"maxFanOut":64,"maxAttempts":2}}'::jsonb, 0, 2, CURRENT_TIMESTAMP)`,
    [malformedId, ids.session, ids.turn, ids.root, JSON.stringify({ status: "completed", structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" } })])
    await expect(command().appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: "followup-malformed", sourceTaskId: malformedId, goal: "Fail closed" },
    })).rejects.toThrow("task_graph_native_result_invalid")

    await event("session.pause_requested")
    const before = await pool!.query(`SELECT COUNT(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, ids.root])
    await expect(command().appendNativeCoordination!(spawn("paused"))).rejects.toBeInstanceOf(SessionPauseRequestedError)
    const after = await pool!.query(`SELECT COUNT(*)::int AS count FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`, [ids.session, ids.root])
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    await event("session.resume_requested")
  }, 60_000)

  it("serializes replacement with real claims under separate restricted roles and replays without outbox delete", async () => {
    const port = restrictedCommand()
    const sourceA = await port.appendNativeCoordination!(spawn("replace-first-" + suffix))
    const sourceB = await port.appendNativeCoordination!(spawn("claim-first-" + suffix))
    const roleRows = await pool!.query<{ role: string; superuser: boolean; bypass: boolean; outboxDelete: boolean; turnLock: boolean }>("SELECT role.rolname AS role, role.rolsuper AS superuser, role.rolbypassrls AS bypass, has_table_privilege(role.rolname, 'public.agent_outbox', 'DELETE') AS \"outboxDelete\", has_column_privilege(role.rolname, 'public.\"agent_turns\"', 'id', 'UPDATE') AS \"turnLock\" FROM pg_roles AS role WHERE role.rolname = ANY($1::text[]) ORDER BY role.rolname", [[commandRole, claimRole]])
    expect(roleRows.rows).toEqual([
      { role: claimRole, superuser: false, bypass: false, outboxDelete: false, turnLock: true },
      { role: commandRole, superuser: false, bypass: false, outboxDelete: false, turnLock: true },
    ])
    const immutableBefore = await pool!.query("SELECT session.\"goal\" AS \"sessionGoal\", root.\"goal\" AS \"rootGoal\", root.\"successCriteria\" AS \"rootCriteria\", turn.\"input\" AS \"turnInput\" FROM \"agent_sessions\" AS session JOIN \"sub_agent_tasks\" AS root ON root.\"sessionId\" = session.\"id\" AND root.\"id\" = $2 JOIN \"agent_turns\" AS turn ON turn.\"sessionId\" = session.\"id\" AND turn.\"id\" = $3 WHERE session.\"id\" = $1", [ids.session, ids.root, ids.turn])
    const initial = await port.readCurrent(scope)
    const blocker = await pool!.connect()
    await blocker.query("BEGIN")
    await blocker.query("SELECT \"id\" FROM \"agent_sessions\" WHERE \"id\" = $1 FOR UPDATE", [ids.session])
    let replacement: Promise<TaskGraphNativeCommandReceipt> | undefined
    let losingClaim: ReturnType<ReturnType<typeof restrictedClaimStore>["claim"]> | undefined
    let released = false
    let replacementFirst: PromiseSettledResult<unknown>[] = []
    try {
      replacement = port.appendNativeCoordination!(replaceRequest(sourceA.child.taskId, "replace-before-claim-" + suffix, initial.revision))
      await waitForLockWait(commandApplicationName)
      losingClaim = restrictedClaimStore().claim({ taskId: sourceA.child.taskId, sessionId: ids.session, ownerId: "replace-first-worker-" + suffix, policy: { ...defaultSubagentPolicy(), maxConcurrency: 64 }, now: new Date() })
      await waitForLockWait(claimApplicationName)
      await blocker.query("COMMIT")
      released = true
      replacementFirst = await Promise.allSettled([replacement, losingClaim])
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined)
      if (replacement || losingClaim) await Promise.allSettled([...(replacement ? [replacement] : []), ...(losingClaim ? [losingClaim] : [])])
      blocker.release()
    }
    expect(replacementFirst[0]?.status).toBe("fulfilled")
    expect(replacementFirst[1]).toMatchObject({ status: "fulfilled", value: null })
    const accepted = replacementFirst[0]?.status === "fulfilled" ? replacementFirst[0].value as TaskGraphNativeCommandReceipt : undefined
    expect(accepted).toMatchObject({ status: "accepted", replay: false, source: { taskId: sourceA.child.taskId, status: "cancelled" } })
    if (!accepted) throw new Error("replacement transaction did not return its receipt")

    const old = await pool!.query<{ status: string; attemptCount: number; startedAt: Date | null }>("SELECT \"status\", \"attemptCount\", \"startedAt\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1", [sourceA.child.taskId])
    expect(old.rows[0]).toEqual({ status: "cancelled", attemptCount: 0, startedAt: null })
    const replayInput = replaceRequest(sourceA.child.taskId, "replace-before-claim-" + suffix, initial.revision)
    expect(await port.appendNativeCoordination!(replayInput)).toMatchObject({
      status: "duplicate", replay: true, operationId: accepted.operationId, child: { taskId: accepted.child.taskId },
    })
    await expect(port.appendNativeCoordination!({
      ...replayInput, request: { ...replayInput.request, goal: "changed replacement goal" },
    } as TaskGraphNativeCommandInput)).rejects.toMatchObject({ code: "idempotency_conflict" })
    overflowCandidateId = accepted.child.taskId
    const graph = await port.readCurrent(scope)
    expect(graph.nodes.find(node => node.taskId === sourceA.child.taskId)).toMatchObject({ status: "cancelled" })
    expect(graph.nodes.find(node => node.taskId === accepted.child.taskId)).toMatchObject({ status: "queued", nativeResult: { disposition: "missing" } })
    const persistedGraphRow = await pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])
    const persistedGraph = parseTaskGraphSnapshot(persistedGraphRow.rows[0]?.content)
    expect(persistedGraph.nodes.find(node => node.taskId === sourceA.child.taskId)?.verificationDisposition).toBe("legacy_unverified")
    expect(persistedGraph.nodes.find(node => node.taskId === accepted.child.taskId)?.verificationDisposition).toBe("legacy_unverified")
    expect(graph.nodes.find(node => node.taskId === accepted.child.taskId)?.native?.source?.taskId).toBe(sourceA.child.taskId)
    const inherited = await pool!.query("SELECT source.\"goal\" AS \"sourceGoal\", source.\"role\" AS \"sourceRole\", source.\"taskType\" AS \"sourceTaskType\", source.\"constraints\" AS \"sourceConstraints\", source.\"successCriteria\" AS \"sourceCriteria\", source.\"allowedActions\" AS \"sourceActions\", source.\"expectedOutputSchema\" AS \"sourceSchema\", source.\"budgetSnapshot\" AS \"sourcePolicy\", replacement.\"goal\" AS \"replacementGoal\", replacement.\"role\" AS \"replacementRole\", replacement.\"taskType\" AS \"replacementTaskType\", replacement.\"constraints\" AS \"replacementConstraints\", replacement.\"successCriteria\" AS \"replacementCriteria\", replacement.\"allowedActions\" AS \"replacementActions\", replacement.\"expectedOutputSchema\" AS \"replacementSchema\", replacement.\"budgetSnapshot\" AS \"replacementPolicy\", replacement.\"status\" AS \"replacementStatus\" FROM \"sub_agent_tasks\" AS source JOIN \"sub_agent_tasks\" AS replacement ON replacement.\"context\"->'provenance'->>'sourceTaskId' = source.\"id\" WHERE source.\"id\" = $1 AND replacement.\"id\" = $2", [sourceA.child.taskId, accepted.child.taskId])
    expect(inherited.rows[0]).toMatchObject({ sourceGoal: "Inspect replace-first-" + suffix, sourceRole: "auditor", sourceTaskType: "audit",
      sourceConstraints: ["read only"], sourceCriteria: ["record findings"], sourceActions: ["jobs.search", "jobs.get"], sourceSchema: {},
      replacementGoal: "Refine the bounded audit", replacementRole: "auditor", replacementTaskType: "audit",
      replacementConstraints: ["read only"], replacementCriteria: ["record findings"], replacementSchema: {}, replacementStatus: "queued" })
    expect(inherited.rows[0]?.replacementActions).toEqual(inherited.rows[0]?.sourceActions)
    expect(inherited.rows[0]?.replacementPolicy).toEqual(inherited.rows[0]?.sourcePolicy)
    const queuedDispatch = await pool!.query<{ publishedAt: Date | null }>("SELECT \"publishedAt\" FROM \"agent_outbox\" WHERE \"aggregateId\" = $1 AND \"topic\" = 'agent.subagent.dispatch' AND \"idempotencyKey\" = $2", [ids.session, "subagent-dispatch:" + sourceA.child.taskId])
    expect(queuedDispatch.rows).toEqual([{ publishedAt: null }])

    const beforeClaim = await port.readCurrent(scope)
    const blocker2 = await pool!.connect()
    await blocker2.query("BEGIN")
    await blocker2.query("SELECT \"id\" FROM \"agent_sessions\" WHERE \"id\" = $1 FOR UPDATE", [ids.session])
    let winnerClaim: ReturnType<ReturnType<typeof restrictedClaimStore>["claim"]> | undefined
    let losingReplacement: Promise<TaskGraphNativeCommandReceipt> | undefined
    let released2 = false
    let claimFirst: PromiseSettledResult<unknown>[] = []
    try {
      winnerClaim = restrictedClaimStore().claim({ taskId: sourceB.child.taskId, sessionId: ids.session, ownerId: "claim-first-worker-" + suffix, policy: { ...defaultSubagentPolicy(), maxConcurrency: 64 }, now: new Date() })
      await waitForLockWait(claimApplicationName)
      losingReplacement = port.appendNativeCoordination!(replaceRequest(sourceB.child.taskId, "claim-before-replace-" + suffix, beforeClaim.revision))
      await waitForLockWait(commandApplicationName)
      await blocker2.query("COMMIT")
      released2 = true
      claimFirst = await Promise.allSettled([winnerClaim, losingReplacement])
    } finally {
      if (!released2) await blocker2.query("ROLLBACK").catch(() => undefined)
      if (winnerClaim || losingReplacement) await Promise.allSettled([...(winnerClaim ? [winnerClaim] : []), ...(losingReplacement ? [losingReplacement] : [])])
      blocker2.release()
    }
    expect(claimFirst[0]).toMatchObject({ status: "fulfilled", value: { status: "running", attemptCount: 1, leaseOwner: "claim-first-worker-" + suffix } })
    expect(claimFirst[1]).toMatchObject({ status: "rejected", reason: { code: "revision_mismatch" } })
    const running = await pool!.query<{ status: string; attemptCount: number; leaseOwner: string | null }>("SELECT \"status\", \"attemptCount\", \"leaseOwner\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1", [sourceB.child.taskId])
    expect(running.rows[0]).toEqual({ status: "running", attemptCount: 1, leaseOwner: "claim-first-worker-" + suffix })
    const noSuccessor = await pool!.query("SELECT \"id\" FROM \"sub_agent_tasks\" WHERE \"sessionId\" = $1 AND \"context\"->'provenance'->>'sourceTaskId' = $2", [ids.session, sourceB.child.taskId])
    expect(noSuccessor.rows).toEqual([])
    const immutableAfter = await pool!.query("SELECT session.\"goal\" AS \"sessionGoal\", root.\"goal\" AS \"rootGoal\", root.\"successCriteria\" AS \"rootCriteria\", turn.\"input\" AS \"turnInput\" FROM \"agent_sessions\" AS session JOIN \"sub_agent_tasks\" AS root ON root.\"sessionId\" = session.\"id\" AND root.\"id\" = $2 JOIN \"agent_turns\" AS turn ON turn.\"sessionId\" = session.\"id\" AND turn.\"id\" = $3 WHERE session.\"id\" = $1", [ids.session, ids.root, ids.turn])
    expect(immutableAfter.rows).toEqual(immutableBefore.rows)
  }, 60_000)

  it("rolls back replacement cancellation, successor, and dispatch when the graph is full", async () => {
    const port = command()
    let candidateId = overflowCandidateId
    if (!candidateId) candidateId = (await restrictedCommand().appendNativeCoordination!(spawn("overflow-source-" + suffix))).child.taskId
    const children = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 AND "id" <> $3`, [ids.session, ids.root, candidateId])
    if (children.rows.length) await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = ANY($1::text[])`, [children.rows.map(row => row.id)])
    let state = await port.readCurrent(scope)
    let index = 0
    while (state.nodes.length < TASK_GRAPH_LIMITS.maxNodes) {
      const receipt = await port.appendNativeCoordination!(spawn(`fill-${index++}`))
      await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = $1`, [receipt.child.taskId])
      state = await port.readCurrent(scope)
    }
    const candidate = await pool!.query<{ status: string; attemptCount: number; goal: string }>(`SELECT "status", "attemptCount", "goal" FROM "sub_agent_tasks" WHERE "id" = $1`, [candidateId])
    expect(candidate.rows[0]).toMatchObject({ status: "queued", attemptCount: 0 })
    const beforeItem = await pool!.query(`SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])
    const cancelKey = taskGraphLifecycleKey(ids.root, state.nodes.find(node => node.taskId === candidateId)!.key, 0, "task.cancelled")
    const before = await pool!.query(`SELECT (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1) AS dispatch,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command') AS events,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $3) AS cancellationEvents,
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "context"->'provenance'->>'sourceTaskId' = $4) AS successors`, [ids.session, ids.root, cancelKey, candidateId])
    await expect(restrictedCommand().appendNativeCoordination!(replaceRequest(candidateId, "overflow-replacement-" + suffix, state.revision)))
      .rejects.toMatchObject({ code: "native_graph_node_invalid" })
    const after = await pool!.query(`SELECT (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2) AS children,
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1) AS dispatch,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command') AS events,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $3) AS cancellationEvents,
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "context"->'provenance'->>'sourceTaskId' = $4) AS successors`, [ids.session, ids.root, cancelKey, candidateId])
    expect(after.rows).toEqual(before.rows)
    expect((await pool!.query(`SELECT "status", "attemptCount", "goal" FROM "sub_agent_tasks" WHERE "id" = $1`, [candidateId])).rows).toEqual(candidate.rows)
    expect((await pool!.query(`SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(ids.root)])).rows).toEqual(beforeItem.rows)
    const current = await port.readCurrent(scope)
    expect(current).toEqual(state)
  }, 120_000)
})
