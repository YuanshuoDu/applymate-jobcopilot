import { createHash, createHmac, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Queue, Worker } from "bullmq"
import Redis from "ioredis"
import { Pool as PgPool } from "pg"
import type { ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"

import { claimTurnLease, releaseTurnLease, type TurnLease } from "../turns/lease.js"
import { reclaimExpiredTurns } from "../turns/recovery-scanner-storage.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createPgTurnQuestionStore } from "../turns/turn-question-store.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { TurnEngine } from "../turns/turn-engine.js"
import { TurnStateRefreshRetryError } from "../turns/turn-execution-question.js"
import type { TurnEngineOptions, TurnEngineResult, TurnEngineStore } from "../turns/turn-engine-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { drainAgentWakeups } from "../wakeup/consumer.js"
import { AGENT_TURN_WAKEUP_TOPIC } from "../wakeup/types.js"
import { createCanonicalExecutionProjection } from "../canonical-execution-projection.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { createScheduledAutomationPrepareContinuation } from "./scheduled-automation-prepare-bridge.js"
import { verifyScheduledPrepareTaskGraphEvidence } from "./scheduled-prepare-task-graph-verification.js"
import { createScheduledAutomationPipelineBridge, type ScheduledAutomationPipelineBridgeScope, type ScheduledAutomationPipelineBridgeState } from "./scheduled-automation-pipeline-bridge.js"
import { postScheduledPipelineContinuation, scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import type { TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { PgSubagentPool, SubagentJobPayload } from "./types.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { createScheduledPipelineCandidateStore, SCHEDULED_PIPELINE_CANDIDATE_EVENT, withScheduledPipelineCandidateModelOutput } from "./scheduled-pipeline-candidate-store.js"
import { attachScheduledPipelineCompletion } from "./scheduled-pipeline-completion.js"
import { createScheduledTaskGraphContinuationContract } from "./scheduled-taskgraph-continuation-receipt.js"
import { createPgRootTaskStore } from "./root-task-store.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const SCOUT_VERIFICATION: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ],
}
const databaseUrl = dedicatedDisposableUrl()
const redisUrl = dedicatedDisposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type Fixture = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  scoutTaskId: string
  analystTaskId: string
  jobId: string
  leaseOwnerId: string
  executionId: string
}>
type IntegrationScheduledOwner = {
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
}

let pool: PgPool | undefined
let fixtureUserIds: string[] = []
let disconnectWebDatabase: (() => Promise<void>) | undefined
let priorDatabaseUrl: string | undefined
const prismaApplicationName = `scheduled-analysis-${randomUUID()}`
const analyzeModulePath = "@/lib/agent/stages/analyze"
const scheduledRouteRunServicePath = "@/lib/agent/run-service"
const scheduledRouteModelRouterPath = "@/lib/model-router"
const scheduledRouteEntitlementsPath = "@/lib/entitlements"
const scheduledPipelineRoutePath: string = "@/app/api/internal/agent-runtime/scheduled-pipeline/route"

afterEach(() => {
  vi.doUnmock(analyzeModulePath)
  vi.doUnmock(scheduledRouteRunServicePath)
  vi.doUnmock(scheduledRouteModelRouterPath)
  vi.doUnmock(scheduledRouteEntitlementsPath)
  vi.resetModules()
})

describeWithServices("scheduled automation TaskGraph continuation on disposable PostgreSQL and Redis", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 4 })
    priorDatabaseUrl = process.env.DATABASE_URL
    const prismaUrl = new URL(databaseUrl!)
    prismaUrl.searchParams.set("application_name", prismaApplicationName)
    process.env.DATABASE_URL = prismaUrl.toString()
  })

  it("loads the Web route through the Worker Vitest alias", async () => {
    const route = await vi.importActual<{ POST(request: Request): Promise<Response> }>(scheduledPipelineRoutePath)
    expect(typeof route.POST).toBe("function")
  }, 30_000)

  afterAll(async () => {
    if (pool && fixtureUserIds.length) await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUserIds])
    await pool?.end()
    await disconnectWebDatabase?.()
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorDatabaseUrl
  })

  it("reuses per-job Analyze journal rows after recreating the Worker runner", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    await seedGraph(pool!, value, graphSnapshot(value))
    const owner = {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
      rootAttemptCount: 1, turnLeaseOwnerId: value.leaseOwnerId, turnLeaseVersion: 4,
      executionId: value.executionId, executionAttemptCount: 1,
    }
    const claimToken = `scheduled-analysis-claim-${randomUUID()}`
    const jobIds = [value.jobId, `scheduled-pipeline-missing-${randomUUID()}`]
    const jobs = jobIds.map(id => ({ id, userId: value.userId }))
    const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], minScore: 70,
      dailyCap: 10, requireApproval: true, autoApply: false }
    const checkpointPath = "@/lib/agent/scheduled-taskgraph-pipeline-checkpoint"
    const checkpointModule = await import(checkpointPath) as unknown as {
      scheduledAutomationSnapshotDigest: (value: unknown) => string
      scheduledTaskGraphContinuationKey: (owner: IntegrationScheduledOwner, attestation: unknown) => string
    }
    const snapshotDigest = checkpointModule.scheduledAutomationSnapshotDigest(snapshot)
    const attestation = {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1",
      owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
      snapshotDigest, graphRevision: 1,
      scout: { taskId: value.scoutTaskId, attemptCount: 1, status: "completed", verification: "passed",
        resultDigest: "a".repeat(64), candidateJobIds: jobIds,
        discoveryReceipt: { status: "complete", taskId: value.scoutTaskId, attemptCount: 1, completedCalls: 1,
          candidateCount: jobIds.length, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: "b".repeat(64) } },
      analyst: { taskId: value.analystTaskId, attemptCount: 1, status: "completed", verification: "passed",
        resultDigest: "c".repeat(64), dependsOnTaskIds: [value.scoutTaskId], jobIds },
      evidenceDigest: "d".repeat(64),
    }
    const key = checkpointModule.scheduledTaskGraphContinuationKey(owner, attestation)
    const leaseResult = await pool!.query<{ leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(
      `SELECT "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
    expect(leaseResult.rows[0]).toBeDefined()
    const initialState = { nextStage: "scout", scheduledTaskGraphClaim: {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner,
      claimedAt: new Date(leaseResult.rows[0]!.leaseStartedAt).toISOString(),
      leaseExpiresAt: new Date(leaseResult.rows[0]!.leaseExpiresAt).toISOString(),
    } }
    await seedScheduledExecution(pool!, value, initialState)

    const pendingCalls: string[][] = [], modeledJobs: string[] = []
    let crashAfterFirstScore = true
    vi.doMock(analyzeModulePath, async () => {
      const actual = await vi.importActual<Record<string, unknown>>(analyzeModulePath)
      return {
        ...actual,
        runAnalyze: async (pending: Array<{ id: string; userId: string }>, _ctx: unknown,
          recovery?: { existingScoredJobs?: Array<{ job: { id: string }; score: number; matchedKeywords: string[]; missingKeywords: string[]; recommendation: string; analysisFenceAt: string }>; initialFailed?: number;
            beforeScore?: (jobId: string) => Promise<void>; onScoredJob?: (row: { job: { id: string }; score: number; matchedKeywords: string[]; missingKeywords: string[]; recommendation: string; analysisFenceAt: string }) => Promise<void> }) => {
          pendingCalls.push(pending.map(job => job.id))
          const scoredJobs = [...(recovery?.existingScoredJobs ?? [])]
          for (const job of pending) {
            modeledJobs.push(job.id)
            await recovery?.beforeScore?.(job.id)
            const scored = { job, score: job.id === jobIds[0] ? 82 : 74, matchedKeywords: ["TypeScript"],
              missingKeywords: ["AWS"], recommendation: "Apply after tailoring.", analysisFenceAt: new Date().toISOString() }
            await recovery?.onScoredJob?.(scored)
            scoredJobs.push(scored)
            if (crashAfterFirstScore) { crashAfterFirstScore = false; throw new Error("simulated worker restart") }
          }
          return { stage: "analyze", ok: true, data: { scoredJobs, failed: recovery?.initialFailed ?? 0 },
            metrics: { durationMs: 1, count: scoredJobs.length } }
        },
      }
    })
    const webDbPath = "@/lib/db"
    const webDb = await import(webDbPath) as unknown as { db: { $disconnect: () => Promise<void> } }
    disconnectWebDatabase = () => webDb.db.$disconnect()
    const journalPath = "@/lib/agent/scheduled-taskgraph-analysis-journal"
    const fencePath = "@/lib/agent/scheduled-taskgraph-pipeline-fence"
    let journal = await import(journalPath) as unknown as {
      runScheduledTaskGraphAnalyze: (input: { jobs: Array<{ id: string; userId: string }>; ctx: unknown; owner: typeof owner; key: string;
        claimToken: string; snapshot: unknown; attestation: unknown; state: unknown;
        persist: (state: unknown) => Promise<void> }) => Promise<{ analysis: { data?: { scoredJobs: Array<{ job: { id: string }; score: number }>; failed: number } }; checkpoint: { scoredJobs?: Array<{ job: { id: string }; score: number }> } }>
      scheduledTaskGraphScoreOwnerIsCurrent: (input: { tx: unknown; owner: typeof owner; key: string; claimToken: string }) => Promise<boolean>
    }
    let fence = await import(fencePath) as unknown as {
      saveScheduledTaskGraphCheckpoint: (input: { expectedState: unknown; state: unknown; owner: typeof owner; key: string; claimToken: string;
        assertOwnerCurrent: (tx: unknown) => Promise<boolean> }) => Promise<boolean>
    }
    let persistedState: unknown = initialState
    const persist = async (state: unknown) => {
      const saved = await fence.saveScheduledTaskGraphCheckpoint({ expectedState: persistedState, state, owner, key, claimToken,
        assertOwnerCurrent: tx => journal.scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key, claimToken }) })
      if (!saved) throw new Error("scheduled checkpoint owner fence rejected persistence")
      persistedState = state
    }
    const runInput = (state: unknown, write: typeof persist) => ({ jobs, ctx: {}, owner, key, claimToken, snapshot, attestation, state, persist: write })
    await expect(journal.runScheduledTaskGraphAnalyze(runInput(initialState, persist))).rejects.toThrow("simulated worker restart")
    const afterCrash = (await pool!.query<{ state: Record<string, unknown> }>(
      `SELECT "state" FROM "agent_executions" WHERE "id" = $1`, [value.executionId])).rows[0]?.state
    expect(afterCrash?.scoredJobs).toMatchObject([{ job: { id: jobIds[0] }, score: 82 }])

    vi.resetModules()
    journal = await import(journalPath) as typeof journal
    fence = await import(fencePath) as typeof fence
    const restartedRun = await journal.runScheduledTaskGraphAnalyze(runInput(afterCrash, persist))
    expect(pendingCalls).toEqual([[jobIds[0], jobIds[1]], [jobIds[1]]])
    expect(modeledJobs).toEqual([jobIds[0], jobIds[1]])
    expect(restartedRun.analysis.data?.scoredJobs.map(row => [row.job.id, row.score])).toEqual([[jobIds[0], 82], [jobIds[1], 74]])
    expect(restartedRun.checkpoint.scoredJobs?.map(row => row.job.id)).toEqual(jobIds)
  })

  it("reclaims only an exact pending Gate receipt in PostgreSQL", async () => {
    const valid = fixture(), tampered = fixture(), mismatchedProjection = fixture()
    fixtureUserIds.push(valid.userId, tampered.userId, mismatchedProjection.userId)
    await seedGraph(pool!, valid, graphSnapshot(valid))
    await seedGraph(pool!, tampered, graphSnapshot(tampered))
    await seedGraph(pool!, mismatchedProjection, graphSnapshot(mismatchedProjection))

    const priorWorkerSecret = process.env.AGENT_WORKER_SECRET
    const secret = "scheduled-gate-recovery-integration-secret"
    process.env.AGENT_WORKER_SECRET = secret
    try {
      const now = new Date()
      await seedExpiredScheduledGate(pool!, valid, now, secret)
      await seedExpiredScheduledGate(pool!, tampered, now, secret, true)
      await seedExpiredScheduledGate(pool!, mismatchedProjection, now, secret, false, true)

      await expect(reclaimExpiredTurns(pool!, now, 10)).resolves.toEqual([
        { turnId: valid.turnId, sessionId: valid.sessionId, previousLeaseVersion: 4 },
      ])

      const rows = await pool!.query<{ id: string; status: string; leaseOwnerId: string | null; leaseVersion: number }>(
        `SELECT "id", "status", "leaseOwnerId", "leaseVersion" FROM "agent_turns" WHERE "id" = ANY($1::text[])`,
        [[valid.turnId, tampered.turnId, mismatchedProjection.turnId]])
      const byId = new Map(rows.rows.map(row => [row.id, row]))
      expect(byId.get(valid.turnId)).toMatchObject({ status: "queued", leaseOwnerId: null, leaseVersion: 5 })
      expect(byId.get(tampered.turnId)).toMatchObject({ status: "waiting_for_approval", leaseOwnerId: tampered.leaseOwnerId, leaseVersion: 4 })
      expect(byId.get(mismatchedProjection.turnId)).toMatchObject({ status: "waiting_for_approval", leaseOwnerId: mismatchedProjection.leaseOwnerId, leaseVersion: 4 })
    } finally {
      if (priorWorkerSecret === undefined) delete process.env.AGENT_WORKER_SECRET
      else process.env.AGENT_WORKER_SECRET = priorWorkerSecret
    }
  })

  it("rejects checkpoint, wait and finish writes when the locked Turn lease expires", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    await seedGraph(pool!, value, graphSnapshot(value))
    const owner = {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
      rootAttemptCount: 1, turnLeaseOwnerId: value.leaseOwnerId, turnLeaseVersion: 4,
      executionId: value.executionId, executionAttemptCount: 1,
    }
    const key = `scheduled-taskgraph:${randomUUID()}`
    const claimToken = `scheduled-analysis-claim-${randomUUID()}`
    const state = { nextStage: "execute", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner },
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
        snapshotDigest: `sha256:${"e".repeat(64)}`, graphRevision: 1, evidenceDigest: "f".repeat(64) } }
    await seedScheduledExecution(pool!, value, state)
    const journalPath = "@/lib/agent/scheduled-taskgraph-analysis-journal"
    const fencePath = "@/lib/agent/scheduled-taskgraph-pipeline-fence"
    const journal = await import(journalPath) as unknown as {
      scheduledTaskGraphScoreOwnerIsCurrent: (input: { tx: unknown; owner: typeof owner; key: string; claimToken: string }) => Promise<boolean>
    }
    const fence = await import(fencePath) as unknown as {
      saveScheduledTaskGraphCheckpoint: (input: { expectedState: unknown; state: unknown; owner: typeof owner; key: string; claimToken: string;
        assertOwnerCurrent: (tx: unknown) => Promise<boolean> }) => Promise<boolean>
      persistScheduledTaskGraphWaitMarker: (input: { state: unknown; owner: typeof owner; key: string; claimToken: string; waitId: string; stage: string;
        assertOwnerCurrent: (tx: unknown) => Promise<boolean> }) => Promise<unknown>
      finishScheduledTaskGraphExecution: (input: { state: unknown; owner: typeof owner; key: string; claimToken: string; status: "completed";
        assertOwnerCurrent: (tx: unknown) => Promise<boolean> }) => Promise<boolean>
    }
    const assertOwnerCurrent = (tx: unknown) => journal.scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key, claimToken })
    const attempts: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: "checkpoint", run: () => fence.saveScheduledTaskGraphCheckpoint({ expectedState: state, state: { ...state, nextStage: "audit" }, owner, key, claimToken, assertOwnerCurrent }) },
      { name: "wait marker", run: () => fence.persistScheduledTaskGraphWaitMarker({ state, owner, key, claimToken,
        waitId: `scheduled-wait-${randomUUID()}`, stage: "post-run", assertOwnerCurrent }) },
      { name: "finish", run: () => fence.finishScheduledTaskGraphExecution({ state, owner, key, claimToken, status: "completed", assertOwnerCurrent }) },
    ]

    for (const attempt of attempts) {
      await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = clock_timestamp() + INTERVAL '2 seconds' WHERE "id" = $1`, [value.turnId])
      const blocker = await pool!.connect()
      try {
        await blocker.query("BEGIN")
        await blocker.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 FOR UPDATE`, [value.turnId])
        const pending = attempt.run()
        await waitForTurnOwnerLockWait(pool!, prismaApplicationName)
        const lease = await pool!.query<{ unexpired: boolean }>(`SELECT "leaseExpiresAt" > clock_timestamp() AS "unexpired"
          FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
        expect(lease.rows[0]?.unexpired).toBe(true)
        await waitUntilTurnLeaseExpires(pool!, value.turnId)
        await blocker.query("COMMIT")
        await expect(pending, attempt.name).resolves.toBeFalsy()
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined)
        blocker.release()
      }
      const persisted = (await pool!.query<{ status: string; state: Record<string, unknown> }>(
        `SELECT "status", "state" FROM "agent_executions" WHERE "id" = $1`, [value.executionId])).rows[0]
      expect(persisted).toMatchObject({ status: "running", state })
    }
  }, 25_000)

  it("replays a private staged candidate under the recovered lease after lease rollover", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    await seedGraph(pool!, value, graphSnapshot(value))
    const stepId = `scheduled-final-step-${value.turnId}`
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
      VALUES ($1, $2, $3, $4, 7, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
    [stepId, value.sessionId, value.turnId, value.rootTaskId])
    const turn = (await pool!.query<{ userId: string; leaseOwnerId: string; leaseVersion: number; leaseExpiresAt: Date | string }>(
      `SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])).rows[0]!
    const writer: TurnExecutionOwnerFence = { kind: "turn", userId: turn.userId, sessionId: value.sessionId, turnId: value.turnId,
      taskId: value.rootTaskId, rootTaskId: value.rootTaskId, ownerId: turn.leaseOwnerId, leaseVersion: turn.leaseVersion,
      leaseExpiresAt: new Date(turn.leaseExpiresAt) }
    const store = createScheduledPipelineCandidateStore(pool!, createPgTurnEngineStore(pool!))
    const candidateText = "Exact durable scheduled final candidate."
    await withScheduledPipelineCandidateModelOutput({ owner: writer, finalStepId: stepId, finalStepOrdinal: 7,
      candidateText, finishReason: "stop", usage: null }, () => store.stage({ owner: writer, rootAttemptCount: 1,
      finalStepId: stepId, finalStepOrdinal: 7, candidateText }))
    const saved = await pool!.query<{ id: string; idempotencyKey: string; type: string; taskId: string; correlationId: string; payload: Record<string, unknown> }>(
      `SELECT "id", "idempotencyKey", "type", "taskId", "correlationId", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`,
      [value.sessionId, value.turnId, SCHEDULED_PIPELINE_CANDIDATE_EVENT])
    expect(saved.rows).toHaveLength(1)
    expect(saved.rows[0]).toMatchObject({ type: SCHEDULED_PIPELINE_CANDIDATE_EVENT, taskId: value.rootTaskId, correlationId: stepId,
      payload: { candidateText: "Exact durable scheduled final candidate.", rootAttemptCount: 1, stepAttempt: 1,
        finalStepId: stepId, finalStepOrdinal: 7 } })

    const recovery = await pool!.query<{ leaseVersion: number; leaseExpiresAt: Date | string }>(`UPDATE "agent_turns"
      SET "leaseOwnerId" = $1, "leaseVersion" = "leaseVersion" + 1, "leaseStartedAt" = CURRENT_TIMESTAMP,
          "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $2 RETURNING "leaseVersion", "leaseExpiresAt"`, [`recovered-${value.leaseOwnerId}`, value.turnId])
    const current: TurnExecutionOwnerFence = { ...writer, ownerId: `recovered-${value.leaseOwnerId}`,
      leaseVersion: Number(recovery.rows[0]!.leaseVersion), leaseExpiresAt: new Date(recovery.rows[0]!.leaseExpiresAt) }
    await withScheduledPipelineCandidateModelOutput({ owner: current, finalStepId: stepId, finalStepOrdinal: 7,
      candidateText, finishReason: "stop", usage: null }, () => store.stage({ owner: current, rootAttemptCount: 1,
      finalStepId: stepId, finalStepOrdinal: 7, candidateText }))
    const replayed = await pool!.query<{ id: string; idempotencyKey: string; payload: Record<string, unknown> }>(
      `SELECT "id", "idempotencyKey", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`,
      [value.sessionId, value.turnId, SCHEDULED_PIPELINE_CANDIDATE_EVENT])
    expect(replayed.rows).toHaveLength(1)
    expect(replayed.rows[0]).toEqual({ id: saved.rows[0]!.id,
      idempotencyKey: `scheduled-candidate:${value.rootTaskId}:1:${stepId}`, payload: saved.rows[0]!.payload })
    await expect(store.read({ owner: current, rootAttemptCount: 1 })).resolves.toMatchObject({
      candidateText, finalStepId: stepId, finalStepOrdinal: 7, finishReason: "stop", usage: null,
    })
    await expect(store.read({ owner: current, rootAttemptCount: 2 })).rejects.toThrow("scheduled_candidate_root_attempt_changed")
    const laterStep = `scheduled-later-step-${value.turnId}`
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
      VALUES ($1, $2, $3, $4, 8, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
    [laterStep, value.sessionId, value.turnId, value.rootTaskId])
    await expect(store.read({ owner: current, rootAttemptCount: 1 })).resolves.toBeNull()
  })

  it("completes the same private final candidate after a Redis Worker restart without another model call", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    await seedGraph(pool!, value, graphSnapshot(value))
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $1, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      WHERE "id" = $2`, [value.leaseOwnerId, value.rootTaskId])

    const sentinel = `private scheduled final candidate ${randomUUID()}`
    const baseStore = createPgTurnEngineStore(pool!)
    const candidateStore = createScheduledPipelineCandidateStore(pool!, baseStore)
    const modelProfile = {
      provider: "fixture", model: "scheduled-candidate-recovery", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
      supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
      maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    let modelCalls = 0
    const model: ModelAdapter = {
      id: "scheduled-candidate-recovery",
      profile: modelProfile,
      async *stream() {
        modelCalls += 1
        const events: ModelStreamEvent[] = [{ type: "text_delta", text: sentinel }, { type: "completed", finishReason: "stop" }]
        yield* events
      },
    }
    const baseCompletionGate: NonNullable<TurnEngineOptions["completionGate"]> = async () => ({ ok: true })
    let failAfterFirstStage = true
    let candidateStageCalls = 0
    let acceptedHandoffs = 0
    let handoffCalls = 0
    let terminalCommitCalls = 0
    const completionOrder: Array<"handoff-accepted" | "terminal-commit"> = []
    const staged: Array<{ finalStepId: string; finalStepOrdinal: number; candidateText: string }> = []
    const priorWebUrl = process.env.AGENT_WEB_URL
    const priorWorkerSecret = process.env.AGENT_WORKER_SECRET
    process.env.AGENT_WEB_URL = "http://applymate.test"
    process.env.AGENT_WORKER_SECRET = "scheduled-pipeline-integration-secret"
    const fetcher: typeof fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      handoffCalls += 1
      return new Response(JSON.stringify({ status: "completed", report: {
        processed: 0, applied: 0, queued: 0, pending: 0, skipped: 0, failed: 0, durationMs: 1,
      } }), { status: 200, headers: { "content-type": "application/json" } })
    }

    const bridge = async (owner: ScheduledAutomationPipelineBridgeScope) => ({
      status: "ready" as const,
      attestation: {
        schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1" as const,
        owner, snapshotDigest: `sha256:${"1".repeat(64)}`, graphRevision: 1,
        scout: { taskId: value.scoutTaskId, attemptCount: 1, status: "completed" as const, verification: "passed" as const,
          resultDigest: "a".repeat(64), candidateJobIds: [value.jobId],
          discoveryReceipt: { status: "complete" as const, taskId: value.scoutTaskId, attemptCount: 1,
            completedCalls: 1, candidateCount: 1, providerFailures: 0 as const, materializationFailures: 0 as const,
            hasMore: false as const, receiptDigest: "b".repeat(64) } },
        analyst: { taskId: value.analystTaskId, attemptCount: 1, status: "completed" as const, verification: "passed" as const,
          resultDigest: "c".repeat(64), dependsOnTaskIds: [value.scoutTaskId], jobIds: [value.jobId] },
        evidenceDigest: "d".repeat(64),
      },
    })
    const store: TurnEngineStore = {
      ...baseStore,
      async recordFinalResponse(input) {
        terminalCommitCalls += 1
        completionOrder.push("terminal-commit")
        return baseStore.recordFinalResponse!(input)
      },
    }
    const snapshot = {
      system: [], profile: [], steerHistory: [], toolObservations: [],
      businessRefs: [{ id: value.jobId, kind: "job" as const, ownerId: value.userId }],
    }
    const executionStepIds: string[] = []
    const contextBuilder: TurnEngineOptions["contextBuilder"] = {
      async build(request) {
        executionStepIds.push(request.stepId)
        return { schemaVersion: "agent-harness.v2", sessionId: request.sessionId, turnId: request.turnId,
          stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "{}" }
      },
    }
    const redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    const queueName = `scheduled-final-recovery-${randomUUID()}`
    const queueRedis = redis.duplicate()
    const queue = new Queue<ScheduledContinuationPayload, TurnEngineResult>(queueName, { connection: queueRedis, skipVersionCheck: true })
    const jobId = `scheduled-final-recovery-${value.turnId}`
    let firstWorker: Worker<ScheduledContinuationPayload, TurnEngineResult> | undefined
    let restartedWorker: Worker<ScheduledContinuationPayload, TurnEngineResult> | undefined
    const currentLease = async (): Promise<TurnLease> => {
      const row = (await pool!.query<{ userId: string; leaseOwnerId: string; leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(
        `SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])).rows[0]
      if (!row?.leaseOwnerId) throw new Error("Scheduled candidate recovery has no current Turn lease")
      return { turnId: value.turnId, sessionId: value.sessionId, userId: row.userId, ownerId: row.leaseOwnerId,
        leaseVersion: Number(row.leaseVersion), leaseStartedAt: new Date(row.leaseStartedAt), leaseExpiresAt: new Date(row.leaseExpiresAt) }
    }
    const execute = async (job: { data: ScheduledContinuationPayload }) => {
      const lease = await currentLease()
      const owner: ScheduledAutomationPipelineBridgeScope = { ...job.data.owner,
        turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
      const executionOwner: TurnExecutionOwnerFence = { kind: "turn", userId: lease.userId, sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: value.rootTaskId, rootTaskId: value.rootTaskId,
        ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
      const recoveredFinalCandidate = await candidateStore.read({ owner: executionOwner, rootAttemptCount: 1 })
      const recoveredCandidate = recoveredFinalCandidate ?? undefined
      const completionGate = attachScheduledPipelineCompletion({
        gate: baseCompletionGate, owner, bridge, fetcher, recoveredCandidate,
        onWebAccepted: () => { acceptedHandoffs += 1; completionOrder.push("handoff-accepted") }, rootAttemptCount: 1,
        stageCandidate: async input => {
          candidateStageCalls += 1
          staged.push({ finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal, candidateText: input.candidateText })
          await candidateStore.stage(input)
          if (failAfterFirstStage) {
            failAfterFirstStage = false
            throw new TurnStateRefreshRetryError()
          }
        },
      })
      const options: TurnEngineOptions = {
        lease, rootTaskId: value.rootTaskId, scope: { userId: value.userId }, goal: "Complete the scheduled automation run",
        snapshot, contextBuilder, store, model, tools: [], executeTool: async ({ call }) => ({
          id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed" as const,
          errorCode: null,
        }), completionGate,
        ...(recoveredCandidate ? { recoveredFinalCandidate: recoveredCandidate.candidateText } : {}),
        ...(recoveredCandidate ? { resume: {
          nextOrdinal: recoveredCandidate.finalStepOrdinal + 1,
          stepCount: recoveredCandidate.finalStepOrdinal + 1,
          toolCallCount: 0,
          inputThroughSequence: 0n,
          consumedInputIds: [],
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        } } : {}),
        idFactory: prefix => recoveredCandidate && prefix === `turn:${value.turnId}:step:0` ? `${prefix}:restarted` : prefix,
      }
      return new TurnEngine(options).run()
    }

    try {
      await redis.ping()
      await queue.waitUntilReady()
      const initialLease = await currentLease()
      const owner: ScheduledAutomationPipelineBridgeScope = {
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
        rootAttemptCount: 1, turnLeaseOwnerId: initialLease.ownerId, turnLeaseVersion: initialLease.leaseVersion,
      }
      await queue.add("run-scheduled-turn", { owner }, { jobId, attempts: 2, backoff: { type: "fixed", delay: 1_500 }, removeOnComplete: false })

      firstWorker = new Worker(queueName, async job => execute(job), { connection: redis.duplicate(), concurrency: 1 })
      const failed = waitForWorkerJobEvent(firstWorker, "failed", jobId)
      await firstWorker.waitUntilReady()
      await failed
      await firstWorker.close()
      firstWorker = undefined

      const initialCandidate = await pool!.query<{ id: string; idempotencyKey: string; sequence: string | bigint; correlationId: string; payload: Record<string, unknown> }>(
        `SELECT "id", "idempotencyKey", "sequence", "correlationId", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`, [value.sessionId, value.turnId, SCHEDULED_PIPELINE_CANDIDATE_EVENT])
      expect(initialCandidate.rows).toHaveLength(1)
      expect(initialCandidate.rows[0]).toMatchObject({
        idempotencyKey: `scheduled-candidate:${value.rootTaskId}:1:turn:${value.turnId}:step:0`,
        correlationId: `turn:${value.turnId}:step:0`, payload: {
          candidateText: sentinel, rootAttemptCount: 1, finalStepId: `turn:${value.turnId}:step:0`, finalStepOrdinal: 0,
        },
      })
      expect(candidateStageCalls).toBe(1)
      expect(terminalCommitCalls).toBe(0)

      const barrierType = "test.scheduled_candidate_recovery_barrier"
      const initialOwnerFence: TurnExecutionOwnerFence = { kind: "turn", userId: value.userId, sessionId: value.sessionId,
        turnId: value.turnId, taskId: value.rootTaskId, rootTaskId: value.rootTaskId,
        ownerId: initialLease.ownerId, leaseVersion: initialLease.leaseVersion, leaseExpiresAt: initialLease.leaseExpiresAt }
      await baseStore.appendEvent({ owner: initialOwnerFence, id: `recovery-barrier-${value.turnId}`, itemId: null,
        type: barrierType, correlationId: value.turnId, causationId: null, idempotencyKey: `recovery-barrier:${value.turnId}`,
        payload: { marker: "candidate-staged" } })
      const candidateSequence = BigInt(initialCandidate.rows[0]!.sequence)
      const streamPath = "@/lib/agent/session/v2-event-stream"
      const streamModule = await import(streamPath) as unknown as {
        createV2EventStream: (db: unknown, options: { sessionId: string; afterSequence: bigint; signal?: AbortSignal;
          dbPollMs?: number; heartbeatMs?: number; redisFactory?: () => null; eventRedisFactory?: () => null }) => ReadableStream<Uint8Array>
      }
      const webDbPath = "@/lib/db"
      const webDb = await import(webDbPath) as unknown as { db: { $disconnect: () => Promise<void> } }
      disconnectWebDatabase = () => webDb.db.$disconnect()
      const sse = await readSseThroughEvent(streamModule.createV2EventStream(webDb.db, {
        sessionId: value.sessionId, afterSequence: candidateSequence - 1n, dbPollMs: 10, heartbeatMs: 50,
        redisFactory: () => null, eventRedisFactory: () => null,
      }), barrierType)
      expect(sse).toContain(`event: ${barrierType}`)
      expect(sse).not.toContain(sentinel)

      const projectionPath = "@/lib/agent/session/transcript-projector"
      const projector = await import(projectionPath) as unknown as {
        projectV2EventsToTranscript: (db: unknown, input: { sessionId: string; userId: string; turnId: string }) => Promise<number>
      }
      const projectedCount = await projector.projectV2EventsToTranscript(webDb.db, { sessionId: value.sessionId, userId: value.userId, turnId: value.turnId })
      const transcript = await pool!.query(`SELECT "type", "body", "data" FROM "agent_transcript_events" WHERE "sessionId" = $1`, [value.sessionId])
      expect(projectedCount).toBeGreaterThan(0)
      expect(JSON.stringify(transcript.rows)).toContain(barrierType)
      expect(JSON.stringify(transcript.rows)).not.toContain(sentinel)
      const beforeCommit = await pool!.query<{ status: string; finalResponse: string | null }>(
        `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
      expect(beforeCommit.rows[0]).toEqual({ status: "in_progress", finalResponse: null })
      const publicFinalBeforeCommit = await pool!.query(`SELECT "id" FROM "agent_items" WHERE "turnId" = $1 AND "phase" = 'final_answer'`, [value.turnId])
      const terminalReceiptBeforeCommit = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "turnId" = $1 AND "type" = 'turn.completed'`, [value.turnId])
      expect(publicFinalBeforeCommit.rows).toHaveLength(0)
      expect(terminalReceiptBeforeCommit.rows).toHaveLength(0)

      const recoveredOwnerId = `recovered-${value.leaseOwnerId}`
      const recoveredLease = await pool!.query<{ leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(`UPDATE "agent_turns"
        SET "leaseOwnerId" = $1, "leaseVersion" = "leaseVersion" + 1, "leaseStartedAt" = CURRENT_TIMESTAMP,
            "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $2 RETURNING "leaseVersion", "leaseStartedAt", "leaseExpiresAt"`, [recoveredOwnerId, value.turnId])
      await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $1, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
        WHERE "id" = $2`, [recoveredOwnerId, value.rootTaskId])
      const completed = waitForWorkerJobEvent(restartedWorker = new Worker(queueName, async job => execute(job), {
        connection: redis.duplicate(), concurrency: 1,
      }), "completed", jobId)
      await restartedWorker.waitUntilReady()
      await expect(completed).resolves.toMatchObject({ status: "completed", finalText: sentinel })
      expect(Number(recoveredLease.rows[0]?.leaseVersion)).toBe(initialLease.leaseVersion + 1)

      const finalCandidate = await pool!.query<{ id: string; idempotencyKey: string; correlationId: string; payload: Record<string, unknown> }>(
        `SELECT "id", "idempotencyKey", "correlationId", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`, [value.sessionId, value.turnId, SCHEDULED_PIPELINE_CANDIDATE_EVENT])
      expect(finalCandidate.rows).toHaveLength(1)
      expect(finalCandidate.rows[0]).toEqual({ id: initialCandidate.rows[0]!.id,
        idempotencyKey: initialCandidate.rows[0]!.idempotencyKey, correlationId: initialCandidate.rows[0]!.correlationId,
        payload: initialCandidate.rows[0]!.payload })
      expect(candidateStageCalls).toBe(2)
      expect(staged).toHaveLength(2)
      expect(executionStepIds).toEqual([initialCandidate.rows[0]!.correlationId])
      expect(staged[1]).toEqual({
        finalStepId: initialCandidate.rows[0]!.correlationId,
        finalStepOrdinal: Number(initialCandidate.rows[0]!.payload.finalStepOrdinal),
        candidateText: sentinel,
      })
      expect(modelCalls).toBe(1)
      expect(terminalCommitCalls).toBe(1)
      expect(acceptedHandoffs).toBe(1)
      expect(handoffCalls).toBe(1)
      expect(completionOrder).toEqual(["handoff-accepted", "terminal-commit"])

      const terminal = await pool!.query<{ status: string; finalResponse: string | null }>(
        `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
      expect(terminal.rows[0]?.status).toBe("completed")
      expect(JSON.parse(terminal.rows[0]!.finalResponse!).response).toBe(sentinel)
      const terminalReceipts = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "turnId" = $1 AND "type" = 'turn.completed'`, [value.turnId])
      expect(terminalReceipts.rows).toHaveLength(1)
      const finalItems = await pool!.query<{ id: string; status: string; phase: string; content: Record<string, unknown> }>(
        `SELECT "id", "status", "phase", "content" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'agent_message' AND "phase" = 'final_answer'`, [value.turnId])
      expect(finalItems.rows).toHaveLength(1)
      expect(finalItems.rows[0]).toMatchObject({ status: "completed", phase: "final_answer", content: { text: sentinel } })
      const rootReceipt = await pool!.query<{ status: string; result: Record<string, unknown> }>(
        `SELECT "status", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [value.rootTaskId])
      expect(rootReceipt.rows[0]).toMatchObject({ status: "completed", result: { status: "completed", finalItemId: finalItems.rows[0]!.id } })
    } finally {
      await firstWorker?.close().catch(() => undefined)
      await restartedWorker?.close().catch(() => undefined)
      const job = await queue.getJob(jobId).catch(() => undefined)
      if (job) await job.remove().catch(() => undefined)
      await queue.close().catch(() => undefined)
      await Promise.all([queueRedis.quit().catch(() => queueRedis.disconnect()), redis.quit().catch(() => redis.disconnect())])
      if (priorWebUrl === undefined) delete process.env.AGENT_WEB_URL
      else process.env.AGENT_WEB_URL = priorWebUrl
      if (priorWorkerSecret === undefined) delete process.env.AGENT_WORKER_SECRET
      else process.env.AGENT_WORKER_SECRET = priorWorkerSecret
    }
  }, 30_000)

  it("defers an answered scheduled continuation until root settlement and resumes it once", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    await seedGraph(pool!, value, graphSnapshot(value))

    const transition = fixture()
    fixtureUserIds.push(transition.userId)
    await seedGraph(pool!, transition, graphSnapshot(transition))
    const transitionLeaseRow = (await pool!.query<{
      userId: string; leaseOwnerId: string; leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string
    }>(`SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [transition.turnId])).rows[0]
    expect(transitionLeaseRow).toBeDefined()
    const transitionLease: TurnLease = {
      turnId: transition.turnId, sessionId: transition.sessionId, ownerId: transitionLeaseRow!.leaseOwnerId,
      userId: transitionLeaseRow!.userId, leaseVersion: transitionLeaseRow!.leaseVersion,
      leaseStartedAt: new Date(transitionLeaseRow!.leaseStartedAt), leaseExpiresAt: new Date(transitionLeaseRow!.leaseExpiresAt),
    }
    expect(await releaseTurnLease(pool!, transitionLease, "waiting_for_user")).toBe(true)
    const transitionResult = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1`, [transition.turnId])
    expect(transitionResult.rows[0]).toEqual({ status: "waiting_for_user", revision: 1 })

    const waitId = `scheduled-continuation-${randomUUID()}`
    const itemId = `agent-wait:question:${waitId}`
    const toolCallId = `scheduled-continuation-call-${randomUUID()}`
    const waitCreated = await pool!.query<{ revision: number }>(`UPDATE "agent_turns"
      SET "status" = 'waiting_for_user', "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'in_progress' RETURNING "revision"`, [value.turnId])
    expect(Number(waitCreated.rows[0]?.revision)).toBe(1)
    await pool!.query(`INSERT INTO "agent_items"
      ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, 'question', 'completed', 1, $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      itemId, value.sessionId, value.turnId,
      JSON.stringify({ waitKind: "question", questionId: waitId, toolCallId, answer: "continue", answerAvailable: true }),
    ])
    const questionTaskId = await pool!.query<{ taskId: string | null }>(`SELECT "taskId" FROM "agent_items" WHERE "id" = $1`, [itemId])
    expect(questionTaskId.rows[0]?.taskId).toBeNull()
    const answeredTurn = await pool!.query<{ revision: number }>(`UPDATE "agent_turns"
      SET "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'waiting_for_user' AND "revision" = $2 RETURNING "revision"`, [value.turnId, waitCreated.rows[0]!.revision])
    expect(Number(answeredTurn.rows[0]?.revision)).toBe(2)

    const answerEventId = randomUUID()
    const wakeupEventId = randomUUID()
    const wakeupPayload = {
      waitKind: "question", waitId, itemId, turnId: value.turnId, toolCallId, status: "answered", nextTurnRevision: 2,
    }
    const sequenceResult = await pool!.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions"
      SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
    const answerSequence = sequenceResult.rows[0]?.eventSequence
    if (answerSequence === undefined) throw new Error("Scheduled answer fixture could not allocate its event sequence")
    await pool!.query(`INSERT INTO "agent_events"
      ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, NULL, $5, 'question.answered', 'user', $6, $7, $8::jsonb)`, [
      answerEventId, value.sessionId, value.turnId, itemId, String(answerSequence), waitId,
      `scheduled-answer:${waitId}`, JSON.stringify({ ...wakeupPayload, answerAvailable: true }),
    ])
    const wakeupSequenceResult = await pool!.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions"
      SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
    const wakeupSequence = wakeupSequenceResult.rows[0]?.eventSequence
    if (wakeupSequence === undefined) throw new Error("Scheduled wakeup fixture could not allocate its event sequence")
    await pool!.query(`INSERT INTO "agent_events"
      ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, NULL, $5, 'turn.wakeup', 'system', $6, $7, $8, $9::jsonb)`, [
      wakeupEventId, value.sessionId, value.turnId, itemId, String(wakeupSequence), value.turnId, answerEventId,
      `scheduled-answer:${waitId}:wakeup`, JSON.stringify(wakeupPayload),
    ])
    await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [
      `scheduled-wakeup-${wakeupEventId}`, AGENT_TURN_WAKEUP_TOPIC, value.sessionId, `scheduled-answer:${waitId}:wakeup`,
      JSON.stringify({ eventId: wakeupEventId, sessionId: value.sessionId, turnId: value.turnId, itemId, type: "turn.wakeup", payload: wakeupPayload }),
    ])

    const rootBeforeSettlement = await pool!.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [value.rootTaskId])
    expect(rootBeforeSettlement.rows[0]?.status).toBe("running")
    await expect(drainAgentWakeups(pool!, 10)).resolves.toBe(0)
    const deferred = await pool!.query<{ publishedAt: Date | null; attemptCount: number; lastError: string | null }>(
      `SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "id" = $1`, [`scheduled-wakeup-${wakeupEventId}`])
    expect(deferred.rows[0]).toMatchObject({ publishedAt: null, attemptCount: 0, lastError: null })
    const dispatchBeforeSettlement = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`, [`turn-dispatch:${value.turnId}`])
    expect(dispatchBeforeSettlement.rows).toHaveLength(0)

    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting_for_user', "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'running'`, [value.rootTaskId])
    const liveTurnRow = (await pool!.query<{
      userId: string; leaseOwnerId: string; leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string
    }>(`SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])).rows[0]
    expect(liveTurnRow).toBeDefined()
    const rootLease: TurnLease = {
      turnId: value.turnId, sessionId: value.sessionId, ownerId: liveTurnRow!.leaseOwnerId,
      userId: liveTurnRow!.userId, leaseVersion: liveTurnRow!.leaseVersion,
      leaseStartedAt: new Date(liveTurnRow!.leaseStartedAt), leaseExpiresAt: new Date(liveTurnRow!.leaseExpiresAt),
    }
    expect(await releaseTurnLease(pool!, rootLease, "waiting_for_user")).toBe(true)
    const settledTurn = await pool!.query<{ status: string; revision: number; leaseOwnerId: string | null; leaseExpiresAt: Date | null }>(
      `SELECT "status", "revision", "leaseOwnerId", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
    expect(settledTurn.rows[0]).toEqual({ status: "waiting_for_user", revision: 2, leaseOwnerId: null, leaseExpiresAt: null })

    await expect(drainAgentWakeups(pool!, 10)).resolves.toBe(1)
    await expect(drainAgentWakeups(pool!, 10)).resolves.toBe(0)
    const resumed = await pool!.query<{ status: string; revision: number; leaseOwnerId: string | null }>(
      `SELECT "status", "revision", "leaseOwnerId" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
    expect(resumed.rows[0]).toEqual({ status: "queued", revision: 3, leaseOwnerId: null })
    const resumedEvents = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.resumed'`, [value.sessionId, value.turnId])
    expect(resumedEvents.rows).toHaveLength(1)
    const dispatchAfterResume = await pool!.query(`SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1`, [`turn-dispatch:${value.turnId}`])
    expect(dispatchAfterResume.rows).toHaveLength(1)
    expect(dispatchAfterResume.rows[0]?.publishedAt).toBeNull()
  })

  it("replays the persisted Prepare choice and resumes without duplicate material after a Worker restart", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    const snapshot = parseTaskGraphSnapshot({ ...graphSnapshot(value), rootSuccessCriteria: [
      "Scheduled automation pipeline integration", "Keep Prepare bound to verified Analyze evidence",
    ] })
    await seedGraph(pool!, value, snapshot)
    const scheduledRootActions = [...new Set([
      ...TASK_GRAPH_TEMPLATES.scout.allowedActions,
      ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
      ...TASK_GRAPH_TEMPLATES.prepare.allowedActions,
    ])]
    await pool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`,
      [value.rootTaskId, JSON.stringify(scheduledRootActions)])
    const baseResumeId = `scheduled-pipeline-resume-${value.turnId}`
    const baseResumeContent = { basics: { name: "Scheduled Fixture Candidate" }, sections: [] }
    const preparedLetter = "Fixture cover letter prepared only for the scheduled Prepare integration test."
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2 WHERE "id" = $1`, [value.rootTaskId, value.leaseOwnerId])
    await pool!.query(`INSERT INTO "Job"
      ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "keywords", "updatedAt")
      VALUES ($1, $2, 'Fixture Systems', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/fixture',
        'Build reliable TypeScript services for European customers.', 'fixture', 'TypeScript', CURRENT_TIMESTAMP)`, [value.jobId, value.userId])
    await pool!.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Fixture Base Resume', $3::jsonb, 'base', 'manual', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [baseResumeId, value.userId, JSON.stringify(baseResumeContent)])
    await persistToolReceipt(pool!, value, value.scoutTaskId, "scout-step", "jobs.discover", "discover-call", {
      query: "Software Engineer Dublin",
    }, discoveryOutput(value), 1)
    await persistToolReceipt(pool!, value, value.scoutTaskId, "scout-step", "jobs.get", "scout-read-call", {
      jobId: value.jobId,
    }, { job: { id: value.jobId, source: "fixture" } }, 2)
    await persistToolReceipt(pool!, value, value.analystTaskId, "analyst-step", "jobs.get", "analyst-read-call", {
      jobId: value.jobId,
    }, { job: { id: value.jobId, source: "fixture" } }, 3)

    const scope = {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId,
    }
    const scoutNode = snapshot.nodes[0]!
    const analystNode = snapshot.nodes[1]!
    const scoutResult = roleResult("scout", value.jobId)
    const scoutProof = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: { ...scope, taskId: value.scoutTaskId, attemptCount: 1 }, snapshot, node: scoutNode, structuredResult: scoutResult,
    })
    expect(scoutProof.verified).toBe(true)
    expect(scoutProof.projection?.role).toBe("scout")
    await persistVerification(pool!, value.scoutTaskId, scoutProof, {
      discoveryAttempt: completeDiscoverySidecar(), toolCallCount: 2,
    })

    const dependencyProof = await verifyCompletedScoutDependencies(pool!, scope, snapshot, analystNode)
    expect(dependencyProof).not.toBeNull()
    const analystResult = roleResult("analyst", value.jobId)
    const analystProof = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: { ...scope, taskId: value.analystTaskId, attemptCount: 1 }, snapshot, node: analystNode,
      structuredResult: analystResult, dependencies: dependencyProof!.projections,
    })
    expect(analystProof.verified).toBe(true)
    expect(analystProof.projection?.role).toBe("analyst")
    await persistVerification(pool!, value.analystTaskId, analystProof, {
      dependencyBindings: dependencyProof!.bindings, toolCallCount: 1,
    })

    await pool!.query(`UPDATE "agent_items" SET "revision" = 2 WHERE "id" = $1`, [taskGraphItemId(value.rootTaskId)])
    let graphScope = { ...scope, turnLeaseOwner: value.leaseOwnerId, turnLeaseVersion: 4, parentLeaseOwner: value.leaseOwnerId, parentAttemptCount: 1 }
    const loaded = await loadTaskGraph(pool!, graphScope, false)
    const persistedGraph = currentTaskGraph(loaded)
    expect(loaded.item?.revision).toBe(2)
    expect(persistedGraph.nodes.map(node => [node.key, node.status])).toEqual([
      ["scheduled-scout", "completed"], ["scheduled-analyst", "completed"],
    ])
    expect(persistedGraph.nodes.every(node => node.verificationReport?.status === "passed")).toBe(true)

    const owner = {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
      rootAttemptCount: 1, turnLeaseOwnerId: value.leaseOwnerId, turnLeaseVersion: 4,
    }
    const bridge = createScheduledAutomationPipelineBridge({
      async load(): Promise<ScheduledAutomationPipelineBridgeState> {
        const turnResult = await pool!.query(`SELECT "id" AS "turnId", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
          FROM "agent_turns" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3`, [value.turnId, value.userId, value.sessionId])
        const rootResult = await pool!.query(`SELECT task."id", session."userId", task."sessionId", task."turnId", task."status", task."attemptCount"
          FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
        [value.rootTaskId, value.sessionId, value.turnId, value.userId])
        const taskResult = await pool!.query(`SELECT task."id", session."userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
            task."role", task."taskType", task."status", task."attemptCount", task."failureReason", task."expectedOutputSchema", task."allowedActions", task."result"
          FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
        [[value.scoutTaskId, value.analystTaskId], value.sessionId, value.turnId, value.userId])
        if (!turnResult.rows[0] || !rootResult.rows[0] || taskResult.rows.length !== 2) throw new Error("scheduled pipeline fixture owner rows missing")
        const persistedGraph = await loadTaskGraph(pool!, graphScope, false)
        return {
          turn: turnResult.rows[0], root: rootResult.rows[0], snapshot: persistedGraph.snapshot,
          current: currentTaskGraph(persistedGraph), tasks: taskResult.rows,
        } as ScheduledAutomationPipelineBridgeState
      },
      async verifyCompletedNode(input) {
        return verifyCompletedTaskGraphNodeEvidence(pool!, input)
      },
    })

    const redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    const queueName = `scheduled-pipeline-${randomUUID()}`
    const queueRedis = redis.duplicate()
    const queue = new Queue<ScheduledContinuationPayload, Awaited<ReturnType<typeof bridge>>>(queueName, {
      connection: queueRedis, skipVersionCheck: true,
    })
    const prepareQueueName = `scheduled-prepare-child-${randomUUID()}`
    const prepareQueueRedis = redis.duplicate()
    const prepareQueue = new Queue<SubagentJobPayload>(prepareQueueName, { connection: prepareQueueRedis, skipVersionCheck: true })
    const deliveries: Array<Awaited<ReturnType<typeof bridge>>> = []
    let firstWorker: Worker<ScheduledContinuationPayload, Awaited<ReturnType<typeof bridge>>> | undefined
    let restartedWorker: Worker<ScheduledContinuationPayload, Awaited<ReturnType<typeof bridge>>> | undefined
    let prepareWorker: Worker<SubagentJobPayload, unknown> | undefined
    let restartedPrepareWorker: Worker<SubagentJobPayload, unknown> | undefined
    const jobId = `scheduled-pipeline-${value.turnId}`
    try {
      await redis.ping()
      await queue.waitUntilReady()
      const payload = { owner }
      const firstJob = await queue.add("continue-scheduled-taskgraph", payload, {
        jobId, attempts: 2, backoff: { type: "fixed", delay: 250 }, removeOnComplete: false,
      })
      const duplicateJob = await queue.add("continue-scheduled-taskgraph", payload, {
        jobId, attempts: 2, backoff: { type: "fixed", delay: 250 }, removeOnComplete: false,
      })
      expect(duplicateJob.id).toBe(firstJob.id)
      expect((await queue.getJobCounts("wait", "delayed", "active", "completed", "failed")).wait).toBe(1)

      firstWorker = new Worker(queueName, async job => {
        const result = await bridge(job.data.owner)
        deliveries.push(result)
        if (job.attemptsMade === 0) throw new Error("simulated lost continuation acknowledgement")
        return result
      }, { connection: redis.duplicate(), concurrency: 1 })
      const firstFailure = waitForWorkerJobEvent(firstWorker, "failed", jobId)
      await firstWorker.waitUntilReady()
      await firstFailure
      await firstWorker.close()
      firstWorker = undefined

      restartedWorker = new Worker(queueName, async job => {
        const result = await bridge(job.data.owner)
        deliveries.push(result)
        return result
      }, { connection: redis.duplicate(), concurrency: 1 })
      const completed = waitForWorkerJobEvent(restartedWorker, "completed", jobId)
      await restartedWorker.waitUntilReady()
      const result = await completed
      expect(result.status).toBe("ready")
      expect(deliveries).toHaveLength(2)
      expect(deliveries[0]).toEqual(deliveries[1])
      if (result.status !== "ready") throw new Error("Scheduled pipeline fixture did not return Analyze evidence")
      expect(result.attestation.owner).toEqual(owner)
      expect(result.attestation.scout.candidateJobIds).toEqual([value.jobId])
      expect(result.attestation.scout.discoveryReceipt).toMatchObject({
        status: "complete", taskId: value.scoutTaskId, attemptCount: 1, candidateCount: 1,
        providerFailures: 0, materializationFailures: 0, hasMore: false,
      })
      expect(result.attestation.analyst).toMatchObject({
        taskId: value.analystTaskId, status: "completed", verification: "passed", jobIds: [value.jobId],
      })

      const executionOwner = { executionId: value.executionId, executionAttemptCount: 1 }
      const claimOwner = { ...owner, ...executionOwner }, claimToken = `scheduled-prepare-claim-${randomUUID()}`
      const continuationKey = scheduledTaskGraphContinuationKey(owner, result.attestation, executionOwner.executionId, executionOwner.executionAttemptCount)
      const turnLeaseRow = (await pool!.query<{ userId: string; leaseOwnerId: string; leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(
        `SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])).rows[0]!
      const turnLease: TurnLease = { turnId: value.turnId, sessionId: value.sessionId, userId: turnLeaseRow.userId,
        ownerId: turnLeaseRow.leaseOwnerId, leaseVersion: turnLeaseRow.leaseVersion,
        leaseStartedAt: new Date(turnLeaseRow.leaseStartedAt), leaseExpiresAt: new Date(turnLeaseRow.leaseExpiresAt) }
      const turnExecutionOwner = {
        kind: "turn" as const, userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        taskId: value.rootTaskId, rootTaskId: value.rootTaskId, ownerId: turnLease.ownerId, leaseVersion: turnLease.leaseVersion,
        leaseExpiresAt: turnLease.leaseExpiresAt,
      }
      const claim = {
        schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: continuationKey, claimToken, owner: claimOwner,
        claimedAt: turnLease.leaseStartedAt.toISOString(), leaseExpiresAt: turnLease.leaseExpiresAt.toISOString(),
      }
      const scheduledSnapshot = scheduledAutomationSnapshot()
      const jobRecord = {
        id: value.jobId, userId: value.userId, company: "Fixture Systems", role: "Software Engineer", location: "Dublin",
        status: "saved", score: null, url: "https://jobs.example.invalid/fixture", source: "fixture", salary: null,
        description: "Build reliable TypeScript services for European customers.", keywords: "TypeScript",
      }
      const checkpointState = {
        nextStage: "prepare", scheduledTaskGraphClaim: claim,
        scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: continuationKey,
          owner: claimOwner, snapshotDigest: result.attestation.snapshotDigest, graphRevision: result.attestation.graphRevision,
          evidenceDigest: result.attestation.evidenceDigest },
        scoutedJobs: [jobRecord],
        scoredJobs: [{ job: { ...jobRecord, coverLetter: null }, score: 82, matchedKeywords: ["TypeScript"],
          missingKeywords: ["PostgreSQL"], recommendation: "Apply after tailoring.", analysisFenceAt: new Date().toISOString() }],
        analysisFailed: 0,
      }
      const checkpointPath = "@/lib/agent/scheduled-taskgraph-gate-checkpoint"
      const checkpointModule = await import(checkpointPath) as unknown as {
        scheduledTaskGraphAnalyzeCheckpointDigest: (value: unknown) => string | null
      }
      const checkpointDigest = checkpointModule.scheduledTaskGraphAnalyzeCheckpointDigest(checkpointState)
      if (!checkpointDigest) throw new Error("Scheduled Analyze fixture checkpoint was invalid")
      await seedScheduledExecution(pool!, value, checkpointState)
      await pool!.query(`UPDATE "agent_executions" SET "checkpoint" = 'prepare' WHERE "id" = $1`, [value.executionId])
      const stepId = `scheduled-prepare-step-${value.turnId}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
        VALUES ($1, $2, $3, $4, 8, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
      [stepId, value.sessionId, value.turnId, value.rootTaskId])
      let prepareInput: TaskGraphScheduledPrepareInput = {
        scope: { ...graphScope, stepId }, executionOwner,
        handoff: { status: "analyze_checkpointed", continuationKey, checkpointDigest,
          claimTokenDigest: `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`,
          executionId: executionOwner.executionId, executionAttemptCount: executionOwner.executionAttemptCount },
        attestation: result.attestation,
        proposal: { expectedRevision: result.attestation.graphRevision, nodes: [{ key: "prepare", templateId: "prepare",
          goal: "Prepare application materials using the persisted scheduled Analyze checkpoint.", successCriteria: [
            "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
            "Persist immutable owner-fenced material references and return no resume or letter bodies.",
          ],
          dependsOn: ["scheduled-analyst"] }] },
      }
      const candidateText = "Scheduled Prepare integration candidate."
      const candidateUsage = { inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018 }
      const candidateStore = createScheduledPipelineCandidateStore(pool!, createPgTurnEngineStore(pool!))
      await withScheduledPipelineCandidateModelOutput({ owner: turnExecutionOwner, finalStepId: stepId, finalStepOrdinal: 8,
        candidateText, finishReason: "stop", usage: candidateUsage }, () => candidateStore.stage({ owner: turnExecutionOwner,
        rootAttemptCount: 1, finalStepId: stepId, finalStepOrdinal: 8, candidateText }))
      const command = createPgTaskGraphCommandPort(pool as unknown as PgSubagentPool)
      const appendScheduledPrepare = command.appendScheduledPrepare
      if (!appendScheduledPrepare) throw new Error("PG command port omitted scheduled Prepare")
      const choiceContract = createScheduledTaskGraphContinuationContract(prepareInput)
      if (!choiceContract) throw new Error("Scheduled Prepare fixture could not bind its Analyze checkpoint")
      const expectedChoiceWaitId = scheduledPrepareChoiceWaitId({ receipt: choiceContract.receipt, finalStepId: stepId, finalStepOrdinal: 8 })
      if (expectedChoiceWaitId === null) throw new Error("Scheduled Prepare fixture did not derive its choice wait")
      const durableWait = createPgDurableWaitPort(pool!)
      const initialContinuation = createScheduledAutomationPrepareContinuation({ commandPort: command, waitPort: durableWait })
      const initialContinuationInput = {
        owner, executionOwner: turnExecutionOwner, attestation: result.attestation,
        proof: prepareInput.handoff, candidateText, finalStepId: stepId, finalStepOrdinal: 8,
        signal: new AbortController().signal,
      }
      await expect(initialContinuation(initialContinuationInput)).resolves.toEqual({
        status: "waiting_for_choice", waitId: expectedChoiceWaitId,
      })

      const analyzeOnlyGraph = await loadTaskGraph(pool!, graphScope, false)
      expect(analyzeOnlyGraph.item?.revision).toBe(2)
      expect(currentTaskGraph(analyzeOnlyGraph).nodes.map(node => [node.key, node.status])).toEqual([
        ["scheduled-scout", "completed"], ["scheduled-analyst", "completed"],
      ])
      const waitingExecution = await pool!.query<{ status: string; state: Record<string, unknown> }>(
        `SELECT "status", "state" FROM "agent_executions" WHERE "id" = $1`, [value.executionId])
      expect(waitingExecution.rows[0]?.status).toBe("running")
      expect(waitingExecution.rows[0]?.state).toMatchObject({
        nextStage: "prepare",
        scheduledTaskGraphClaim: { key: continuationKey, claimToken, owner: claimOwner },
        scheduledTaskGraphContinuation: { key: continuationKey, owner: claimOwner },
      })
      expect(waitingExecution.rows[0]?.state.scheduledTaskGraphWait).toBeUndefined()
      const prematurePrepare = await pool!.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "rootTaskId" = $1 AND "role" = $2`,
        [value.rootTaskId, TASK_GRAPH_TEMPLATES.prepare.role])
      expect(prematurePrepare.rows).toHaveLength(0)
      const prematureReceipt = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "type" = 'agent.plan.scheduled_prepare_binding'`, [value.sessionId, value.turnId])
      expect(prematureReceipt.rows).toHaveLength(0)
      const prematureDispatch = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1`,
        [value.sessionId])
      expect(prematureDispatch.rows).toHaveLength(0)

      const questionStore = createPgTurnQuestionStore(pool!)
      const choiceWait = await questionStore.waitForQuestion({ owner: turnExecutionOwner, stepId, toolCallId: null,
        expectedWaitId: expectedChoiceWaitId, finishReason: "stop", usage: candidateUsage, now: new Date() })
      expect(choiceWait).toMatchObject({ status: "waiting_for_user", disposition: "created", waitId: expectedChoiceWaitId, toolCallId: null })
      const webDbPath = "@/lib/db"
      const webDatabase = await import(webDbPath) as unknown as {
        db: { $disconnect(): Promise<void> }
      }
      disconnectWebDatabase = () => webDatabase.db.$disconnect()
      const questionBrokerPath = "@/lib/agent/broker/store"
      const questionBroker = await import(questionBrokerPath) as unknown as {
        answerQuestion(db: unknown, input: { sessionId: string; userId: string; waitId: string; clientMessageId: string;
          expectedTurnId: string; expectedRevision: number; answer: string; now: Date }): Promise<{
            disposition: string; status: string; waitId: string; turnId: string; nextTurnRevision: number
          }>
      }
      const answerResult = await questionBroker.answerQuestion(webDatabase.db, {
        sessionId: value.sessionId, userId: value.userId, waitId: expectedChoiceWaitId,
        clientMessageId: `scheduled-prepare-answer-${value.turnId}`, expectedTurnId: value.turnId,
        expectedRevision: choiceWait.nextTurnRevision, answer: "keep_resume", now: new Date(),
      })
      expect(answerResult).toMatchObject({ disposition: "resolved", status: "answered", waitId: expectedChoiceWaitId,
        turnId: value.turnId, nextTurnRevision: choiceWait.nextTurnRevision + 1 })

      const rootStore = createPgRootTaskStore(pool as unknown as PgSubagentPool)
      await rootStore.finish({ lease: turnLease, rootTaskId: value.rootTaskId, result: {
        status: "waiting_for_user", stepCount: 1, toolCallCount: 0, waitId: expectedChoiceWaitId,
      } })
      const executionProjection = createCanonicalExecutionProjection(pool!)
      await executionProjection.finish({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        result: { status: "waiting_for_user" } })
      await releaseTurnLease(pool!, turnLease, "waiting_for_user")
      const wakeupEventIdempotencyKey = `agent-wait-command:scheduled-prepare-answer-${value.turnId}:wakeup`
      const pendingWakeup = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT outbox."id", outbox."publishedAt" FROM "agent_outbox" AS outbox
          JOIN "agent_events" AS event ON outbox."idempotencyKey" = 'agent-event:' || event."id"
          WHERE outbox."topic" = $1 AND event."type" = 'turn.wakeup' AND event."idempotencyKey" = $2`,
        [AGENT_TURN_WAKEUP_TOPIC, wakeupEventIdempotencyKey])
      expect(pendingWakeup.rows).toHaveLength(1)
      expect(pendingWakeup.rows[0]?.publishedAt).toBeNull()
      expect(await drainAgentWakeups(pool!, 10)).toBeGreaterThanOrEqual(1)
      const publishedWakeup = await pool!.query<{ publishedAt: Date | null }>(
        `SELECT "publishedAt" FROM "agent_outbox" WHERE "id" = $1`, [pendingWakeup.rows[0]!.id])
      expect(publishedWakeup.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const queuedTurn = await pool!.query<{ status: string; leaseVersion: number; leaseOwnerId: string | null }>(
        `SELECT "status", "leaseVersion", "leaseOwnerId" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])
      expect(queuedTurn.rows[0]).toMatchObject({ status: "queued", leaseVersion: turnLease.leaseVersion, leaseOwnerId: null })

      const resumedLease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId,
        ownerId: `${value.leaseOwnerId}-resumed` })
      expect(resumedLease.leaseVersion).toBe(turnLease.leaseVersion + 1)
      const resumedRoot = await rootStore.ensure({ lease: resumedLease, goal: "Resume scheduled automation after the user's choice",
        allowedActions: scheduledRootActions })
      expect(resumedRoot).toMatchObject({ id: value.rootTaskId, status: "running", leaseOwner: resumedLease.ownerId })
      await createCanonicalExecutionProjection(pool!).start({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId })
      const resumedOwner = { ...owner, turnLeaseOwnerId: resumedLease.ownerId, turnLeaseVersion: resumedLease.leaseVersion }
      const resumedTurnExecutionOwner = {
        kind: "turn" as const, userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        taskId: value.rootTaskId, rootTaskId: value.rootTaskId, ownerId: resumedLease.ownerId,
        leaseVersion: resumedLease.leaseVersion, leaseExpiresAt: resumedLease.leaseExpiresAt,
      }
      graphScope = { ...graphScope, turnLeaseOwner: resumedLease.ownerId, turnLeaseVersion: resumedLease.leaseVersion,
        parentLeaseOwner: resumedLease.ownerId, parentAttemptCount: 1 }
      const resumedBridge = await bridge(resumedOwner)
      expect(resumedBridge.status).toBe("ready")
      if (resumedBridge.status !== "ready") throw new Error("Resumed scheduled pipeline did not rebind Analyze evidence")
      expect(resumedBridge.attestation.owner).toEqual(resumedOwner)
      expect(scheduledTaskGraphContinuationKey(resumedOwner, resumedBridge.attestation, executionOwner.executionId,
        executionOwner.executionAttemptCount)).toBe(continuationKey)

      const priorAgentWebUrl = process.env.AGENT_WEB_URL
      const priorWorkerSecret = process.env.AGENT_WORKER_SECRET
      process.env.AGENT_WEB_URL = "http://scheduled-pipeline.integration.invalid"
      process.env.AGENT_WORKER_SECRET = `scheduled-pipeline-secret-${randomUUID()}`
      const routePipelineCalls: Array<{ owner: IntegrationScheduledOwner; continuationKey: string; claimToken: string }> = []
      let reboundHandoff: Awaited<ReturnType<typeof postScheduledPipelineContinuation>>
      try {
        vi.doMock(scheduledRouteRunServicePath, () => ({
          runAgentPipeline: vi.fn(async (value: unknown) => {
            const input = value as { scheduledTaskGraph: { owner: IntegrationScheduledOwner; continuationKey: string; claimToken: string } }
            const scheduled = input.scheduledTaskGraph
            routePipelineCalls.push({ owner: scheduled.owner, continuationKey: scheduled.continuationKey, claimToken: scheduled.claimToken })
            const saved = await pool!.query<{ state: Record<string, unknown> }>(`SELECT "state" FROM "agent_executions" WHERE "id" = $1`, [scheduled.owner.executionId])
            const reboundDigest = checkpointModule.scheduledTaskGraphAnalyzeCheckpointDigest(saved.rows[0]?.state)
            if (!reboundDigest) throw new Error("Scheduled route did not persist a valid Analyze checkpoint")
            return { status: "analyze_checkpointed", continuationKey: scheduled.continuationKey, checkpointDigest: reboundDigest,
              claimTokenDigest: `sha256:${createHash("sha256").update(scheduled.claimToken, "utf8").digest("hex")}`,
              executionId: scheduled.owner.executionId, executionAttemptCount: scheduled.owner.executionAttemptCount }
          }),
        }))
        vi.doMock(scheduledRouteModelRouterPath, () => ({ APPLYMATE_BACKING: "fixture", loadUserAiConfig: vi.fn(async () => ({
          resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-pipeline-route",
        })), resolveConfig: vi.fn(() => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-pipeline-route" })) }))
        vi.doMock(scheduledRouteEntitlementsPath, () => ({ isFeatureAllowed: vi.fn(async () => true),
          hasEffectiveEntitlement: vi.fn(async () => true), resolveAiAccess: vi.fn(async () => "available") }))
        const scheduledPipelineRoute = await vi.importActual<{ POST(request: Request): Promise<Response> }>(scheduledPipelineRoutePath)
        const routeFetcher: typeof fetch = async (input, init) => scheduledPipelineRoute.POST(new Request(input, init))
        reboundHandoff = await postScheduledPipelineContinuation({ owner: resumedOwner, attestation: resumedBridge.attestation },
          new AbortController().signal, routeFetcher)
      } finally {
        if (priorAgentWebUrl === undefined) delete process.env.AGENT_WEB_URL
        else process.env.AGENT_WEB_URL = priorAgentWebUrl
        if (priorWorkerSecret === undefined) delete process.env.AGENT_WORKER_SECRET
        else process.env.AGENT_WORKER_SECRET = priorWorkerSecret
      }
      expect(reboundHandoff.status).toBe("analyze_checkpointed")
      if (reboundHandoff.status !== "analyze_checkpointed") throw new Error("Scheduled route did not return a rebound Analyze proof")
      expect(routePipelineCalls).toHaveLength(1)
      expect(routePipelineCalls[0]).toMatchObject({ owner: resumedOwner, continuationKey })
      const reboundExecution = await pool!.query<{ status: string; state: Record<string, unknown> }>(
        `SELECT "status", "state" FROM "agent_executions" WHERE "id" = $1`, [value.executionId])
      expect(reboundExecution.rows[0]?.status).toBe("running")
      expect((reboundExecution.rows[0]?.state.scheduledTaskGraphClaim as { owner: IntegrationScheduledOwner }).owner).toMatchObject(resumedOwner)
      expect((reboundExecution.rows[0]?.state.scheduledTaskGraphContinuation as { owner: IntegrationScheduledOwner }).owner).toMatchObject(resumedOwner)
      const reboundPrepareInput: TaskGraphScheduledPrepareInput = {
        ...prepareInput, scope: { ...graphScope, stepId },
        handoff: reboundHandoff.proof,
        attestation: resumedBridge.attestation,
      }
      await expect(appendScheduledPrepare(prepareInput)).rejects.toThrow("task_graph_turn_fenced")

      const restartedCommand = createPgTaskGraphCommandPort(pool as unknown as PgSubagentPool)
      const appendRestartedPrepare = restartedCommand.appendScheduledPrepare
      if (!appendRestartedPrepare) throw new Error("Restarted PG command port omitted scheduled Prepare")
      const restartedContinuation = createScheduledAutomationPrepareContinuation({
        commandPort: restartedCommand, waitPort: durableWait,
        async verifyReadyPrepare({ scope: verifyScope, prepareTaskId: verifyTaskId }) {
          const graph = await loadTaskGraph(pool!, verifyScope, false)
          const current = currentTaskGraph(graph)
          const task = graph.tasks.get(verifyTaskId)
          if (!graph.snapshot || !task || !Number.isSafeInteger(task.attemptCount)) return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
          return verifyScheduledPrepareTaskGraphEvidence(pool!, { scope: { ...verifyScope, taskId: verifyTaskId, attemptCount: task.attemptCount! },
            snapshot: graph.snapshot, current, tasks: graph.tasks,
            structuredResult: (task.result as Record<string, unknown> | null)?.structuredResult, completionGraphRevision: current.revision })
        },
      })
      const continuationInput = {
        owner: resumedOwner, executionOwner: resumedTurnExecutionOwner, attestation: resumedBridge.attestation,
        proof: reboundHandoff.proof,
        candidateText, finalStepId: stepId, finalStepOrdinal: 8, signal: new AbortController().signal,
      }
      const resumedPrepare = await restartedContinuation(continuationInput)
      expect(resumedPrepare).toMatchObject({ status: "waiting_for_dependency" })
      const scheduledReceipt = await appendRestartedPrepare(reboundPrepareInput)
      expect(scheduledReceipt).toMatchObject({ status: "duplicate", revision: 3,
        nodes: [{ key: "prepare", status: "queued" }], readyTaskIds: [expect.any(String)],
        choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } })
      const prepareTaskId = scheduledReceipt.nodes[0]!.taskId
      const preparedTask = await pool!.query<{ rootTaskId: string; parentTaskId: string; status: string; role: string; taskType: string }>(
        `SELECT "rootTaskId", "parentTaskId", "status", "role", "taskType" FROM "sub_agent_tasks" WHERE "id" = $1`, [prepareTaskId])
      expect(preparedTask.rows[0]).toMatchObject({ rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId,
        status: "queued", role: TASK_GRAPH_TEMPLATES.prepare.role, taskType: TASK_GRAPH_TEMPLATES.prepare.taskType })
      const storedGraph = await pool!.query<{ revision: number; content: Record<string, unknown> }>(
        `SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1`, [taskGraphItemId(value.rootTaskId)])
      expect(storedGraph.rows[0]).toMatchObject({ revision: 3, content: { rootSuccessCriteria: snapshot.rootSuccessCriteria } })
      expect((storedGraph.rows[0]!.content.nodes as Array<{ key: string; taskId: string }>)[2]).toMatchObject({ key: "prepare", taskId: prepareTaskId })

      const privateReceipts = await pool!.query<{ id: string; itemId: string | null; taskId: string | null; actor: string; payload: Record<string, unknown> }>(
        `SELECT "id", "itemId", "taskId", "actor", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'agent.plan.scheduled_prepare_binding'`, [value.sessionId, value.turnId])
      expect(privateReceipts.rows).toHaveLength(1)
      const privateReceipt = privateReceipts.rows[0]!
      expect(privateReceipt).toMatchObject({ itemId: null, taskId: null, actor: "system" })
      expect(privateReceipt.payload).not.toHaveProperty("claimToken")
      expect(privateReceipt.payload).not.toHaveProperty("claimTokenDigest")
      expect(JSON.stringify(privateReceipt.payload)).not.toContain(claimToken)
      expect(privateReceipt.payload).toMatchObject({ continuationKey, analyzeGraphRevision: 2, prepareScheduleRevision: 3,
        owner: { turnLeaseOwnerId: resumedLease.ownerId, turnLeaseVersion: resumedLease.leaseVersion } })
      await expect(questionStore.readScheduledPrepareChoice({ owner: resumedTurnExecutionOwner, receipt: privateReceipt.payload, now: new Date() }))
        .resolves.toMatchObject({ status: "answered", waitId: expectedChoiceWaitId, itemId: choiceWait.itemId, answer: "keep_resume" })
      const receiptOutbox = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = $1 OR "payload"->>'eventId' = $2`,
        [`agent-event:${privateReceipt.id}`, privateReceipt.id])
      expect(receiptOutbox.rows).toHaveLength(0)
      const dispatch = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1`,
        [`subagent-dispatch:${prepareTaskId}`])
      expect(dispatch.rows).toHaveLength(1)
      await expect(appendRestartedPrepare({ ...reboundPrepareInput,
        handoff: { ...reboundPrepareInput.handoff, checkpointDigest: "f".repeat(64) } }))
        .rejects.toMatchObject({ code: "scheduled_prepare_graph_mismatch" })

      const [childRuntime, childStore, childManager, childRunner, childQueue, dispatchIdentity] = await Promise.all([
        import("./production-child-runtime.js"), import("./pg-store.js"), import("./manager.js"),
        import("../../queue/subagent-pause-dispatch.js"), import("../../queue/subagent-queue.js"), import("./dispatch-identity.js"),
      ])
      const profile: ModelAdapter["profile"] = {
        provider: "fixture", model: "scheduled-prepare-integration", nativeTools: true, structuredOutput: true, streaming: true,
        continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
        supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
        maxContextTokens: null, maxOutputTokens: 2200, costClass: "low",
      }
      let toolModelCalls = 0
      let materialModelCalls = 0
      const modelRuntimeFactory = (): ModelAdapter => ({
        id: "scheduled-prepare-fixture", profile,
        async *stream(request) {
          const parts = request.messages.flatMap(message => message.content)
          const toolResult = parts.find(part => part.type === "tool_result")
          if (request.tools.some(tool => (tool as { name?: unknown }).name === "scheduled.application.prepare")) {
            if (!toolResult || toolResult.type !== "tool_result") {
              toolModelCalls += 1
              yield { type: "tool_call_completed", callId: `scheduled-prepare-tool-${prepareTaskId}`, name: "scheduled.application.prepare", arguments: {} }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (toolResult.isError) throw new Error("scheduled Prepare tool returned an error")
            yield { type: "text_delta", text: toolResult.content }
            yield { type: "completed", finishReason: "stop" }
            return
          }
          const prompt = parts.filter(part => part.type === "text").map(part => part.text).join("\n")
          materialModelCalls += 1
          yield { type: "text_delta", text: prompt.includes("Tailor this resume")
            ? JSON.stringify(baseResumeContent)
            : prompt.includes("Write a concise, professional European application cover letter")
              ? preparedLetter : (() => { throw new Error("unexpected scheduled Prepare model prompt") })() }
          yield { type: "completed", finishReason: "stop" }
        },
      })
      const authorizeUsage = async () => ({ settle: async () => undefined })
      const executor = childRuntime.createProductionChildExecutor({ pool: pool!, authorizeUsage, modelRuntimeFactory })
      const manager = new childManager.AgentTreeManager(new childStore.PgSubagentTaskStore(pool!))
      await prepareQueue.waitUntilReady()
      expect(await childQueue.dispatchPendingSubagentOutbox(pool as never, prepareQueue, 10)).toBe(1)
      const prepareQueueJobId = childQueue.subagentJobId(prepareTaskId)
      const queuedPrepare = await prepareQueue.getJob(prepareQueueJobId)
      expect(queuedPrepare?.data).toEqual({ taskId: prepareTaskId, sessionId: value.sessionId, rootTaskId: value.rootTaskId, ownerId: expect.any(String) })
      prepareWorker = new Worker<SubagentJobPayload, unknown>(prepareQueueName, async job => {
        const identity = dispatchIdentity.parseSubagentDispatchJobId(job.id, job.data.taskId)
        if (!identity) throw new Error("scheduled Prepare dispatch identity was invalid")
        return childRunner.runSubagentQueueJob(pool as never, manager, executor, job.data, identity)
      }, { connection: redis.duplicate(), skipVersionCheck: true, concurrency: 1 })
      const prepareCompleted = waitForSubagentWorkerCompletion(prepareWorker, prepareQueueJobId)
      await prepareWorker.waitUntilReady()
      const prepareOutcome = await prepareCompleted
      expect(prepareOutcome).toMatchObject({ taskId: prepareTaskId, status: "completed" })
      await prepareWorker.close()
      prepareWorker = undefined

      const completedPrepare = await pool!.query<{ status: string; attemptCount: number; failureReason: string | null; result: Record<string, unknown> }>(
        `SELECT "status", "attemptCount", "failureReason", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [prepareTaskId])
      expect(completedPrepare.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, failureReason: null })
      const structuredResult = completedPrepare.rows[0]?.result.structuredResult as Record<string, unknown> | undefined
      expect(structuredResult).toMatchObject({ schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: prepareTaskId,
        attemptCount: 1, snapshotDigest: result.attestation.snapshotDigest, checkpointDigest,
        jobs: [{ jobId: value.jobId, status: "prepared" }], materials: expect.arrayContaining([
          expect.objectContaining({ jobId: value.jobId, kind: "resume" }),
          expect.objectContaining({ jobId: value.jobId, kind: "cover_letter" }),
        ]) })
      expect(JSON.stringify(structuredResult)).not.toContain(preparedLetter)
      expect(toolModelCalls).toBe(1)
      expect(materialModelCalls).toBe(2)
      expect(completedPrepare.rows[0]?.result.taskGraphScheduledPrepareProofFacts).toBeDefined()
      const artifactVersions = await pool!.query<{ artifactType: string; content: unknown; version: number; taskId: string; sourceDigest: string; contentHash: string }>(
        `SELECT "artifactType", "content", "version", "taskId", "sourceDigest", "contentHash" FROM "agent_artifact_version"
          WHERE "taskId" = $1 ORDER BY "artifactType"`, [prepareTaskId])
      expect(artifactVersions.rows).toHaveLength(2)
      expect(artifactVersions.rows.map(row => row.artifactType)).toEqual(["cover_letter", "resume"])
      expect(artifactVersions.rows[0]).toMatchObject({ artifactType: "cover_letter", content: preparedLetter, version: 1, taskId: prepareTaskId })
      expect(artifactVersions.rows[1]).toMatchObject({ artifactType: "resume", content: baseResumeContent, version: 1, taskId: prepareTaskId })

      const completedDuplicate = await appendRestartedPrepare(reboundPrepareInput)
      expect(completedDuplicate).toMatchObject({ status: "duplicate", nodes: [{ key: "prepare", taskId: prepareTaskId, status: "waiting" }], readyTaskIds: [] })
      if (resumedPrepare.status !== "waiting_for_dependency") throw new Error("Scheduled Prepare did not persist its dependency wait")
      const resolvedPrepareWait = await durableWait.resolve({ userId: value.userId, sessionId: value.sessionId, waitId: resumedPrepare.waitId })
      expect(resolvedPrepareWait).toMatchObject({ status: "ready", matchedTaskIds: [prepareTaskId] })
      const readyPrepare = await restartedContinuation(continuationInput)
      expect(readyPrepare.status).toBe("ready")
      if (readyPrepare.status !== "ready") throw new Error("Scheduled Prepare fixture did not produce a verified proof")
      const gateDatabase = await import(webDbPath) as unknown as {
        db: { job: { findMany(input: unknown): Promise<unknown[]> }; $disconnect(): Promise<void> }
      }
      const gatePath = "@/lib/agent/scheduled-taskgraph-run-service"
      const gateService = await import(gatePath) as unknown as {
        buildScheduledTaskGraphGateResumeState(input: { owner: IntegrationScheduledOwner; snapshot: unknown; attestation: unknown; continuationKey: string;
          claimToken: string; ownedJobs: readonly unknown[]; persistedCheckpoint: unknown; prepareProof: unknown }): Promise<Record<string, unknown>>
      }
      const ownedJobs = await gateDatabase.db.job.findMany({ where: { id: value.jobId, userId: value.userId } })
      expect(ownedJobs).toHaveLength(1)
      const resumedClaimOwner = { ...resumedOwner, ...executionOwner }
      const resumedClaimToken = routePipelineCalls[0]!.claimToken
      const currentExecutionState = (await pool!.query<{ state: Record<string, unknown> }>(
        `SELECT "state" FROM "agent_executions" WHERE "id" = $1`, [value.executionId])).rows[0]?.state
      expect(currentExecutionState).toBeDefined()
      const gateState = await gateService.buildScheduledTaskGraphGateResumeState({ owner: resumedClaimOwner, snapshot: scheduledSnapshot,
        attestation: resumedBridge.attestation, continuationKey, claimToken: resumedClaimToken, ownedJobs,
        persistedCheckpoint: currentExecutionState, prepareProof: readyPrepare.prepareProof })
      expect(gateState.nextStage).toBe("gate")
      expect(gateState.scheduledTaskGraphPreparedArtifacts).toHaveLength(2)
      expect(gateState.preparedPackages).toMatchObject([{ job: { id: value.jobId }, score: 82,
        matchedKeywords: ["TypeScript"], missingKeywords: ["PostgreSQL"], coverLetter: preparedLetter,
        tailoredResumeArtifact: { kind: "resume", version: 1 }, coverLetterArtifact: { kind: "cover_letter", version: 1 } }])

      const duplicateQueueJob = await prepareQueue.getJob(prepareQueueJobId)
      expect(await duplicateQueueJob?.getState()).toBe("completed")
      await duplicateQueueJob?.remove()
      await childQueue.enqueueSubagentTask(prepareQueue, { taskId: prepareTaskId, sessionId: value.sessionId,
        rootTaskId: value.rootTaskId, ownerId: queuedPrepare!.data.ownerId }, 3, 0)
      const restartedManager = new childManager.AgentTreeManager(new childStore.PgSubagentTaskStore(pool!))
      const restartedExecutor = childRuntime.createProductionChildExecutor({ pool: pool!, authorizeUsage, modelRuntimeFactory })
      restartedPrepareWorker = new Worker<SubagentJobPayload, unknown>(prepareQueueName, async job => {
        const identity = dispatchIdentity.parseSubagentDispatchJobId(job.id, job.data.taskId)
        if (!identity) throw new Error("replayed scheduled Prepare dispatch identity was invalid")
        return childRunner.runSubagentQueueJob(pool as never, restartedManager, restartedExecutor, job.data, identity)
      }, { connection: redis.duplicate(), skipVersionCheck: true, concurrency: 1 })
      const duplicateCompletion = waitForSubagentWorkerCompletion(restartedPrepareWorker, prepareQueueJobId)
      await restartedPrepareWorker.waitUntilReady()
      expect(await duplicateCompletion).toMatchObject({ taskId: prepareTaskId, status: "skipped", reason: "not_available" })
      await restartedPrepareWorker.close()
      restartedPrepareWorker = undefined
      expect(toolModelCalls).toBe(1)
      expect(materialModelCalls).toBe(2)
      const versionsAfterReplay = await pool!.query(`SELECT "id" FROM "agent_artifact_version" WHERE "taskId" = $1`, [prepareTaskId])
      expect(versionsAfterReplay.rows).toHaveLength(2)

      const finalReceiptCount = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'agent.plan.scheduled_prepare_binding'`,
        [value.sessionId, value.turnId])
      const finalDispatchCount = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1`,
        [`subagent-dispatch:${prepareTaskId}`])
      expect(finalReceiptCount.rows).toHaveLength(1)
      expect(finalDispatchCount.rows).toHaveLength(1)

      const redelivery = await queue.add("continue-scheduled-taskgraph", payload, {
        jobId, attempts: 2, backoff: { type: "fixed", delay: 250 }, removeOnComplete: false,
      })
      expect(redelivery.id).toBe(jobId)
      expect(await redelivery.getState()).toBe("completed")
      expect(deliveries).toHaveLength(2)
    } finally {
      await firstWorker?.close().catch(() => undefined)
      await restartedWorker?.close().catch(() => undefined)
      await prepareWorker?.close().catch(() => undefined)
      await restartedPrepareWorker?.close().catch(() => undefined)
      const job = await queue.getJob(jobId).catch(() => undefined)
      if (job) await job.remove().catch(() => undefined)
      try { await queue.close() } catch { /* Continue cleanup for the isolated Prepare queue. */ }
      // The UUID-scoped Prepare queue belongs only to this test.
      await prepareQueue.obliterate({ force: true }).catch(() => undefined)
      await prepareQueue.close().catch(() => undefined)
      await Promise.all([queueRedis.quit().catch(() => queueRedis.disconnect()), prepareQueueRedis.quit().catch(() => prepareQueueRedis.disconnect()), redis.quit().catch(() => redis.disconnect())])
    }
  })

  it("persists a verified zero-result run and rejects provider failure and foreign ownership", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    const snapshot = graphSnapshot(value)
    await seedGraph(pool!, value, snapshot, true)
    const discovery = emptyDiscoveryOutput(value)
    await persistToolReceipt(pool!, value, value.scoutTaskId, "scout-step", "jobs.discover", "zero-discover", {
      targetRoles: ["Software Engineer"], targetLocations: ["Dublin"],
    }, discovery, 1)

    const scope = {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId,
    }
    const scoutNode = snapshot.nodes[0]!
    const analystNode = snapshot.nodes[1]!
    const scoutResult = emptyRoleResult("scout")
    const scoutScope = { ...scope, taskId: value.scoutTaskId, attemptCount: 1 }
    const scoutProof = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: scoutScope, snapshot, node: scoutNode, structuredResult: scoutResult,
    })
    expect(scoutProof, `Zero-result Scout verification failed: ${JSON.stringify(scoutProof.evaluation)}`)
      .toMatchObject({ verified: true, projection: { role: "scout", candidates: [] } })
    expect(scoutProof.projection?.evidenceIds).toHaveLength(1)
    await persistVerification(pool!, value.scoutTaskId, scoutProof, {
      discoveryAttempt: completeDiscoverySidecar(0), toolCallCount: 1,
    })

    const dependencyProof = await verifyCompletedScoutDependencies(pool!, scope, snapshot, analystNode)
    expect(dependencyProof).not.toBeNull()
    const analystResult = emptyRoleResult("analyst")
    const analystProof = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: { ...scope, taskId: value.analystTaskId, attemptCount: 1 }, snapshot, node: analystNode,
      structuredResult: analystResult, dependencies: dependencyProof!.projections,
    })
    expect(analystProof).toMatchObject({ verified: true, projection: { role: "analyst", findings: [], evidenceIds: [] } })
    await persistVerification(pool!, value.analystTaskId, analystProof, {
      dependencyBindings: dependencyProof!.bindings, toolCallCount: 0,
    })

    const ownerMismatch = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: { ...scoutScope, userId: "foreign-scheduled-pipeline-user" }, snapshot, node: scoutNode, structuredResult: scoutResult,
    })
    expect(ownerMismatch.verified).toBe(false)
    expect(ownerMismatch.report.reasonCode).toBe("canonical_evidence_invalid")

    const resultItemId = `zero-discover-${value.turnId}-result`
    const callItemId = `zero-discover-${value.turnId}-item`
    await pool!.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{output,usage,providerFailures}', '1'::jsonb) WHERE "id" = $1`, [resultItemId])
    await pool!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{output,usage,providerFailures}', '1'::jsonb)
      WHERE "itemId" = $1 AND "type" = 'tool_call.completed'`, [callItemId])
    const providerFailure = await verifyCompletedTaskGraphNodeEvidence(pool!, {
      scope: scoutScope, snapshot, node: scoutNode, structuredResult: scoutResult,
    })
    expect(providerFailure.verified).toBe(false)
    expect(providerFailure.projection).toBeUndefined()
  })
})

type ScheduledContinuationPayload = Readonly<{ owner: {
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  turnLeaseOwnerId: string; turnLeaseVersion: number
} }>

function waitForWorkerJobEvent<Result>(worker: Worker<ScheduledContinuationPayload, Result>, event: "failed", jobId: string): Promise<void>
function waitForWorkerJobEvent<Result>(worker: Worker<ScheduledContinuationPayload, Result>, event: "completed", jobId: string): Promise<Result>
function waitForWorkerJobEvent<Result>(worker: Worker<ScheduledContinuationPayload, Result>, event: "failed" | "completed", jobId: string): Promise<Result | void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scheduled continuation ${event} event timed out`)), 20_000)
    if (event === "failed") {
      worker.on("failed", (job, error) => {
        if (job?.id !== jobId) return
        clearTimeout(timer)
        if (job.attemptsMade !== 1) reject(new Error(`Expected one failed scheduled delivery, received ${job.attemptsMade}: ${error.message}`))
        else resolve()
      })
    } else {
      worker.on("completed", (job, result) => {
        if (job.id !== jobId) return
        clearTimeout(timer)
        resolve(result)
      })
    }
  })
}

