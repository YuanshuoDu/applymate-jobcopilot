import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { backfillObjectiveHistoryProjection } from "./objective-history-backfill.js"
import type { RootObjectiveHistoryIdentity } from "./objective-history-projection.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Objective history backfill needs the dedicated disposable PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== "/" + DATABASE_NAME || url.search || url.hash) {
    throw new Error("Objective history backfill requires the loopback disposable PostgreSQL service")
  }
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
let pool: Pool | undefined
const goal = "Find senior platform roles", criteria = ["Use the saved EU locations"]
const validInput = { input: { goal, successCriteria: criteria, intent: { kind: "interactive_discovery_shortlist", version: 1 } } }

type Owner = { userId: string; cleanup: () => Promise<void> }
type SeedOptions = { linked?: boolean; rootGoal?: string; input?: unknown; failedEvent?: boolean; interruptedWithoutRootReceipt?: boolean }

async function createOwner(): Promise<Owner> {
  const suffix = randomUUID(), userId = "objective-backfill-user-" + suffix
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, userId + "@example.invalid"])
  return { userId, cleanup: async () => { await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]) } }
}

async function seedTurn(owner: Owner, name: string, options: SeedOptions = {}): Promise<RootObjectiveHistoryIdentity> {
  const suffix = randomUUID(), identity = {
    userId: owner.userId, sessionId: `objective-backfill-session-${name}-${suffix}`,
    turnId: `objective-backfill-turn-${name}-${suffix}`, rootTaskId: `objective-backfill-root-${name}-${suffix}`,
  }
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'test', 100, CURRENT_TIMESTAMP)`, [identity.sessionId, owner.userId, goal])
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [identity.turnId, identity.sessionId, owner.userId, JSON.stringify(options.input ?? validInput)])
  if (options.linked !== false) {
    await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "parentTaskId", "path", "depth", "role", "taskType", "status",
      "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
      VALUES ($1, $2, $3, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4, '[]'::jsonb, $5::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP)`,
    [identity.rootTaskId, identity.sessionId, identity.turnId, options.rootGoal ?? goal, JSON.stringify(criteria)])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = "id" WHERE "id" = $1`, [identity.rootTaskId])
    await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [identity.rootTaskId, identity.turnId])
  }
  if (options.failedEvent) {
    const at = new Date("2026-10-17T10:00:00.123Z")
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
      "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 10, 'turn.started', 'orchestrator', $3, $5, $6::jsonb, $7)`,
    [randomUUID(), identity.sessionId, identity.turnId, identity.rootTaskId, `turn:${identity.turnId}:event:turn-started`,
      JSON.stringify({ taskId: identity.rootTaskId, rootTaskId: identity.rootTaskId }), at])
    const eventId = randomUUID()
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
      "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 11, 'turn.failed', 'orchestrator', $3, $5, $6::jsonb, $7)`,
    [eventId, identity.sessionId, identity.turnId, identity.rootTaskId,
      `turn:${identity.turnId}:event:turn-failed:provider_error`,
      JSON.stringify({ turnId: identity.turnId, taskId: identity.rootTaskId, errorCode: "provider_error", finalItemId: null }), at])
  }
  if (options.interruptedWithoutRootReceipt) {
    await pool!.query(`UPDATE "agent_turns" SET "status" = 'interrupted' WHERE "id" = $1`, [identity.turnId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'interrupted' WHERE "id" = $1`, [identity.rootTaskId])
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
      "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, NULL, 12, 'turn.interrupted', 'system', $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
    [randomUUID(), identity.sessionId, identity.turnId, `agent-turn:${identity.sessionId}:${identity.turnId}:terminal`,
      JSON.stringify({ turnId: identity.turnId, requestId: "stop-request", reason: "user_stop" })])
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
      "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 13, 'task.interrupted', 'system', $3, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [randomUUID(), identity.sessionId, identity.turnId, identity.rootTaskId,
      `agent-root-stop:${identity.rootTaskId}:attempt:1:task.interrupted`,
      JSON.stringify({ taskId: identity.rootTaskId, status: "interrupted", attemptCount: 1 })])
  }
  return identity
}

function racePool(mutateAfterCandidate: () => Promise<void>, failSecondCommit = false): Pick<Pool, "connect"> {
  let mutated = false, commits = 0
  return {
    connect: async () => {
      const client = await pool!.connect(), query = client.query.bind(client)
      return {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === "COMMIT" && failSecondCommit && ++commits === 2) throw new Error("injected batch interruption")
          const result = await query(sql, values)
          if (!mutated && sql.includes('SELECT turn."id" AS "turnId"')) { mutated = true; await mutateAfterCandidate() }
          return result
        },
        release: client.release.bind(client),
      } as unknown as PoolClient
    },
  }
}

describePg("objective history backfill on disposable PostgreSQL", () => {
  beforeAll(async () => { pool = new Pool({ connectionString: databaseUrl!, max: 3 }) })
  afterAll(async () => { await pool?.end() })

  it("resumes committed keyset batches, records unindexable rows, ignores unlinked rows, and replays idempotently", async () => {
    const owner = await createOwner()
    try {
      const good = await seedTurn(owner, "a-good")
      const invalid = await seedTurn(owner, "b-invalid", { rootGoal: "Conflicting root objective" })
      const failed = await seedTurn(owner, "c-failed", { failedEvent: true })
      const unlinked = await seedTurn(owner, "z-unlinked", { linked: false })

      const first = await backfillObjectiveHistoryProjection(pool!, { batchSize: 2, maxBatches: 1 })
      expect(first).toMatchObject({ batches: 1, evaluated: 2, unindexable: 1, capped: true, ready: false,
        transactions: 2, workTransactions: 1 })
      const partial = await pool!.query(`SELECT "isReady" FROM "agent_objective_history_index_readiness"
        WHERE "indexName" = 'agent_turns_objective_history' AND "semanticsVersion" = 1`)
      expect(partial.rows[0]).toEqual({ isReady: false })

      const resumed = await backfillObjectiveHistoryProjection(pool!, { batchSize: 2, maxBatches: 2 })
      expect(resumed).toMatchObject({ batches: 1, evaluated: 1, capped: false, ready: true,
        transactions: 3, workTransactions: 2, verificationBatches: 1 })
      const fields = await pool!.query(`SELECT "id", "objectiveDigest", "canonicalOriginDigest", "objectiveIndexSemanticsVersion",
        "terminalEventSequence", "terminalEventAt" FROM "agent_turns" WHERE "id" = ANY($1::text[])`,
      [[good.turnId, invalid.turnId, failed.turnId, unlinked.turnId]])
      const indexed = new Map(fields.rows.map(row => [row.id, row]))
      expect(indexed.get(good.turnId)).toMatchObject({ objectiveIndexSemanticsVersion: 1 })
      expect(indexed.get(invalid.turnId)).toMatchObject({ objectiveDigest: null, canonicalOriginDigest: null, objectiveIndexSemanticsVersion: 1 })
      expect(indexed.get(failed.turnId)).toMatchObject({ objectiveIndexSemanticsVersion: 1, terminalEventSequence: "11" })
      expect(indexed.get(unlinked.turnId)).toMatchObject({ objectiveIndexSemanticsVersion: null })

      const replay = await backfillObjectiveHistoryProjection(pool!)
      expect(replay).toMatchObject({ batches: 0, evaluated: 0, ready: true })

      await pool!.query(`UPDATE "agent_turns" SET "terminalEventSequence" = 98 WHERE "id" = $1`, [failed.turnId])
      const failedVerification = await backfillObjectiveHistoryProjection(pool!)
      expect(failedVerification).toMatchObject({ verificationFailed: true, ready: false })
    } finally { await owner.cleanup() }
  })

  it("preserves exact large JSON numbers while projecting an ignored input field", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "large-json-number")
      const rawInput = '{"input":{"goal":"Find senior platform roles","successCriteria":["Use the saved EU locations"],"intent":{"kind":"interactive_discovery_shortlist","version":1},"ignoredNumeric":9007199254740993}}'
      await pool!.query(`UPDATE "agent_turns" SET "input" = $1::jsonb WHERE "id" = $2`, [rawInput, identity.turnId])

      const report = await backfillObjectiveHistoryProjection(pool!)

      expect(report).toMatchObject({ evaluated: 1, conflicts: 0, ready: true, verificationFailed: false })
      const saved = await pool!.query(`SELECT "input"::text AS "inputText", "objectiveIndexSemanticsVersion"
        FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
      expect(saved.rows[0]?.inputText).toContain('"ignoredNumeric": 9007199254740993')
      expect(saved.rows[0]?.objectiveIndexSemanticsVersion).toBe(1)
    } finally { await owner.cleanup() }
  })

  it("defers the final consistency transaction when the shared invocation budget is exhausted", async () => {
    const owner = await createOwner()
    try {
      await seedTurn(owner, "deferred-verifier")
      const first = await backfillObjectiveHistoryProjection(pool!, { maxBatches: 1 })
      expect(first).toMatchObject({ batches: 1, verificationBatches: 0, transactions: 2, workTransactions: 1, capped: true, ready: false })
      const second = await backfillObjectiveHistoryProjection(pool!, { maxBatches: 1 })
      expect(second).toMatchObject({ batches: 0, verificationBatches: 1, transactions: 2, workTransactions: 1, verificationComplete: true, ready: true })
    } finally { await owner.cleanup() }
  })

  it("detects objective and Root-link races as retryable conflicts", async () => {
    for (const race of ["objective", "link"] as const) {
      const owner = await createOwner()
      try {
        const identity = await seedTurn(owner, race)
        const wrapper = racePool(async () => {
          if (race === "objective") await pool!.query(`UPDATE "agent_turns" SET "input" = $1::jsonb WHERE "id" = $2`,
            [JSON.stringify({ input: { goal: "Changed while scanned" } }), identity.turnId])
          else await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = NULL WHERE "id" = $1`, [identity.turnId])
        })
        const report = await backfillObjectiveHistoryProjection(wrapper)
        expect(report).toMatchObject({ conflicts: 1, evaluated: 0, ready: false })
      } finally { await owner.cleanup() }
    }
  })

  it("uses the terminal receipt persisted when the batch reaches its locked resolver", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "terminal-race", { failedEvent: true })
      const changedAt = new Date("2026-10-17T10:05:00.456Z")
      const wrapper = racePool(async () => {
        await pool!.query(`UPDATE "agent_events" SET "sequence" = 12, "createdAt" = $1 WHERE "sessionId" = $2 AND "turnId" = $3 AND "type" = 'turn.failed'`,
          [changedAt, identity.sessionId, identity.turnId])
      })
      const report = await backfillObjectiveHistoryProjection(wrapper)
      expect(report).toMatchObject({ evaluated: 1, terminalIneligible: 0, ready: true })
      const saved = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt" FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
      expect(saved.rows[0]).toEqual({ terminalEventSequence: "12", terminalEventAt: changedAt })
    } finally { await owner.cleanup() }
  })

  it("keeps readiness false when a pre-existing terminal locator points to an invalid receipt", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "invalid-existing-terminal", { failedEvent: true })
      await expect(backfillObjectiveHistoryProjection(pool!)).resolves.toMatchObject({ ready: true })
      await pool!.query(`UPDATE "agent_events" SET "actor" = 'system' WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.failed'`,
        [identity.sessionId, identity.turnId])

      const report = await backfillObjectiveHistoryProjection(pool!)

      expect(report).toMatchObject({ verificationFailed: true, ready: false })
      const readiness = await pool!.query(`SELECT "isReady" FROM "agent_objective_history_index_readiness"
        WHERE "indexName" = 'agent_turns_objective_history' AND "semanticsVersion" = 1`)
      expect(readiness.rows[0]).toEqual({ isReady: false })
    } finally { await owner.cleanup() }
  })

  it("keeps readiness false when exactly one persisted terminal locator field is missing", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "partial-terminal-locator", { failedEvent: true })
      await expect(backfillObjectiveHistoryProjection(pool!)).resolves.toMatchObject({ ready: true })
      await pool!.query(`UPDATE "agent_turns" SET "terminalEventSequence" = NULL WHERE "id" = $1`, [identity.turnId])

      const report = await backfillObjectiveHistoryProjection(pool!)

      expect(report).toMatchObject({ verificationComplete: true, verificationFailed: true, ready: false })
      const locator = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt" FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
      expect(locator.rows[0]?.terminalEventSequence).toBeNull()
      expect(locator.rows[0]?.terminalEventAt).toBeInstanceOf(Date)
      const readiness = await pool!.query(`SELECT "isReady" FROM "agent_objective_history_index_readiness"
        WHERE "indexName" = 'agent_turns_objective_history' AND "semanticsVersion" = 1`)
      expect(readiness.rows[0]).toEqual({ isReady: false })
    } finally { await owner.cleanup() }
  })

  it("does not hide a terminal-ineligible receipt behind an otherwise passing verifier", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "terminal-ineligible", { failedEvent: true })
      await pool!.query(`UPDATE "agent_turns" SET "status" = 'completed' WHERE "id" = $1`, [identity.turnId])
      await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed' WHERE "id" = $1`, [identity.rootTaskId])

      const report = await backfillObjectiveHistoryProjection(pool!)

      expect(report).toMatchObject({ terminalIneligible: 1, verificationFailed: true, ready: false })
    } finally { await owner.cleanup() }
  })

  it("accepts a legitimate interrupted Turn with a null-task Stop receipt and no root terminal locator", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "interrupted-null-task", { interruptedWithoutRootReceipt: true })

      const report = await backfillObjectiveHistoryProjection(pool!)

      expect(report).toMatchObject({ evaluated: 1, verificationComplete: true, verificationFailed: false, ready: true })
      const locator = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt", "status"
        FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
      expect(locator.rows[0]).toEqual({ terminalEventSequence: null, terminalEventAt: null, status: "interrupted" })
    } finally { await owner.cleanup() }
  })

  it("rolls back a batch interrupted before commit and leaves readiness false", async () => {
    const owner = await createOwner()
    try {
      const identity = await seedTurn(owner, "rollback")
      const wrapper = racePool(async () => undefined, true)
      await expect(backfillObjectiveHistoryProjection(wrapper)).rejects.toThrow("injected batch interruption")
      const row = await pool!.query(`SELECT turn."objectiveIndexSemanticsVersion", ready."isReady"
        FROM "agent_turns" turn CROSS JOIN "agent_objective_history_index_readiness" ready
        WHERE turn."id" = $1 AND ready."indexName" = 'agent_turns_objective_history' AND ready."semanticsVersion" = 1`,
      [identity.turnId])
      expect(row.rows[0]).toEqual({ objectiveIndexSemanticsVersion: null, isReady: false })
    } finally { await owner.cleanup() }
  })
})
