import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import { canonicalJson } from "@jobcopilot/shared"

import type { TurnLease } from "../turns/lease.js"
import type { SubagentLease } from "../subagents/types.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { verifyScheduledPrepareToolResultReference } from "../subagents/scheduled-prepare-tool-result-verification.js"
import { createToolResultReferenceRepository, isVerifiedToolResultChunk } from "./tool-result-reference-repo.js"
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES, prepareToolResultJson, type CanonicalToolSourceName, type PutToolResultInput, type ToolResultReferenceRepository } from "./tool-result-reference-types.js"

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

type OwnerFixture = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly stepId: string
  readonly owner: { readonly kind: "turn"; readonly taskId: string; readonly lease: TurnLease }
}

function fixture(label: string): OwnerFixture {
  const suffix = randomUUID()
  const userId = `p1-${label}-${suffix}`
  const sessionId = `p1-session-${label}-${suffix}`
  const turnId = `p1-turn-${label}-${suffix}`
  const rootTaskId = `p1-root-${label}-${suffix}`
  const stepId = `p1-step-${label}-${suffix}`
  const leaseExpiresAt = new Date(Date.now() + 5 * 60_000)
  const leaseStartedAt = new Date(Date.now() - 1000)
  const lease = {
    turnId,
    sessionId,
    ownerId: `worker-${label}`,
    userId,
    leaseVersion: 1,
    leaseStartedAt,
    leaseExpiresAt,
  }
  return { userId, sessionId, turnId, rootTaskId, stepId, owner: { kind: "turn", taskId: rootTaskId, lease } }
}

type ScheduledPrepareFixture = {
  readonly root: OwnerFixture
  readonly taskId: string
  readonly stepId: string
  readonly attemptCount: number
  readonly owner: { readonly kind: "task"; readonly lease: SubagentLease }
}

function scheduledPrepareFixture(root: OwnerFixture): ScheduledPrepareFixture {
  const taskId = `subagent-${randomUUID()}`, stepId = `p1-prepare-step-${randomUUID()}`, attemptCount = 2
  const ownerId = root.owner.lease.ownerId
  const lease: SubagentLease = {
    id: taskId, userId: root.userId, sessionId: root.sessionId, turnId: root.turnId, rootTaskId: root.rootTaskId,
    parentTaskId: root.rootTaskId, path: `/root/${taskId}`, depth: 1, role: "prepare", taskType: "scheduled_application_prepare",
    status: "running", goal: "Prepare scheduled materials", constraints: [], successCriteria: [], allowedActions: ["scheduled.application.prepare"],
    context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount, maxAttempts: 3, leaseOwner: ownerId,
    leaseExpiresAt: root.owner.lease.leaseExpiresAt, interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId,
    signal: new AbortController().signal,
  }
  return { root, taskId, stepId, attemptCount, owner: { kind: "task", lease } }
}

