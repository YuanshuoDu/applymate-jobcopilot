import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  findRootOutputReservation,
  lockRootUsageAdmissionScope,
  lockRootUsageReservationScope,
  reserveRootOutputTokens,
  settleRootOutputReservation,
  startRootOutputReservation,
  type RootUsageQuery,
  type RootUsageScopeInput,
} from "./agent-root-usage-reservations"

const DATABASE_NAME = "applymate_agent_brain_ci"

function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (required) throw new Error("Root output reservation PostgreSQL tests need the dedicated disposable URL")
    return null
  }
  if (process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") throw new Error("Root output reservation PostgreSQL tests require AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Root output reservation PostgreSQL tests require the dedicated loopback disposable URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll("-", "")
const schema = `root_usage_${suffix}`
const runtimeRole = `root_usage_runtime_${suffix}`
const ids = {
  user: `root-usage-user-${suffix}`, otherUser: `root-usage-other-${suffix}`,
  session: `root-usage-session-${suffix}`, turn: `root-usage-turn-${suffix}`, root: `root-usage-root-${suffix}`,
  tasks: [0, 1, 2, 3, 4, 5, 6, 7].map(index => `root-usage-child-${index}-${suffix}`),
  steps: [0, 1, 2, 3, 4, 5, 6, 7].map(index => `root-usage-step-${index}-${suffix}`),
}
const operationIds = ids.tasks.map(() => randomUUID())
let admin: PrismaClient | undefined
let runtime: PrismaClient | undefined
let roleCreated = false
let schemaCreated = false

function scopedClient(): PrismaClient {
  const url = new URL(databaseUrl!)
  url.searchParams.set("schema", schema)
  return new PrismaClient({ datasources: { db: { url: url.toString() } } })
}

async function runtimeTransaction<T>(userId: string, work: (tx: RootUsageQuery) => Promise<T>): Promise<T> {
  return runtime!.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`)
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.user_id', ${userId}, true)`)
    return work(tx as unknown as RootUsageQuery)
  })
}

function scope(taskIndex: number): RootUsageScopeInput {
  return { userId: ids.user, sessionId: ids.session, turnId: ids.turn, stepId: ids.steps[taskIndex]! }
}

function owner(taskIndex: number) {
  return { kind: "task" as const, taskId: ids.tasks[taskIndex]!, rootTaskId: ids.root, ownerId: `worker-${taskIndex}`, attemptCount: 1 }
}

async function admit(taskIndex: number, operationId = operationIds[taskIndex]!) {
  return runtimeTransaction(ids.user, async tx => {
    const locked = await lockRootUsageAdmissionScope(tx, scope(taskIndex), owner(taskIndex))
    const admitted = await reserveRootOutputTokens(tx, locked, {
      operationId, attemptId: `attempt-${taskIndex}`, provider: "minimax", model: "MiniMax-M3", requestedOutputTokens: 80,
      startProtocolVersion: 1,
    })
    return { ...admitted, operationId }
  })
}

