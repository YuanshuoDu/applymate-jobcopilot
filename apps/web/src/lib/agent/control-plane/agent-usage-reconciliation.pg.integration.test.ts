import { createHash, randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { reconcileAbandonedAgentUsage } from "./agent-usage-reconciliation"
import { startAiUsage, type UsageBrokerDatabase, type UsageBrokerQuery, type UsageStartInput } from "./usage-broker"
import type { RootUsageQuery } from "./agent-root-usage-reservations"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (required) throw new Error("Agent usage reconciliation PostgreSQL tests need the dedicated disposable URL")
    return null
  }
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") throw new Error("Agent usage reconciliation tests require AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432" ||
      url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Agent usage reconciliation tests require the dedicated loopback disposable URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll("-", "")
const schema = `usage_reconcile_${suffix}`
const runtimeRole = `usage_reconcile_runtime_${suffix}`
const userId = `usage-reconcile-user-${suffix}`
const otherUserId = `usage-reconcile-other-${suffix}`
const sessionId = `usage-reconcile-session-${suffix}`
const otherSessionId = `usage-reconcile-other-session-${suffix}`
const turnId = `usage-reconcile-turn-${suffix}`
const otherTurnId = `usage-reconcile-other-turn-${suffix}`
const rootTaskId = `usage-reconcile-root-${suffix}`
const otherRootTaskId = `usage-reconcile-other-root-${suffix}`
let admin: PrismaClient | undefined
let scopedAdmin: PrismaClient | undefined
let runtime: PrismaClient | undefined
let roleCreated = false
let schemaCreated = false

function scopedClient(): PrismaClient {
  const url = new URL(databaseUrl!)
  url.searchParams.set("schema", schema)
  return new PrismaClient({ datasources: { db: { url: url.toString() } } })
}

async function scopedTransaction<T>(ownerId: string, work: (tx: RootUsageQuery) => Promise<T>): Promise<T> {
  return runtime!.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`)
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${ownerId}, true)`)
    return work(tx as unknown as RootUsageQuery)
  })
}

function broker(ownerId: string): UsageBrokerDatabase {
  return {
    $transaction: async <T>(work: (tx: UsageBrokerQuery) => Promise<T>) => runtime!.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`)
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${ownerId}, true)`)
      return work(tx as unknown as UsageBrokerQuery)
    }),
  }
}

function scope(ownerId = userId, session = sessionId, turn = turnId, root = rootTaskId) {
  return { userId: ownerId, sessionId: session, turnId: turn, rootTaskId: root }
}

function startInput(name: string, stepId = `usage-reconcile-step-${name}-${suffix}`): UsageStartInput {
  const attemptId = `attempt-${name}`
  const identity = [userId, sessionId, turnId, stepId, "turn", "worker-1", 4, attemptId, "autoApply", "minimax", "MiniMax-M3", 1].join("\u001f")
  return {
    operationId: `agent-usage-${createHash("sha256").update(identity).digest("hex")}`,
    userId, sessionId, turnId, stepId, leaseOwnerId: "worker-1", leaseVersion: 4,
    attemptId, featureKey: "autoApply", provider: "minimax", model: "MiniMax-M3", startProtocolVersion: 1,
  }
}