function largePrepareReceipt(taskId: string, attemptCount: number) {
  const jobs = Array.from({ length: 50 }, (_, index) => ({ jobId: `c${index.toString(36).padStart(24, "0")}`, status: "prepared" as const }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" as const, status: "completed" as const, taskId, attemptCount,
    snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64), jobs,
    materials: jobs.map((job, index) => ({ jobId: job.jobId, kind: "resume" as const, artifactRef: {
      artifactId: `scheduled-draft:${index.toString(16).padStart(64, "0")}`, version: 1,
      contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}`,
    } })),
  }
}

async function seedOwner(pool: PgPool, value: OwnerFixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'P1 PostgreSQL private result test', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, $4, $5, $6, 1, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId, value.owner.lease.ownerId,
    value.owner.lease.leaseExpiresAt, value.owner.lease.leaseStartedAt,
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'P1 PostgreSQL private result test', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 1, CURRENT_TIMESTAMP)`, [
    value.rootTaskId, value.sessionId, value.turnId,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.rootTaskId, value.turnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 0, '[]'::jsonb, '{}'::jsonb)`, [
    value.stepId, value.sessionId, value.turnId, value.rootTaskId,
  ])
}

async function seedToolCall(pool: PgPool, owner: OwnerFixture, toolCallId: string): Promise<void> {
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP)`, [
    `p1-tool-call-${randomUUID()}`, owner.sessionId, owner.turnId, owner.stepId, owner.rootTaskId,
    JSON.stringify({ toolCallId, toolName: "notes.read" }),
  ])
}

async function seedScheduledPrepareTask(pool: PgPool, value: ScheduledPrepareFixture): Promise<void> {
  const lease = value.owner.lease
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, $5, 1, 'prepare', 'scheduled_application_prepare', 'running', 'Prepare fixture',
      '[]'::jsonb, '[]'::jsonb, $6::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $7, 3, $8, $9, CURRENT_TIMESTAMP)`, [value.taskId, value.root.sessionId, value.root.turnId,
    value.root.rootTaskId, lease.path, JSON.stringify(lease.allowedActions), value.attemptCount, lease.ownerId, lease.leaseExpiresAt])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, $5, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [value.stepId, value.root.sessionId, value.root.turnId, value.taskId, value.attemptCount])
}

async function seedScheduledPrepareToolCall(pool: PgPool, value: ScheduledPrepareFixture, toolCallId: string): Promise<void> {
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', $6::jsonb, CURRENT_TIMESTAMP)`, [
    `p1-prepare-call-${randomUUID()}`, value.root.sessionId, value.root.turnId, value.stepId, value.taskId,
    JSON.stringify({ toolCallId, toolName: "scheduled.application.prepare", toolVersion: "1", status: "completed", errorCode: null, input: {} }),
  ])
}

async function setRuntimeRole(client: PoolClient): Promise<void> {
  await client.query(`SET ROLE "${RUNTIME_ROLE}"`)
}

function runtimePool(adminPool: PgPool, backendPids: number[]): Pick<PgPool, "connect"> {
  return {
    async connect() {
      const client = await adminPool.connect()
      try {
        await setRuntimeRole(client)
        const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        backendPids.push(identity.rows[0]!.pid)
        return client
      } catch (error) {
        client.release()
        throw error
      }
    },
  }
}

describeWithPostgres("PostgreSQL private tool-result persistence (P1 slice)", () => {
  const ownerA = fixture("owner-a")
  const ownerB = fixture("owner-b")
  const ownerC = fixture("prepare-restart")
  const scheduledPrepare = scheduledPrepareFixture(ownerC)
  let adminPool: PgPool | undefined
  let writerPool: PgPool | undefined
  let readerPool: PgPool | undefined
  let writer: ToolResultReferenceRepository
  let reader: ToolResultReferenceRepository
  let resultId: string
  const writerBackendPids: number[] = []
  const readerBackendPids: number[] = []

  beforeAll(async () => {
    adminPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    await adminPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
    await adminPool.query(`ALTER ROLE ${RUNTIME_ROLE} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "agent_steps", "agent_items", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_sessions", "agent_turns", "agent_steps", "sub_agent_tasks" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT SELECT, INSERT ON "agent_tool_result_references" TO ${RUNTIME_ROLE}`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_tool_result_references" TO ${RUNTIME_ROLE}`)
    await seedOwner(adminPool, ownerA)
    await seedOwner(adminPool, ownerB)

    writerPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    writer = createToolResultReferenceRepository(runtimePool(writerPool, writerBackendPids))
    readerPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    reader = createToolResultReferenceRepository(runtimePool(readerPool, readerBackendPids))
  })

  afterAll(async () => {
    await writerPool?.end()
    await readerPool?.end()
    if (adminPool) {
      await adminPool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[ownerA.userId, ownerB.userId, ownerC.userId]])
      await adminPool.end()
    }
  })

  it("persists across a new pool and enforces owner-scoped RLS for reads", async () => {
    const roleState = await readerPool!.connect()
    try {
      await setRuntimeRole(roleState)
      const result = await roleState.query<{
        isSuperuser: boolean
        bypassesRls: boolean
        ownsTable: boolean
        tableRlsEnabled: boolean
        rowSecurityActive: boolean
      }>(`SELECT role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          pg_get_userbyid(relation.relowner) = current_user AS "ownsTable", relation.relrowsecurity AS "tableRlsEnabled",
          row_security_active(relation.oid) AS "rowSecurityActive"
        FROM pg_roles role CROSS JOIN pg_class AS relation
        WHERE role.rolname = current_user AND relation.oid = 'agent_tool_result_references'::regclass`)
      expect(result.rows[0]).toEqual({
        isSuperuser: false,
        bypassesRls: false,
        ownsTable: false,
        tableRlsEnabled: true,
        rowSecurityActive: true,
      })
    } finally {
      roleState.release()
    }

    const input: PutToolResultInput = {
      stepId: ownerA.stepId,
      toolCallId: `call-${randomUUID()}`,
      value: { private: "owner A durable tool result", nested: { status: "complete" } },
    }
    await seedToolCall(writerPool!, ownerA, input.toolCallId)
    const stored = await writer!.put(ownerA.owner, input)
    resultId = stored.id
    await writerPool!.end()
    writerPool = undefined

    const ownerARead = await reader!.read(ownerA.owner, { referenceId: resultId })
    expect(ownerARead).toMatchObject({
      ref: resultId,
      byteCount: stored.byteCount,
      sha256: stored.sha256,
      chunk: JSON.stringify({ nested: { status: "complete" }, private: "owner A durable tool result" }),
      nextCursor: null,
    })

    const policyProbe = await readerPool!.connect()
    try {
      await setRuntimeRole(policyProbe)
      await policyProbe.query("BEGIN")
      await policyProbe.query("SELECT set_config('app.user_id', $1, true)", [ownerB.userId])
      const rows = await policyProbe.query<{ id: string }>(
        `SELECT "id" FROM "agent_tool_result_references" WHERE "id" = $1`,
        [resultId],
      )
      expect(rows.rows).toEqual([])
      await policyProbe.query("COMMIT")
    } catch (error) {
      await policyProbe.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      policyProbe.release()
    }

    const ownerBRead = await reader!.read(ownerB.owner, { referenceId: resultId })
    expect(ownerBRead).toBeNull()
    expect(writerBackendPids[0]).toBeDefined()
    expect(readerBackendPids[0]).toBeDefined()
    expect(readerBackendPids[0]).not.toBe(writerBackendPids[0])
  })

  it("persists a large Prepare receipt across a Worker restart with the exact attempt and tool-call binding", async () => {
    await seedOwner(adminPool!, ownerC)
    await seedScheduledPrepareTask(adminPool!, scheduledPrepare)
    const toolCallId = `prepare-${randomUUID()}`
    await seedScheduledPrepareToolCall(adminPool!, scheduledPrepare, toolCallId)
    const source = "scheduled.application.prepare" as CanonicalToolSourceName
    const value = largePrepareReceipt(scheduledPrepare.taskId, scheduledPrepare.attemptCount)
    const prepared = prepareToolResultJson(value, source, scheduledPrepare.taskId, scheduledPrepare.attemptCount)
    expect(prepared.bytes).toBeGreaterThan(8 * 1024)
    expect(prepared.bytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)

    const writerBackend: number[] = [], readerBackend: number[] = []
    let beforeRestartPool: PgPool | undefined = new PgPool({ connectionString: databaseUrl!, max: 1 })
    let afterRestartPool: PgPool | undefined = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const beforeRestart = createToolResultReferenceRepository(runtimePool(beforeRestartPool, writerBackend))
      const stored = await beforeRestart.put(scheduledPrepare.owner, {
        stepId: scheduledPrepare.stepId, toolCallId, value,
      })
      expect(stored.sanitizedJson).toEqual(prepared.value)
      expect(stored.taskId).toBe(scheduledPrepare.taskId)
      expect(stored.toolCallId).toBe(toolCallId)
      expect(stored.byteCount).toBe(prepared.bytes)
      expect(stored.sha256).toBe(prepared.sha256)
      expect(stored.sha256).toBe(createHash("sha256").update(canonicalJson(stored.sanitizedJson), "utf8").digest("hex"))

      await beforeRestartPool.end()
      beforeRestartPool = undefined
      const afterRestart = createToolResultReferenceRepository(runtimePool(afterRestartPool, readerBackend))
      const chunks: string[] = []
      let cursor: string | undefined
      let last: Awaited<ReturnType<typeof afterRestart.read>> = null
      for (let index = 0; index < Math.ceil(stored.byteCount / 2_048) + 2; index += 1) {
        last = await afterRestart.read(scheduledPrepare.owner, {
          referenceId: stored.id, ...(cursor === undefined ? {} : { cursor }),
        }, toolCallId)
        expect(last).not.toBeNull()
        const encodedChunk = JSON.stringify(last)
        expect(encodedChunk).toBeTypeOf("string")
        expect(Buffer.byteLength(encodedChunk!, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_READ_BYTES)
        expect(isVerifiedToolResultChunk(last, scheduledPrepare.owner, toolCallId)).toBe(true)
        chunks.push(last!.chunk)
        if (last!.nextCursor === null) break
        cursor = last!.nextCursor
      }
      const encoded = chunks.join("")
      expect(last?.nextCursor).toBeNull()
      expect(encoded).toBe(prepared.encoded)
      expect(Buffer.byteLength(encoded, "utf8")).toBe(stored.byteCount)
      expect(createHash("sha256").update(encoded, "utf8").digest("hex")).toBe(stored.sha256)
      expect(writerBackend[0]).toBeDefined()
      expect(readerBackend[0]).toBeDefined()
      expect(readerBackend[0]).not.toBe(writerBackend[0])

      const reference = { $ref: stored.id, sizeBytes: stored.byteCount, sha256: stored.sha256 }
      const verificationScope = { userId: ownerC.userId, sessionId: ownerC.sessionId, turnId: ownerC.turnId,
        rootTaskId: ownerC.rootTaskId, taskId: scheduledPrepare.taskId, attemptCount: scheduledPrepare.attemptCount }
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = $2 WHERE "id" = $1`, [
        scheduledPrepare.taskId, scheduledPrepare.attemptCount + 1,
      ])
      await expect(afterRestart.read(scheduledPrepare.owner, { referenceId: stored.id }, toolCallId))
        .rejects.toMatchObject({ code: "tool_result_fence_rejected" })
      const staleVerificationClient = await afterRestartPool.connect()
      try {
        await setRuntimeRole(staleVerificationClient)
        await staleVerificationClient.query("BEGIN")
        await staleVerificationClient.query("SELECT set_config('app.user_id', $1, true)", [ownerC.userId])
        await expect(verifyScheduledPrepareToolResultReference(staleVerificationClient, {
          reference, scope: verificationScope, mode: { phase: "finish", ownerId: scheduledPrepare.owner.lease.ownerId },
          stepId: scheduledPrepare.stepId, toolCallId, expectedResult: value,
        })).resolves.toBeNull()
        await staleVerificationClient.query("COMMIT")
      } catch (error) {
        await staleVerificationClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally {
        staleVerificationClient.release()
      }
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = $2 WHERE "id" = $1`, [
        scheduledPrepare.taskId, scheduledPrepare.attemptCount,
      ])

      await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed' WHERE "id" = $1`, [scheduledPrepare.stepId])
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "failureReason" = NULL,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE "id" = $1`, [scheduledPrepare.taskId])
      const verificationClient = await afterRestartPool.connect()
      try {
        await setRuntimeRole(verificationClient)
        await verificationClient.query("BEGIN")
        await verificationClient.query("SELECT set_config('app.user_id', $1, true)", [ownerC.userId])
        const verificationInput = { reference, scope: verificationScope, mode: { phase: "persisted_gate" as const },
          stepId: scheduledPrepare.stepId, toolCallId, expectedResult: value }
        await expect(verifyScheduledPrepareToolResultReference(verificationClient, verificationInput)).resolves.toEqual(value)
        await expect(verifyScheduledPrepareToolResultReference(verificationClient, {
          ...verificationInput, toolCallId: `wrong-${toolCallId}`,
        })).resolves.toBeNull()
        await expect(verifyScheduledPrepareToolResultReference(verificationClient, {
          ...verificationInput, reference: { ...reference, sha256: "e".repeat(64) },
        })).resolves.toBeNull()
        await expect(verifyScheduledPrepareToolResultReference(verificationClient, {
          ...verificationInput, scope: { ...verificationScope, attemptCount: scheduledPrepare.attemptCount + 1 },
        })).resolves.toBeNull()
        await verificationClient.query("COMMIT")
      } catch (error) {
        await verificationClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally {
        verificationClient.release()
      }
    } finally {
      await beforeRestartPool?.end()
      await afterRestartPool?.end()
    }
  })
})
