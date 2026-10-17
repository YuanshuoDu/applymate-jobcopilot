import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin } from "./root-task-history-fence.js"
import { updateRootObjectiveHistoryProjection, type RootObjectiveHistoryIdentity } from "./objective-history-projection.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Objective history projection needs the dedicated disposable PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== "/" + DATABASE_NAME || url.search || url.hash) {
    throw new Error("Objective history projection requires the loopback disposable PostgreSQL service")
  }
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), userId = "objective-history-user-" + suffix
const goal = "Find senior platform roles", criteria = ["Use the saved EU locations"]
const requirements = { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
] }
const turnInput = { input: { goal, successCriteria: criteria, verificationRequirements: requirements,
  intent: { kind: "interactive_discovery_shortlist", version: 1 } } }
const identities = Object.fromEntries(["objective", "failed", "interrupted", "completed"].map(name => [name, {
  userId, sessionId: "objective-history-session-" + name + "-" + suffix, turnId: "objective-history-" + name + "-turn-" + suffix,
  rootTaskId: "objective-history-" + name + "-root-" + suffix,
}])) as Record<string, RootObjectiveHistoryIdentity>
const eventIds: Record<string, string> = {}, terminalAt = new Date("2026-10-16T12:30:00.321Z")
let pool: Pool | undefined

async function seedTurn(identity: RootObjectiveHistoryIdentity, turnStatus = "in_progress", rootStatus = "running"): Promise<void> {
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, $4, 'user', $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [identity.turnId, identity.sessionId, userId, turnStatus, JSON.stringify(turnInput)])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "parentTaskId", "path", "depth", "role", "taskType", "status",
    "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, NULL, '/root', 0, 'orchestrator', 'root', $4, $5, '[]'::jsonb, $6::jsonb, '[]'::jsonb,
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP)`,
  [identity.rootTaskId, identity.sessionId, identity.turnId, rootStatus, goal, JSON.stringify(criteria)])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1 AND "sessionId" = $2`, [identity.rootTaskId, identity.sessionId])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2 AND "sessionId" = $3`,
    [identity.rootTaskId, identity.turnId, identity.sessionId])
}

async function insertEvent(input: {
  id: string; identity: RootObjectiveHistoryIdentity; sequence: number; type: string; taskId: string | null
  itemId?: string | null; correlationId: string; idempotencyKey: string; payload: unknown
}, client: Pool | PoolClient = pool!): Promise<void> {
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence",
    "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'orchestrator', $8, $9, $10::jsonb, $11)`,
  [input.id, input.identity.sessionId, input.identity.turnId, input.itemId ?? null, input.taskId, input.sequence,
    input.type, input.correlationId, input.idempotencyKey, JSON.stringify(input.payload), terminalAt])
}