function waitForSubagentWorkerCompletion(worker: Worker<SubagentJobPayload, unknown>, jobId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scheduled Prepare child timed out: ${jobId}`)), 30_000)
    worker.on("completed", (job, result) => {
      if (job.id !== jobId) return
      clearTimeout(timer)
      resolve(result)
    })
    worker.on("failed", (job, error) => {
      if (job?.id !== jobId) return
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function readSseThroughEvent(stream: ReadableStream<Uint8Array>, eventName: string): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 5_000
  let body = ""
  try {
    while (!body.includes(`event: ${eventName}\n`)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`SSE stream did not reach ${eventName}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`SSE stream did not reach ${eventName}`)), remaining) }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
      if (next.done) throw new Error(`SSE stream closed before ${eventName}`)
      body += decoder.decode(next.value, { stream: true })
    }
    return body
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function dedicatedDisposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Scheduled automation PostgreSQL integration requires the disposable CI service URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Scheduled automation PostgreSQL integration requires the dedicated disposable CI service URL")
  }
  return value
}

function dedicatedDisposableRedisUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1") {
    if (required) throw new Error("Scheduled automation Redis integration requires the dedicated disposable CI service URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "redis:" || url.hostname !== "127.0.0.1" || url.port !== "6379"
    || url.username || url.password || url.pathname !== "/15" || url.search || url.hash) {
    throw new Error("Scheduled automation Redis integration requires the dedicated disposable Redis DB 15 URL")
  }
  return value
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    userId: `scheduled-pipeline-user-${suffix}`,
    sessionId: `scheduled-pipeline-session-${suffix}`,
    turnId: `scheduled-pipeline-turn-${suffix}`,
    rootTaskId: `scheduled-pipeline-root-${suffix}`,
    scoutTaskId: `scheduled-pipeline-scout-${suffix}`,
    analystTaskId: `scheduled-pipeline-analyst-${suffix}`,
    jobId: `scheduled-pipeline-job-${suffix}`,
    leaseOwnerId: `scheduled-pipeline-turn-owner-${suffix}`,
    executionId: `scheduled-pipeline-execution-${suffix}`,
  }
}