describePg("Root output-token reservations on disposable PostgreSQL", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    runtime = scopedClient()
    const ddl = [
      `CREATE TABLE "agent_sessions" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "status" TEXT NOT NULL, UNIQUE ("id", "userId"))`,
      `CREATE TABLE "agent_turns" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "userId" TEXT NOT NULL, "rootTaskId" TEXT,
        "status" TEXT NOT NULL, "leaseOwnerId" TEXT NOT NULL, "leaseVersion" INTEGER NOT NULL, "leaseExpiresAt" TIMESTAMP NOT NULL,
        UNIQUE ("id", "sessionId"), UNIQUE ("id", "sessionId", "userId"))`,
      `CREATE TABLE "sub_agent_tasks" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL,
        "rootTaskId" TEXT NOT NULL, "parentTaskId" TEXT, "path" TEXT NOT NULL, "depth" INTEGER NOT NULL, "role" TEXT NOT NULL, "taskType" TEXT NOT NULL,
        "status" TEXT NOT NULL, "budgetSnapshot" JSONB NOT NULL, "outputTokenReservationVersion" INTEGER,
        "interruptRequestedAt" TIMESTAMP, "attemptCount" INTEGER NOT NULL, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP,
        UNIQUE ("id", "sessionId"), CHECK ("outputTokenReservationVersion" IS NULL OR "outputTokenReservationVersion" = 1))`,
      `CREATE TABLE "agent_steps" ("id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "turnId" TEXT NOT NULL, "taskId" TEXT,
        "attempt" INTEGER NOT NULL, "status" TEXT NOT NULL, UNIQUE ("id", "turnId", "sessionId"))`,
      `CREATE TABLE "agent_root_usage_reservations" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
        "turnId" TEXT NOT NULL, "rootTaskId" TEXT NOT NULL, "taskId" TEXT NOT NULL, "stepId" TEXT NOT NULL,
        "executionOwnerKind" TEXT NOT NULL, "executionOwnerId" TEXT NOT NULL, "executionOwnerVersion" INTEGER NOT NULL,
        "outputReservationRequired" BOOLEAN NOT NULL, "attempt" INTEGER NOT NULL,
        "attemptId" TEXT NOT NULL, "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "reservedOutputTokens" INTEGER NOT NULL,
        "actualOutputTokens" INTEGER, "status" TEXT NOT NULL DEFAULT 'reserved', "outcomeStatus" TEXT, "errorCode" TEXT,
        "idempotencyKey" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "startedAt" TIMESTAMP, "settledAt" TIMESTAMP, "releasedAt" TIMESTAMP, UNIQUE ("sessionId", "idempotencyKey"),
        CHECK ("attempt" >= 1), CHECK ("reservedOutputTokens" >= 0 AND "outputReservationRequired" = ("reservedOutputTokens" > 0)
          AND ("actualOutputTokens" IS NULL OR "actualOutputTokens" >= 0)))`,
    ]
    for (const statement of ddl) await runtime.$executeRawUnsafe(statement)
    await runtime.$executeRawUnsafe(`ALTER TABLE "sub_agent_tasks"
      ADD CONSTRAINT "root_usage_task_turn_fk" FOREIGN KEY ("turnId", "sessionId") REFERENCES "agent_turns"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
      ADD CONSTRAINT "root_usage_task_parent_fk" FOREIGN KEY ("parentTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE,
      ADD CONSTRAINT "root_usage_task_root_fk" FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "agent_root_usage_reservations"
      ADD CONSTRAINT "root_usage_session_fk" FOREIGN KEY ("sessionId", "userId") REFERENCES "agent_sessions"("id", "userId"),
      ADD CONSTRAINT "root_usage_turn_fk" FOREIGN KEY ("turnId", "sessionId", "userId") REFERENCES "agent_turns"("id", "sessionId", "userId"),
      ADD CONSTRAINT "root_usage_root_fk" FOREIGN KEY ("rootTaskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId"),
      ADD CONSTRAINT "root_usage_task_fk" FOREIGN KEY ("taskId", "sessionId") REFERENCES "sub_agent_tasks"("id", "sessionId"),
      ADD CONSTRAINT "root_usage_step_fk" FOREIGN KEY ("stepId", "turnId", "sessionId") REFERENCES "agent_steps"("id", "turnId", "sessionId")`)
    await runtime.$executeRawUnsafe(`CREATE INDEX "root_usage_scope_status_idx" ON "agent_root_usage_reservations"("userId", "sessionId", "turnId", "rootTaskId", "status")`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "agent_turns" ENABLE ROW LEVEL SECURITY`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "sub_agent_tasks" ENABLE ROW LEVEL SECURITY`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "agent_steps" ENABLE ROW LEVEL SECURITY`)
    await runtime.$executeRawUnsafe(`ALTER TABLE "agent_root_usage_reservations" ENABLE ROW LEVEL SECURITY`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "sessions_tenant" ON "agent_sessions" USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "turns_tenant" ON "agent_turns" USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "tasks_tenant" ON "sub_agent_tasks" USING (EXISTS (
      SELECT 1 FROM "agent_sessions" s WHERE s."id" = "sub_agent_tasks"."sessionId"
        AND s."userId" = NULLIF(current_setting('app.user_id', true), '')))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "steps_tenant" ON "agent_steps" USING (EXISTS (SELECT 1 FROM "agent_sessions" s WHERE s."id" = "agent_steps"."sessionId" AND s."userId" = NULLIF(current_setting('app.user_id', true), '')))`)
    await runtime.$executeRawUnsafe(`CREATE POLICY "root_usage_tenant" ON "agent_root_usage_reservations"
      USING ("userId" = NULLIF(current_setting('app.user_id', true), '')) WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''))`)
    await runtime.$executeRawUnsafe(`CREATE ROLE "${runtimeRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    roleCreated = true
    await runtime.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT UPDATE ("status") ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps" TO "${runtimeRole}"`)
    await runtime.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "agent_root_usage_reservations" TO "${runtimeRole}"`)
    await runtime.$executeRaw`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES (${ids.session}, ${ids.user}, 'running')`
    await runtime.$executeRaw`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "rootTaskId", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt")
      VALUES (${ids.turn}, ${ids.session}, ${ids.user}, ${ids.root}, 'in_progress', 'root-worker', 1, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`
    await runtime.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "budgetSnapshot", "outputTokenReservationVersion", "attemptCount", "leaseOwner", "leaseExpiresAt")
      VALUES (${ids.root}, ${ids.session}, ${ids.turn}, ${ids.root}, NULL, ${`/${ids.root}`}, 0, 'orchestrator', 'root', 'running', '{"limits":{"maxOutputTokens":100}}'::jsonb, 1, 1, 'root-worker', CURRENT_TIMESTAMP + INTERVAL '10 minutes')`
    await runtime.$executeRaw`UPDATE "agent_turns" SET "rootTaskId" = ${ids.root} WHERE "id" = ${ids.turn}`
    for (let index = 0; index < ids.tasks.length; index++) {
      const parentIndex = index < 2 ? null : index < 5 ? 0 : 1
      const parentTaskId = parentIndex === null ? ids.root : ids.tasks[parentIndex]!
      const depth = parentIndex === null ? 1 : 2
      const path = parentIndex === null
        ? `/${ids.root}/${ids.tasks[index]}`
        : `/${ids.root}/${ids.tasks[parentIndex]}/${ids.tasks[index]}`
      await runtime.$executeRaw`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "budgetSnapshot", "attemptCount", "leaseOwner", "leaseExpiresAt")
        VALUES (${ids.tasks[index]}, ${ids.session}, ${ids.turn}, ${ids.root}, ${parentTaskId}, ${path}, ${depth}, 'scout', 'job_discovery', 'running', '{}'::jsonb, 1, ${`worker-${index}`}, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`
      await runtime.$executeRaw`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "attempt", "status")
        VALUES (${ids.steps[index]}, ${ids.session}, ${ids.turn}, ${ids.tasks[index]}, 1, 'streaming')`
    }
  })

  afterAll(async () => {
    await runtime?.$disconnect()
    if (admin && schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    if (admin && roleCreated) {
      await admin.$executeRawUnsafe(`DROP OWNED BY "${runtimeRole}"`)
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${runtimeRole}"`)
    }
    await admin?.$disconnect()
  })

  it("serializes depth-2 Scout reservations and rejects unknown usage and stale owners under tenant RLS", async () => {
    const chain = await runtimeTransaction(ids.user, tx => tx.$queryRaw<Array<{
      id: string; parentTaskId: string; depth: number; role: string; taskType: string; graphUserId: string
      parentDepth: number; parentRole: string; grandparentTaskId: string; rootDepth: number; rootRole: string; rootTaskType: string; rootParentTaskId: string | null
    }>>(Prisma.sql`
      SELECT child."id", child."parentTaskId", child."depth", child."role", child."taskType",
        parent."depth" AS "parentDepth", parent."role" AS "parentRole", parent."parentTaskId" AS "grandparentTaskId",
        root."depth" AS "rootDepth", root."role" AS "rootRole", root."taskType" AS "rootTaskType", root."parentTaskId" AS "rootParentTaskId",
        owner_session."userId" AS "graphUserId"
      FROM "sub_agent_tasks" child
      JOIN "sub_agent_tasks" parent ON parent."id" = child."parentTaskId" AND parent."sessionId" = child."sessionId"
      JOIN "sub_agent_tasks" root ON root."id" = parent."parentTaskId" AND root."sessionId" = parent."sessionId"
      JOIN "agent_sessions" owner_session ON owner_session."id" = root."sessionId" AND owner_session."userId" = ${ids.user}
      WHERE child."id" IN (${Prisma.join(ids.tasks.slice(2))})
        AND child."rootTaskId" = ${ids.root} AND parent."rootTaskId" = ${ids.root} AND root."id" = ${ids.root}
        AND child."sessionId" = ${ids.session} AND parent."sessionId" = ${ids.session} AND root."sessionId" = ${ids.session}
        AND child."turnId" = ${ids.turn} AND parent."turnId" = ${ids.turn} AND root."turnId" = ${ids.turn}
      ORDER BY child."id"`))
    expect(chain).toHaveLength(6)
    expect(chain.map(row => row.id).sort()).toEqual(ids.tasks.slice(2).sort())
    expect(chain.every(row => row.depth === 2 && row.role === "scout" && row.taskType === "job_discovery"
      && row.parentDepth === 1 && row.parentRole === "scout" && row.grandparentTaskId === ids.root
      && row.rootDepth === 0 && row.rootRole === "orchestrator" && row.rootTaskType === "root"
      && row.rootParentTaskId === null && row.graphUserId === ids.user)).toBe(true)

    const results = await Promise.all([admit(2), admit(5)])
    expect(results.map(value => value.maxOutputTokens).sort((a, b) => Number(a) - Number(b))).toEqual([20, 80])

    const admitted = results.find(value => value.maxOutputTokens === 80)!
    const row = await runtimeTransaction(ids.user, tx => findRootOutputReservation(tx, admitted.operationId, ids.user))
    expect(row).not.toBeNull()
    await runtimeTransaction(ids.user, async tx => {
      await lockRootUsageReservationScope(tx, row!)
      await startRootOutputReservation(tx, row!)
    })
    await runtimeTransaction(ids.user, async tx => {
      await lockRootUsageReservationScope(tx, row!)
      await settleRootOutputReservation(tx, row!, { status: "error", outputTokens: null, errorCode: "provider_error" })
    })

    await expect(admit(4)).rejects.toMatchObject({ code: "output_budget_exhausted" })
    const persisted = await runtimeTransaction(ids.user, tx => findRootOutputReservation(tx, admitted.operationId, ids.user))
    expect(persisted).toMatchObject({ status: "started", actualOutputTokens: null, outcomeStatus: "error" })
    await expect(runtimeTransaction(ids.otherUser, tx => findRootOutputReservation(tx, admitted.operationId, ids.otherUser))).resolves.toBeNull()
    await expect(runtimeTransaction(ids.otherUser, tx => lockRootUsageAdmissionScope(tx, {
      ...scope(2), userId: ids.otherUser,
    }, owner(2)))).rejects.toMatchObject({ code: "usage_fence_rejected" })

    await runtime!.$executeRaw`UPDATE "sub_agent_tasks" SET "attemptCount" = 2 WHERE "id" = ${ids.tasks[6]} AND "sessionId" = ${ids.session}`
    await runtime!.$executeRaw`UPDATE "agent_steps" SET "attempt" = 2 WHERE "id" = ${ids.steps[6]} AND "sessionId" = ${ids.session}`
    await expect(admit(6)).rejects.toMatchObject({ code: "usage_fence_rejected" })
    await expect(runtimeTransaction(ids.user, tx => lockRootUsageAdmissionScope(tx, scope(6), {
      ...owner(6), attemptCount: 2,
    }))).resolves.toMatchObject({ taskId: ids.tasks[6], attempt: 2 })

    await runtime!.$executeRaw`UPDATE "sub_agent_tasks" SET "leaseOwner" = 'worker-7-current' WHERE "id" = ${ids.tasks[7]} AND "sessionId" = ${ids.session}`
    await expect(admit(7)).rejects.toMatchObject({ code: "usage_fence_rejected" })
    await expect(runtimeTransaction(ids.user, tx => lockRootUsageAdmissionScope(tx, scope(7), {
      ...owner(7), ownerId: "worker-7-current",
    }))).resolves.toMatchObject({ taskId: ids.tasks[7], attempt: 1 })
    for (const index of [6, 7]) {
      await expect(runtimeTransaction(ids.user, tx => findRootOutputReservation(tx, operationIds[index]!, ids.user))).resolves.toBeNull()
    }
  })
})
