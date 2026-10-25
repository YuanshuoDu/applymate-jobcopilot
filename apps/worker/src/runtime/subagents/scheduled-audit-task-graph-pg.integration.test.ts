import { randomUUID } from "node:crypto"
import { Queue, Worker, type Job } from "bullmq"
import Redis from "ioredis"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.js"
import { createScheduledAuditChildExecutor } from "./scheduled-audit-child-runtime.js"
import { createScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg-runner.fixture.js"
import { parseScheduledAuditReport, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { parseSubagentDispatchJobId } from "./dispatch-identity.js"
import { dispatchPendingSubagentOutbox, type SubagentJobPayload } from "../../queue/subagent-queue.js"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.js"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

const databaseUrl = dedicatedDisposableUrl()
const redisUrl = dedicatedDisposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip
type Fixture = Awaited<ReturnType<typeof createScheduledGatePrepareFixture>>
type Runner = Readonly<{ worker: Worker<SubagentJobPayload, unknown>; redis: Redis; queue: Queue<SubagentJobPayload> }>
type ScheduledPipelineRoute = Readonly<{ POST(request: Request): Promise<Response> }>
type ExecuteHttpResponse = Readonly<{ status: number; body: Record<string, unknown> }>
const scheduledPipelineRoutePath = "@/app/api/internal/agent-runtime/scheduled-pipeline/route"
const scheduledGateQualityReviewPath = "@/lib/agent/stages/gate-quality-review"
const scheduledModelRouterPath = "@/lib/model-router"
const scheduledEntitlementsPath = "@/lib/entitlements"
const scheduledWebDbPath = "@/lib/db"
let pool: Pool | undefined
let runner: Runner | undefined
let disconnectWebDatabase: (() => Promise<void>) | undefined
let priorDatabaseUrl: string | undefined
let priorAgentWebUrl: string | undefined
let priorWorkerSecret: string | undefined
const fixtureUsers: string[] = []

describeWithServices("scheduled Audit child on disposable PostgreSQL and Redis", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 })
    priorDatabaseUrl = process.env.DATABASE_URL
    priorAgentWebUrl = process.env.AGENT_WEB_URL
    priorWorkerSecret = process.env.AGENT_WORKER_SECRET
    process.env.DATABASE_URL = databaseUrl!
    process.env.AGENT_WEB_URL = "http://scheduled-audit-fixture.invalid"
    process.env.AGENT_WORKER_SECRET = "scheduled-audit-fixture-secret"
  })
  afterEach(async () => {
    await stopRunner()
    vi.doUnmock(scheduledGateQualityReviewPath)
    vi.doUnmock(scheduledModelRouterPath)
    vi.doUnmock(scheduledEntitlementsPath)
    vi.resetModules()
  })
  afterAll(async () => {
    if (pool && fixtureUsers.length) await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUsers])
    if (disconnectWebDatabase) await disconnectWebDatabase().catch(() => undefined)
    await pool?.end()
    restoreEnv("DATABASE_URL", priorDatabaseUrl)
    restoreEnv("AGENT_WEB_URL", priorAgentWebUrl)
    restoreEnv("AGENT_WORKER_SECRET", priorWorkerSecret)
  })

  it("replays one Audit child across a Worker restart and releases root only with its private current-attempt proof", async () => {
    const fixture = await createScheduledGatePrepareFixture(pool!, redisUrl!, { jobCount: 1 })
    fixtureUsers.push(fixture.ids.userId)
    await seedScheduledAuditAgentConfig(fixture)
    const command = createPgTaskGraphCommandPort(pool as never), waitPort = createPgDurableWaitPort(pool!)
    const turnOwner = fixture.turnExecutionOwner as TurnExecutionOwnerFence
    const stepId = await startRootStep(fixture, turnOwner)
    const scope = { ...fixture.graphScope, stepId, turnLeaseOwner: fixture.owner.turnLeaseOwnerId,
      turnLeaseVersion: fixture.owner.turnLeaseVersion, parentLeaseOwner: fixture.owner.turnLeaseOwnerId,
      parentAttemptCount: fixture.owner.rootAttemptCount }
    const response = await setupFetcher(fixture)
    const continuation = createScheduledAutomationGateContinuation({ pool: pool as never, commandPort: command,
      waitPort, nativeQuestionWaitEnabled: false, fetcher: response.fetcher })
    const input = { owner: fixture.owner, executionOwner: turnOwner, attestation: fixture.attestation,
      handoff: fixture.handoff, prepareProof: fixture.prepareProof, scheduledWaitId: fixture.prepareChoiceWaitId,
      finalStepId: stepId, signal: new AbortController().signal }

    await expect(continuation(input)).resolves.toMatchObject({ status: "waiting_for_dependency" })
    const gateTaskId = await findTaskId("scheduled_taskgraph_gate", fixture.ids.rootTaskId)
    runner = startRunner(fixture, response.fetcher)
    await expect(dispatchAndWait(runner, gateTaskId, fixture.ids.sessionId)).resolves.toMatchObject({ status: "completed" })
    expect(response.gateCalls()).toBe(1)

    const gateProof = await requireGateProof(fixture)
    const auditWait = await continuation(input)
    expect(auditWait.status).toBe("waiting_for_dependency")
    const auditTaskId = await findTaskId(SCHEDULED_AUDIT_TASK_TYPE, fixture.ids.rootTaskId)
    const appended = await command.appendScheduledAudit!({ scope, executionOwner: fixture.executionOwner, handoff: fixture.handoff,
      attestation: fixture.attestation, gateProof, scheduledWaitId: fixture.prepareChoiceWaitId })
    expect(appended).toMatchObject({ status: "duplicate", auditTaskId, expectedAttemptCount: 1 })
    expect((await graphCount(fixture)).auditNodes).toBe(1)
    expect(await requireGateProof(fixture)).toEqual(gateProof)

    const firstTaskOutcome = await dispatchAndWait(runner, auditTaskId, fixture.ids.sessionId)
    expect(firstTaskOutcome).toMatchObject({ status: "retrying" })
    expect(response.executeCalls()).toBe(1)
    const firstHttpResponse = response.firstExecuteResponse()
    expect(firstHttpResponse).toBeDefined()
    expect(firstHttpResponse?.status).toBe(200)
    expect(Object.keys(firstHttpResponse?.body ?? {}).sort()).toEqual(["report", "status"])
    expect(firstHttpResponse?.body.status).toBe("completed")
    expect(firstHttpResponse?.body.report).toEqual(response.report())
    expect(response.report()).toMatchObject({ processed: fixture.preparedJobIds.length, pending: fixture.preparedJobIds.length })
    const firstExecutionState = await readExecutionState(fixture)
    expect(firstExecutionState.status).toBe("completed")
    expect(firstExecutionState.state.report).toEqual(response.report())
    await stopRunner()
    const queued = await taskState(auditTaskId)
    expect(queued).toMatchObject({ status: "queued", attemptCount: 1, result: null })

    const retryWait = await continuation(input)
    expect(retryWait.status).toBe("waiting_for_dependency")
    expect(await requireGateProof(fixture)).toEqual(gateProof)
    const retryReceipt = await command.appendScheduledAudit!({ scope, executionOwner: fixture.executionOwner, handoff: fixture.handoff,
      attestation: fixture.attestation, gateProof, scheduledWaitId: fixture.prepareChoiceWaitId })
    expect(retryReceipt).toMatchObject({ status: "duplicate", auditTaskId, expectedAttemptCount: 2 })
    runner = startRunner(fixture, response.fetcher)
    await expect(dispatchAndWait(runner, auditTaskId, fixture.ids.sessionId)).resolves.toMatchObject({ status: "completed" })
    expect(response.executeCalls()).toBe(2)
    expect(response.replayedExecuteRequest()).toEqual(response.firstExecuteRequest())
    expect(response.replayedExecuteResponse()).toEqual(firstHttpResponse)
    expect(await readExecutionState(fixture)).toEqual(firstExecutionState)

    const completed = await taskState(auditTaskId)
    expect(completed).toMatchObject({ status: "completed", attemptCount: 2 })
    expect(completed.result).toEqual({
      finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: response.report(),
    })
    const proofInput = { scope: { ...fixture.graphScope, turnLeaseOwner: fixture.owner.turnLeaseOwnerId,
      turnLeaseVersion: fixture.owner.turnLeaseVersion, parentLeaseOwner: fixture.owner.turnLeaseOwnerId,
      parentAttemptCount: fixture.owner.rootAttemptCount }, executionOwner: fixture.executionOwner,
      gateProof, auditTaskId, attemptCount: 2 }
    const privateProof = await command.verifyScheduledAuditCompletion!(proofInput)
    expect(privateProof).toMatchObject({ owner: expect.objectContaining({ executionId: fixture.executionOwner.executionId }),
      audit: { taskId: auditTaskId, attemptCount: 2 }, report: response.report() })
    expect(privateProof?.report).toEqual(response.report())
    await expect(command.verifyScheduledAuditCompletion!({ ...proofInput, attemptCount: 1 })).resolves.toBeNull()

    const graph = await loadTaskGraph(pool as never, fixture.graphScope, false)
    const auditNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
    expect(auditNode?.verificationDisposition).toBe("legacy_unverified")
    const generic = await verifyCompletedTaskGraphNodeEvidence({ query: async () => { throw new Error("unverified Audit must not reach generic evidence queries") } } as never, {
      scope: { ...fixture.graphScope, taskId: auditTaskId, attemptCount: 2 }, snapshot: graph.snapshot!, node: auditNode!,
      structuredResult: response.report(),
    })
    expect(generic.verified).toBe(false)
    expect(generic.report.status).not.toBe("passed")

    const replay = await command.appendScheduledAudit!({ scope, executionOwner: fixture.executionOwner, handoff: fixture.handoff,
      attestation: fixture.attestation, gateProof, scheduledWaitId: fixture.prepareChoiceWaitId })
    expect(replay).toMatchObject({ status: "duplicate", auditTaskId, expectedAttemptCount: 2 })
    expect((await graphCount(fixture)).auditNodes).toBe(1)
    await expect(continuation(input)).resolves.toMatchObject({ status: "completed" })
  }, 600_000)
})