async function seedScheduledExecution(database: PgPool, value: Fixture, state: Record<string, unknown>): Promise<void> {
  await database.query(`INSERT INTO "agent_executions"
    ("id", "userId", "sessionId", "status", "checkpoint", "state", "attemptCount", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'scout', $4::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [value.executionId, value.userId, value.sessionId, JSON.stringify(state)])
}

async function seedExpiredScheduledGate(database: PgPool, value: Fixture, now: Date, secret: string, tamperScope = false, tamperTitle = false): Promise<void> {
  const lease = (await database.query<{ leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(
    `SELECT "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1`, [value.turnId])).rows[0]
  if (!lease) throw new Error("Scheduled Gate fixture has no Turn lease")
  const owner = {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
    rootAttemptCount: 1, turnLeaseOwnerId: value.leaseOwnerId, turnLeaseVersion: 4,
    executionId: value.executionId, executionAttemptCount: 1,
  }
  const key = `scheduled-gate-recovery:${value.turnId}`
  const claimToken = `scheduled-gate-claim:${value.turnId}`
  const claim = {
    schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner,
    claimedAt: new Date(lease.leaseStartedAt).toISOString(), leaseExpiresAt: new Date(lease.leaseExpiresAt).toISOString(),
  }
  const state = { nextStage: "gate", scheduledTaskGraphClaim: claim, scheduledTaskGraphContinuation: {
    schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
    snapshotDigest: `sha256:${"a".repeat(64)}`, graphRevision: 1, evidenceDigest: "b".repeat(64),
  } }
  await seedScheduledExecution(database, value, state)
  await database.query(`UPDATE "agent_executions" SET "checkpoint" = 'gate' WHERE "id" = $1`, [value.executionId])
  const expiredLease = new Date(now.getTime() - 1_000)
  await database.query(`UPDATE "agent_turns" SET "status" = 'waiting_for_approval', "leaseExpiresAt" = $2,
    "updatedAt" = $3 WHERE "id" = $1`, [value.turnId, expiredLease, now])

  const jobId = value.jobId
  const resourceHash = await hashAgentReceiptValue("resource", { jobId })
  const materialHash = await hashAgentReceiptValue("material", { jobId, resume: "fixture-resume" })
  const answersHash = await hashAgentReceiptValue("answers", null)
  const identity = JSON.stringify([1, owner.userId, owner.sessionId, owner.turnId, owner.executionId, owner.executionAttemptCount,
    [owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount], jobId,
    "review_application", resourceHash, materialHash, answersHash])
  const derive = (label: string) => createHmac("sha256", secret)
    .update(`applymate.gate-review-replay.v1:${label}\0${identity}`).digest("hex")
  const approvalId = `gate_review_${derive("approval-id")}`
  const toolCallId = `application-review:${derive("tool-call-id")}`
  const nonceHash = await hashApprovalNonce(derive("receipt-nonce"))
  const revision = 3
  const expiresAt = new Date(now.getTime() + 60 * 60_000)
  const validScopeHash = await hashApprovalScope({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    jobId, toolCallId, action: "review_application", resourceHash, materialHash, answersHash, revision, nonceHash,
    expiresAt: expiresAt.toISOString() })
  const scopeHash = tamperScope ? "f".repeat(64) : validScopeHash
  const title = "Review application: Example Engineer"
  const body = "Review the job and prepared materials."
  const impact = { externalSubmission: false, jobId }
  const itemContent = {
    waitKind: "approval", approvalId, toolCallId, action: "review_application", title: tamperTitle ? `${title} altered` : title, body, impact,
    scopeHash, receiptRevision: revision, expiresAt: expiresAt.toISOString(), decision: null, responseAvailable: false,
  }

  await database.query(`INSERT INTO "agent_approvals"
    ("id", "sessionId", "taskId", "userId", "turnId", "toolCallId", "jobId", "type", "status", "title", "body",
      "impact", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt")
    VALUES ($1, $2, NULL, $3, $4, $5, $6, 'review_application', 'pending', $7, $8, $9::jsonb, $10::jsonb,
      $11, $12, $13, $14, $15, $16, $17)`, [
    approvalId, owner.sessionId, owner.userId, owner.turnId, toolCallId, jobId, title, body,
    JSON.stringify(impact), JSON.stringify({ jobId, applicationTaskId: `application-task-${value.turnId}` }),
    resourceHash, materialHash, answersHash, scopeHash, nonceHash, revision, expiresAt,
  ])
  await database.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'approval_request', 'started', 0, $4::jsonb, $5, NULL, $5, $5)`, [
    `agent-wait:approval:${approvalId}`, owner.sessionId, owner.turnId, JSON.stringify(itemContent), now,
  ])
}

async function waitForTurnOwnerLockWait(database: PgPool, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const waiting = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM pg_stat_activity
      WHERE "application_name" = $1 AND "wait_event_type" = 'Lock' AND "query" ILIKE '%agent_turns%'`, [applicationName])
    if (Number(waiting.rows[0]?.count) > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Scheduled owner fence did not block on the locked Turn row")
}

