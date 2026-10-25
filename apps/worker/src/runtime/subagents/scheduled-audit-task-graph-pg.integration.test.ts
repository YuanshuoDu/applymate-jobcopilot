import { createHash, randomUUID } from "node:crypto"
import { Queue, Worker, type Job } from "bullmq"
import Redis from "ioredis"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
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
import { dispatchPendingSubagentOutbox } from "../../queue/subagent-queue.js"
import type { SubagentJobPayload } from "./types.js"
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
type GateFailureDiagnostics = Readonly<Record<string, unknown>>
const diagnosticOutcomeStatuses = new Set(["completed", "retrying", "failed", "waiting", "waiting_for_user", "interrupted", "skipped", "lease_lost"])
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
    // Keep the step that owns the persisted Prepare choice; a newer root step makes its wait proof stale.
    const stepId = fixture.rootQuestionStepId
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
    const gateOutcome = await dispatchAndWait(runner, gateTaskId, fixture.ids.sessionId)
    if (!gateOutcome || typeof gateOutcome !== "object" || !("status" in gateOutcome) || gateOutcome.status !== "completed") {
      const rawOutcomeStatus = debugRecord(gateOutcome)?.status
      const outcomeStatus = typeof rawOutcomeStatus === "string" && diagnosticOutcomeStatuses.has(rawOutcomeStatus)
        ? rawOutcomeStatus : "other"
      throw new Error(`Scheduled Gate child did not complete: ${JSON.stringify({ outcomeStatus,
        gateDiagnostics: response.gateDiagnostics() })}`)
    }
    expect(gateOutcome).toMatchObject({ status: "completed" })
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
  let gateDiagnostics: GateFailureDiagnostics | undefined
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
      const payload = await response.clone().json().catch(() => null)
      const routeBody = debugRecord(payload)
      if (response.status === 409 && routeBody?.errorCode === "scheduled_pipeline_turn_stale") {
        gateDiagnostics = await readGateFailureDiagnostics(fixture, body, request.signal.aborted, response.status, payload)
      }
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
    gateDiagnostics: () => gateDiagnostics,
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