async function seedAttempt(
  input: UsageStartInput,
  options: { ownerId?: string; ownerVersion?: number; protocolVersion?: number; reservationStatus?: string; eventStatus?: string; providerStarted?: boolean; credit?: boolean } = {},
): Promise<void> {
  const ownerId = options.ownerId ?? "worker-1"
  const ownerVersion = options.ownerVersion ?? 4
  const protocolVersion = options.protocolVersion ?? 1
  await scopedAdmin!.$executeRaw`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "attempt", "status")
    VALUES (${input.stepId}, ${sessionId}, ${turnId}, ${rootTaskId}, 1, 'streaming')`
  await scopedAdmin!.$executeRaw`INSERT INTO ai_usage_events
    (id, user_id, feature_key, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms, status,
     error_code, credential_source, runtime, output_reservation_required, usage_start_protocol_version, provider_started_at)
    VALUES (${input.operationId}, ${userId}, 'autoApply', 'minimax', 'MiniMax-M3', 0, 0, 0, 0, ${options.eventStatus ?? "reserved"},
      ${options.credit === false ? null : "credit_reserved_2026-11"}, 'platform', 'worker', true, ${protocolVersion},
      ${options.providerStarted ? new Date() : null})`
  await scopedAdmin!.$executeRaw`INSERT INTO "agent_root_usage_reservations"
    ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId",
     "executionOwnerVersion", "outputReservationRequired", "attempt", "attemptId", "provider", "model", "reservedOutputTokens",
     "status", "idempotencyKey", "startedAt")
    VALUES (${input.operationId}, ${userId}, ${sessionId}, ${turnId}, ${rootTaskId}, ${rootTaskId}, ${input.stepId}, 'turn', ${ownerId},
      ${ownerVersion}, true, 1, ${input.attemptId}, 'minimax', 'MiniMax-M3', 24, ${options.reservationStatus ?? "reserved"},
      ${input.operationId}, ${options.reservationStatus === "started" ? new Date() : null})`
  if (options.credit !== false) {
    await scopedAdmin!.$executeRaw`INSERT INTO ai_budgets (user_id, month, used, updated_at) VALUES (${input.userId}, '2026-11', 1, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, month) DO UPDATE SET used = 1, updated_at = CURRENT_TIMESTAMP`
  }
}