async function waitUntilTurnLeaseExpires(database: PgPool, turnId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await database.query<{ expired: boolean }>(`SELECT "leaseExpiresAt" <= clock_timestamp() AS "expired"
      FROM "agent_turns" WHERE "id" = $1`, [turnId])
    if (result.rows[0]?.expired) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Scheduled Turn lease did not expire while the owner fence was blocked")
}

function scheduledAutomationSnapshot() {
  return {
    schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
    targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], minScore: 70,
    dailyCap: 10, requireApproval: true, autoApply: false,
  }
}

function graphSnapshot(value: Fixture) {
  return parseTaskGraphSnapshot({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [
      {
        key: "scheduled-scout", templateId: "scout", goal: "Discover a matching role",
        successCriteria: ["Return an evidenced matching role"], dependsOn: [], depth: 1,
        taskId: value.scoutTaskId, verificationDisposition: "typed", verification: SCOUT_VERIFICATION,
      },
      {
        key: "scheduled-analyst", templateId: "analyst", goal: "Analyze the discovered role",
        successCriteria: ["Return a dependency-bound analysis"], dependsOn: ["scheduled-scout"], depth: 2,
        taskId: value.analystTaskId, verificationDisposition: "typed",
        verification: {
          schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
          criteria: [
            { id: "scout-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scheduled-scout" } },
            { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
          ],
        },
      },
    ],
  })
}