/** Captures only redacted lock predicates while the rejected Gate lease is still live. */
async function readGateFailureDiagnostics(fixture: Fixture, requestBody: Record<string, unknown>, signalAborted: boolean,
  responseStatus: number, responsePayload: unknown): Promise<GateFailureDiagnostics> {
  const response = debugRecord(responsePayload)
  const owner = debugRecord(requestBody.owner), rootTaskId = owner?.rootTaskId, gateTaskId = requestBody.gateTaskId,
    gateLeaseOwnerId = requestBody.gateLeaseOwnerId, gateAttemptCount = requestBody.gateAttemptCount,
    suppliedWaitId = requestBody.scheduledWaitId
  const safeResponse = { responseStatus, responseErrorCode: typeof response?.errorCode === "string" ? response.errorCode : null, signalAborted }
  if (!owner || typeof owner.userId !== "string" || typeof owner.sessionId !== "string" || typeof owner.turnId !== "string"
    || typeof rootTaskId !== "string" || typeof gateTaskId !== "string" || typeof gateLeaseOwnerId !== "string"
    || !Number.isSafeInteger(gateAttemptCount) || suppliedWaitId !== undefined && typeof suppliedWaitId !== "string") {
    return { requestShapeValid: false, ...safeResponse }
  }
  try {
    const [sessionResult, turnResult, rootResult, gateResult, executionResult, stepResult] = await Promise.all([
      pool!.query<Record<string, unknown>>(`SELECT "status" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2`,
        [owner.sessionId, owner.userId]),
      pool!.query<Record<string, unknown>>(`SELECT "id", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input",
          "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
        FROM "agent_turns" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3`, [owner.turnId, owner.userId, owner.sessionId]),
      pool!.query<Record<string, unknown>>(`SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "attemptCount",
          "interruptRequestedAt", "closedAt"
        FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3`, [owner.rootTaskId, owner.sessionId, owner.turnId]),
      pool!.query<Record<string, unknown>>(`SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType",
          "status", "attemptCount", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "closedAt", "expectedOutputSchema", "allowedActions"
        FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$4`,
      [gateTaskId, owner.sessionId, owner.turnId, owner.rootTaskId]),
      pool!.query<Record<string, unknown>>(`SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"
        WHERE "userId"=$1 AND "sessionId"=$2`, [owner.userId, owner.sessionId]),
      pool!.query<Record<string, unknown>>(`SELECT "id", "taskId", "attempt", "ordinal", "status" FROM "agent_steps"
        WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 ORDER BY "ordinal" DESC LIMIT 1`,
      [owner.sessionId, owner.turnId, owner.rootTaskId]),
    ])
    const session = sessionResult.rows[0], turn = turnResult.rows[0], root = rootResult.rows[0], gate = gateResult.rows[0], execution = executionResult.rows[0],
      latestStep = stepResult.rows[0], state = debugRecord(execution?.state),
      claim = debugRecord(state?.scheduledTaskGraphClaim), continuation = debugRecord(state?.scheduledTaskGraphContinuation)
    const ownerForLock = { ...owner, executionId: execution?.id, executionAttemptCount: Number(execution?.attemptCount) }
    const turnDate = debugDate(turn?.leaseExpiresAt), gateDate = debugDate(gate?.leaseExpiresAt)
    const turnIdentityMatches = Boolean(turn && turn.id === owner.turnId && turn.userId === owner.userId
      && turn.sessionId === owner.sessionId && turn.rootTaskId === owner.rootTaskId)
    const rootIdentityMatches = Boolean(root && root.id === owner.rootTaskId && root.sessionId === owner.sessionId
      && root.turnId === owner.turnId && root.rootTaskId === owner.rootTaskId && root.parentTaskId == null
      && Number(root.attemptCount) === Number(owner.rootAttemptCount))
    const gateRpc = await vi.importActual<{
      scheduledTaskGraphGateTurnIsCurrent(value: unknown, input: { owner: unknown; mode: "gate_child" }): boolean
      scheduledTaskGraphGateTaskLeaseIsCurrent(value: unknown, input: { owner: unknown; taskId: string; leaseOwnerId: string; attemptCount: number }): boolean
    }>("@/lib/agent/scheduled-taskgraph-gate-rpc")
    const turnFenceCurrent = gateRpc.scheduledTaskGraphGateTurnIsCurrent(turn, { owner, mode: "gate_child" })
    const gateLeaseCurrent = gateRpc.scheduledTaskGraphGateTaskLeaseIsCurrent(gate, { owner, taskId: gateTaskId,
      leaseOwnerId: gateLeaseOwnerId, attemptCount: Number(gateAttemptCount) })
    const gateTaskPolicyMatches = Boolean(gate && Number(gate.depth) === 1 && gate.role === "prepare"
      && gate.taskType === "scheduled_taskgraph_gate" && gate.status === "running"
      && Number(gate.attemptCount) === Number(gateAttemptCount) && gate.leaseOwner === gateLeaseOwnerId
      && gate.interruptRequestedAt == null && gate.closedAt == null
      && debugSameJson(gate.expectedOutputSchema, { schemaVersion: "agent-harness.v2.subagent.result",
        role: "prepare", taskType: "scheduled_taskgraph_gate" }) && debugSameJson(gate.allowedActions, []))
    const pipelineFence = await vi.importActual<{
      scheduledTaskGraphContinuationKey(owner: unknown, attestation: unknown): string
    }>("@/lib/agent/scheduled-taskgraph-pipeline-checkpoint")
    const storedClaimToken = typeof claim?.claimToken === "string" ? claim.claimToken : ""
    let continuationKey: string | undefined
    try { continuationKey = pipelineFence.scheduledTaskGraphContinuationKey(ownerForLock, requestBody.attestation) }
    catch { continuationKey = undefined }
    const executionFence = await vi.importActual<{
      scheduledTaskGraphClaimMatches(state: unknown, key: string, owner: unknown, claimToken?: string): boolean
    }>("@/lib/agent/scheduled-taskgraph-pipeline-fence")
    const claimMatchesCurrent = Boolean(continuationKey && executionFence.scheduledTaskGraphClaimMatches(
      execution?.state, continuationKey, ownerForLock, storedClaimToken))
    const continuationMatchesCurrent = Boolean(continuationKey && continuation?.key === continuationKey
      && debugSameLineageOwner(continuation.owner, ownerForLock))
    const turnInput = debugRecord(turn?.input)
    const automationSnapshot = await vi.importActual<{
      parseScheduledAutomationSnapshot(value: unknown): unknown
    }>("@/lib/agent/scheduled-automation-snapshot")
    let persistedSnapshot: unknown
    try { persistedSnapshot = automationSnapshot.parseScheduledAutomationSnapshot(turnInput?.scheduledAutomationSnapshot) }
    catch { persistedSnapshot = undefined }
    const persistedSnapshotValid = turnInput?.automationRunMode === "scheduled"
      && persistedSnapshot !== undefined && persistedSnapshot !== null
    const scheduledWaitStored = state?.scheduledTaskGraphScheduledWaitId
    const scheduledWaitIdConsistent = scheduledWaitStored === undefined
      || typeof scheduledWaitStored === "string" && (suppliedWaitId === undefined || scheduledWaitStored === suppliedWaitId)
    const effectiveWaitId = scheduledWaitIdConsistent
      ? typeof scheduledWaitStored === "string" ? scheduledWaitStored : suppliedWaitId : undefined
    const snapshotRequiresApproval = debugRecord(persistedSnapshot)?.requireApproval === true
    const effectiveWaitIdValid = snapshotRequiresApproval
      ? typeof effectiveWaitId === "string" && effectiveWaitId.startsWith(`agent-question:${owner.turnId}:canonical:`)
      : effectiveWaitId === undefined
    const persistedPrepareWaitValid = persistedSnapshotValid && scheduledWaitIdConsistent && effectiveWaitIdValid
    const claimValid = Boolean(continuationKey && claim && Object.keys(claim).length === 6
      && claim.schemaVersion === "agent-harness.v2.scheduled-pipeline-claim.v1"
      && debugValidId(claim.claimToken) && claim.claimToken === storedClaimToken
      && claim.key === continuationKey && debugSameLineageOwner(claim.owner, ownerForLock)
      && typeof claim.claimedAt === "string" && Number.isFinite(Date.parse(claim.claimedAt))
      && typeof claim.leaseExpiresAt === "string" && Number.isFinite(Date.parse(claim.leaseExpiresAt)))
    const questionResult = typeof effectiveWaitId === "string"
      ? await pool!.query<Record<string, unknown>>(`SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items"
          WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3`,
        [`agent-wait:question:${effectiveWaitId}`, owner.sessionId, owner.turnId])
      : null
    const question = questionResult?.rows[0]
    const gateInput = await vi.importActual<{
      scheduledTaskGraphAnalyzeCheckpointForGate(state: unknown): unknown
      isScheduledTaskGraphGateProofCurrent(input: Record<string, unknown>, tx: unknown): Promise<boolean>
    }>("@/lib/agent/scheduled-taskgraph-gate-input")
    const gateCheckpoint = await vi.importActual<{
      scheduledTaskGraphAnalyzeCheckpointDigest(value: unknown): string | null
      parseScheduledTaskGraphPrepareProof(value: unknown): null | {
        graphRevision: number
        nodes: [{ attemptCount: number }, { attemptCount: number }, { attemptCount: number }]
        result: { snapshotDigest: string; checkpointDigest: string; jobs: Array<{ jobId: string; status: string }> }
      }
    }>("@/lib/agent/scheduled-taskgraph-gate-checkpoint")
    const gateHistory = await vi.importActual<{
      scheduledTaskGraphGateBindingIsCurrent(input: {
        reader: unknown; owner: unknown; marker: Record<string, unknown>; checkpointDigest: string; proof: unknown
        gate: { taskId: string; attemptCount: number; phase: "running" }
      }): Promise<boolean>
      scheduledTaskGraphGateHistoryIsCurrent(input: {
        reader: unknown; owner: unknown; prepareGraphRevision: number; prepareAttemptCount: number
        graphRevision: number; graphContent: unknown
        gateTask: { id: string; status: string; attemptCount: number; maxAttempts: number; result: unknown }
        gate: { taskId: string; attemptCount: number; phase: "running" }; expectedJobIds: readonly string[]
      }): Promise<boolean>
    }>("@/lib/agent/scheduled-taskgraph-gate-history")
    type GateProofDebugReader = {
      agentItem: { findFirst(args: unknown): Promise<{ revision: number; content: unknown } | null> }
      subAgentTask: { findFirst(args: unknown): Promise<{
        id: string; status: string; attemptCount: number; maxAttempts: number; result: unknown
      } | null> }
    }
    const webDb = await vi.importActual<{ db: { $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> } }>(scheduledWebDbPath)
    const analyzeCheckpoint = gateInput.scheduledTaskGraphAnalyzeCheckpointForGate(execution?.state)
    const gateProofDiagnostics = await webDb.db.$transaction(async tx => {
      const checkpointRecord = debugRecord(analyzeCheckpoint)
      const marker = debugRecord(checkpointRecord?.scheduledTaskGraphContinuation)
      const checkpointDigest = analyzeCheckpoint
        ? gateCheckpoint.scheduledTaskGraphAnalyzeCheckpointDigest(analyzeCheckpoint) : null
      const parsedProof = gateCheckpoint.parseScheduledTaskGraphPrepareProof(requestBody.prepareProof)
      const prepareProofMatchesCheckpoint = Boolean(parsedProof && marker && checkpointDigest
        && parsedProof.result.snapshotDigest === marker.snapshotDigest
        && parsedProof.result.checkpointDigest === checkpointDigest)
      const gate = { taskId: gateTaskId, attemptCount: Number(gateAttemptCount), phase: "running" as const }
      const gateBindingEvaluated = Boolean(persistedSnapshotValid && analyzeCheckpoint && marker && checkpointDigest
        && parsedProof && prepareProofMatchesCheckpoint)
      let gateBindingCurrent = false
      let gateBindingError = false
      if (gateBindingEvaluated && parsedProof && marker && checkpointDigest) {
        try {
          gateBindingCurrent = await gateHistory.scheduledTaskGraphGateBindingIsCurrent({ reader: tx, owner: ownerForLock,
            marker, checkpointDigest, proof: parsedProof, gate })
        } catch { gateBindingError = true }
      }
      let gateHistoryCurrent: boolean | null = null
      let gateHistoryError = false
      if (gateBindingCurrent && parsedProof) {
        const reader = tx as GateProofDebugReader
        const graphId = `task-graph-${createHash("sha256").update(rootTaskId).digest("hex")}`
        const [graph, historyGateTask] = await Promise.all([
          reader.agentItem.findFirst({ where: { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId,
            taskId: owner.rootTaskId, type: "task_graph", session: { is: { userId: owner.userId } },
            turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } }, select: { revision: true, content: true } }),
          reader.subAgentTask.findFirst({ where: { id: gateTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
            rootTaskId: owner.rootTaskId, session: { is: { userId: owner.userId } } },
            select: { id: true, status: true, attemptCount: true, maxAttempts: true, result: true } }),
        ])
        gateHistoryCurrent = Boolean(graph && historyGateTask)
        if (graph && historyGateTask) {
          try {
            gateHistoryCurrent = await gateHistory.scheduledTaskGraphGateHistoryIsCurrent({
              reader: tx, owner: ownerForLock, prepareGraphRevision: parsedProof.graphRevision,
              prepareAttemptCount: parsedProof.nodes[2].attemptCount, graphRevision: graph.revision, graphContent: graph.content,
              gateTask: historyGateTask, gate, expectedJobIds: parsedProof.result.jobs
                .filter(job => job.status === "prepared").map(job => job.jobId),
            })
          } catch { gateHistoryCurrent = false; gateHistoryError = true }
        }
      }
      const gateProofCurrent = Boolean(persistedSnapshotValid && analyzeCheckpoint
        && await gateInput.isScheduledTaskGraphGateProofCurrent({ owner: ownerForLock, snapshot: persistedSnapshot,
          analyzeCheckpoint, analyzeAttestation: requestBody.attestation, prepareProof: requestBody.prepareProof, gate }, tx))
      return { prepareProofParsed: Boolean(parsedProof), analyzeCheckpointDigestPresent: Boolean(checkpointDigest),
        prepareProofMatchesCheckpoint, gateBindingEvaluated, gateBindingCurrent,
        gateBindingError, gateHistoryEvaluated: gateHistoryCurrent !== null, gateHistoryCurrent, gateHistoryError, gateProofCurrent }
    })
    const prepareWait = await vi.importActual<{
      validateScheduledPrepareWaitIdentity(input: { owner: unknown; snapshot: unknown; proof: unknown; scheduledWaitId?: string }): Promise<boolean>
    }>("@/lib/agent/scheduled-taskgraph-run-service")
    const prepareWaitIdentityValid = persistedPrepareWaitValid && await prepareWait.validateScheduledPrepareWaitIdentity({ owner: ownerForLock,
      snapshot: persistedSnapshot, proof: requestBody.prepareProof,
      ...(effectiveWaitId !== undefined ? { scheduledWaitId: effectiveWaitId } : {}) })
    const questionContent = debugRecord(question?.content)
    const attestation = debugRecord(requestBody.attestation), scout = debugRecord(attestation?.scout), candidateIds = scout?.candidateJobIds
    const candidateIdsValid = Array.isArray(candidateIds) && candidateIds.length <= 100
      && candidateIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id)
      && new Set(candidateIds).size === candidateIds.length
    const ownedJobRows = candidateIdsValid
      ? await pool!.query<{ id: string }>(`SELECT "id" FROM "Job" WHERE "userId"=$1 AND "id" = ANY($2::text[])`,
        [owner.userId, candidateIds]) : null
    const candidateJobsMatch = Boolean(candidateIdsValid && ownedJobRows && ownedJobRows.rows.length === candidateIds.length
      && new Set(ownedJobRows.rows.map(row => row.id)).size === candidateIds.length)
    return {
      ...safeResponse,
      session: { rowPresent: Boolean(session), status: session?.status ?? null,
        available: Boolean(session && !["aborted", "archived"].includes(String(session.status))) },
      turn: { identityMatches: turnIdentityMatches, sourceMatches: turn?.source === "automation",
        modeMatches: turn?.executionMode === "canonical_task_graph", snapshotValid: persistedSnapshotValid, status: turn?.status ?? null,
        leaseVersion: Number.isSafeInteger(turn?.leaseVersion) ? Number(turn?.leaseVersion) : null,
        leaseOwnerMatchesRequest: turn?.leaseOwnerId === owner.turnLeaseOwnerId,
        leaseUnexpired: Number.isFinite(turnDate) && turnDate > Date.now(), gateChildFenceCurrent: turnFenceCurrent },
      root: { identityMatches: rootIdentityMatches, status: root?.status ?? null,
        attemptCount: Number.isSafeInteger(root?.attemptCount) ? Number(root?.attemptCount) : null,
        interruptRequested: root?.interruptRequestedAt != null, closed: root?.closedAt != null },
      gate: { identityMatches: Boolean(gate && gate.id === gateTaskId && gate.sessionId === owner.sessionId
          && gate.turnId === owner.turnId && gate.rootTaskId === owner.rootTaskId && gate.parentTaskId === owner.rootTaskId),
        depth: Number.isSafeInteger(gate?.depth) ? Number(gate?.depth) : null, status: gate?.status ?? null,
        attemptCount: Number.isSafeInteger(gate?.attemptCount) ? Number(gate?.attemptCount) : null,
        leaseOwnerMatchesRequest: gate?.leaseOwner === gateLeaseOwnerId,
        leaseUnexpired: Number.isFinite(gateDate) && gateDate > Date.now(), taskPolicyMatches: gateTaskPolicyMatches,
        exactChildFenceCurrent: gateLeaseCurrent },
      execution: { rowPresent: Boolean(execution), status: execution?.status ?? null,
        attemptCount: Number.isSafeInteger(execution?.attemptCount) ? Number(execution?.attemptCount) : null,
        nextStage: typeof state?.nextStage === "string" ? state.nextStage : null,
        stageAllowsGateAction: ["gate", "execute", "audit"].includes(String(state?.nextStage)),
        stageIsGate: state?.nextStage === "gate",
        scheduledWaitIdConsistent, effectiveWaitIdPresent: typeof effectiveWaitId === "string",
        persistedPrepareWaitValid,
        claimPresent: Boolean(claim), claimValid, claimMatchesCurrent, continuationMatchesCurrent,
        claimLeaseUnexpired: Boolean(claim && typeof claim.leaseExpiresAt === "string" && Date.parse(claim.leaseExpiresAt) > Date.now()) },
      prepareWait: { identityValid: prepareWaitIdentityValid, itemPresent: Boolean(question), type: question?.type ?? null,
        status: question?.status ?? null, latestRootStepStatus: latestStep?.status ?? null,
        latestRootStepOrdinal: Number.isSafeInteger(latestStep?.ordinal) ? Number(latestStep?.ordinal) : null,
        latestRootStepAttempt: Number.isSafeInteger(latestStep?.attempt) ? Number(latestStep?.attempt) : null,
        latestStepMatchesQuestionStep: Boolean(latestStep && question && latestStep.id === question.stepId
          && latestStep.id === fixture.rootQuestionStepId),
        questionTaskMatchesRoot: question?.taskId === owner.rootTaskId,
        questionAnswered: typeof questionContent?.answeredAt === "string",
        answerAvailable: questionContent?.answerAvailable === true },
      jobs: { candidateIdsValid, candidateCount: candidateIdsValid ? candidateIds.length : null, candidateJobsMatch },
      gateProof: gateProofDiagnostics,
    }
  } catch {
    return { ...safeResponse, diagnosticsUnavailable: true }
  }
}

function debugRecord(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function debugDate(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
}
function debugSameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(debugCanonical(left)) === JSON.stringify(debugCanonical(right)) } catch { return false }
}
function debugCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(debugCanonical)
  const row = debugRecord(value)
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, debugCanonical(row[key])])) : value
}
function debugValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function debugSameLineageOwner(value: unknown, owner: Record<string, unknown>): boolean {
  const row = debugRecord(value)
  return Boolean(row && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => row[key] === owner[key]))
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
async function findTaskId(taskType: string, rootTaskId: string): Promise<string> {
  const rows = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "rootTaskId"=$1 AND "taskType"=$2`, [rootTaskId, taskType])
  if (rows.rows.length !== 1) throw new Error(`scheduled Audit task identity invalid: ${taskType}`)
  return rows.rows[0]!.id
}
async function taskState(taskId: string): Promise<{ status: string; attemptCount: number; result: unknown }> {
  const row = (await pool!.query<{ status: string; attemptCount: number; result: unknown }>(
    `SELECT "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id"=$1`, [taskId])).rows[0]
  if (!row) throw new Error("scheduled Audit task missing")
  return row
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
