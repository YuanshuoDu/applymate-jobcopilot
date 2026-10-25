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
type GateHttpFailure = Readonly<{ status: number; errorCode: string | null; testDiagnostic: Readonly<{
  phase: string | null; errorClass: string | null; prismaCode: string | null; safeErrorCode: string | null
}> }>
type ExecuteHttpFailure = Readonly<{ status: number; errorCode: string | null; keys: readonly string[]; reportValid: boolean;
  executionStatus?: string | null; executionCheckpoint?: string | null; executionNextStage?: string | null;
  hasExecutionError?: boolean; executionErrorCode?: string | null; pipelineOutcome?: string;
  continuation?: Readonly<{ gateResume: string; analyzeCheckpoint: string; continuationKey: string; waitBinding: string;
    ownerCurrentRecheck: string; prepareWait: string; gateInputRecheck: string; gateProofCurrent: string;
    gateHandoff: string; claimLease: string; storedStage: string; completionProof: string; completionPrepareProof: string;
    preparedArtifactRefs: string; gateDecisions: string; persistedGateDecisions: string; gateOutput: string;
    serializedCheckpoint: string; checkpointSave: string }> }>
type GateHistoryProbeRow = Readonly<{ actor: string | null; taskId: string | null; idempotencyKey: string | null; sequence: bigint; payload: unknown }>
const diagnosticOutcomeStatuses = new Set(["completed", "retrying", "failed", "waiting", "waiting_for_user", "interrupted", "skipped", "lease_lost"])
const diagnosticGateErrorCodes = new Set([
  "scheduled_pipeline_account_unavailable", "scheduled_pipeline_agent_unavailable", "scheduled_pipeline_ai_budget_exhausted",
  "scheduled_pipeline_ai_unavailable", "scheduled_pipeline_analysis_interrupted", "scheduled_pipeline_attestation_invalid",
  "scheduled_pipeline_claim_conflict", "scheduled_pipeline_discovery_incomplete", "scheduled_pipeline_entitlement_required",
  "scheduled_pipeline_execution_failed", "scheduled_pipeline_execution_mismatch", "scheduled_pipeline_gate_proof_invalid",
  "scheduled_pipeline_jobs_mismatch", "scheduled_pipeline_mode_mismatch", "scheduled_pipeline_owner_mismatch",
  "scheduled_pipeline_request_invalid", "scheduled_pipeline_resume_unavailable", "scheduled_pipeline_snapshot_mismatch",
  "scheduled_pipeline_turn_stale", "scheduled_pipeline_unauthorized",
])
const diagnosticWorkerErrorCodes = new Set([
  ...diagnosticGateErrorCodes, "scheduled_gate_analyze_proof_invalid", "scheduled_gate_completion_unverified",
  "scheduled_gate_graph_invalid", "scheduled_gate_handoff_retryable", "scheduled_gate_owner_stale",
  "scheduled_gate_prepare_proof_invalid", "scheduled_gate_registration_invalid", "scheduled_gate_runtime_failed",
  "scheduled_gate_task_invalid", "scheduled_gate_wait_invalid",
])
const diagnosticGateSafeErrorCodes = new Set([
  "scheduled_taskgraph_gate_result_invalid", "application_review_session_scope_required",
])
const diagnosticAuditFailureReasons = new Set([
  "scheduled_audit_analyze_proof_invalid", "scheduled_audit_cancelled", "scheduled_audit_checkpoint_invalid",
  "scheduled_audit_continuation_unsupported", "scheduled_audit_gate_registration_invalid", "scheduled_audit_graph_invalid",
  "scheduled_audit_handoff_retryable", "scheduled_audit_invocation_proof_invalid", "scheduled_audit_owner_stale",
  "scheduled_audit_prepare_proof_invalid", "scheduled_audit_report_invalid", "scheduled_audit_runtime_failed",
  "scheduled_audit_task_invalid", "scheduled_audit_wait_unsupported",
  ...diagnosticGateErrorCodes,
  "scheduled_pipeline_agent_unavailable", "scheduled_pipeline_gate_checkpoint_missing", "scheduled_pipeline_gate_checkpoint_unexpected",
  "scheduled_pipeline_gate_input_invalid", "scheduled_pipeline_gate_response_invalid", "scheduled_pipeline_handoff_in_progress",
  "scheduled_pipeline_handoff_input_invalid", "scheduled_pipeline_handoff_response_invalid", "scheduled_pipeline_handoff_retryable",
  "scheduled_pipeline_handoff_unavailable", "scheduled_pipeline_resume_unavailable", "scheduled_pipeline_root_mismatch",
  "scheduled_pipeline_wait_identity_mismatch",
])
const scheduledPipelineRoutePath = "@/app/api/internal/agent-runtime/scheduled-pipeline/route"
const scheduledRunServicePath = "@/lib/agent/run-service"
const scheduledTaskGraphRunServicePath = "@/lib/agent/scheduled-taskgraph-run-service"
const scheduledTaskGraphFencePath = "@/lib/agent/scheduled-taskgraph-pipeline-fence"
const scheduledTaskGraphGateInputPath = "@/lib/agent/scheduled-taskgraph-gate-input"
const scheduledTaskGraphGateCheckpointPath = "@/lib/agent/scheduled-taskgraph-gate-checkpoint"
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
    vi.doUnmock(scheduledRunServicePath)
    vi.doUnmock(scheduledTaskGraphRunServicePath)
    vi.doUnmock(scheduledTaskGraphFencePath)
    vi.doUnmock(scheduledTaskGraphGateInputPath)
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

    const initialGateWait = await continuation(input)
    expect(initialGateWait.status).toBe("waiting_for_dependency")
    if (initialGateWait.status !== "waiting_for_dependency") throw new Error("scheduled Audit Gate wait missing")
    const gateTaskId = await findTaskId("scheduled_taskgraph_gate", fixture.ids.rootTaskId)
    runner = startRunner(fixture, response.fetcher)
    const gateOutcome = await dispatchAndWait(runner, gateTaskId, fixture.ids.sessionId)
    if (!gateOutcome || typeof gateOutcome !== "object" || !("status" in gateOutcome) || gateOutcome.status !== "completed") {
      const rawOutcomeStatus = debugRecord(gateOutcome)?.status
      const outcomeStatus = typeof rawOutcomeStatus === "string" && diagnosticOutcomeStatuses.has(rawOutcomeStatus)
        ? rawOutcomeStatus : "other"
      const workerErrorCode = diagnosticWorkerErrorCode(debugRecord(gateOutcome)?.reason)
        ?? diagnosticWorkerErrorCode((await taskState(gateTaskId)).failureReason)
      const gateDiagnostics = response.gateDiagnostics()
      throw new Error(`Scheduled Gate child did not complete: ${JSON.stringify({ outcomeStatus,
        ...(workerErrorCode ? { workerErrorCode } : {}), gateHttpFailures: response.gateHttpFailures(),
        ...(gateDiagnostics ? { gateDiagnostics } : {}) })}`)
    }
    expect(gateOutcome).toMatchObject({ status: "completed" })
    expect(response.gateCalls()).toBe(1)
    const gateResolution = await waitPort.resolve({ userId: fixture.ids.userId, sessionId: fixture.ids.sessionId,
      waitId: initialGateWait.waitId })
    expect(gateResolution).not.toBeNull()
    expect(gateResolution?.status).toBe("ready")
    expect(gateResolution?.matchedTaskIds).toEqual([gateTaskId])

    const gateProof = await requireGateProof(fixture)
    const auditWait = await continuation(input)
    expect(auditWait.status).toBe("waiting_for_dependency")
    if (auditWait.status !== "waiting_for_dependency") throw new Error("scheduled Audit wait missing")
    expect(auditWait.waitId).not.toBe(initialGateWait.waitId)
    const auditTaskId = await findTaskId(SCHEDULED_AUDIT_TASK_TYPE, fixture.ids.rootTaskId)
    const appended = await command.appendScheduledAudit!({ scope, executionOwner: fixture.executionOwner, handoff: fixture.handoff,
      attestation: fixture.attestation, gateProof, scheduledWaitId: fixture.prepareChoiceWaitId })
    expect(appended).toMatchObject({ status: "duplicate", auditTaskId, expectedAttemptCount: 1 })
    expect((await graphCount(fixture)).auditNodes).toBe(1)
    expect(await requireGateProof(fixture)).toEqual(gateProof)

    const firstTaskOutcome = await dispatchAndWait(runner, auditTaskId, fixture.ids.sessionId)
    if (debugRecord(firstTaskOutcome)?.status !== "retrying") {
      const failedTask = await taskState(auditTaskId)
      const failureReason = diagnosticAuditFailureReasons.has(failedTask.failureReason ?? "")
        ? failedTask.failureReason : "other"
      throw new Error(`Scheduled Audit first attempt did not retry: ${JSON.stringify({
        status: failedTask.status, failureReason, executeCalls: response.executeCalls(), executeHttpFailures: response.executeHttpFailures(),
      })}`)
    }
    expect(firstTaskOutcome).toMatchObject({ status: "retrying" })
    expect(response.executeCalls()).toBe(1)
    const firstHttpResponse = response.firstExecuteResponse()
    if (!firstHttpResponse) throw new Error(`Scheduled Audit execute response missing: ${JSON.stringify(response.executeHttpFailures())}`)
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
  let pipelineOutcome = "not_called"
  let continuation = { gateResume: "not_called", analyzeCheckpoint: "not_checked", continuationKey: "not_checked",
    waitBinding: "not_checked", ownerCurrentRecheck: "not_checked", prepareWait: "not_checked",
    gateInputRecheck: "not_checked", gateProofCurrent: "not_checked",
    gateHandoff: "not_called", claimLease: "not_checked", storedStage: "not_checked", completionProof: "not_checked",
    completionPrepareProof: "not_checked", preparedArtifactRefs: "not_checked", gateDecisions: "not_checked",
    persistedGateDecisions: "not_checked", gateOutput: "not_checked",
    serializedCheckpoint: "not_called", checkpointSave: "not_called" }
  type GateInputProbe = {
    loadScheduledTaskGraphGateInput(input: unknown): Promise<unknown>
    scheduledTaskGraphAnalyzeCheckpointForGate(value: unknown): Record<string, unknown> | null
    isScheduledTaskGraphGateProofCurrent(input: unknown, tx: unknown): Promise<boolean>
  }
  const gateInput = await vi.importActual<GateInputProbe>(scheduledTaskGraphGateInputPath)
  type GateCheckpointProbe = { buildScheduledTaskGraphGateCheckpoint(input: unknown, now?: number): unknown }
  const gateCheckpoint = await vi.importActual<GateCheckpointProbe>(scheduledTaskGraphGateCheckpointPath)
  vi.doMock(scheduledTaskGraphGateCheckpointPath, () => ({
    ...gateCheckpoint,
    buildScheduledTaskGraphGateCheckpoint: (input: unknown, now?: number) => {
      try {
        const result = gateCheckpoint.buildScheduledTaskGraphGateCheckpoint(input, now)
        continuation.gateHandoff = result && typeof result === "object" ? "built" : "rejected"
        return result
      } catch (error) {
        continuation.gateHandoff = "rejected"
        throw error
      }
    },
  }))
  const gateRpc = await vi.importActual<{
    scheduledTaskGraphExecuteGateCompletionProof(value: unknown): Record<string, unknown> | null
  }>("@/lib/agent/scheduled-taskgraph-gate-rpc")
  const diagnosticWebDb = await vi.importActual<{
    db: { $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> }
  }>(scheduledWebDbPath)
  const continuationCheckpoint = await vi.importActual<{
    scheduledTaskGraphContinuationKey(owner: unknown, attestation: unknown): string
  }>("@/lib/agent/scheduled-taskgraph-pipeline-checkpoint")
  type ScheduledTaskGraphFenceProbe = {
    isScheduledTaskGraphOwnerCurrent(owner: unknown, key: string, claimToken: string): Promise<boolean>
    saveScheduledTaskGraphCheckpoint(input: unknown): Promise<boolean>
  }
  const taskGraphFence = await vi.importActual<ScheduledTaskGraphFenceProbe>(scheduledTaskGraphFencePath)
  vi.doMock(scheduledTaskGraphFencePath, () => ({
    ...taskGraphFence,
    saveScheduledTaskGraphCheckpoint: async (input: unknown) => {
      try {
        const saved = await taskGraphFence.saveScheduledTaskGraphCheckpoint(input)
        continuation.checkpointSave = saved ? "saved" : "rejected"
        return saved
      } catch (error) { continuation.checkpointSave = "threw"; throw error }
    },
  }))
  type ScheduledTaskGraphRunServiceProbe = {
    buildScheduledTaskGraphGateResumeState(input: unknown): Promise<unknown>
    serializeScheduledTaskGraphCheckpoint(value: unknown): unknown
    validateScheduledPrepareWaitIdentity(input: unknown): Promise<boolean>
  }
  const taskGraphRunService = await vi.importActual<ScheduledTaskGraphRunServiceProbe>(scheduledTaskGraphRunServicePath)
  vi.doMock(scheduledTaskGraphRunServicePath, () => ({
    ...taskGraphRunService,
    buildScheduledTaskGraphGateResumeState: async (input: unknown) => {
      continuation.gateHandoff = "not_called"
      continuation.claimLease = "not_checked"
      continuation.storedStage = "not_checked"
      continuation.completionProof = "not_checked"
      continuation.completionPrepareProof = "not_checked"
      continuation.preparedArtifactRefs = "not_checked"
      continuation.gateDecisions = "not_checked"
      continuation.persistedGateDecisions = "not_checked"
      continuation.gateOutput = "not_checked"
      try {
        const result = await taskGraphRunService.buildScheduledTaskGraphGateResumeState(input)
        continuation.gateResume = debugSafeEnum(debugRecord(result)?.nextStage, ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]) ?? "invalid"
        return result
      } catch (error) {
        continuation.gateResume = "threw"
        const resume = debugRecord(input), owner = resume?.owner
        if (resume && owner) {
          const persisted = debugRecord(resume.persistedCheckpoint)
          const claim = debugRecord(persisted?.scheduledTaskGraphClaim), claimExpiry = claim?.leaseExpiresAt
          const claimExpiryMs = typeof claimExpiry === "string" ? Date.parse(claimExpiry) : Number.NaN
          continuation.claimLease = !claim ? "missing"
            : !Number.isFinite(claimExpiryMs) || !(new Date(claimExpiryMs).toISOString() === claimExpiry) ? "invalid"
              : claimExpiryMs > Date.now() ? "unexpired" : "expired"
          const stageValue = persisted?.nextStage
          continuation.storedStage = debugSafeEnum(stageValue,
            ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"])
            ?? (stageValue === undefined ? "missing" : "invalid")
          const completion = gateRpc.scheduledTaskGraphExecuteGateCompletionProof(resume.gateCompletionProof)
          continuation.completionProof = completion ? "valid" : "invalid"
          continuation.completionPrepareProof = completion
            ? debugSameJson(completion.prepareProof, resume.prepareProof) ? "matches" : "mismatch" : "unavailable"
          const analyzeCheckpoint = gateInput.scheduledTaskGraphAnalyzeCheckpointForGate(resume.persistedCheckpoint)
          continuation.analyzeCheckpoint = analyzeCheckpoint ? "valid" : "invalid"
          try { continuation.continuationKey = continuationCheckpoint.scheduledTaskGraphContinuationKey(owner, resume.attestation)
            === resume.continuationKey ? "matches" : "mismatch" } catch { continuation.continuationKey = "invalid" }
          const persistedWaitId = debugRecord(resume.persistedCheckpoint)?.scheduledTaskGraphScheduledWaitId
          const approvalRequired = debugRecord(resume.snapshot)?.requireApproval === true
          continuation.waitBinding = approvalRequired
            ? persistedWaitId === undefined || persistedWaitId === resume.scheduledWaitId ? "consistent" : "mismatch"
            : persistedWaitId === undefined && resume.scheduledWaitId === undefined ? "consistent" : "mismatch"
          try {
            continuation.ownerCurrentRecheck = typeof resume.continuationKey === "string" && typeof resume.claimToken === "string"
              && await taskGraphFence.isScheduledTaskGraphOwnerCurrent(owner, resume.continuationKey, resume.claimToken) ? "current" : "rejected"
          } catch { continuation.ownerCurrentRecheck = "threw" }
          try { continuation.prepareWait = await taskGraphRunService.validateScheduledPrepareWaitIdentity({
            owner, snapshot: resume.snapshot, proof: resume.prepareProof, scheduledWaitId: resume.scheduledWaitId,
          }) ? "current" : "rejected" } catch { continuation.prepareWait = "threw" }
          const gate = debugRecord(completion?.gate)
          if (analyzeCheckpoint && completion && gate && typeof gate.taskId === "string" && Number.isSafeInteger(gate.attemptCount)) {
            const request = { owner, snapshot: resume.snapshot, analyzeCheckpoint, analyzeAttestation: resume.attestation,
              prepareProof: resume.prepareProof,
              gate: { taskId: gate.taskId, attemptCount: Number(gate.attemptCount), phase: "completed" as const,
                completionProof: resume.gateCompletionProof } }
            try { continuation.gateProofCurrent = await diagnosticWebDb.db.$transaction(tx =>
              gateInput.isScheduledTaskGraphGateProofCurrent(request, tx)) ? "current" : "rejected" }
            catch { continuation.gateProofCurrent = "threw" }
            let loaded: unknown
            try {
              loaded = await gateInput.loadScheduledTaskGraphGateInput(request)
              continuation.gateInputRecheck = loaded ? "loaded" : "rejected"
            } catch { continuation.gateInputRecheck = "threw" }
            if (loaded) {
              const loadedRecord = debugRecord(loaded), persistedArtifacts = persisted?.scheduledTaskGraphPreparedArtifacts
              const materials = loadedRecord?.materials
              continuation.preparedArtifactRefs = persistedArtifacts === undefined ? "not_present"
                : Array.isArray(materials) ? debugExactJson(persistedArtifacts, materials.map(value => {
                  const row = debugRecord(value)
                  return row ? { jobId: row.jobId, kind: row.kind, artifactRef: row.artifactRef } : null
                })) ? "matches" : "mismatch" : "unavailable"
              const gateState = debugScheduledGateOutput(loaded, persisted)
              continuation.gateDecisions = gateState.decisions
              continuation.persistedGateDecisions = gateState.persistedDecisions
              continuation.gateOutput = gateState.output
            } else {
              continuation.preparedArtifactRefs = "unavailable"
              continuation.gateDecisions = "unavailable"
              continuation.persistedGateDecisions = "unavailable"
              continuation.gateOutput = "unavailable"
            }
          }
        }
        throw error
      }
    },
    serializeScheduledTaskGraphCheckpoint: (value: unknown) => {
      const result = taskGraphRunService.serializeScheduledTaskGraphCheckpoint(value)
      const stage = debugRecord(result)?.nextStage
      continuation.serializedCheckpoint = result === null ? "rejected"
        : debugSafeEnum(stage, ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]) ?? "invalid"
      return result
    },
  }))
  type RunServiceProbe = { runAgentPipeline(input: unknown): Promise<unknown> }
  const runService = await vi.importActual<RunServiceProbe>(scheduledRunServicePath)
  vi.doMock(scheduledRunServicePath, () => ({ ...runService, runAgentPipeline: async (input: unknown) => {
    try {
      const result = await runService.runAgentPipeline(input)
      const status = debugRecord(result)?.status
      pipelineOutcome = result === null ? "returned_null" : status === "waiting_for_user" ? "returned_wait"
        : status === "gate_checkpointed" ? "returned_gate_checkpoint" : status === "analyze_checkpointed" ? "returned_analyze_checkpoint" : "returned_report"
      return result
    } catch (error) {
      pipelineOutcome = "threw"
      throw error
    }
  } }))
  const route = await vi.importActual<ScheduledPipelineRoute>(scheduledPipelineRoutePath)
  const webDb = await vi.importActual<{ db: { $disconnect(): Promise<void> } }>(scheduledWebDbPath)
  disconnectWebDatabase = () => webDb.db.$disconnect()
  let loseFirstExecuteResponse = true, gates = 0, executes = 0
  let gateDiagnostics: GateFailureDiagnostics | undefined
  const gateHttpFailures: GateHttpFailure[] = []
  const executeHttpFailures: ExecuteHttpFailure[] = []
  let firstExecute: ExecuteHttpResponse | undefined
  let replayedExecute: ExecuteHttpResponse | undefined
  let firstExecuteRequest: Record<string, unknown> | undefined
  let replayedExecuteRequest: Record<string, unknown> | undefined
  const fetcher: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init)
    const body = await request.clone().json() as Record<string, unknown>
    expect(request.method).toBe("POST")
    expect(request.headers.get("x-agent-worker-secret")).toBe("scheduled-audit-fixture-secret")
    if (body.action === "execute") {
      pipelineOutcome = "not_called"
      continuation = { gateResume: "not_called", analyzeCheckpoint: "not_checked", continuationKey: "not_checked", waitBinding: "not_checked",
        ownerCurrentRecheck: "not_checked", prepareWait: "not_checked", gateInputRecheck: "not_checked", gateProofCurrent: "not_checked",
        serializedCheckpoint: "not_called", checkpointSave: "not_called" }
    }
    const response = await route.POST(request)
    if (body.action === "gate") {
      gates += 1
      const payload = await response.clone().json().catch(() => null)
      const routeBody = debugRecord(payload)
      if ((response.status < 200 || response.status >= 300) && gateHttpFailures.length < 4) {
        gateHttpFailures.push({ status: response.status, errorCode: diagnosticGateErrorCode(routeBody?.errorCode),
          testDiagnostic: diagnosticGateFailure(routeBody?.testDiagnostic) })
      }
      if (response.status === 409 && routeBody?.errorCode === "scheduled_pipeline_turn_stale") {
        gateDiagnostics = await readGateFailureDiagnostics(fixture, body, request.signal.aborted, response.status)
      }
      return response
    }
    if (body.action !== "execute") throw new Error("scheduled Audit action invalid")
    executes += 1
    const payload = debugRecord(await response.clone().json().catch(() => null))
    const keys = payload ? Object.keys(payload).sort() : []
    const reportValid = payload !== null && parseScheduledAuditReport(payload.report) !== null
    if (!payload || response.status !== 200 || payload.status !== "completed" || keys.join(",") !== "report,status" || !reportValid) {
      const errorCode = typeof payload?.errorCode === "string" && diagnosticAuditFailureReasons.has(payload.errorCode)
        ? payload.errorCode : null
      const execution = await readExecutionFailureDiagnostic(fixture)
      executeHttpFailures.push({ status: response.status, errorCode, keys, reportValid, pipelineOutcome, continuation: { ...continuation }, ...execution })
      return response
    }
    expect(body).toMatchObject({ owner: fixture.owner, attestation: fixture.attestation, prepareProof: fixture.prepareProof,
      scheduledWaitId: fixture.prepareChoiceWaitId, gateCompletionProof: expect.objectContaining({ gate: expect.objectContaining({ taskId: expect.any(String) }) }) })
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
    gateHttpFailures: () => [...gateHttpFailures],
    executeCalls: () => executes,
    executeHttpFailures: () => [...executeHttpFailures],
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