async function seedGraph(database: PgPool, value: Fixture, snapshot: ReturnType<typeof parseTaskGraphSnapshot>, empty = false): Promise<void> {
  const scheduledInput = { automationRunMode: "scheduled", scheduledAutomationSnapshot: scheduledAutomationSnapshot() }
  await database.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [value.userId, `${value.userId}@example.invalid`])
  await database.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Scheduled automation pipeline integration', 'running', 'automation', CURRENT_TIMESTAMP)`, [value.sessionId, value.userId])
  await database.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
      "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "executionMode", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'automation', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 4, 'canonical_task_graph', CURRENT_TIMESTAMP)`,
  [value.turnId, value.sessionId, value.userId, JSON.stringify(scheduledInput), value.leaseOwnerId])
  await database.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
      "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Scheduled automation pipeline integration',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":4,"maxDepth":4,"maxFanOut":4,"maxAttempts":2}}'::jsonb,
      1, 2, 'root-lease-owner', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [value.rootTaskId, value.sessionId, value.turnId])
  await database.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.rootTaskId])
  await database.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.rootTaskId, value.turnId])
  for (const node of snapshot.nodes) {
    const template = TASK_GRAPH_TEMPLATES[node.templateId as "scout" | "analyst"]
    const roleResult = empty ? emptyRoleResult(node.templateId as "scout" | "analyst") : initialRoleResult(node.templateId as "scout" | "analyst", value.jobId)
    const result = {
      status: "completed", stepCount: empty ? 0 : 1, toolCallCount: node.templateId === "scout" ? empty ? 1 : 2 : empty ? 0 : 1,
      finalItemId: null, finalText: "Fixture task completed", structuredResult: roleResult,
      ...(node.templateId === "scout" ? { discoveryAttempt: completeDiscoverySidecar(empty ? 0 : 1) } : {}),
    }
    await database.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
        "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
        "budgetSnapshot", "attemptCount", "maxAttempts", "result", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed', $10,
        '[]'::jsonb, $11::jsonb, $12::jsonb, '{}'::jsonb, $13::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, 1, 2, $14::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      node.taskId, value.sessionId, value.turnId, value.rootTaskId, value.rootTaskId,
      `/root/${node.key}`, node.depth, template.role, template.taskType, node.goal, JSON.stringify(node.successCriteria),
      JSON.stringify(template.allowedActions), JSON.stringify(template.expectedOutputSchema), JSON.stringify(result),
    ])
  }
  await database.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'started', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId, value.rootTaskId, JSON.stringify(snapshot),
  ])
}