async function snapshot(id: string, owner = userId) {
  const [reservation, event, budget] = await Promise.all([
    scopedAdmin!.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT "status" FROM "agent_root_usage_reservations" WHERE "id" = ${id}`),
    scopedAdmin!.$queryRaw<Array<{ status: string; providerStartedAt: Date | null; protocolVersion: number }>>(Prisma.sql`
      SELECT status, provider_started_at AS "providerStartedAt", usage_start_protocol_version AS "protocolVersion"
      FROM ai_usage_events WHERE id = ${id}`),
    scopedAdmin!.$queryRaw<Array<{ used: number }>>(Prisma.sql`SELECT used FROM ai_budgets WHERE user_id = ${owner} AND month = '2026-11'`),
  ])
  return { reservation: reservation[0]?.status, event: event[0], budget: budget[0]?.used }
}

describePg("mandatory-start recovery on disposable PostgreSQL", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    scopedAdmin = scopedClient()
    runtime = scopedClient()
    const ddl = [
      `CREATE TABLE "agent_sessions" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "status" TEXT NOT NULL, UNIQUE ("id", "userId"))`,
      `CREATE TABLE "agent_turns" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, "rootTaskId" TEXT,
        "status" TEXT NOT NULL, "leaseOwnerId" TEXT NOT NULL, "leaseVersion" INTEGER NOT NULL, "leaseExpiresAt" TIMESTAMP NOT NULL,
        UNIQUE ("id", "sessionId", "userId"))`,
      `CREATE TABLE "sub_agent_tasks" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL,
        "rootTaskId" TEXT NOT NULL, "status" TEXT NOT NULL, "budgetSnapshot" JSONB NOT NULL, "outputTokenReservationVersion" INTEGER,
        "interruptRequestedAt" TIMESTAMP, "attemptCount" INTEGER NOT NULL, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP,
        UNIQUE ("id", "sessionId"))`,
      `CREATE TABLE "agent_steps" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "taskId" TEXT,
        "attempt" INTEGER NOT NULL, "status" TEXT NOT NULL, UNIQUE ("id", "turnId", "sessionId"))`,
      `CREATE TABLE "agent_root_usage_reservations" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
        "turnId" TEXT NOT NULL, "rootTaskId" TEXT NOT NULL, "taskId" TEXT NOT NULL, "stepId" TEXT NOT NULL,
        "executionOwnerKind" TEXT NOT NULL, "executionOwnerId" TEXT NOT NULL, "executionOwnerVersion" INTEGER NOT NULL,
        "outputReservationRequired" BOOLEAN NOT NULL, "attempt" INTEGER NOT NULL, "attemptId" TEXT NOT NULL,
        "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "reservedOutputTokens" INTEGER NOT NULL, "actualOutputTokens" INTEGER,
        "status" TEXT NOT NULL DEFAULT 'reserved', "outcomeStatus" TEXT, "errorCode" TEXT, "idempotencyKey" TEXT NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "startedAt" TIMESTAMP, "settledAt" TIMESTAMP, "releasedAt" TIMESTAMP, UNIQUE ("sessionId", "idempotencyKey"))`,
      `CREATE TABLE ai_usage_events (id TEXT PRIMARY KEY, user_id TEXT, feature_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error_code TEXT, credential_source TEXT NOT NULL DEFAULT 'platform',
        runtime TEXT NOT NULL DEFAULT 'worker', output_reservation_required BOOLEAN NOT NULL DEFAULT false,
        usage_start_protocol_version INTEGER NOT NULL DEFAULT 0, provider_started_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE ai_budgets (user_id TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, month))`,
    ]
    for (const statement of ddl) await runtime.$executeRawUnsafe(statement)
    for (const table of ["agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_root_usage_reservations", "ai_usage_events", "ai_budgets"]) {
      await runtime.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
    }
    await runtime.$executeRawUnsafe(`CREATE POLICY "session_tenant" ON "agent_sessions" USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "turn_tenant" ON "agent_turns" USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "task_tenant" ON "sub_agent_tasks" USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "step_tenant" ON "agent_steps" USING (EXISTS (SELECT 1 FROM "agent_sessions" s WHERE s."id" = "agent_steps"."sessionId" AND s."userId" = NULLIF(current_setting('app.user_id', true), '')))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "reservation_tenant" ON "agent_root_usage_reservations" USING ("userId" = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "usage_tenant" ON ai_usage_events USING (user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "budget_tenant" ON ai_budgets USING (user_id = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE ROLE "${runtimeRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    roleCreated = true
    await runtime.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT UPDATE ("status") ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "agent_root_usage_reservations", ai_usage_events, ai_budgets TO "${runtimeRole}"`)
    await scopedAdmin.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${sessionId}, ${userId}, 'running'), (${otherSessionId}, ${otherUserId}, 'running')`
    await scopedAdmin.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "rootTaskId", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt")
      VALUES (${turnId}, ${sessionId}, ${userId}, ${rootTaskId}, 'in_progress', 'worker-1', 4, CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
        (${otherTurnId}, ${otherSessionId}, ${otherUserId}, ${otherRootTaskId}, 'in_progress', 'worker-new', 8, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`
    await scopedAdmin.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "userId", "sessionId", "turnId", "rootTaskId", "status", "budgetSnapshot", "outputTokenReservationVersion", "attemptCount", "leaseOwner", "leaseExpiresAt")
      VALUES (${rootTaskId}, ${userId}, ${sessionId}, ${turnId}, ${rootTaskId}, 'running', '{"limits":{"maxOutputTokens":100}}'::jsonb, 1, 1, 'worker-1', CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
        (${otherRootTaskId}, ${otherUserId}, ${otherSessionId}, ${otherTurnId}, ${otherRootTaskId}, 'running', '{"limits":{"maxOutputTokens":100}}'::jsonb, 1, 1, 'worker-new', CURRENT_TIMESTAMP + INTERVAL '10 minutes')`
  })

  beforeEach(async () => {
    await scopedAdmin!.$executeRaw`UPDATE "agent_turns" SET "leaseOwnerId" = 'worker-1', "leaseVersion" = 4, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '10 minutes' WHERE "id" = ${turnId}`
    await scopedAdmin!.$executeRaw`UPDATE "sub_agent_tasks" SET "leaseOwner" = 'worker-1', "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '10 minutes' WHERE "id" = ${rootTaskId}`
  })

  afterAll(async () => {
    await runtime?.$disconnect()
    await scopedAdmin?.$disconnect()
    if (admin && schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    if (admin && roleCreated) {
      await admin.$executeRawUnsafe(`DROP OWNED BY "${runtimeRole}"`)
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${runtimeRole}"`)
    }
    await admin?.$disconnect()
  })

  it("serializes a live start against reconciliation without releasing its credit", async () => {
    const input = startInput("race")
    await seedAttempt(input)
    const [started] = await Promise.all([
      startAiUsage(broker(userId), input),
      scopedTransaction(userId, tx => reconcileAbandonedAgentUsage(tx, scope())),
    ])
    expect(started).toMatchObject({ startProtocolVersion: 1, outputReservationRequired: true, maxOutputTokens: 24 })
    const final = await snapshot(input.operationId)
    expect(final).toMatchObject({ reservation: "started", event: { status: "reserved", protocolVersion: 1 }, budget: 1 })
    expect(final.event?.providerStartedAt).toBeInstanceOf(Date)
  })

  it("atomically releases a stale owner hold and refunds its finite credit", async () => {
    const input = startInput("stale")
    await seedAttempt(input, { ownerId: "worker-old", ownerVersion: 3 })
    await scopedAdmin!.$executeRaw`UPDATE "agent_turns" SET "leaseOwnerId" = 'worker-new', "leaseVersion" = 5 WHERE "id" = ${turnId}`
    await scopedAdmin!.$executeRaw`UPDATE "sub_agent_tasks" SET "leaseOwner" = 'worker-new' WHERE "id" = ${rootTaskId}`
    await expect(scopedTransaction(userId, tx => reconcileAbandonedAgentUsage(tx, scope()))).resolves.toBe(1)
    expect(await snapshot(input.operationId)).toMatchObject({ reservation: "released", event: { status: "released", protocolVersion: 1 }, budget: 0 })
  })

  it("preserves legacy, started, cross-tenant, and credit-without-refund candidates", async () => {
    const legacy = startInput("legacy")
    const started = startInput("started")
    const other = startInput("other", `usage-reconcile-other-step-${suffix}`)
    await seedAttempt(legacy, { protocolVersion: 0 })
    await seedAttempt(started, { reservationStatus: "started", providerStarted: true })
    await scopedAdmin!.$executeRaw`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "attempt", "status") VALUES (${other.stepId}, ${otherSessionId}, ${otherTurnId}, ${otherRootTaskId}, 1, 'streaming')`
    await scopedAdmin!.$executeRaw`INSERT INTO ai_usage_events (id, user_id, feature_key, provider, model, status, error_code, output_reservation_required, usage_start_protocol_version)
      VALUES (${other.operationId}, ${otherUserId}, 'autoApply', 'minimax', 'MiniMax-M3', 'reserved', 'credit_reserved_2026-11', true, 1)`
    await scopedAdmin!.$executeRaw`INSERT INTO "agent_root_usage_reservations"
      ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion",
       "outputReservationRequired", "attempt", "attemptId", "provider", "model", "reservedOutputTokens", "idempotencyKey")
      VALUES (${other.operationId}, ${otherUserId}, ${otherSessionId}, ${otherTurnId}, ${otherRootTaskId}, ${otherRootTaskId}, ${other.stepId}, 'turn', 'worker-old', 7,
        true, 1, ${other.attemptId}, 'minimax', 'MiniMax-M3', 24, ${other.operationId})`
    await scopedAdmin!.$executeRaw`INSERT INTO ai_budgets (user_id, month, used) VALUES (${otherUserId}, '2026-11', 1)`
    await scopedAdmin!.$executeRaw`UPDATE "agent_turns" SET "leaseOwnerId" = 'worker-new', "leaseVersion" = 5 WHERE "id" = ${turnId}`
    await expect(scopedTransaction(userId, tx => reconcileAbandonedAgentUsage(tx, scope()))).resolves.toBe(0)
    expect(await snapshot(legacy.operationId)).toMatchObject({ reservation: "reserved", event: { status: "reserved", protocolVersion: 0 }, budget: 1 })
    expect(await snapshot(started.operationId)).toMatchObject({ reservation: "started", event: { status: "reserved", protocolVersion: 1 }, budget: 1 })
    expect(await snapshot(other.operationId, otherUserId)).toMatchObject({ reservation: "reserved", event: { status: "reserved", protocolVersion: 1 }, budget: 1 })

    const missingRefund = startInput("refund-missing")
    await seedAttempt(missingRefund, { ownerId: "worker-old", ownerVersion: 3 })
    await scopedAdmin!.$executeRaw`DELETE FROM ai_budgets WHERE user_id = ${userId} AND month = '2026-11'`
    await scopedAdmin!.$executeRaw`UPDATE "agent_turns" SET "leaseOwnerId" = 'worker-new', "leaseVersion" = 5 WHERE "id" = ${turnId}`
    await expect(scopedTransaction(userId, tx => reconcileAbandonedAgentUsage(tx, scope()))).rejects.toMatchObject({ code: "usage_credit_refund_unavailable", status: 503 })
    expect(await snapshot(missingRefund.operationId)).toMatchObject({ reservation: "reserved", event: { status: "reserved", protocolVersion: 1 }, budget: undefined })
  })
})