async function readExecutionFailureDiagnostic(fixture: Fixture): Promise<Pick<ExecuteHttpFailure,
  "executionStatus" | "executionCheckpoint" | "executionNextStage" | "hasExecutionError" | "executionErrorCode">> {
  const result = await pool!.query<{ status: string; checkpoint: string | null; nextStage: string | null; error: string | null }>(
    `SELECT "status", "checkpoint", "state"->>'nextStage' AS "nextStage", "error" FROM "agent_executions"
      WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3`,
    [fixture.executionOwner.executionId, fixture.ids.userId, fixture.ids.sessionId])
  const row = result.rows[0]
  if (!row) return { executionStatus: null, executionCheckpoint: null, executionNextStage: null,
    hasExecutionError: false, executionErrorCode: null }
  return { executionStatus: debugSafeEnum(row.status, ["queued", "running", "waiting_for_user", "paused", "completed", "failed", "cancelled"]),
    executionCheckpoint: debugSafeEnum(row.checkpoint, ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]),
    executionNextStage: debugSafeEnum(row.nextStage, ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"]),
    hasExecutionError: typeof row.error === "string" && row.error.length > 0,
    executionErrorCode: typeof row.error === "string" && diagnosticAuditFailureReasons.has(row.error) ? row.error : null }
}