async function persistToolReceipt(database: PgPool, value: Fixture, taskId: string, stepSuffix: string, toolName: string,
  callSuffix: string, input: unknown, output: unknown, ordinal: number): Promise<void> {
  const stepId = `${stepSuffix}-${callSuffix}-${value.turnId}`, callId = `${callSuffix}-${value.turnId}`, callItemId = `${callId}-item`, resultItemId = `${callId}-result`
  await database.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt", "completedAt")
    VALUES ($1, $2, $3, $4, $5, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [stepId, value.sessionId, value.turnId, taskId, ordinal])
  const callContent = { toolCallId: callId, toolName, toolVersion: "1", input, status: "completed", errorCode: null }
  const resultContent = { toolCallId: callId, output, errorCode: null }
  await database.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "completedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($7, $2, $3, $4, $5, 'tool_result', 'completed', $8::jsonb, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [callItemId, value.sessionId, value.turnId, stepId, taskId, JSON.stringify(callContent), resultItemId, JSON.stringify(resultContent)])
  await persistToolEvent(database, value, taskId, callItemId, callId, toolName, "tool_call.started", {
    taskId, toolCallId: callId, toolName, toolVersion: "1",
  })
  await persistToolEvent(database, value, taskId, callItemId, callId, toolName, "tool_call.completed", {
    taskId, toolCallId: callId, toolName, toolVersion: "1", status: "completed", errorCode: null, output,
  })
}

