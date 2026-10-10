import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { createPgRootTaskStore } from "./root-task-store.js"
import type { TurnLease } from "../turns/lease.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Root TaskStore PostgreSQL acceptance needs the dedicated disposable URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Root TaskStore PostgreSQL acceptance requires the dedicated loopback disposable URL")
  }
  return value
}
const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `root-finish-steering-user-${suffix}`, session: `root-finish-steering-session-${suffix}`,
  turn: `root-finish-steering-turn-${suffix}`, root: `root-finish-steering-task-${suffix}`,
  step: `root-finish-steering-step-${suffix}`, original: `root-finish-steering-original-${suffix}`,
  steer: `root-finish-steering-input-${suffix}`, owner: `root-finish-steering-owner-${suffix}`,
}
const runtimeRole = `root_finish_runtime_${suffix.replaceAll("-", "")}`
const future = new Date(Date.now() + 10 * 60_000)
const lease: TurnLease = { turnId: ids.turn, sessionId: ids.session, ownerId: ids.owner, userId: ids.user,
  leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: future }
let admin: Pool | undefined
let runtime: Pool | undefined
let roleCreated = false

function restrictedPool(pool: Pool): PgSubagentPool {
  return { async connect() {
    const client = await pool.connect()
    return new Proxy(client, { get(target, property) {
      if (property === "query") return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(target.query, target, args)
        const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
        return Promise.resolve(result).then(async value => {
          if (sql === "BEGIN") await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${runtimeRole}"`])
          return value
        })
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
  } }
}

async function seed(): Promise<void> {
  await admin!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await admin!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt", "eventSequence")
    VALUES ($1, $2, 'Complete the original task', 'running', 'test', CURRENT_TIMESTAMP, 2)`, [ids.session, ids.user])
  const messageId = `${ids.original}-message`
  await admin!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [ids.turn, ids.session, ids.user, JSON.stringify({ goal: "Complete the original task", clientMessageId: messageId }), ids.owner, future])
  await admin!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
      "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Complete the original task', '[]'::jsonb, '[]'::jsonb, '["agent.plan"]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, $4, $5, CURRENT_TIMESTAMP)`, [ids.root, ids.session, ids.turn, ids.owner, future])
  await admin!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await admin!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await admin!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 0, 1, 'completed', 2, $5::jsonb, '{}'::jsonb)`,
  [ids.step, ids.session, ids.turn, ids.root, JSON.stringify([ids.original, ids.steer])])
  for (const input of [
    { id: ids.original, clientMessageId: messageId, delivery: "follow_up", text: "Complete the original task", disposition: "submitted", sequence: 1 },
    { id: ids.steer, clientMessageId: `${ids.steer}-message`, delivery: "steer", text: "Also preserve the location constraint", disposition: "steered", sequence: 2 },
  ]) {
    const itemId = `${input.id}-item`, content = { parts: [{ type: "text", text: input.text }], clientMessageId: input.clientMessageId,
      source: "user", disposition: input.disposition }
    await admin!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, 'user_message', 'completed', 'commentary', 0, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [itemId, ids.session, ids.turn, JSON.stringify(content)])
    await admin!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, NULL, $5, 'input.accepted', 'user', $3, $6, $7::jsonb)`,
    [`${input.id}-accepted`, ids.session, ids.turn, itemId, input.sequence, `agent-command:${input.clientMessageId}`,
      JSON.stringify({ inputId: input.id, clientMessageId: input.clientMessageId, delivery: input.delivery, source: "user", disposition: input.disposition })])
    await admin!.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt")
      VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7::jsonb, $8, $9, CURRENT_TIMESTAMP)`,
    [input.id, ids.session, ids.turn, ids.user, input.clientMessageId, input.delivery, JSON.stringify([{ type: "text", text: input.text }]), input.sequence, ids.step])
  }
}

describePg("Root TaskStore steering finalization on disposable PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl!, max: 2 })
    await seed()
    await admin.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    roleCreated = true
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`)
    await admin.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_inputs", "agent_items", "agent_events", "agent_outbox" TO "${runtimeRole}"`)
    await admin.query(`GRANT UPDATE ("updatedAt") ON "agent_sessions", "agent_turns" TO "${runtimeRole}"`)
    await admin.query(`GRANT UPDATE ("status", "result", "failureReason", "leaseOwner", "leaseExpiresAt", "completedAt", "updatedAt") ON "sub_agent_tasks" TO "${runtimeRole}"`)
    runtime = new Pool({ connectionString: databaseUrl!, max: 2, application_name: `root_finish_${suffix}` })
  })
  afterAll(async () => {
    await runtime?.end()
    if (!admin) return
    await admin.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    if (roleCreated) {
      await admin.query(`DROP OWNED BY "${runtimeRole}"`)
      await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`)
    }
    await admin.end()
  })

  it("rolls back Root finish when consumed steering has no persisted decision receipt", async () => {
    const before = await admin!.query(`SELECT turn."status" AS "turnStatus", turn."finalResponse", root."status" AS "rootStatus", root."result",
      root."failureReason", root."leaseOwner", root."leaseExpiresAt", root."completedAt"
      FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId"
      WHERE turn."id" = $1 AND root."id" = $2`, [ids.turn, ids.root])
    const store = createPgRootTaskStore(restrictedPool(runtime!))
    await expect(store.finish({ lease, rootTaskId: ids.root, result: { status: "completed", stepCount: 1, toolCallCount: 0 } }))
      .rejects.toThrow("steering_reconciliation_pending")
    const after = await admin!.query(`SELECT turn."status" AS "turnStatus", turn."finalResponse", root."status" AS "rootStatus", root."result",
      root."failureReason", root."leaseOwner", root."leaseExpiresAt", root."completedAt"
      FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId"
      WHERE turn."id" = $1 AND root."id" = $2`, [ids.turn, ids.root])
    expect(after.rows).toEqual(before.rows)
    expect(after.rows[0]).toMatchObject({ turnStatus: "in_progress", rootStatus: "running", result: null, leaseOwner: ids.owner, completedAt: null })
    expect((await admin!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'turn.completed'`, [ids.session])).rows).toEqual([])
    expect((await admin!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events'`, [ids.session])).rows).toEqual([])
  })
})
