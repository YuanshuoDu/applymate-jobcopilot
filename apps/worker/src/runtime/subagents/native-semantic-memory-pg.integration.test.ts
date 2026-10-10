import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { digestNativeVerificationValue, NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, parseNativeVerificationControl } from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { attachNativeVerificationReport, parseNativeVerificationModelReport } from "./native-verification-report.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native semantic memory needs the dedicated disposable PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native semantic memory requires the dedicated disposable PostgreSQL URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), userId = `native-semantic-user-${suffix}`, sessionId = `native-semantic-session-${suffix}`
const turnId = `native-semantic-turn-${suffix}`, rootTaskId = `native-semantic-root-${suffix}`
const turnOwnerId = `native-semantic-turn-owner-${suffix}`
const stepIds = [1, 2, 3, 4, 5, 6, 7, 8].map(index => `native-semantic-step-${index}-${suffix}`)
stepIds[0] = `s${"é".repeat(210)}${suffix}`
const criterion = "The candidate must meet the persisted user objective"
const goal = "Produce a concise answer for the persisted objective"
const candidateA = "Candidate A does not satisfy the persisted objective."
const candidateB = "Candidate B also remains under review."
const future = new Date(Date.now() + 10 * 60_000)
const owner: ExecutionOwnerFence = {
  kind: "turn", userId, sessionId, turnId, taskId: rootTaskId, rootTaskId,
  ownerId: turnOwnerId, leaseVersion: 1, leaseExpiresAt: future,
}
const scope: TaskGraphExecutionScope = {
  userId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, stepId: stepIds[0]!,
  turnLeaseOwner: turnOwnerId, turnLeaseVersion: 1, parentLeaseOwner: turnOwnerId, parentAttemptCount: 1,
}
let adminPool: Pool | undefined
let runtimePool: Pool | undefined
let runtimeRole: string | undefined
let store: TurnEngineStore | undefined

async function seedOwnerRows(): Promise<void> {
  await adminPool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [userId, `${userId}@example.invalid`])
  await adminPool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Native semantic memory disposable integration', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
  await adminPool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, $6, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [turnId, sessionId, userId, JSON.stringify({ goal, successCriteria: [criterion] }), turnOwnerId, future])
  await adminPool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4,
      '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $6, $7, CURRENT_TIMESTAMP)`,
  [rootTaskId, sessionId, turnId, goal, JSON.stringify([criterion]), turnOwnerId, future])
  await adminPool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [rootTaskId])
  await adminPool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [rootTaskId, turnId])
}

async function seedStep(stepId: string, ordinal: number, inputThroughSequence: string): Promise<void> {
  await adminPool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, $5, 1, 'streaming', $6, '[]'::jsonb, '{}'::jsonb)`,
  [stepId, sessionId, turnId, rootTaskId, ordinal, inputThroughSequence])
}

function requiredStoreMethod<K extends "resolveNativeSemanticProgressMode" | "readNativeSemanticRejections" | "completeNativeSemanticRejectionStep">(
  value: TurnEngineStore, name: K,
): NonNullable<TurnEngineStore[K]> {
  const method = value[name]
  if (typeof method !== "function") throw new Error(`native_semantic_store_method_missing:${name}`)
  return method as NonNullable<TurnEngineStore[K]>
}

async function persistStrictFailedRootReport(candidateText: string, taskId: string, reportReason: "does_not_meet_criterion" | "evidence_conflict") {
  const stored = await adminPool!.query<{ expectedOutputSchema: unknown; context: unknown }>(
    `SELECT "expectedOutputSchema", "context" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
      AND "rootTaskId" = $4 AND "parentTaskId" = $4 AND "role" = 'auditor' AND "taskType" = 'native_verification'`,
  [taskId, sessionId, turnId, rootTaskId])
  const row = stored.rows[0], control = row && parseNativeVerificationControl(row.expectedOutputSchema)
  const packet = control ? parseNativeVerificationPacket(row!.context, control) : null
  if (!control || !packet || control.target.kind !== "root_goal"
    || control.target.candidateDigest !== digestNativeVerificationValue(candidateText)) {
    throw new Error("native_semantic_fixture_control_invalid")
  }
  const modelReport = parseNativeVerificationModelReport({
    schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
    criteria: packet.criteria.map(item => ({ criterionId: item.criterionId, disposition: "failed" as const,
      reasonCode: reportReason, evidenceReferenceIds: [packet.target.referenceId] })),
  }, packet)
  if (!modelReport) throw new Error("native_semantic_fixture_report_invalid")
  const report = attachNativeVerificationReport(control, 1, modelReport)
  if (!report) throw new Error("native_semantic_fixture_report_unbound")
  const updated = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = 1,
      "result" = $2::jsonb, "failureReason" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "rootTaskId" = $5 AND "parentTaskId" = $5
      AND "role" = 'auditor' AND "taskType" = 'native_verification' AND "status" IN ('queued', 'waiting') AND "attemptCount" = 0`,
  [taskId, JSON.stringify({ nativeVerificationReport: report }), sessionId, turnId, rootTaskId])
  if (updated.rowCount !== 1) throw new Error("native_semantic_fixture_control_completion_conflict")
}