async function insertStart(identity: RootObjectiveHistoryIdentity, sequence: number, client?: Pool | PoolClient): Promise<void> {
  await insertEvent({ id: randomUUID(), identity, sequence, type: "turn.started", taskId: identity.rootTaskId,
    correlationId: identity.turnId, idempotencyKey: "turn:" + identity.turnId + ":event:turn-started",
    payload: { taskId: identity.rootTaskId, rootTaskId: identity.rootTaskId } }, client)
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

describePg("objective history projection on disposable PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 })
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      [userId, userId + "@example.invalid"])
    for (const identity of Object.values(identities)) {
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
        VALUES ($1, $2, $3, 'running', 'test', 100, CURRENT_TIMESTAMP)`, [identity.sessionId, userId, goal])
    }
    await seedTurn(identities.objective!)
    await seedTurn(identities.failed!)
    await seedTurn(identities.interrupted!)
    await seedTurn(identities.completed!, "completed", "completed")
    await insertStart(identities.failed!, 101)
    eventIds.failed = randomUUID()
    await insertStart(identities.interrupted!, 103)
    eventIds.interrupted = randomUUID()
    eventIds.nullTask = randomUUID()
    await insertEvent({ id: eventIds.nullTask!, identity: identities.failed!, sequence: 105, type: "turn.interrupted",
      taskId: null, correlationId: identities.failed!.turnId, idempotencyKey: "event:null-task:" + eventIds.nullTask!,
      payload: { turnId: identities.failed!.turnId, taskId: identities.failed!.rootTaskId, errorCode: "interrupted" } })
    await insertStart(identities.completed!, 106)
    const stepId = "objective-history-completed-step-" + suffix, itemId = "objective-history-final-item-" + suffix
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
      "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`,
    [stepId, identities.completed!.sessionId, identities.completed!.turnId, identities.completed!.rootTaskId])
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase",
      "revision", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'agent_message', 'completed', 'final_answer', 1, '{"text":"done"}'::jsonb, $6, $6, $6)`,
    [itemId, identities.completed!.sessionId, identities.completed!.turnId, stepId, identities.completed!.rootTaskId, terminalAt])
    await insertEvent({ id: randomUUID(), identity: identities.completed!, sequence: 107, type: "step.completed",
      taskId: identities.completed!.rootTaskId, correlationId: stepId,
      idempotencyKey: "turn:" + identities.completed!.turnId + ":event:step-completed:" + stepId,
      payload: { stepId, status: "completed", taskId: identities.completed!.rootTaskId } })
    eventIds.completed = randomUUID()
    await insertEvent({ id: eventIds.completed!, identity: identities.completed!, sequence: 108, type: "turn.completed",
      taskId: identities.completed!.rootTaskId, itemId, correlationId: stepId,
      idempotencyKey: "turn:" + identities.completed!.turnId + ":event:turn-completed",
      payload: { turnId: identities.completed!.turnId, taskId: identities.completed!.rootTaskId, finalItemId: itemId } })
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
    await pool.end()
  })

  it("writes same-session and versioned cross-session keys from persisted Root/Turn linkage and rolls back atomically", async () => {
    const identity = identities.objective!
    const rollbackClient = await pool!.connect()
    try {
      await rollbackClient.query("BEGIN")
      expect(await updateRootObjectiveHistoryProjection(rollbackClient, identity)).toBe(true)
      await rollbackClient.query("ROLLBACK")
    } finally { rollbackClient.release() }
    const absent = await pool!.query(`SELECT "objectiveDigest", "canonicalOriginDigest", "objectiveIndexSemanticsVersion"
      FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
    expect(absent.rows[0]).toEqual({ objectiveDigest: null, canonicalOriginDigest: null, objectiveIndexSemanticsVersion: null })

    await inTransaction(async client => expect(await updateRootObjectiveHistoryProjection(client, identity)).toBe(true))
    const saved = await pool!.query(`SELECT "objectiveDigest", "canonicalOriginDigest", "objectiveIndexSemanticsVersion"
      FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
    const origin = rootTaskHistoryOrigin("user", turnInput)!
    const cross = rootTaskHistoryObjectiveDigest(turnInput, { goal, successCriteria: criteria }, true)!
    const canonical = createHash("sha256").update(JSON.stringify({ objectiveDigest: cross, canonicalOrigin: origin })).digest("hex")
    expect(saved.rows[0]).toEqual({
      objectiveDigest: rootTaskHistoryObjectiveDigest(turnInput, { goal, successCriteria: criteria }, false),
      canonicalOriginDigest: canonical, objectiveIndexSemanticsVersion: 1,
    })

  })

  it("writes event-first failed/interrupted locators, excludes taskId-null interruption, and validates completion", async () => {
    const failedReceipt = { id: eventIds.failed!, identity: identities.failed!, sequence: 102, type: "turn.failed",
      taskId: identities.failed!.rootTaskId, correlationId: identities.failed!.turnId,
      idempotencyKey: "turn:" + identities.failed!.turnId + ":event:turn-failed:provider_error",
      payload: { turnId: identities.failed!.turnId, taskId: identities.failed!.rootTaskId,
        errorCode: "provider_error", finalItemId: null } }
    const rollbackClient = await pool!.connect()
    try {
      await rollbackClient.query("BEGIN")
      await insertEvent(failedReceipt, rollbackClient)
      expect(await updateRootObjectiveHistoryProjection(rollbackClient, identities.failed!,
        { terminalEventId: eventIds.failed! })).toBe(true)
      await rollbackClient.query("ROLLBACK")
    } finally { rollbackClient.release() }
    const rolledBackEvent = await pool!.query(`SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "id" = $1`, [eventIds.failed!])
    expect(rolledBackEvent.rows[0]).toEqual({ count: 0 })
    const absent = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt" FROM "agent_turns" WHERE "id" = $1`,
      [identities.failed!.turnId])
    expect(absent.rows[0]).toEqual({ terminalEventSequence: null, terminalEventAt: null })
    await inTransaction(async client => {
      await insertEvent(failedReceipt, client)
      expect(await updateRootObjectiveHistoryProjection(client, identities.failed!,
        { terminalEventId: eventIds.failed! })).toBe(true)
    })
    const committedEvent = await pool!.query(`SELECT "sequence"::text AS "sequence", "createdAt" AS "at"
      FROM "agent_events" WHERE "id" = $1`, [eventIds.failed!])
    expect(committedEvent.rows[0]).toEqual({ sequence: "102", at: terminalAt })
    const committedProjection = await pool!.query(`SELECT "terminalEventSequence"::text AS "sequence", "terminalEventAt" AS "at"
      FROM "agent_turns" WHERE "id" = $1`, [identities.failed!.turnId])
    expect(committedProjection.rows[0]).toEqual({ sequence: "102", at: terminalAt })
    const interruptedReceipt = { id: eventIds.interrupted!, identity: identities.interrupted!, sequence: 104,
      type: "turn.interrupted", taskId: identities.interrupted!.rootTaskId, correlationId: identities.interrupted!.turnId,
      idempotencyKey: "turn:" + identities.interrupted!.turnId + ":event:turn-interrupted",
      payload: { turnId: identities.interrupted!.turnId, taskId: identities.interrupted!.rootTaskId, errorCode: "interrupted" } }
    const interruptedRollback = await pool!.connect()
    try {
      await interruptedRollback.query("BEGIN")
      await insertEvent(interruptedReceipt, interruptedRollback)
      expect(await updateRootObjectiveHistoryProjection(interruptedRollback, identities.interrupted!,
        { terminalEventId: eventIds.interrupted! })).toBe(true)
      await interruptedRollback.query("ROLLBACK")
    } finally { interruptedRollback.release() }
    const interruptedAbsent = await pool!.query(`SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "id" = $1`,
      [eventIds.interrupted!])
    expect(interruptedAbsent.rows[0]).toEqual({ count: 0 })
    const interruptedLocatorAbsent = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt"
      FROM "agent_turns" WHERE "id" = $1`, [identities.interrupted!.turnId])
    expect(interruptedLocatorAbsent.rows[0]).toEqual({ terminalEventSequence: null, terminalEventAt: null })
    await inTransaction(async client => {
      await insertEvent(interruptedReceipt, client)
      expect(await updateRootObjectiveHistoryProjection(client, identities.interrupted!,
        { terminalEventId: eventIds.interrupted! })).toBe(true)
    })
    const interruptedEvent = await pool!.query(`SELECT "sequence"::text AS "sequence", "createdAt" AS "at"
      FROM "agent_events" WHERE "id" = $1`, [eventIds.interrupted!])
    expect(interruptedEvent.rows[0]).toEqual({ sequence: "104", at: terminalAt })
    const interruptedProjection = await pool!.query(`SELECT "terminalEventSequence"::text AS "sequence", "terminalEventAt" AS "at"
      FROM "agent_turns" WHERE "id" = $1`, [identities.interrupted!.turnId])
    expect(interruptedProjection.rows[0]).toEqual({ sequence: "104", at: terminalAt })
    for (const [name, status, expectedSequence] of [["failed", "failed", "102"], ["interrupted", "interrupted", "104"]] as const) {
      const identity = identities[name]!, eventId = eventIds[name]!
      await inTransaction(async client => {
        await client.query(`UPDATE "agent_turns" SET "status" = $1 WHERE "id" = $2`, [status, identity.turnId])
        await client.query(`UPDATE "sub_agent_tasks" SET "status" = $1 WHERE "id" = $2`, [status, identity.rootTaskId])
        expect(await updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: eventId })).toBe(true)
      })
      const locator = await pool!.query(`SELECT "terminalEventSequence"::text AS "sequence", "terminalEventAt" AS "at"
        FROM "agent_turns" WHERE "id" = $1`, [identity.turnId])
      expect(locator.rows[0]).toEqual({ sequence: expectedSequence, at: terminalAt })
    }
    await expect(inTransaction(client => updateRootObjectiveHistoryProjection(client, identities.failed!,
      { terminalEventId: eventIds.nullTask! }))).resolves.toBe(false)
    const activeCompleted = await pool!.connect()
    try {
      await activeCompleted.query("BEGIN")
      await activeCompleted.query(`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = $1`,
        [identities.completed!.turnId])
      await activeCompleted.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`,
        [identities.completed!.rootTaskId])
      expect(await updateRootObjectiveHistoryProjection(activeCompleted, identities.completed!,
        { terminalEventId: eventIds.completed! })).toBe(false)
      await activeCompleted.query("ROLLBACK")
    } finally { activeCompleted.release() }
    const completedLocatorAbsent = await pool!.query(`SELECT "terminalEventSequence", "terminalEventAt"
      FROM "agent_turns" WHERE "id" = $1`, [identities.completed!.turnId])
    expect(completedLocatorAbsent.rows[0]).toEqual({ terminalEventSequence: null, terminalEventAt: null })
    await inTransaction(async client => expect(await updateRootObjectiveHistoryProjection(client, identities.completed!,
      { terminalEventId: eventIds.completed! })).toBe(true))
    const completed = await pool!.query(`SELECT "terminalEventSequence"::text AS "sequence", "terminalEventAt" AS "at"
      FROM "agent_turns" WHERE "id" = $1`, [identities.completed!.turnId])
    expect(completed.rows[0]).toEqual({ sequence: "108", at: terminalAt })
  })
})
