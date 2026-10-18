import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"

import { hydrateChildMailbox } from "./hydration.js"
import { drainSubagentMailboxOutbox } from "./outbox-consumer.js"
import { PgCoordinationStore } from "./store.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search !== "" || url.hash !== "") {
    throw new Error("Attempt-bound mailbox integration requires the dedicated disposable CI PostgreSQL service")
  }
  return value
}

const databaseUrl = disposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll("-", "")
const fixture = {
  userId: `mailbox-attempt-user-${suffix}`,
  sessionId: `mailbox-attempt-session-${suffix}`,
  turnId: `mailbox-attempt-turn-${suffix}`,
  rootTaskId: `mailbox-attempt-root-${suffix}`,
  taskId: `mailbox-attempt-child-${suffix}`,
  stepId: `mailbox-attempt-step-${suffix}`,
  oldMessageId: `mailbox-attempt-old-${suffix}`,
  currentMessageId: `mailbox-attempt-current-${suffix}`,
  legacyMessageId: `mailbox-attempt-legacy-${suffix}`,
  staleOutboxId: `mailbox-attempt-stale-outbox-${suffix}`,
  currentOutboxId: `mailbox-attempt-current-outbox-${suffix}`,
  oldKey: `mailbox-attempt-old-key-${suffix}`,
  currentKey: `mailbox-attempt-current-key-${suffix}`,
  legacyKey: `mailbox-attempt-legacy-key-${suffix}`,
}

describeWithPostgres("attempt-bound mailbox messages in PostgreSQL", () => {
  let pool: PgPool

  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 4 })
    try {
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [fixture.userId, `${fixture.userId}@example.invalid`])
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'Attempt fence', 'running', 'test', CURRENT_TIMESTAMP)`, [fixture.sessionId, fixture.userId])
      await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [fixture.turnId, fixture.sessionId, fixture.userId])
      await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
        VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Attempt fence', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP)`, [fixture.rootTaskId, fixture.sessionId, fixture.turnId])
      await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [fixture.rootTaskId])
      await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [fixture.rootTaskId, fixture.turnId])
      await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $4, '/root/child', 1, 'analyst', 'inspect', 'running', 'Inspect attempt-bound messages', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, 'worker-current', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [fixture.taskId, fixture.sessionId, fixture.turnId, fixture.rootTaskId])
      await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 1, 2, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [fixture.stepId, fixture.sessionId, fixture.turnId, fixture.taskId])
      await insertMessage(pool, fixture.oldMessageId, fixture.oldKey, "human_follow_up", 1)
      await insertMessage(pool, fixture.currentMessageId, fixture.currentKey, "human_follow_up", 2)
      await insertMessage(pool, fixture.legacyMessageId, fixture.legacyKey, "result", null)
      await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, '{}'::jsonb)`, [`mailbox-attempt-dispatch-${suffix}`, fixture.sessionId, `subagent-dispatch:${fixture.taskId}`])
      await pool.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = 4, "lastError" = 'prior_failure'
        WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`])
    } catch (error: unknown) {
      await cleanup(pool)
      throw error
    }
  })

  afterAll(async () => {
    if (pool) { await cleanup(pool); await pool.end() }
  })

  it("blocks K after the task advances to K+1, while matching and NULL legacy messages remain readable", async () => {
    const store = new PgCoordinationStore(pool)
    const pending = await store.listPendingMessages({ userId: fixture.userId, sessionId: fixture.sessionId, toTaskId: fixture.taskId })
    expect(pending.map(message => message.id)).toEqual([fixture.currentMessageId, fixture.legacyMessageId])

    const hydrated = await hydrateChildMailbox(pool, {
      userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId,
      toTaskId: fixture.taskId, ownerId: "worker-current", attemptCount: 2, stepId: fixture.stepId, limit: 20,
    })
    expect(hydrated.map(message => message.id)).toEqual([fixture.currentMessageId, fixture.legacyMessageId])
  })

  it("rejects stale outbox wake and applies a matching wake once across duplicate delivery", async () => {
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting', "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE "id" = $1`, [fixture.taskId])
    await insertMailboxOutbox(pool, fixture.staleOutboxId, fixture.oldMessageId, fixture.oldKey, 1)

    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status: "waiting" }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), attemptCount: 4, lastError: "prior_failure" }] })
    await expect(pool.query(`SELECT "deliveredAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [fixture.oldMessageId]))
      .resolves.toMatchObject({ rows: [{ deliveredAt: null }] })

    await insertMailboxOutbox(pool, fixture.currentOutboxId, fixture.currentMessageId, fixture.currentKey, 2)
    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: null, attemptCount: 5, lastError: null }] })

    await pool.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL WHERE "id" = $1`, [fixture.currentOutboxId])
    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status: "queued" }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: null, attemptCount: 5 }] })
  })
})

async function insertMessage(pool: PgPool, id: string, key: string, kind: string, targetAttemptCount: number | null): Promise<void> {
  await pool.query(`INSERT INTO "agent_mailbox_messages" ("id", "sessionId", "turnId", "toTaskId", "kind", "targetAttemptCount", "payload", "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [id, fixture.sessionId, fixture.turnId, fixture.taskId, kind, targetAttemptCount, JSON.stringify(kind === "human_follow_up" ? { text: `follow-up attempt ${targetAttemptCount}` } : { legacy: true }), key])
}

async function insertMailboxOutbox(pool: PgPool, id: string, messageId: string, key: string, targetAttemptCount: number): Promise<void> {
  await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.subagent.mailbox', $2, $3, $4::jsonb)`, [id, fixture.sessionId, `agent.subagent.mailbox:${key}`, JSON.stringify({
    messageId, sessionId: fixture.sessionId, turnId: fixture.turnId, toTaskId: fixture.taskId, targetAttemptCount,
  })])
}

async function cleanup(pool: PgPool): Promise<void> {
  await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId]).catch(() => undefined)
  await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId]).catch(() => undefined)
}