async function readStrictRejectionIdentity(candidateText: string, taskId: string, proofScope: TaskGraphExecutionScope = scope) {
  const port = createPgNativeVerificationPort(adminPool as unknown as PgSubagentPool)
  const identity = await port.readFailedRootSemanticRejection?.({ scope: proofScope, candidateText, controlTaskId: taskId })
  if (!identity) throw new Error("native_semantic_fixture_strict_proof_unavailable")
  return identity
}

async function ensureRejectedCandidate(
  candidateText: string,
  stepId: string,
  reportReason: "does_not_meet_criterion" | "evidence_conflict" = "does_not_meet_criterion",
) {
  const proofScope = { ...scope, stepId }
  const port = createPgNativeVerificationPort(adminPool as unknown as PgSubagentPool)
  const result = await port.ensureRootGoal({ scope: proofScope, candidateText })
  if (!result.controlTaskIds.length || !["pending", "failed"].includes(result.status)) {
    throw new Error("native_semantic_fixture_root_control_not_created")
  }
  const taskId = [...result.controlTaskIds].reverse()[0]!
  const existing = await adminPool!.query<{ status: string; attemptCount: number }>(
    `SELECT "status", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
  const row = existing.rows[0]
  if (row?.status === "queued" || row?.status === "waiting") await persistStrictFailedRootReport(candidateText, taskId, reportReason)
  return readStrictRejectionIdentity(candidateText, taskId, proofScope)
}

describePg("native semantic rejection PostgreSQL acceptance", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl!, max: 4 })
    await seedOwnerRows()
    const roleName = `native_semantic_runtime_${suffix.replaceAll("-", "")}`
    await adminPool.query(`CREATE ROLE "${roleName}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    runtimeRole = roleName
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("updatedAt") ON "agent_sessions", "sub_agent_tasks" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("updatedAt") ON "agent_items" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("native_semantic_progress_mode", "updatedAt") ON "agent_turns" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT UPDATE ("status", "finishReason", "errorCode", "inputTokens", "outputTokens", "estimatedCostUsd", "completedAt") ON "agent_steps" TO "${runtimeRole}"`)
    await adminPool.query(`GRANT SELECT, INSERT ON "agent_native_semantic_rejections" TO "${runtimeRole}"`)
    runtimePool = new Pool({ connectionString: databaseUrl!, max: 2 })
    const rolePool = {
      async connect() {
        const client = await runtimePool!.connect()
        await client.query(`SET ROLE "${runtimeRole}"`)
        return client
      },
    }
    store = createPgTurnEngineStore(rolePool as unknown as Pick<Pool, "connect">)
  })

  afterAll(async () => {
    await runtimePool?.end()
    if (adminPool) {
      if (runtimeRole) {
        await adminPool.query(`DROP OWNED BY "${runtimeRole}"`)
        await adminPool.query(`DROP ROLE "${runtimeRole}"`)
      }
      await adminPool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [sessionId])
      await adminPool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
      await adminPool.end()
    }
  })

  it("pins durable mode and counts only distinct strict root rejections per candidate and input epoch", async () => {
    expect(Array.from(stepIds[0]!).length).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(stepIds[0]!, "utf8")).toBeGreaterThan(256)
    const resolveMode = requiredStoreMethod(store!, "resolveNativeSemanticProgressMode")
    const complete = requiredStoreMethod(store!, "completeNativeSemanticRejectionStep")
    const read = requiredStoreMethod(store!, "readNativeSemanticRejections")
    await expect(resolveMode({ owner, requestedEnabled: true, now: new Date() })).resolves.toBe("durable_v1")
    await seedStep(stepIds[0]!, 1, "0")
    const identityA = await ensureRejectedCandidate(candidateA, stepIds[0]!)
    await expect(read({ owner, stepId: stepIds[0]!, identity: identityA })).resolves.toMatchObject({ inputThroughSequence: 0n, stepIds: [] })
    const usage = { inputTokens: 41, outputTokens: 17, estimatedCostUsd: 0.0041 }
    const times = new Map<string, Date>()
    const finish = (stepId: string, identity: typeof identityA, values = usage) => {
      let now = times.get(stepId)
      if (!now) { now = new Date(); times.set(stepId, now) }
      return complete({ owner, stepId, finishReason: "stop", errorCode: null, ...values, now, identity })
    }
    await expect(resolveMode({ owner, requestedEnabled: false, now: new Date() })).resolves.toBe("durable_v1")

    const first = await finish(stepIds[0]!, identityA)
    expect(first).toMatchObject({ inputThroughSequence: 0n, distinctStepCount: 1 })
    const persistedStep = await adminPool!.query<{ status: string; inputTokens: number; outputTokens: number; estimatedCostUsd: string }>(
      `SELECT "status", "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_steps" WHERE "id" = $1`, [stepIds[0]])
    expect(persistedStep.rows[0]).toMatchObject({ status: "completed", inputTokens: 41, outputTokens: 17 })
    expect(Number(persistedStep.rows[0]?.estimatedCostUsd)).toBeCloseTo(0.0041, 8)

    // A newly constructed Store represents database-backed Store/runtime reconstruction, not a Worker restart.
    const reconstructedStore = createPgTurnEngineStore({
      async connect() { const client = await runtimePool!.connect(); await client.query(`SET ROLE "${runtimeRole}"`); return client },
    } as unknown as Pick<Pool, "connect">)
    const readAfterReconstruction = requiredStoreMethod(reconstructedStore, "readNativeSemanticRejections")
    await seedStep(stepIds[1]!, 2, "0")
    await expect(readAfterReconstruction({ owner, stepId: stepIds[1]!, identity: identityA })).resolves.toMatchObject({
      inputThroughSequence: 0n, stepIds: [stepIds[0]],
    })
    await expect(finish(stepIds[0]!, identityA)).resolves.toMatchObject({ distinctStepCount: 1 })
    await expect(finish(stepIds[0]!, identityA, { ...usage, inputTokens: 42 })).rejects.toThrow()

    await seedStep(stepIds[2]!, 3, "0")
    await expect(finish(stepIds[1]!, identityA)).resolves.toMatchObject({ distinctStepCount: 2 })
    const reconstructedAfterTwo = createPgTurnEngineStore({
      async connect() { const client = await runtimePool!.connect(); await client.query(`SET ROLE "${runtimeRole}"`); return client },
    } as unknown as Pick<Pool, "connect">)
    const readAfterTwo = requiredStoreMethod(reconstructedAfterTwo, "readNativeSemanticRejections")
    const completeAfterTwo = requiredStoreMethod(reconstructedAfterTwo, "completeNativeSemanticRejectionStep")
    await expect(readAfterTwo({ owner, stepId: stepIds[2]!, identity: identityA })).resolves.toMatchObject({
      inputThroughSequence: 0n, stepIds: [stepIds[0], stepIds[1]],
    })
    await expect(completeAfterTwo({ owner, stepId: stepIds[2]!, finishReason: "stop", errorCode: null,
      ...usage, now: new Date(), identity: identityA })).resolves.toMatchObject({ distinctStepCount: 3 })
    await expect(finish(stepIds[0]!, identityA)).resolves.toMatchObject({ distinctStepCount: 3 })
    const ledger = await adminPool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_native_semantic_rejections"
      WHERE "turnId" = $1 AND "candidateDigest" = $2 AND "controlTaskId" = $3 AND "controlOperationId" = $4
        AND "controlAttempt" = $5 AND "controlReportDigest" = $6 AND "inputThroughSequence" = 0`,
    [turnId, identityA.candidateDigest, identityA.controlTaskId, identityA.controlOperationId, identityA.controlAttempt, identityA.controlReportDigest])
    expect(ledger.rows[0]?.count).toBe(3)

    await seedStep(stepIds[3]!, 4, "0")
    const identityB = await ensureRejectedCandidate(candidateB, stepIds[3]!, "evidence_conflict")
    expect(identityB.controlTaskId).not.toBe(identityA.controlTaskId)
    expect(identityB.candidateDigest).not.toBe(identityA.candidateDigest)
    expect(identityB.controlReportDigest).not.toBe(identityA.controlReportDigest)
    await expect(readAfterReconstruction({ owner, stepId: stepIds[3]!, identity: identityB })).resolves.toMatchObject({
      inputThroughSequence: 0n, stepIds: [],
    })
    await expect(readAfterReconstruction({ owner, stepId: stepIds[3]!, identity: identityA })).resolves.toMatchObject({
      inputThroughSequence: 0n, stepIds: expect.arrayContaining(stepIds.slice(0, 3)),
    })
    await expect(finish(stepIds[3]!, identityB)).resolves.toMatchObject({ distinctStepCount: 1 })

    await expect(complete({ owner, stepId: stepIds[0]!, finishReason: "stop", errorCode: null,
      ...usage, now: times.get(stepIds[0]!)!, identity: identityB })).rejects.toThrow()

    await seedStep(stepIds[4]!, 5, "9")
    await expect(readAfterReconstruction({ owner, stepId: stepIds[4]!, identity: identityB })).resolves.toMatchObject({
      inputThroughSequence: 9n, stepIds: [],
    })
    await expect(finish(stepIds[4]!, identityB)).resolves.toMatchObject({ distinctStepCount: 1 })

    await seedStep(stepIds[5]!, 6, "9")
    const staleIdentityB = { ...identityB, controlAttempt: identityB.controlAttempt + 1 }
    await expect(complete({ owner, stepId: stepIds[5]!, finishReason: "stop", errorCode: null,
      ...usage, now: new Date(), identity: staleIdentityB })).rejects.toThrow()
    const foreignOwner = { ...owner, userId: `native-semantic-foreign-${suffix}` }
    await expect(complete({ owner: foreignOwner, stepId: stepIds[5]!, finishReason: "stop", errorCode: null,
      ...usage, now: new Date(), identity: identityB })).rejects.toThrow()
    const otherOwner = { ...owner, ownerId: `${turnOwnerId}-stale`, leaseVersion: 2 }
    await expect(complete({ owner: otherOwner, stepId: stepIds[5]!, finishReason: "stop", errorCode: null,
      ...usage, now: new Date(), identity: identityB })).rejects.toThrow()
    const untouched = await adminPool!.query<{ status: string }>(`SELECT "status" FROM "agent_steps" WHERE "id" = $1`, [stepIds[5]])
    expect(untouched.rows[0]?.status).toBe("streaming")
    await expect(finish(stepIds[5]!, identityB)).resolves.toMatchObject({ distinctStepCount: 2 })

    const privileges = await adminPool!.query<{ canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean }>(
      `SELECT has_table_privilege($1, 'public.agent_native_semantic_rejections', 'SELECT') AS "canSelect",
        has_table_privilege($1, 'public.agent_native_semantic_rejections', 'INSERT') AS "canInsert",
        has_table_privilege($1, 'public.agent_native_semantic_rejections', 'UPDATE') AS "canUpdate",
        has_table_privilege($1, 'public.agent_native_semantic_rejections', 'DELETE') AS "canDelete"`, [runtimeRole])
    expect(privileges.rows[0]).toEqual({ canSelect: true, canInsert: true, canUpdate: false, canDelete: false })
  }, 60_000)

  it("rolls back Step completion when the restrictive role cannot insert its receipt", async () => {
    await seedStep(stepIds[7]!, 8, "0")
    const identity = await ensureRejectedCandidate(candidateB, stepIds[7]!, "evidence_conflict")
    await adminPool!.query(`REVOKE INSERT ON "agent_native_semantic_rejections" FROM "${runtimeRole}"`)
    try {
      const complete = requiredStoreMethod(store!, "completeNativeSemanticRejectionStep")
      await expect(complete({ owner, stepId: stepIds[7]!, finishReason: "stop", errorCode: null,
        inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.0002, now: new Date(), identity })).rejects.toThrow()
      const rows = await adminPool!.query<{ status: string; inputTokens: number; receipts: number }>(
        `SELECT step."status", step."inputTokens", (SELECT COUNT(*)::int FROM "agent_native_semantic_rejections" AS rejection WHERE rejection."stepId" = step."id") AS "receipts"
         FROM "agent_steps" AS step WHERE step."id" = $1`, [stepIds[7]])
      expect(rows.rows[0]).toEqual({ status: "streaming", inputTokens: 0, receipts: 0 })
    } finally { await adminPool!.query(`GRANT INSERT ON "agent_native_semantic_rejections" TO "${runtimeRole}"`) }
  }, 30_000)
})
