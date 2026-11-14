import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const DATABASE_NAME = "applymate_agent_brain_ci"
const MIGRATION_NAME = "20261113000000_add_agent_root_usage_reservations"

function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (required) throw new Error("Root usage migration PostgreSQL tests need the dedicated disposable URL")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) {
    throw new Error("Root usage migration tests require the dedicated loopback disposable CI PostgreSQL URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll("-", "")
const fixture = {
  userId: `root-usage-migration-user-${suffix}`,
  otherUserId: `root-usage-migration-other-${suffix}`,
  sessionId: `root-usage-migration-session-${suffix}`,
  otherSessionId: `root-usage-migration-other-session-${suffix}`,
  turnId: `root-usage-migration-turn-${suffix}`,
  otherTurnId: `root-usage-migration-other-turn-${suffix}`,
  rootTaskId: `root-usage-migration-root-${suffix}`,
  otherRootTaskId: `root-usage-migration-other-root-${suffix}`,
  stepId: `root-usage-migration-step-${suffix}`,
  otherStepId: `root-usage-migration-other-step-${suffix}`,
  reservationId: `root-usage-migration-reservation-${suffix}`,
  insertedReservationId: `root-usage-migration-allowed-insert-${suffix}`,
  otherReservationId: `root-usage-migration-other-reservation-${suffix}`,
  usageEventId: `root-usage-migration-event-${suffix}`,
}
let db: PrismaClient | undefined

async function asCandidate<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db!.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE "applymate_candidate"')
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${userId}, true)`)
    return work(tx)
  })
}

async function hasSqlState(work: () => Promise<unknown>, expected: string): Promise<boolean> {
  try {
    await work()
    return false
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("meta" in error)) return false
    const meta = error.meta
    return typeof meta === "object" && meta !== null && "code" in meta && meta.code === expected
  }
}

describeWithPostgres("root usage migration on disposable PostgreSQL", () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "User" ("id", "email", "updatedAt") VALUES (${fixture.userId}, ${`${fixture.userId}@example.invalid`}, CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "User" ("id", "email", "updatedAt") VALUES (${fixture.otherUserId}, ${`${fixture.otherUserId}@example.invalid`}, CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES (${fixture.sessionId}, ${fixture.userId}, 'ledger fixture', 'running', 'test', CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES (${fixture.otherSessionId}, ${fixture.otherUserId}, 'ledger fixture', 'running', 'test', CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt") VALUES (${fixture.turnId}, ${fixture.sessionId}, ${fixture.userId}, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt") VALUES (${fixture.otherTurnId}, ${fixture.otherSessionId}, ${fixture.otherUserId}, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "attemptCount", "leaseOwner", "leaseExpiresAt", "updatedAt") VALUES (${fixture.rootTaskId}, ${fixture.sessionId}, ${fixture.turnId}, '/root', 0, 'orchestrator', 'root', 'running', 'ledger fixture', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 'fixture-worker', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`
      await tx.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "attemptCount", "leaseOwner", "leaseExpiresAt", "updatedAt") VALUES (${fixture.otherRootTaskId}, ${fixture.otherSessionId}, ${fixture.otherTurnId}, '/root', 0, 'orchestrator', 'root', 'running', 'ledger fixture', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 'fixture-worker', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`
      await tx.$executeRaw`UPDATE "sub_agent_tasks" SET "rootTaskId" = ${fixture.rootTaskId} WHERE "id" = ${fixture.rootTaskId}`
      await tx.$executeRaw`UPDATE "sub_agent_tasks" SET "rootTaskId" = ${fixture.otherRootTaskId} WHERE "id" = ${fixture.otherRootTaskId}`
      await tx.$executeRaw`UPDATE "agent_turns" SET "rootTaskId" = ${fixture.rootTaskId} WHERE "id" = ${fixture.turnId}`
      await tx.$executeRaw`UPDATE "agent_turns" SET "rootTaskId" = ${fixture.otherRootTaskId} WHERE "id" = ${fixture.otherTurnId}`
      await tx.$executeRaw`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot") VALUES (${fixture.stepId}, ${fixture.sessionId}, ${fixture.turnId}, ${fixture.rootTaskId}, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`
      await tx.$executeRaw`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot") VALUES (${fixture.otherStepId}, ${fixture.otherSessionId}, ${fixture.otherTurnId}, ${fixture.otherRootTaskId}, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`
      await tx.$executeRaw`INSERT INTO public.agent_root_usage_reservations ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion", "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "idempotencyKey") VALUES (${fixture.reservationId}, ${fixture.userId}, ${fixture.sessionId}, ${fixture.turnId}, ${fixture.rootTaskId}, ${fixture.rootTaskId}, ${fixture.stepId}, 'task', 'fixture-worker', 1, 1, ${`${fixture.reservationId}-attempt`}, 'minimax', 'MiniMax-M3', true, 128, ${`${fixture.reservationId}-key`})`
      await tx.$executeRaw`INSERT INTO public.agent_root_usage_reservations ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion", "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "idempotencyKey") VALUES (${fixture.otherReservationId}, ${fixture.otherUserId}, ${fixture.otherSessionId}, ${fixture.otherTurnId}, ${fixture.otherRootTaskId}, ${fixture.otherRootTaskId}, ${fixture.otherStepId}, 'task', 'fixture-worker', 1, 1, ${`${fixture.otherReservationId}-attempt`}, 'minimax', 'MiniMax-M3', true, 128, ${`${fixture.otherReservationId}-key`})`
      await tx.$executeRaw`INSERT INTO public.ai_usage_events ("id", "user_id", "feature_key", "provider", "model", "latency_ms", "status", "output_reservation_required", "usage_start_protocol_version") VALUES (${fixture.usageEventId}, ${fixture.userId}, 'root_usage_test', 'minimax', 'MiniMax-M3', 1, 'reserved', true, 1)`
    })
  })

  afterAll(async () => {
    if (!db) return
    try {
      await db.$executeRaw`DELETE FROM public.ai_usage_events WHERE "id" = ${fixture.usageEventId}`
      await db.$executeRaw`DELETE FROM "User" WHERE "id" IN (${fixture.userId}, ${fixture.otherUserId})`
    } finally {
      await db.$disconnect()
    }
  })

  it("uses the applied migration's public RLS table and real candidate grants", async () => {
    const database = await db!.$queryRaw<{ name: string }[]>`SELECT current_database() AS "name"`
    expect(database[0]?.name).toBe(DATABASE_NAME)
    const migration = await db!.$queryRaw<{ applied: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = ${MIGRATION_NAME} AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS "applied"`
    expect(migration[0]?.applied).toBe(true)

    const role = await db!.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]>`SELECT "rolsuper", "rolbypassrls", "rolcanlogin" FROM pg_roles WHERE "rolname" = 'applymate_candidate'`
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }])

    const table = await db!.$queryRaw<{ rls: boolean; policyName: string; usingExpression: string | null; checkExpression: string | null }[]>`SELECT c.relrowsecurity AS "rls", p.policyname AS "policyName", p.qual AS "usingExpression", p.with_check AS "checkExpression" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname WHERE n.nspname = 'public' AND c.relname = 'agent_root_usage_reservations'`
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ rls: true, policyName: "agent_root_usage_reservations_user_isolation" })
    expect(table[0]?.usingExpression).toContain('"userId"')
    expect(table[0]?.usingExpression).toContain('app.user_id')
    expect(table[0]?.checkExpression).toContain('app.user_id')

    const grants = await db!.$queryRaw<{ reservedUpdate: boolean; reservationRequiredUpdate: boolean; ownerKindUpdate: boolean; ownerIdUpdate: boolean; ownerVersionUpdate: boolean; lifecycleUpdate: boolean; actualTokensUpdate: boolean; flagUpdate: boolean; providerStartedUpdate: boolean; usageTableUpdate: boolean; usageTableSelect: boolean; deleteTable: boolean }[]>`SELECT has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'reservedOutputTokens', 'UPDATE') AS "reservedUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'outputReservationRequired', 'UPDATE') AS "reservationRequiredUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'executionOwnerKind', 'UPDATE') AS "ownerKindUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'executionOwnerId', 'UPDATE') AS "ownerIdUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'executionOwnerVersion', 'UPDATE') AS "ownerVersionUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'status', 'UPDATE') AS "lifecycleUpdate", has_column_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'actualOutputTokens', 'UPDATE') AS "actualTokensUpdate", has_column_privilege('applymate_candidate', 'public.ai_usage_events', 'output_reservation_required', 'UPDATE') AS "flagUpdate", has_column_privilege('applymate_candidate', 'public.ai_usage_events', 'provider_started_at', 'UPDATE') AS "providerStartedUpdate", has_table_privilege('applymate_candidate', 'public.ai_usage_events', 'UPDATE') AS "usageTableUpdate", has_table_privilege('applymate_candidate', 'public.ai_usage_events', 'SELECT') AS "usageTableSelect", has_table_privilege('applymate_candidate', 'public.agent_root_usage_reservations', 'DELETE') AS "deleteTable"`
    expect(grants[0]).toEqual({ reservedUpdate: false, reservationRequiredUpdate: false, ownerKindUpdate: false, ownerIdUpdate: false, ownerVersionUpdate: false, lifecycleUpdate: true, actualTokensUpdate: true, flagUpdate: false, providerStartedUpdate: true, usageTableUpdate: false, usageTableSelect: true, deleteTable: false })
  })

  it("enforces tenant RLS and permits only reservation lifecycle updates", async () => {
    const visible = await asCandidate(fixture.userId, tx => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM public.agent_root_usage_reservations ORDER BY "id"`)
    expect(visible.map(row => row.id)).toEqual([fixture.reservationId])

    const sameTenantInsert = await asCandidate(fixture.userId, tx => tx.$executeRaw`INSERT INTO public.agent_root_usage_reservations ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion", "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "idempotencyKey") VALUES (${fixture.insertedReservationId}, ${fixture.userId}, ${fixture.sessionId}, ${fixture.turnId}, ${fixture.rootTaskId}, ${fixture.rootTaskId}, ${fixture.stepId}, 'task', 'fixture-worker', 1, 1, ${fixture.insertedReservationId}, 'minimax', 'MiniMax-M3', true, 64, ${fixture.insertedReservationId})`)
    expect(sameTenantInsert).toBe(1)

    expect(await hasSqlState(() => asCandidate(fixture.userId, tx => tx.$executeRaw`INSERT INTO public.agent_root_usage_reservations ("id", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "stepId", "executionOwnerKind", "executionOwnerId", "executionOwnerVersion", "attempt", "attemptId", "provider", "model", "outputReservationRequired", "reservedOutputTokens", "idempotencyKey") VALUES (${`cross-tenant-${suffix}`}, ${fixture.otherUserId}, ${fixture.otherSessionId}, ${fixture.otherTurnId}, ${fixture.otherRootTaskId}, ${fixture.otherRootTaskId}, ${fixture.otherStepId}, 'task', 'fixture-worker', 1, 1, ${`cross-tenant-attempt-${suffix}`}, 'minimax', 'MiniMax-M3', true, 64, ${`cross-tenant-key-${suffix}`})`), "42501")).toBe(true)

    await asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.agent_root_usage_reservations SET "status" = 'started', "startedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${fixture.reservationId}`)
    await asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.agent_root_usage_reservations SET "status" = 'settled', "actualOutputTokens" = 42, "outcomeStatus" = 'success', "settledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${fixture.reservationId}`)
    const settled = await asCandidate(fixture.userId, tx => tx.$queryRaw<{ status: string; actualOutputTokens: number }[]>`SELECT "status", "actualOutputTokens" FROM public.agent_root_usage_reservations WHERE "id" = ${fixture.reservationId}`)
    expect(settled).toEqual([{ status: "settled", actualOutputTokens: 42 }])

    expect(await hasSqlState(() => asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.agent_root_usage_reservations SET "reservedOutputTokens" = 256 WHERE "id" = ${fixture.reservationId}`), "42501")).toBe(true)
    expect(await hasSqlState(() => asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.agent_root_usage_reservations SET "outputReservationRequired" = false WHERE "id" = ${fixture.reservationId}`), "42501")).toBe(true)
    expect(await hasSqlState(() => asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.agent_root_usage_reservations SET "executionOwnerVersion" = 2 WHERE "id" = ${fixture.reservationId}`), "42501")).toBe(true)
    expect(await hasSqlState(() => asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.ai_usage_events SET "output_reservation_required" = true WHERE "id" = ${fixture.usageEventId}`), "42501")).toBe(true)

    await expect(asCandidate(fixture.userId, tx => tx.$executeRaw`UPDATE public.ai_usage_events SET "provider_started_at" = CURRENT_TIMESTAMP WHERE "id" = ${fixture.usageEventId}`)).resolves.toBe(1)
  })
})