async function persistToolEvent(database: PgPool, value: Fixture, taskId: string, itemId: string, callId: string, toolName: string,
  type: string, payload: unknown): Promise<void> {
  const updated = await database.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
  const sequence = updated.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Scheduled pipeline fixture could not allocate a tool event sequence")
  await database.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10::jsonb)`, [
    randomUUID(), value.sessionId, value.turnId, itemId, taskId, String(sequence), type, callId,
    `scheduled-pipeline:${callId}:${type}`, JSON.stringify(payload),
  ])
}

function discoveryOutput(value: Fixture) {
  return {
    jobs: [{ id: value.jobId, source: "fixture" }], evidence: [], nextCursor: null,
    usage: {
      ledgerKey: "scheduled-pipeline-fixture-ledger", toolName: "jobs.discover", toolVersion: "1",
      toolCallId: `discover-call-${value.turnId}`, sessionId: value.sessionId, turnId: value.turnId,
      stepId: `scout-step-discover-call-${value.turnId}`, requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
      jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
    },
  }
}

function emptyDiscoveryOutput(value: Fixture) {
  const toolCallId = `zero-discover-${value.turnId}`, stepId = `scout-step-${toolCallId}`
  return {
    jobs: [], evidence: [], nextCursor: null,
    usage: {
      ledgerKey: [value.userId, value.sessionId, value.turnId, stepId, toolCallId].join(":"),
      toolName: "jobs.discover", toolVersion: "1", toolCallId, sessionId: value.sessionId, turnId: value.turnId, stepId,
      requests: 1, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 0,
      aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
    },
  }
}

function initialRoleResult(role: "scout" | "analyst", jobId: string) {
  const evidenceId = `fixture-${role}-job-evidence`
  const evidence = [{ id: evidenceId, kind: "job", ref: jobId, source: "fixture" }]
  return role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId, source: "fixture", url: null, evidenceIds: [evidenceId] }], evidence, summary: "One discovered job" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId, score: 8, evidenceIds: [evidenceId] }], evidence, summary: "One analyzed job" }
}

function emptyRoleResult(role: "scout" | "analyst") {
  return role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [], evidence: [], summary: "No matching jobs" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [], evidence: [], summary: "No jobs to analyze" }
}

function roleResult(role: "scout" | "analyst", jobId: string) { return initialRoleResult(role, jobId) }

function completeDiscoverySidecar(candidateCount = 1) {
  return {
    attemptCount: 1,
    health: {
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
      candidateCount, providerFailures: 0, materializationFailures: 0, hasMore: false,
    },
  }
}

async function persistVerification(database: PgPool, taskId: string, proof: Awaited<ReturnType<typeof verifyCompletedTaskGraphNodeEvidence>>,
  options: Readonly<{ discoveryAttempt?: unknown; dependencyBindings?: readonly unknown[]; toolCallCount: number }>): Promise<void> {
  if (!proof.verified || !proof.structuredResult) throw new Error(`Scheduled pipeline verifier did not pass: ${proof.evaluation.reasonCode}`)
  const existing = await database.query<{ result: Record<string, unknown> }>(`SELECT "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
  const previous = existing.rows[0]?.result
  if (!previous || typeof previous !== "object") throw new Error("Scheduled pipeline task result was not persisted")
  const report = {
    ...proof.report,
    ...(options.dependencyBindings ? { dependencyBindings: options.dependencyBindings } : {}),
  }
  await database.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [
    taskId,
    JSON.stringify({
      ...previous, stepCount: 1, toolCallCount: options.toolCallCount,
      structuredResult: proof.structuredResult, taskGraphVerificationReport: report,
      ...(options.discoveryAttempt ? { discoveryAttempt: options.discoveryAttempt } : {}),
    }),
  ])
}
