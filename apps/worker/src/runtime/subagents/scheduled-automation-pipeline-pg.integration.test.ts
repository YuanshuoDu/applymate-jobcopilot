import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Queue, Worker } from "bullmq"
import Redis from "ioredis"
import { Pool as PgPool } from "pg"

import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { createScheduledAutomationPipelineBridge, type ScheduledAutomationPipelineBridgeState } from "./scheduled-automation-pipeline-bridge.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, type StoredTaskGraphNode } from "./task-graph-snapshot.js"

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
}>

let pool: PgPool | undefined
let fixtureUserIds: string[] = []

describeWithServices("scheduled automation TaskGraph continuation on disposable PostgreSQL and Redis", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 4 })
  })

  afterAll(async () => {
    if (pool && fixtureUserIds.length) await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUserIds])
    await pool?.end()
  })

  it("rechecks persisted Scout → Analyst evidence on duplicate continuation after a Worker restart", async () => {
    const value = fixture()
    fixtureUserIds.push(value.userId)
    const snapshot = graphSnapshot(value)
    await seedGraph(pool!, value, snapshot)
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

    const graphScope = { ...scope, turnLeaseOwner: value.leaseOwnerId, turnLeaseVersion: 4, parentLeaseOwner: "root-lease-owner", parentAttemptCount: 1 }
    const loaded = await loadTaskGraph(pool!, graphScope, false)
    const persistedGraph = currentTaskGraph(loaded)
    expect(loaded.item?.revision).toBe(1)
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
    const deliveries: Array<Awaited<ReturnType<typeof bridge>>> = []
    let firstWorker: Worker<ScheduledContinuationPayload, Awaited<ReturnType<typeof bridge>>> | undefined
    let restartedWorker: Worker<ScheduledContinuationPayload, Awaited<ReturnType<typeof bridge>>> | undefined
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
      if (result.status === "ready") {
        expect(result.attestation.owner).toEqual(owner)
        expect(result.attestation.scout.candidateJobIds).toEqual([value.jobId])
        expect(result.attestation.scout.discoveryReceipt).toMatchObject({
          status: "complete", taskId: value.scoutTaskId, attemptCount: 1, candidateCount: 1,
          providerFailures: 0, materializationFailures: 0, hasMore: false,
        })
        expect(result.attestation.analyst).toMatchObject({
          taskId: value.analystTaskId, status: "completed", verification: "passed", jobIds: [value.jobId],
        })
      }

      const redelivery = await queue.add("continue-scheduled-taskgraph", payload, {
        jobId, attempts: 2, backoff: { type: "fixed", delay: 250 }, removeOnComplete: false,
      })
      expect(redelivery.id).toBe(jobId)
      expect(await redelivery.getState()).toBe("completed")
      expect(deliveries).toHaveLength(2)
    } finally {
      await firstWorker?.close().catch(() => undefined)
      await restartedWorker?.close().catch(() => undefined)
      const job = await queue.getJob(jobId).catch(() => undefined)
      if (job) await job.remove().catch(() => undefined)
      await queue.close().catch(() => undefined)
      await Promise.all([queueRedis.quit().catch(() => queueRedis.disconnect()), redis.quit().catch(() => redis.disconnect())])
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
  }
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