/** Captures only redacted lock predicates while the rejected Gate lease is still live. */
async function readGateFailureDiagnostics(fixture: Fixture, requestBody: Record<string, unknown>, signalAborted: boolean,
  responseStatus: number): Promise<GateFailureDiagnostics> {
  const owner = debugRecord(requestBody.owner), rootTaskId = owner?.rootTaskId, gateTaskId = requestBody.gateTaskId,
    gateLeaseOwnerId = requestBody.gateLeaseOwnerId, gateAttemptCount = requestBody.gateAttemptCount,
    suppliedWaitId = requestBody.scheduledWaitId
  const safeResponse = { responseStatus, signalAborted }
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
    const ownerSessionId = owner.sessionId as string, ownerTurnId = owner.turnId as string
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
        nodes: [{ attemptCount: number }, { attemptCount: number }, { taskId: string; attemptCount: number }]
        result: { snapshotDigest: string; checkpointDigest: string; jobs: Array<{ jobId: string; status: string }> }
      }
    }>("@/lib/agent/scheduled-taskgraph-gate-checkpoint")
    const gateHistory = await vi.importActual<{
      scheduledTaskGraphGateBindingIsCurrent(input: {
        reader: unknown; owner: unknown; marker: Record<string, unknown>; checkpointDigest: string; proof: unknown
        gate: { taskId: string; attemptCount: number; phase: "running" }
      }): Promise<boolean>
      scheduledTaskGraphGateHistoryIsCurrent(input: {
        reader: unknown; owner: unknown; prepareTaskId: string; prepareGraphRevision: number; prepareAttemptCount: number
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
      agentEvent: { findMany(args: unknown): Promise<GateHistoryProbeRow[]> }
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
      let gateHistoryEventSummary: Record<string, unknown> | null = null
      if (gateBindingCurrent && parsedProof) {
        const reader = tx as GateProofDebugReader
        const graphId = `task-graph-${createHash("sha256").update(rootTaskId).digest("hex")}`
        const prepareNodeHash = createHash("sha256").update("prepare").digest("hex").slice(0, 20)
        const prepareEventKey = `${graphId}:node:${prepareNodeHash}:${parsedProof.nodes[2].attemptCount}:task.completed`
        const [graph, historyGateTask, prepareEvents] = await Promise.all([
          reader.agentItem.findFirst({ where: { id: graphId, sessionId: owner.sessionId, turnId: owner.turnId,
            taskId: owner.rootTaskId, type: "task_graph", session: { is: { userId: owner.userId } },
            turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } }, select: { revision: true, content: true } }),
          reader.subAgentTask.findFirst({ where: { id: gateTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
            rootTaskId: owner.rootTaskId, session: { is: { userId: owner.userId } } },
            select: { id: true, status: true, attemptCount: true, maxAttempts: true, result: true } }),
          reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId,
            type: "item.delta", idempotencyKey: prepareEventKey }, orderBy: { sequence: "asc" }, take: 2,
            select: { actor: true, taskId: true, idempotencyKey: true, sequence: true, payload: true } }),
        ])
        const prepareEvent = prepareEvents.length === 1 ? prepareEvents[0] : null
        const laterEvents = prepareEvent
          ? await reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, itemId: graphId,
            type: "item.delta", sequence: { gt: prepareEvent.sequence } }, orderBy: { sequence: "asc" }, take: 256,
          select: { actor: true, taskId: true, idempotencyKey: true, sequence: true, payload: true } })
          : []
        const historyEvents = [...prepareEvents, ...laterEvents]
        gateHistoryEventSummary = summarizeGateHistoryEvents({ rows: historyEvents, graphId, rootTaskId,
          prepareTaskId: parsedProof.nodes[2].taskId,
          sessionId: ownerSessionId, turnId: ownerTurnId, graphContent: graph?.content,
          prepareGraphRevision: parsedProof.graphRevision, prepareAttemptCount: parsedProof.nodes[2].attemptCount,
          gateTaskId, gateAttemptCount: gate.attemptCount, gateTaskStatus: historyGateTask?.status ?? null,
          gateTaskAttemptCount: historyGateTask?.attemptCount ?? null, gateMaxAttempts: historyGateTask?.maxAttempts ?? null,
          graphRevision: graph?.revision ?? null })
        gateHistoryCurrent = Boolean(graph && historyGateTask)
        if (graph && historyGateTask) {
          try {
            gateHistoryCurrent = await gateHistory.scheduledTaskGraphGateHistoryIsCurrent({
              reader: tx, owner: ownerForLock, prepareGraphRevision: parsedProof.graphRevision,
              prepareTaskId: parsedProof.nodes[2].taskId, prepareAttemptCount: parsedProof.nodes[2].attemptCount,
              graphRevision: graph.revision, graphContent: graph.content,
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
        gateBindingError, gateHistoryEvaluated: gateHistoryCurrent !== null, gateHistoryCurrent, gateHistoryError,
        gateHistoryEventSummary, gateProofCurrent }
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
function debugExactJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}
function debugCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(debugCanonical)
  const row = debugRecord(value)
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, debugCanonical(row[key])])) : value
}
function debugScheduledGateOutput(loadedValue: unknown, persistedValue: unknown): {
  decisions: string; persistedDecisions: string; output: string
} {
  const loaded = debugRecord(loadedValue), persisted = debugRecord(persistedValue), gateResult = debugRecord(loaded?.gateResult)
  const persistedDecisionValue = persisted?.scheduledTaskGraphGateDecisions
  const decisionSource = gateResult?.status === "completed"
    ? { approvedJobIds: gateResult.approvedJobIds, pendingJobIds: gateResult.pendingJobIds, skippedJobIds: gateResult.skippedJobIds }
    : persistedDecisionValue
  const decisions = debugParseGateDecisions(decisionSource)
  const persistedParsed = debugParseGateDecisions(persistedDecisionValue)
  const persistedDecisions = persistedDecisionValue === undefined ? "not_present"
    : !persistedParsed ? "invalid"
      : gateResult ? decisions && debugExactJson(persistedDecisionValue, decisions) ? "matches" : "mismatch" : "valid"
  if (!decisions) return { decisions: decisionSource === undefined ? "missing" : "invalid",
    persistedDecisions, output: "unavailable" }
  const packages = loaded?.packages
  if (!Array.isArray(packages)) return { decisions: "valid", persistedDecisions, output: "unavailable" }
  const byId = new Map<string, true>()
  for (const value of packages) {
    const row = debugRecord(value)
    if (!row || typeof row.jobId !== "string") return { decisions: "valid", persistedDecisions, output: "unavailable" }
    byId.set(row.jobId, true)
  }
  const ids = [...decisions.approvedJobIds, ...decisions.pendingJobIds, ...decisions.skippedJobIds]
  const restored = ids.length === byId.size && new Set(ids).size === ids.length && ids.every(id => byId.has(id))
  return { decisions: "valid", persistedDecisions, output: restored ? "restored" : "rejected" }
}
function debugParseGateDecisions(value: unknown): {
  approvedJobIds: string[]; pendingJobIds: string[]; skippedJobIds: string[]
} | null {
  const row = debugRecord(value), keys = ["approvedJobIds", "pendingJobIds", "skippedJobIds"]
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return null
  const lists = keys.map(key => row[key])
  if (lists.some(list => !Array.isArray(list) || !list.every(id => typeof id === "string" && id.length > 0 && id.trim() === id)
    || new Set(list as string[]).size !== (list as string[]).length)) return null
  return { approvedJobIds: [...lists[0] as string[]], pendingJobIds: [...lists[1] as string[]],
    skippedJobIds: [...lists[2] as string[]] }
}
function debugValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function debugSameLineageOwner(value: unknown, owner: Record<string, unknown>): boolean {
  const row = debugRecord(value)
  return Boolean(row && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => row[key] === owner[key]))
}
function summarizeGateHistoryEvents(input: {
  rows: readonly GateHistoryProbeRow[]; graphId: string; rootTaskId: string; sessionId: string; turnId: string; graphContent: unknown
  prepareTaskId: string
  prepareGraphRevision: number
  prepareAttemptCount: number; gateTaskId: string; gateAttemptCount: number; gateTaskStatus: string | null
  gateTaskAttemptCount: number | null; gateMaxAttempts: number | null; graphRevision: number | null
}): Record<string, unknown> {
  const lifecycleKey = (nodeKey: string, attempt: number, type: string) =>
    `${input.graphId}:node:${createHash("sha256").update(nodeKey).digest("hex").slice(0, 20)}:${attempt}:${type}`
  const prepareKey = lifecycleKey("prepare", input.prepareAttemptCount, "task.completed")
  const prepareMatches = input.rows.filter(row => row.idempotencyKey === prepareKey)
  const prepareRow = prepareMatches.length === 1 ? prepareMatches[0] : null
  const prepareTaskIdentityMatches = Boolean(prepareRow && prepareRow.taskId === input.prepareTaskId)
  const prepareSequence = prepareRow ? debugSequence(prepareRow.sequence) : null
  const laterRows = prepareSequence === null ? [] : input.rows.filter(row => {
    const sequence = debugSequence(row.sequence)
    return sequence !== null && sequence > prepareSequence
  })
  const proposalRow = laterRows[0] ?? null
  const preparePayload = debugRecord(prepareRow?.payload)
  const proposalPayload = debugRecord(proposalRow?.payload)
  const receipt = debugRecord(proposalPayload?.receipt)
  const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes : null
  const priorItem = debugRecord(preparePayload?.item)
  const priorSnapshot = debugGateHistorySnapshot(priorItem?.content)
  const proposedSnapshot = debugGateHistorySnapshot(proposalPayload?.content)
  const prefixMatches = Boolean(priorSnapshot && proposedSnapshot && priorSnapshot.nodes.length === 3
    && proposedSnapshot.nodes.length === 4
    && debugSameJson(priorSnapshot, { ...proposedSnapshot, nodes: proposedSnapshot.nodes.slice(0, 3) }))
  const proposalGateNode = proposedSnapshot?.nodes[3]
  const proposalGateNodeStatus = debugSafeEnum(proposalGateNode?.status,
    ["queued", "running", "waiting_for_user", "completed", "failed", "skipped"])
  const proposalGateDependencies = proposalGateNode?.dependsOn
  const proposalGateNodeMatches = Boolean(proposalGateNode && proposalGateNode.key === "gate"
    && proposalGateNode.templateId === "gate" && proposalGateNode.taskId === input.gateTaskId
    && proposalGateNode.depth === 4 && Array.isArray(proposalGateDependencies)
    && proposalGateDependencies.length === 1 && proposalGateDependencies[0] === "prepare"
    && proposalGateNode.verificationDisposition === "specialized"
    && !Object.hasOwn(proposalGateNode, "verification") && !Object.hasOwn(proposalGateNode, "repairOf")
    && !Object.hasOwn(proposalGateNode, "nativeDelegation"))
  const persistedSnapshot = debugGateHistorySnapshot(input.graphContent)
  const persistedGateNodeStatus = debugSafeEnum(persistedSnapshot?.nodes[3]?.status,
    ["queued", "running", "waiting_for_user", "completed", "failed", "skipped"])
  const proposalKey = `${input.graphId}:proposal:${input.prepareGraphRevision}`
  const receiptNode = receiptNodes?.length === 1 ? debugRecord(receiptNodes[0]) : null
  const receiptReadyIds = Array.isArray(receipt?.readyTaskIds) ? receipt.readyTaskIds : null
  const proposalTaskIdentityMatches = Boolean(proposalRow && proposalRow.taskId === input.rootTaskId)
  const proposalValid = Boolean(proposalRow && proposalRow.actor === "orchestrator"
    && proposalTaskIdentityMatches && proposalRow.idempotencyKey === proposalKey && proposalPayload?.kind === "proposal"
    && proposalPayload.revision === input.prepareGraphRevision + 1
    && typeof proposalPayload.fingerprint === "string" && /^[a-f0-9]{64}$/.test(proposalPayload.fingerprint)
    && receipt?.status === "accepted" && receipt.revision === input.prepareGraphRevision + 1
    && receiptNodes?.length === 1 && receiptNode?.key === "gate" && receiptNode?.taskId === input.gateTaskId
    && receiptNode?.status === "queued" && receiptReadyIds?.length === 1 && receiptReadyIds[0] === input.gateTaskId
    && proposedSnapshot?.nodes.length === 4 && prefixMatches && input.graphRevision !== null
    && input.graphRevision >= input.prepareGraphRevision + 1
    && proposalGateNodeMatches && input.gateMaxAttempts !== null && input.gateMaxAttempts >= 1)
  let expectedRevision = input.prepareGraphRevision + 1
  let expectedStatus: "queued" | "running" | "waiting_for_user" | "completed" = "queued"
  let expectedAttempt = 1
  let timelineValid = proposalValid
  const eventRows = prepareRow ? [prepareRow, ...laterRows] : [...input.rows]
  const eventOrder = eventRows.map((row, index) => {
    const payload = debugRecord(row.payload), event = debugRecord(payload?.event)
    const kind = payload?.kind
    const isPrepare = row === prepareRow
    const isProposal = !isPrepare && row === proposalRow
    const taskIdentityMatches = isPrepare ? prepareTaskIdentityMatches
      : isProposal ? row.taskId === input.rootTaskId
        : kind === "lifecycle" && event?.nodeKey === "gate" ? row.taskId === input.gateTaskId : false
    let rowExpectedRevision: number | null = null
    let expectedPayloadRevision: number | null = null
    let expectedKey: string | null = null
    if (isPrepare) {
      rowExpectedRevision = input.prepareGraphRevision - 1
      expectedPayloadRevision = input.prepareGraphRevision
      expectedKey = prepareKey
    } else if (isProposal) {
      rowExpectedRevision = input.prepareGraphRevision
      expectedPayloadRevision = input.prepareGraphRevision + 1
      expectedKey = proposalKey
    } else if (prepareRow && index >= 2 && event && typeof event.type === "string" && event.nodeKey === "gate") {
      rowExpectedRevision = expectedRevision
      expectedPayloadRevision = expectedRevision + 1
      expectedKey = lifecycleKey("gate", expectedAttempt, event.type)
    }
    const payloadRevision = debugSafeInteger(payload?.revision)
    const eventExpectedRevision = debugSafeInteger(event?.expectedRevision)
    const rowEventKeyMatches = typeof event?.idempotencyKey === "string"
      ? row.idempotencyKey === event.idempotencyKey : null
    const expectedKeyMatches = expectedKey !== null && row.idempotencyKey === expectedKey
      && (typeof event?.idempotencyKey !== "string" || event.idempotencyKey === expectedKey)
    const expectedRevisionMatches = isProposal
      ? expectedKeyMatches
      : eventExpectedRevision !== null && eventExpectedRevision === rowExpectedRevision
    const payloadRevisionMatches = expectedPayloadRevision !== null && payloadRevision === expectedPayloadRevision
    const eventItem = debugRecord(payload?.item)
    const eventGraphContent = isProposal ? payload?.content : eventItem?.content
    const eventSnapshot = debugGateHistorySnapshot(eventGraphContent)
    const eventGateNodeStatus = debugSafeEnum(eventSnapshot?.nodes[3]?.status,
      ["queued", "running", "waiting_for_user", "completed", "failed", "skipped"])
    const result = {
      order: index + 1,
      actor: debugSafeEnum(row.actor, ["system", "orchestrator", "user", "assistant", "worker"]),
      kind: debugSafeEnum(kind, ["lifecycle", "proposal"]),
      lifecycleType: debugSafeEnum(event?.type, ["task.completed", "task.started", "task.waiting_for_user",
        "task.gate_choice_resumed", "task.retrying"]),
      nodeKey: debugSafeEnum(event?.nodeKey, ["scout", "analyst", "prepare", "gate"]),
      expectedRevision: rowExpectedRevision,
      payloadRevision,
      expectedRevisionMatches,
      payloadRevisionMatches,
      rowEventKeyMatches,
      expectedKeyMatches,
      taskIdentityMatches,
      gateNodeStatus: eventGateNodeStatus,
    }
    const eventItemValid = Boolean(eventItem && eventItem.id === input.graphId && eventItem.sessionId === input.sessionId
      && eventItem.turnId === input.turnId && eventItem.taskId === input.rootTaskId && eventItem.type === "task_graph"
      && eventItem.revision === payloadRevision)
    const eventKeys = event ? Object.keys(event).sort().join(",") : ""
    const eventShapeMatches = event?.type === "task.gate_choice_resumed"
      ? eventKeys === "expectedRevision,gateTaskId,idempotencyKey,nodeKey,requestAttemptCount,resumedAttemptCount,type"
        && event.gateTaskId === input.gateTaskId && event.requestAttemptCount === expectedAttempt
        && event.resumedAttemptCount === expectedAttempt + 1
      : eventKeys === "expectedRevision,idempotencyKey,nodeKey,type"
    if (prepareRow && index >= 2 && timelineValid) {
      let nextStatus: typeof expectedStatus | null = null
      let nextAttempt = expectedAttempt
      const type = event?.type
      if (type === "task.started" && expectedStatus === "queued") nextStatus = "running"
      else if (type === "task.waiting_for_user" && expectedStatus === "running") nextStatus = "waiting_for_user"
      else if (type === "task.gate_choice_resumed" && expectedStatus === "waiting_for_user") {
        nextAttempt += 1; nextStatus = "queued"
      } else if (type === "task.retrying" && expectedStatus === "running" && input.gateMaxAttempts !== null
        && expectedAttempt < input.gateMaxAttempts) {
        nextAttempt += 1; nextStatus = "queued"
      } else if (type === "task.completed" && expectedStatus === "running") nextStatus = "completed"
      const eventEnvelopeMatches = row.actor === "system" && kind === "lifecycle" && event?.nodeKey === "gate"
        && taskIdentityMatches && eventShapeMatches && eventItemValid && expectedRevisionMatches && payloadRevisionMatches
        && rowEventKeyMatches === true && expectedKeyMatches
      const expectedContent = proposedSnapshot && nextStatus
        ? { ...proposedSnapshot, nodes: [...proposedSnapshot.nodes.slice(0, 3), { ...proposedSnapshot.nodes[3]!, status: nextStatus }] }
        : null
      const eventContent = debugGateHistorySnapshot(eventItem?.content)
      timelineValid = Boolean(nextStatus && eventEnvelopeMatches && eventContent && expectedContent
        && debugSameJson(eventContent, expectedContent))
      if (timelineValid && nextStatus) {
        expectedStatus = nextStatus
        expectedAttempt = nextAttempt
        expectedRevision += 1
      }
    }
    return result
  })
  const allSequences = input.rows.map(row => debugSequence(row.sequence))
  const sequenceOrderMatches = allSequences.every((sequence, index) => sequence !== null
    && (index === 0 || allSequences[index - 1] !== null && sequence > allSequences[index - 1]!))
  const persistedStatus = debugSafeEnum(input.gateTaskStatus,
    ["queued", "running", "waiting_for_user", "completed", "failed", "interrupted", "skipped"])
  return {
    eventCount: input.rows.length,
    sequenceOrderMatches,
    prepareEventMatchCount: prepareMatches.length,
    prepareEventOrder: prepareRow ? input.rows.indexOf(prepareRow) + 1 : null,
    prepareTaskIdentityMatches,
    proposalTaskIdentityMatches,
    prepareSequenceFound: prepareSequence !== null,
    postPrepareEventCount: laterRows.length,
    events: eventOrder,
    proposalReceiptStatus: debugSafeEnum(receipt?.status, ["accepted", "rejected"]),
    proposalReceiptNodeCount: receiptNodes?.length ?? null,
    proposalReceiptNodeCountMatches: Boolean(receiptNodes && receiptNodes.length === 1
      && Reflect.ownKeys(receiptNodes).length === receiptNodes.length + 1),
    proposalPrefixMatches: prefixMatches,
    proposalGateNodeStatus,
    persistedGateNodeStatus,
    final: {
      expectedRevision, persistedRevision: input.graphRevision,
      revisionMatches: input.graphRevision === expectedRevision,
      expectedStatus, persistedStatus, statusMatches: persistedStatus === expectedStatus,
      expectedAttempt, persistedAttempt: input.gateTaskAttemptCount,
      attemptMatches: input.gateTaskAttemptCount === expectedAttempt,
      requestedAttempt: input.gateAttemptCount, requestedAttemptMatches: input.gateAttemptCount === expectedAttempt,
    },
  }
}
function debugGateHistorySnapshot(value: unknown): { schemaVersion: string; nodes: Record<string, unknown>[]; rootSuccessCriteria?: unknown } | null {
  const row = debugRecord(value), rawNodes = row?.nodes
  if (!row || row.schemaVersion !== "agent-harness.v2.task-graph" || !Array.isArray(rawNodes)
    || Reflect.ownKeys(rawNodes).length !== rawNodes.length + 1) return null
  const nodes = rawNodes.map(debugRecord).filter((node): node is Record<string, unknown> => node !== null)
  if (nodes.length !== rawNodes.length) return null
  return { schemaVersion: "agent-harness.v2.task-graph", nodes,
    ...(Object.hasOwn(row, "rootSuccessCriteria") ? { rootSuccessCriteria: row.rootSuccessCriteria } : {}) }
}
function debugSequence(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  } catch { return null }
  return null
}
function debugSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}
function debugSafeEnum(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" ? allowed.includes(value) ? value : "other" : null
}
function diagnosticGateErrorCode(value: unknown): string | null {
  return typeof value === "string" && diagnosticGateErrorCodes.has(value) ? value : null
}
function diagnosticWorkerErrorCode(value: unknown): string | null {
  return typeof value === "string" && diagnosticWorkerErrorCodes.has(value) ? value : null
}
function diagnosticGateFailure(value: unknown): GateHttpFailure["testDiagnostic"] {
  const row = debugRecord(value)
  return { phase: row ? debugSafeEnum(row.phase, ["owner_assertion", "gate_execution"]) : null,
    errorClass: row ? debugSafeEnum(row.errorClass, ["prisma_known_request_error", "agent_execution_cancelled", "type_error",
      "range_error", "syntax_error", "error", "non_error"]) : null,
    prismaCode: typeof row?.prismaCode === "string" && /^P\d{4}$/.test(row.prismaCode) ? row.prismaCode : null,
    safeErrorCode: typeof row?.safeErrorCode === "string" && diagnosticGateSafeErrorCodes.has(row.safeErrorCode)
      ? row.safeErrorCode : null }
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
async function taskState(taskId: string): Promise<{ status: string; attemptCount: number; result: unknown; failureReason: string | null }> {
  const row = (await pool!.query<{ status: string; attemptCount: number; result: unknown; failureReason: string | null }>(
    `SELECT "status", "attemptCount", "result", "failureReason" FROM "sub_agent_tasks" WHERE "id"=$1`, [taskId])).rows[0]
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