function startRunner(fixture: Fixture, fetcher: typeof fetch): Runner {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100 })
  const queueName = `scheduled-audit-${randomUUID()}`
  const queue = new Queue<SubagentJobPayload>(queueName, { connection: redis.duplicate(), skipVersionCheck: true })
  const manager = new AgentTreeManager(new PgSubagentTaskStore(pool as never))
  const gate = createScheduledGateChildExecutor({ pool: pool as never, fetcher,
    loadInvocation: async () => ({ owner: fixture.owner, attestation: fixture.attestation, prepareProof: fixture.prepareProof,
      scheduledWaitId: fixture.prepareChoiceWaitId }), loadChoices: async () => ({ validatedChoice: null, priorChoices: [] }) })
  const audit = createScheduledAuditChildExecutor({ pool: pool as never, fetcher })
  const execute: SubagentExecutor = input => input.lease.taskType === SCHEDULED_AUDIT_TASK_TYPE
    ? audit({ lease: input.lease }) : gate({ lease: input.lease })
  const worker = new Worker<SubagentJobPayload, unknown>(queueName, async job => {
    const identity = parseSubagentDispatchJobId(job.id, job.data.taskId)
    if (!identity) throw new Error("scheduled Audit dispatch identity invalid")
    return runSubagentQueueJob(pool as never, manager, execute, job.data, identity)
  }, { connection: redis.duplicate(), concurrency: 1, skipVersionCheck: true })
  const active = { worker, redis, queue }
  runner = active
  return active
}

async function dispatchAndWait(active: Runner, taskId: string, sessionId: string): Promise<unknown> {
  const finished = waitForTask(active.worker, taskId)
  expect(await dispatchPendingSubagentOutbox(pool as never, active.queue, 10, sessionId)).toBe(1)
  return finished
}
function waitForTask(worker: Worker<SubagentJobPayload, unknown>, taskId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`scheduled Audit child timed out: ${taskId}`)), 60_000)
    const cleanup = () => { clearTimeout(timer); worker.off("completed", complete); worker.off("failed", failed) }
    const done = (error?: Error, value?: unknown) => { cleanup(); error ? reject(error) : resolve(value) }
    const complete = (job: Job<SubagentJobPayload, unknown>) => { if (job.data.taskId === taskId) done(undefined, job.returnvalue) }
    const failed = (job: Job<SubagentJobPayload, unknown> | undefined, error: Error) => { if (job?.data.taskId === taskId) done(error) }
    worker.on("completed", complete); worker.on("failed", failed)
  })
}
async function stopRunner(): Promise<void> {
  if (!runner) return
  const active = runner; runner = undefined
  await active.worker.close().catch(() => undefined)
  await active.queue.obliterate({ force: true }).catch(() => undefined)
  await active.queue.close().catch(() => undefined)
  await active.redis.quit().catch(() => active.redis.disconnect())
}
async function setupFetcher(fixture: Fixture) {
  vi.doMock(scheduledGateQualityReviewPath, () => ({ reviewApplicationQuality: async () => ({ kind: "unavailable" }) }))
  vi.doMock(scheduledModelRouterPath, () => ({ APPLYMATE_BACKING: "fixture",
    loadUserAiConfig: async () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-audit-route" }),
    resolveConfig: () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-audit-route" }) }))
  vi.doMock(scheduledEntitlementsPath, () => ({ isFeatureAllowed: async () => true,
    hasEffectiveEntitlement: async () => true, resolveAiAccess: async () => "available" }))
  const route = await vi.importActual<ScheduledPipelineRoute>(scheduledPipelineRoutePath)
  const webDb = await vi.importActual<{ db: { $disconnect(): Promise<void> } }>(scheduledWebDbPath)
  disconnectWebDatabase = () => webDb.db.$disconnect()
  let loseFirstExecuteResponse = true, gates = 0, executes = 0
  let firstExecute: ExecuteHttpResponse | undefined
  let replayedExecute: ExecuteHttpResponse | undefined
  let firstExecuteRequest: Record<string, unknown> | undefined
  let replayedExecuteRequest: Record<string, unknown> | undefined
  const fetcher: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init)
    const body = await request.clone().json() as Record<string, unknown>
    expect(request.method).toBe("POST")
    expect(request.headers.get("x-agent-worker-secret")).toBe("scheduled-audit-fixture-secret")
    const response = await route.POST(request)
    if (body.action === "gate") {
      gates += 1
      return response
    }
    if (body.action !== "execute") throw new Error("scheduled Audit action invalid")
    executes += 1
    expect(body).toMatchObject({ owner: fixture.owner, attestation: fixture.attestation, prepareProof: fixture.prepareProof,
      scheduledWaitId: fixture.prepareChoiceWaitId, gateCompletionProof: expect.objectContaining({ gate: expect.objectContaining({ taskId: expect.any(String) }) }) })
    const payload = await response.clone().json() as Record<string, unknown>
    const completed = { status: response.status, body: payload }
    assertExactExecuteResponse(completed)
    if (loseFirstExecuteResponse) {
      loseFirstExecuteResponse = false
      firstExecuteRequest = body
      firstExecute = completed
      throw new Error("scheduled_pipeline_handoff_unavailable")
    }
    replayedExecuteRequest = body
    expect(replayedExecuteRequest).toEqual(firstExecuteRequest)
    expect(completed).toEqual(firstExecute)
    replayedExecute = completed
    return response
  }
  return {
    fetcher,
    gateCalls: () => gates,
    executeCalls: () => executes,
    firstExecuteRequest: () => firstExecuteRequest,
    replayedExecuteRequest: () => replayedExecuteRequest,
    firstExecuteResponse: () => firstExecute,
    replayedExecuteResponse: () => replayedExecute,
    report: () => {
      const report = parseScheduledAuditReport(firstExecute?.body.report)
      if (!report) throw new Error("scheduled Audit route report missing")
      return report
    },
  }
}

function assertExactExecuteResponse(value: ExecuteHttpResponse): void {
  expect(value.status).toBe(200)
  expect(Object.keys(value.body).sort()).toEqual(["report", "status"])
  expect(value.body.status).toBe("completed")
  expect(parseScheduledAuditReport(value.body.report)).not.toBeNull()
}

async function seedScheduledAuditAgentConfig(fixture: Fixture): Promise<void> {
  await pool!.query(`INSERT INTO "AgentConfig" ("id", "userId", "targetLocations", "targetRoles", "excludeCompanies", "priorityCompanies", "updatedAt")
      VALUES ($1, $2, ARRAY['Dublin']::text[], ARRAY['Software Engineer']::text[], ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)
      ON CONFLICT ("userId") DO NOTHING`, [`scheduled-audit-agent-config-${fixture.ids.turnId}`, fixture.ids.userId])
}

async function readExecutionState(fixture: Fixture): Promise<{ status: string; state: Record<string, unknown> }> {
  const result = await pool!.query<{ status: string; state: Record<string, unknown> }>(
    `SELECT "status", "state" FROM "agent_executions" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3`,
    [fixture.executionOwner.executionId, fixture.ids.userId, fixture.ids.sessionId])
  if (result.rows.length !== 1 || !result.rows[0]) throw new Error("scheduled Audit execution missing")
  return result.rows[0]
}

async function requireGateProof(fixture: Fixture) {
  const command = createPgTaskGraphCommandPort(pool as never)
  const proof = await command.verifyScheduledGateCompletion!({ scope: { ...fixture.graphScope,
    turnLeaseOwner: fixture.owner.turnLeaseOwnerId, turnLeaseVersion: fixture.owner.turnLeaseVersion,
    parentLeaseOwner: fixture.owner.turnLeaseOwnerId, parentAttemptCount: fixture.owner.rootAttemptCount },
    executionOwner: fixture.executionOwner, prepareProof: fixture.prepareProof })
  if (!proof) throw new Error("scheduled Audit fixture Gate proof missing")
  return proof
}
async function startRootStep(fixture: Fixture, owner: TurnExecutionOwnerFence): Promise<string> {
  const turnStore = createPgTurnEngineStore(pool as never)
  const ordinal = Number((await pool!.query(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS ordinal FROM "agent_steps" WHERE "turnId"=$1 AND "sessionId"=$2`,
    [fixture.ids.turnId, fixture.ids.sessionId])).rows[0]?.ordinal)
  const stepId = `scheduled-audit-root-step-${randomUUID()}`
  await turnStore.startStep({ owner, stepId, ordinal, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [],
    modelProfileSnapshot: { provider: "fixture", model: "scheduled-audit-root" }, now: new Date() })
  return stepId
}
async function findTaskId(taskType: string, rootTaskId: string): Promise<string> {
  const rows = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "rootTaskId"=$1 AND "taskType"=$2`, [rootTaskId, taskType])
  if (rows.rows.length !== 1) throw new Error(`scheduled Audit task identity invalid: ${taskType}`)
  return rows.rows[0]!.id
}
async function taskState(taskId: string): Promise<Record<string, unknown>> {
  const row = (await pool!.query(`SELECT "status", "attemptCount", "result", "failureReason" FROM "sub_agent_tasks" WHERE "id"=$1`, [taskId])).rows[0]
  if (!row) throw new Error("scheduled Audit task missing")
  return row as Record<string, unknown>
}
async function graphCount(fixture: Fixture): Promise<{ auditNodes: number }> {
  const loaded = await loadTaskGraph(pool as never, fixture.graphScope, false)
  return { auditNodes: loaded.snapshot?.nodes.filter(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID).length ?? 0 }
}
function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value }
function dedicatedDisposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Scheduled Audit PostgreSQL integration requires the disposable CI service URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres"
    || url.password !== "postgres" || url.pathname !== "/applymate_agent_brain_ci" || url.search || url.hash) {
    throw new Error("Scheduled Audit PostgreSQL integration requires the dedicated disposable CI service URL")
  }
  return value
}
function dedicatedDisposableRedisUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1") {
    if (required) throw new Error("Scheduled Audit Redis integration requires the dedicated disposable CI service URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "redis:" || url.hostname !== "127.0.0.1" || url.port !== "6379" || url.username || url.password
    || url.pathname !== "/15" || url.search || url.hash) throw new Error("Scheduled Audit Redis integration requires disposable DB 15")
  return value
}
