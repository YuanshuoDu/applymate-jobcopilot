import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { Queue, Worker, type Job } from "bullmq"
import Redis from "ioredis"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TurnEngine } from "../turns/turn-engine.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createCanonicalSessionProjection } from "../canonical-session-projection.js"
import type { TurnEngineOptions, TurnEngineResult } from "../turns/turn-engine-types.js"
import { runTurnJob } from "../turns/turn-queue.js"
import { dispatchPendingTurnOutbox } from "../turns/recovery-scanner.js"
import type { TurnJobPayload, TurnLease } from "../turns/lease.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { suspendAndReleaseWait } from "./durable-wait-handoff.js"
import { reconcileDurableWaits } from "./durable-wait-resolver.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createScheduledPipelineCandidateStore, SCHEDULED_PIPELINE_CANDIDATE_EVENT } from "./scheduled-pipeline-candidate-store.js"
import { readScheduledPipelineRecoveryStepProfile, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY } from "./scheduled-pipeline-recovery-step.js"
import { classifyScheduledPipelineRecoveryGraphItem } from "./scheduled-pipeline-recovery-graph-item.js"
import { attachScheduledPipelineCompletion } from "./scheduled-pipeline-completion.js"
import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"
import { createScheduledAutomationPrepareContinuation } from "./scheduled-automation-prepare-bridge.js"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.js"
import { createScheduledAuditChildExecutor } from "./scheduled-audit-child-runtime.js"
import { createScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg-runner.fixture.js"
import { scheduledGateRootActions } from "./scheduled-gate-prepare-pg-resume.fixture.js"
import { parseScheduledAuditReport, SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_TASK_TYPE,
  SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphProposalKey,
  TASK_GRAPH_ITEM_TYPE } from "./task-graph-snapshot.js"
import { verifyScheduledPrepareTaskGraphEvidence } from "./scheduled-prepare-task-graph-verification.js"
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
type FixtureWebDatabase = Readonly<{ db: {
  $disconnect(): Promise<void>
  $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T>
  customAgentRole: { findMany(args: unknown): Promise<readonly unknown[]> }
} }>
type CustomAgentRoleLookup = Readonly<{ userId: string; insertAfter: string; enabled: true }>
type GateFailureDiagnostics = Readonly<Record<string, unknown>>
type AuditPreflightState = "not_checked" | "passed" | "rejected" | "threw"
type ReadTraceCount = { reached: boolean; rowCount: number | null }
type PrismaDecimalInstance = Readonly<{ isZero(): boolean; toString(): string }>
type PrismaDecimalClass = (new (...args: unknown[]) => PrismaDecimalInstance) & { isDecimal?: (value: unknown) => boolean }
type WebPrismaRuntime = Readonly<{ Prisma: Readonly<{ Decimal: PrismaDecimalClass }> }>
const requireFromWeb = createRequire(new URL("../../../../web/package.json", import.meta.url))
type PrepareSourceReadTrace = {
  receiptEvents: ReadTraceCount
  candidateEvents: ReadTraceCount
  sourceStepLookups: Array<{ found: boolean; status: string | null; cursorType: string }>
  choiceItemLookups: Array<{ found: boolean; itemKeys: string[]; extraItemKeyCount: number; contentKeys: string[]; extraContentKeyCount: number }>
  tailSteps: ReadTraceCount & { statuses: string[] }
  tailEvents: ReadTraceCount
  tailItems: ReadTraceCount
  tailWaits: ReadTraceCount
  targetTasks: ReadTraceCount
  graphProposalEvents: ReadTraceCount
  recoverySteps: Array<Readonly<Record<string, unknown>>>
  waitEvidence: Array<Readonly<Record<string, unknown>>>
  targetEvidence: Array<Readonly<Record<string, unknown>>>
}
type PrepareSourceTraceCapture = {
  candidateEvents: unknown[]
  sourceSteps: Array<unknown | null>
  choiceItems: Array<unknown | null>
  tailSteps: unknown[]
  tailEvents: unknown[]
  tailItems: unknown[]
  tailWaits: unknown[]
  targetTasks: unknown[]
  graphProposalEvents: unknown[]
}
type AuditPreflightDiagnostics = {
  gateCompletionProofValid: boolean
  executionOwnerDerived: boolean
  prepareProofCanonicalMatch: boolean
  executionContext: AuditPreflightState
  markerKeyMatches: boolean
  claimKeyMatches: boolean
  markerOwnerExact9Matches: boolean
  markerOwnerStable7Matches: boolean
  claimOwnerExact9Matches: boolean
  claimOwnerStable7Matches: boolean
  claimTokenValid: boolean
  savedScheduledWaitIdMatchesRequest: boolean
  prepareSource: AuditPreflightState
  prepareSourceTrace: PrepareSourceReadTrace
  gateProofCurrent: AuditPreflightState
}
type AuditRequestOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string;
  rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number }>
type AuditExecutionOwner = AuditRequestOwner & Readonly<{ executionId: string; executionAttemptCount: number }>
type DiagnosticAuditReader = Readonly<{ agentExecution: { findFirst(args: unknown): Promise<unknown> } }>
type AuditAction = Readonly<{ action: "scheduled_audit_execute"; owner: AuditRequestOwner; attestation: unknown;
  prepareProof: unknown; gateCompletionProof: unknown; auditActor: Readonly<{ taskId: string; attemptCount: number; leaseOwner: string }>;
  scheduledWaitId?: string }>
type GateHttpFailure = Readonly<{ status: number; errorCode: string | null; testDiagnostic: Readonly<{
  phase: string | null; errorClass: string | null; prismaCode: string | null; safeErrorCode: string | null
}> }>
type ExecuteHttpFailure = Readonly<{ status: number; errorCode: string | null; keys: readonly string[]; reportValid: boolean;
  executionStatus?: string | null; executionCheckpoint?: string | null; executionNextStage?: string | null;
  hasExecutionError?: boolean; executionErrorCode?: string | null; pipelineOutcome?: string;
  auditPreflight: AuditPreflightDiagnostics;
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
  "scheduled_pipeline_audit_child_fenced", "scheduled_pipeline_audit_gate_proof_invalid",
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
const scheduledTaskGraphAuditChildFencePath = "@/lib/agent/scheduled-taskgraph-audit-child-fence"
const scheduledTaskGraphAuditPrepareSourcePath = "@/lib/agent/scheduled-taskgraph-audit-prepare-source"
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
    vi.doUnmock(scheduledTaskGraphAuditChildFencePath)
    vi.doUnmock(scheduledTaskGraphAuditPrepareSourcePath)
    vi.doUnmock(scheduledWebDbPath)
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
    const sourceStepId = fixture.rootQuestionStepId
    const scopeBase = { ...fixture.graphScope, turnLeaseOwner: fixture.owner.turnLeaseOwnerId,
      turnLeaseVersion: fixture.owner.turnLeaseVersion, parentLeaseOwner: fixture.owner.turnLeaseOwnerId,
      parentAttemptCount: fixture.owner.rootAttemptCount }
    const response = await setupFetcher(fixture)
    const continuation = createScheduledAutomationGateContinuation({ pool: pool as never, commandPort: command,
      waitPort, nativeQuestionWaitEnabled: false, fetcher: response.fetcher })
    const input = { owner: fixture.owner, executionOwner: turnOwner, attestation: fixture.attestation,
      handoff: fixture.handoff, prepareProof: fixture.prepareProof, scheduledWaitId: fixture.prepareChoiceWaitId,
      finalStepId: sourceStepId, recoveryStepId: sourceStepId, signal: new AbortController().signal }
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
    const rootStore = createPgRootTaskStore(pool as never)
    const sessionProjection = createCanonicalSessionProjection(pool as never)
    const projectionIdentity = { userId: fixture.ids.userId, sessionId: fixture.ids.sessionId, turnId: fixture.ids.turnId }
    const auditReplayCaptures: Array<{ mode: "append_audit" | "resume_audit"; recoveryStepId: string; receipt: unknown }> = []
    const captureAuditAppendReplay = async (recoveryStepId: string, mode: "append_audit" | "resume_audit"): Promise<void> => {
      const receipt = await command.appendScheduledAudit!({ scope: { ...scopeBase, stepId: recoveryStepId },
        executionOwner: fixture.executionOwner, handoff: fixture.handoff, attestation: fixture.attestation,
        gateProof, scheduledWaitId: fixture.prepareChoiceWaitId })
      auditReplayCaptures.push({ mode, recoveryStepId, receipt })
    }
    const pendingRoot = await runAttachedScheduledAuditRoot(fixture, response.fetcher, command, waitPort,
      "waiting_for_dependency", captureAuditAppendReplay)
    expect(pendingRoot.status).toBe("waiting_for_dependency")
    if (pendingRoot.status !== "waiting_for_dependency" || !pendingRoot.waitId) throw new Error("scheduled Audit root wait missing")
    const pendingTrace = await readScheduledAuditRootRecoveryTrace(fixture)
    expectScheduledAuditRecoveryTrace(pendingTrace, fixture, 1, "waiting_for_tool", null)
    expect(pendingTrace.steps[0]?.completionEvents[0]?.payload).toMatchObject({ status: "waiting_for_dependency", waitId: pendingRoot.waitId })
    expect(pendingTrace.steps[0]?.waits.some(wait => wait.id === pendingRoot.waitId)).toBe(true)
    const auditWait = { status: "waiting_for_dependency" as const, waitId: pendingRoot.waitId }
    expect(auditWait.waitId).not.toBe(initialGateWait.waitId)
    expect(await requireGateProof(fixture)).toEqual(gateProof)
    await rootStore.finish({ lease: fixture.turnLease, rootTaskId: fixture.ids.rootTaskId, result: pendingRoot })
    await sessionProjection.finish({ ...projectionIdentity, result: { status: "waiting_for_dependency" } })
    await expect(suspendAndReleaseWait(pool as never, { lease: fixture.turnLease, waitId: auditWait.waitId }))
      .resolves.toMatchObject({ waitId: auditWait.waitId, handoff: "suspended", waitStatus: "waiting" })
    const pendingRootState = await readRootTurnState(fixture)
    expect(pendingRootState.turnStatus).toBe("waiting_for_dependency")
    expect(pendingRootState.sessionStatus).toBe("running")
    expect(pendingRootState.turnLeaseOwnerId).toBeNull()
    expect(pendingRootState.rootStatus).toBe("waiting")
    expect(pendingRootState.rootResult).toMatchObject({ status: "waiting_for_dependency", waitId: auditWait.waitId })
    const auditTaskId = await findTaskId(SCHEDULED_AUDIT_TASK_TYPE, fixture.ids.rootTaskId)
    expect(auditReplayCaptures).toHaveLength(1)
    expect(auditReplayCaptures[0]).toMatchObject({ mode: "append_audit", recoveryStepId: pendingTrace.steps[0]?.id,
      receipt: { status: "duplicate", auditTaskId, expectedAttemptCount: 1 } })
    expect((await graphCount(fixture)).auditNodes).toBe(1)
    const auditDispatchOutbox = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_outbox"
      WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
    [fixture.ids.sessionId, `subagent-dispatch:${auditTaskId}`])
    expect(auditDispatchOutbox.rows).toHaveLength(1)

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
    const customRoleLookups = response.customRoleLookups()
    expect(customRoleLookups).toEqual([])
    expect(response.customModelCalls()).toEqual([])
    expect(response.report()).toMatchObject({ processed: fixture.preparedJobIds.length, pending: 0 })
    const firstExecutionState = await readExecutionState(fixture)
    expect(firstExecutionState.status).toBe("completed")
    expect(firstExecutionState.state.report).toEqual(response.report())
    await stopRunner()
    const queued = await taskState(auditTaskId)
    expect(queued).toMatchObject({ status: "queued", attemptCount: 1, result: null })

    const parkedAfterRetry = await readRootTurnState(fixture)
    expect(parkedAfterRetry).toMatchObject({ turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null,
      rootStatus: "waiting", sessionStatus: "running", rootResult: { status: "waiting_for_dependency", waitId: auditWait.waitId } })
    await expect(reconcileDurableWaits(pool as never, { ownerId: "scheduled-audit-resolver-before-retry" }))
      .resolves.toMatchObject({ woken: 0 })
    expect(await readRootTurnState(fixture)).toMatchObject({ turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, sessionStatus: "running" })
    runner = startRunner(fixture, response.fetcher)
    expect(await readRootTurnState(fixture)).toMatchObject({ turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, sessionStatus: "running" })
    await waitForAuditRetryDue(auditTaskId)
    const secondTaskOutcome = await dispatchAndWait(runner, auditTaskId, fixture.ids.sessionId)
    const secondOutcomeRow = debugRecord(secondTaskOutcome)
    if (secondOutcomeRow?.status !== "completed") {
      const [failedTask, rootState] = await Promise.all([taskState(auditTaskId), readRootTurnState(fixture)])
      const safeStatus = (value: unknown) => typeof value === "string" && (diagnosticOutcomeStatuses.has(value)
        || ["queued", "in_progress", "running", "cancelled", "closed", "paused", "aborted", "not_called", "gate_checkpointed",
          "scout", "analyze", "prepare", "gate", "execute", "audit"].includes(value)) ? value : "other"
      const safeFailureReason = (value: unknown) => typeof value === "string"
        ? diagnosticAuditFailureReasons.has(value) ? value : "other" : null
      const safeRetryDisposition = (value: unknown) => value === "retryable" || value === "terminal" ? value : null
      const replay = response.replayedExecuteResponse()
      const safeReplay = replay ? {
        status: replay.status,
        bodyStatus: safeStatus(debugRecord(replay.body)?.status),
        bodyKeys: Object.keys(replay.body).filter(key => ["status", "report", "errorCode"].includes(key)).sort(),
        reportValid: parseScheduledAuditReport(replay.body.report) !== null,
      } : null
      const safeExecuteFailures = response.executeHttpFailures().map(failure => ({
        status: failure.status,
        errorCode: failure.errorCode && diagnosticAuditFailureReasons.has(failure.errorCode) ? failure.errorCode : failure.errorCode ? "other" : null,
        keys: failure.keys.filter(key => ["status", "report", "errorCode"].includes(key)).sort(),
        reportValid: failure.reportValid,
        executionStatus: safeStatus(failure.executionStatus),
        executionCheckpoint: safeStatus(failure.executionCheckpoint),
        executionNextStage: safeStatus(failure.executionNextStage),
        hasExecutionError: failure.hasExecutionError ?? false,
        executionErrorCode: safeFailureReason(failure.executionErrorCode),
        pipelineOutcome: safeStatus(failure.pipelineOutcome),
        auditPreflight: {
          gateCompletionProofValid: failure.auditPreflight.gateCompletionProofValid,
          executionOwnerDerived: failure.auditPreflight.executionOwnerDerived,
          prepareProofCanonicalMatch: failure.auditPreflight.prepareProofCanonicalMatch,
          executionContext: failure.auditPreflight.executionContext,
          markerKeyMatches: failure.auditPreflight.markerKeyMatches,
          claimKeyMatches: failure.auditPreflight.claimKeyMatches,
          markerOwnerExact9Matches: failure.auditPreflight.markerOwnerExact9Matches,
          markerOwnerStable7Matches: failure.auditPreflight.markerOwnerStable7Matches,
          claimOwnerExact9Matches: failure.auditPreflight.claimOwnerExact9Matches,
          claimOwnerStable7Matches: failure.auditPreflight.claimOwnerStable7Matches,
          claimTokenValid: failure.auditPreflight.claimTokenValid,
          savedScheduledWaitIdMatchesRequest: failure.auditPreflight.savedScheduledWaitIdMatchesRequest,
          prepareSource: failure.auditPreflight.prepareSource,
          gateProofCurrent: failure.auditPreflight.gateProofCurrent,
        },
        continuation: failure.continuation ? {
          gateResume: safeStatus(failure.continuation.gateResume), analyzeCheckpoint: safeStatus(failure.continuation.analyzeCheckpoint),
          continuationKey: safeStatus(failure.continuation.continuationKey), waitBinding: safeStatus(failure.continuation.waitBinding),
          ownerCurrentRecheck: safeStatus(failure.continuation.ownerCurrentRecheck), prepareWait: safeStatus(failure.continuation.prepareWait),
          gateInputRecheck: safeStatus(failure.continuation.gateInputRecheck), gateProofCurrent: safeStatus(failure.continuation.gateProofCurrent),
          gateHandoff: safeStatus(failure.continuation.gateHandoff), claimLease: safeStatus(failure.continuation.claimLease),
          storedStage: safeStatus(failure.continuation.storedStage), completionProof: safeStatus(failure.continuation.completionProof),
          completionPrepareProof: safeStatus(failure.continuation.completionPrepareProof),
          preparedArtifactRefs: safeStatus(failure.continuation.preparedArtifactRefs), gateDecisions: safeStatus(failure.continuation.gateDecisions),
          persistedGateDecisions: safeStatus(failure.continuation.persistedGateDecisions), gateOutput: safeStatus(failure.continuation.gateOutput),
          serializedCheckpoint: safeStatus(failure.continuation.serializedCheckpoint), checkpointSave: safeStatus(failure.continuation.checkpointSave),
        } : null,
      }))
      const taskFailureReason = failedTask.failureReason === null ? null : safeFailureReason(failedTask.failureReason)
      throw new Error(`Scheduled Audit retry returned a non-completed outcome: ${JSON.stringify({
        result: { status: safeStatus(secondOutcomeRow?.status), failureReason: safeFailureReason(secondOutcomeRow?.failureReason),
          retryDisposition: safeRetryDisposition(secondOutcomeRow?.retryDisposition) },
        task: { status: safeStatus(failedTask.status), attemptCount: failedTask.attemptCount, failureReason: taskFailureReason },
        executeCalls: response.executeCalls(), executeHttpFailures: safeExecuteFailures, replay: safeReplay,
        root: { turnStatus: safeStatus(rootState.turnStatus), turnLeaseOwned: rootState.turnLeaseOwnerId !== null,
          sessionStatus: safeStatus(rootState.sessionStatus), rootStatus: safeStatus(rootState.rootStatus),
          resultStatus: safeStatus(debugRecord(rootState.rootResult)?.status) },
      })}`)
    }
    expect(secondTaskOutcome).toMatchObject({ status: "completed" })
    expect(response.executeCalls()).toBe(2)
    const firstRequest = response.firstExecuteRequest()!
    const retryRequest = response.replayedExecuteRequest()!
    const { auditActor: firstActor, ...firstRequestProof } = firstRequest
    const { auditActor: retryActor, ...retryRequestProof } = retryRequest
    expect(retryRequestProof).toEqual(firstRequestProof)
    expect(firstActor).toMatchObject({ taskId: auditTaskId, attemptCount: 1, leaseOwner: expect.any(String) })
    expect(retryActor).toMatchObject({ taskId: auditTaskId, attemptCount: 2, leaseOwner: expect.any(String) })
    expect(response.replayedExecuteResponse()).toEqual(firstHttpResponse)
    expect(await readExecutionState(fixture)).toEqual(firstExecutionState)

    const completed = await taskState(auditTaskId)
    expect(completed).toMatchObject({ status: "completed", attemptCount: 2 })
    expect(completed.result).toEqual({
      finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: response.report(),
    })
    let proofLease = fixture.turnLease
    const terminalAuditProofCaptures: Array<{ current: Awaited<ReturnType<NonNullable<typeof command.verifyScheduledAuditCompletion>>>;
      staleAttempt: Awaited<ReturnType<NonNullable<typeof command.verifyScheduledAuditCompletion>>> }> = []
    const captureTerminalAuditProof = async (_recoveryStepId: string, mode: "append_audit" | "resume_audit"): Promise<void> => {
      if (mode !== "resume_audit") throw new Error("terminal Audit proof must use the existing Audit resume path")
      const proofInput = { scope: { ...fixture.graphScope, turnLeaseOwner: proofLease.ownerId,
        turnLeaseVersion: proofLease.leaseVersion, parentLeaseOwner: proofLease.ownerId,
        parentAttemptCount: fixture.owner.rootAttemptCount }, executionOwner: fixture.executionOwner,
        gateProof, auditTaskId, attemptCount: 2 }
      const current = await command.verifyScheduledAuditCompletion!(proofInput)
      const staleAttempt = await command.verifyScheduledAuditCompletion!({ ...proofInput, attemptCount: 1 })
      terminalAuditProofCaptures.push({ current, staleAttempt })
    }

    const reconciled = await reconcileDurableWaits(pool as never, { ownerId: "scheduled-audit-resolver" })
    expect(reconciled.woken).toBe(1)
    const auditWake = await pool!.query<{ status: string; matchedTaskIds: unknown }>(
      `SELECT "status", "matchedTaskIds" FROM "agent_wait_conditions" WHERE "id"=$1`, [auditWait.waitId])
    expect(auditWake.rows).toMatchObject([{ status: "ready", matchedTaskIds: [auditTaskId] }])
    expect(await readRootTurnState(fixture)).toMatchObject({ turnStatus: "queued", turnLeaseOwnerId: null,
      rootStatus: "waiting", sessionStatus: "running" })
    const turnJobs: TurnJobPayload[] = []
    expect(await dispatchPendingTurnOutbox(pool as never, { add: async (_name, payload) => { turnJobs.push(payload) } })).toBe(1)
    expect(turnJobs).toHaveLength(1)
    let terminalRoot: TurnEngineResult | undefined
    let resumedLease: TurnLease | undefined
    const resumedJob = await runTurnJob({ data: turnJobs[0]!, attemptsMade: 0 }, { pool: pool as never,
      requireCanonicalAutomationMode: true, heartbeatMs: 60_000,
      async execute({ lease }) {
        resumedLease = lease
        proofLease = lease
        await sessionProjection.start(projectionIdentity)
        const staleAuditPort = command as typeof command & {
          verifyScheduledAuditCompletion: NonNullable<typeof command.verifyScheduledAuditCompletion>
        }
        const verifyAudit = staleAuditPort.verifyScheduledAuditCompletion.bind(staleAuditPort)
        const staleAuditProof = vi.spyOn(staleAuditPort, "verifyScheduledAuditCompletion").mockImplementation(proof =>
          verifyAudit({ ...proof, attemptCount: 1 }))
        let staleRoot: TurnEngineResult
        try { staleRoot = await runAttachedScheduledAuditRoot(fixture, response.fetcher, command, waitPort,
          undefined, undefined, undefined, lease) }
        finally { staleAuditProof.mockRestore() }
        expect(staleRoot).toMatchObject({ status: "waiting_for_dependency", errorCode: "scheduled_audit_completion_unverified" })
        expect(staleRoot).not.toMatchObject({ status: "completed" })
        expect(await readRootTurnState(fixture)).toMatchObject({ turnStatus: "in_progress",
          turnLeaseOwnerId: lease.ownerId, rootStatus: "running", sessionStatus: "running" })
        terminalRoot = await runAttachedScheduledAuditRoot(fixture, response.fetcher, command, waitPort,
          undefined, undefined, captureTerminalAuditProof, lease)
        await rootStore.finish({ lease, rootTaskId: fixture.ids.rootTaskId, result: terminalRoot })
        await sessionProjection.finish({ ...projectionIdentity, result: { status: terminalRoot.status } })
        return terminalRoot
      } })
    expect(resumedJob).toMatchObject({ status: "completed" })
    expect(resumedLease?.leaseVersion).toBe(fixture.turnLease.leaseVersion + 1)
    expect(terminalRoot).toMatchObject({ status: "completed", finalText: "Scheduled Gate integration candidate." })
    expect(terminalAuditProofCaptures.length).toBeGreaterThan(0)
    const terminalAuditProof = terminalAuditProofCaptures.at(-1)
    expect(terminalAuditProof?.current).toMatchObject({ owner: expect.objectContaining({ executionId: fixture.executionOwner.executionId }),
      audit: { taskId: auditTaskId, attemptCount: 2 }, report: response.report() })
    expect(terminalAuditProof?.current?.report).toEqual(response.report())
    expect(terminalAuditProof?.staleAttempt).toBeNull()
    const terminalTrace = await readScheduledAuditRootRecoveryTrace(fixture)
    expectScheduledAuditRecoveryTrace(terminalTrace, fixture, 3, "completed", null)
    expect(terminalTrace.candidateEvent.id).toBe(pendingTrace.candidateEvent.id)
    expect(terminalTrace.candidatePayload).toEqual(pendingTrace.candidatePayload)
    expect(terminalTrace.sourceStep).toEqual(pendingTrace.sourceStep)
    expect(terminalTrace.steps[2]?.completionEvents[0]?.payload).toEqual({ stepId: terminalTrace.steps[2]?.id,
      status: "completed", taskId: fixture.ids.rootTaskId })
    expect(terminalTrace.steps.map(step => step.id)).toEqual(expect.arrayContaining([
      pendingTrace.steps[0]?.id, terminalTrace.steps[1]?.id, terminalTrace.steps[2]?.id,
    ]))
    const terminalRootState = await readRootTurnState(fixture)
    expect(terminalRootState.turnStatus).toBe("completed")
    expect(terminalRootState.rootStatus).toBe("completed")
    expect(terminalRootState.sessionStatus).toBe("completed")
    expect(terminalRootState.rootResult).toMatchObject({ status: "completed", finalItemId: terminalRoot!.finalItemId })

    const graph = await loadTaskGraph(pool as never, fixture.graphScope, false)
    const auditNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID)
    expect(auditNode?.verificationDisposition).toBe("specialized")
    const generic = await verifyCompletedTaskGraphNodeEvidence({ query: async () => { throw new Error("unverified Audit must not reach generic evidence queries") } } as never, {
      scope: { ...fixture.graphScope, taskId: auditTaskId, attemptCount: 2 }, snapshot: graph.snapshot!, node: auditNode!,
      structuredResult: response.report(),
    })
    expect(generic.verified).toBe(false)
    expect(generic.report.status).not.toBe("passed")

    expect((await graphCount(fixture)).auditNodes).toBe(1)
  }, 600_000)
})

async function runAttachedScheduledAuditRoot(fixture: Fixture, fetcher: typeof fetch,
  commandPort: ReturnType<typeof createPgTaskGraphCommandPort>, waitPort: ReturnType<typeof createPgDurableWaitPort>,
  expectedStatus?: "waiting_for_dependency",
  afterAuditWait?: (recoveryStepId: string, mode: "append_audit" | "resume_audit") => Promise<void>,
  afterAuditCompletion?: (recoveryStepId: string, mode: "append_audit" | "resume_audit") => Promise<void>,
  activeLease: TurnLease = fixture.turnLease): Promise<TurnEngineResult> {
  const phases: Array<{ phase: string; outcome?: string; errorClass?: string; errorCode?: string }> = []
  const safeStatuses = new Set(["ready", "blocked", "not_registered", "completed", "waiting_for_dependency", "waiting_for_choice",
    "waiting_for_external_user", "waiting_for_user", "invalid", "failed", "interrupted"])
  const safeErrorCodes = new Set([...diagnosticAuditFailureReasons, ...diagnosticGateErrorCodes,
    "evidence_missing", "evidence_conflict", "final_unverified", "business_precondition_failed",
    "invalid_output", "persistence_conflict", "step_limit", "model_incomplete", "budget_exhausted",
    "no_progress", "discovery_memory_overflow", "turn_execution_failed",
    "scheduled_candidate_identity_invalid", "scheduled_candidate_model_receipt_conflict", "scheduled_candidate_model_receipt_missing",
    "scheduled_candidate_owner_invalid", "scheduled_candidate_recovery_mismatch", "root_objective_history_projection_failed",
    "root_session_fenced", "root_task_fenced", "root_turn_fenced"])
  const errorDiagnostic = (error: unknown): Pick<typeof phases[number], "errorClass" | "errorCode"> => {
    const name = error instanceof Error ? error.constructor.name : "NonError"
    const errorClass = new Set(["AbortError", "DatabaseError", "Error", "RangeError", "TaskGraphCommandError",
      "TurnStateRefreshRetryError", "TypeError"]).has(name) ? name : error instanceof Error ? "OtherError" : "NonError"
    const row = debugRecord(error), candidates = [row?.code, error instanceof Error ? error.message : undefined]
    const code = candidates.find((value): value is string => typeof value === "string"
      && (safeErrorCodes.has(value) || /^[0-9A-Z]{5}$/.test(value)))
    return { errorClass, ...(code ? { errorCode: /^[0-9A-Z]{5}$/.test(code) ? `pg_sqlstate_${code}` : code } : {}) }
  }
  const outcome = (value: unknown): string => {
    const row = debugRecord(value), status = row?.status
    if (row && typeof status === "string" && safeStatuses.has(status)) {
      const code = typeof row.errorCode === "string" && safeErrorCodes.has(row.errorCode) ? `:${row.errorCode}` : ""
      return `${status}${code}`
    }
    return row?.ok === false ? "blocked" : "ok"
  }
  const observe = async <T>(phase: string, work: () => Promise<T>, describe: (value: T) => string = outcome): Promise<T> => {
    try {
      const result = await work()
      phases.push({ phase, outcome: describe(result) })
      return result
    } catch (error: unknown) {
      phases.push({ phase, ...errorDiagnostic(error) })
      throw error
    }
  }
  const run = async (): Promise<TurnEngineResult> => {
    const lease = activeLease, owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    const executionOwner: TurnExecutionOwnerFence = { ...fixture.turnExecutionOwner, ownerId: lease.ownerId,
      leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
    const store = createPgTurnEngineStore(pool as never), candidateStore = createScheduledPipelineCandidateStore(pool as never, store)
    const rootStore = createPgRootTaskStore(pool as never)
    await observe("root.ensure", () => rootStore.ensure({ lease, goal: "Finish the scheduled automation only after its current Audit proof",
      allowedActions: scheduledGateRootActions() }), () => "ensured")
    const recoveredCandidate = await observe("candidate.read", () => candidateStore.read({ owner: executionOwner,
      rootAttemptCount: owner.rootAttemptCount }), value => value ? "present" : "absent")
    if (!recoveredCandidate) throw new Error("scheduled Audit root candidate missing")
    const resumeOrdinal = recoveredCandidate.recoveryTail?.ordinal ?? recoveredCandidate.finalStepOrdinal
    phases.push({ phase: "owner_attempt_binding", outcome: owner.rootAttemptCount === fixture.owner.rootAttemptCount
      && owner.turnLeaseOwnerId === lease.ownerId && owner.turnLeaseVersion === lease.leaseVersion
      && executionOwner.userId === owner.userId && executionOwner.sessionId === owner.sessionId
      && executionOwner.turnId === owner.turnId && executionOwner.taskId === owner.rootTaskId
      && executionOwner.ownerId === lease.ownerId && executionOwner.leaseVersion === lease.leaseVersion ? "matched" : "mismatch" })
    phases.push({ phase: "candidate_step_binding", outcome: recoveredCandidate.finalStepId === fixture.rootQuestionStepId
      && Number.isSafeInteger(recoveredCandidate.finalStepOrdinal) ? "matched_historical_step" : "other_step" })
    const tracedFetcher: typeof fetch = (...args) => observe("web.fetch", () => fetcher(...args), response => response.ok ? "http_ok" : "http_non_ok")
    const prepareContinuationBase = createScheduledAutomationPrepareContinuation({ commandPort, waitPort,
      async verifyReadyPrepare({ scope, prepareTaskId }) {
        const graph = await loadTaskGraph(pool as never, scope, false), current = currentTaskGraph(graph), task = graph.tasks.get(prepareTaskId)
        if (!graph.snapshot || !task || !Number.isSafeInteger(task.attemptCount)) return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
        return verifyScheduledPrepareTaskGraphEvidence(pool as never, { scope: { ...scope, taskId: prepareTaskId, attemptCount: task.attemptCount! },
          snapshot: graph.snapshot, current, tasks: graph.tasks, structuredResult: debugRecord(task.result)?.structuredResult,
          completionGraphRevision: current.revision, referenceVerificationMode: { phase: "persisted_gate" } })
      } })
    const prepareContinuation: typeof prepareContinuationBase = input => observe("continue_after_analyze",
      () => prepareContinuationBase(input))
    const gateContinuationBase = createScheduledAutomationGateContinuation({ pool: pool as never, commandPort, waitPort,
      nativeQuestionWaitEnabled: false, fetcher: tracedFetcher })
    const gateContinuation: typeof gateContinuationBase = async input => {
      const mode = "mode" in input && input.mode === "resume_audit" ? "resume_audit" : "append_audit"
      const result = await observe(
        mode === "resume_audit" ? "continue_after_gate.resume_audit" : "continue_after_gate.append_audit",
        () => gateContinuationBase(input))
      if (afterAuditWait && result.status === "waiting_for_dependency") {
        await afterAuditWait(input.recoveryStepId, mode)
      }
      if (afterAuditCompletion && result.status === "completed") {
        await afterAuditCompletion(input.recoveryStepId, mode)
      }
      return result
    }
    const checkRootCompletion = rootStore.checkCompletion
    if (typeof checkRootCompletion !== "function") throw new Error("Scheduled Audit fixture requires the production root completion verifier")
    const baseCompletionGate: NonNullable<TurnEngineOptions["completionGate"]> = async () => observe("root.completion_verifier",
      () => checkRootCompletion.call(rootStore, { lease, rootTaskId: fixture.ids.rootTaskId, taskGraphVerification: true }),
      result => result.ok ? "allowed" : "blocked")
    const completionGate = attachScheduledPipelineCompletion({ gate: baseCompletionGate, owner,
      async bridge() {
        const attestation = await observe("pipeline.bridge", () => fixture.reattestCurrentTurn(lease), () => "reattested")
        return { status: "ready" as const, attestation }
      },
      continueAfterAnalyze: prepareContinuation, continueAfterGate: gateContinuation, fetcher: tracedFetcher,
      stageCandidate: input => observe("candidate.stage", () => candidateStore.stage(input), () => "staged"),
      onWebAccepted() { phases.push({ phase: "web.accepted", outcome: "called" }) },
      rootAttemptCount: owner.rootAttemptCount, recoveredCandidate })
    const profile: ModelAdapter["profile"] = { provider: "fixture", model: "scheduled-audit-root", nativeTools: true,
      structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false,
      supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false,
      supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null,
      maxOutputTokens: 128, costClass: "low" }
    const model: ModelAdapter = { id: "scheduled-audit-root", profile,
      async *stream() { throw new Error("scheduled Audit root candidate replay unexpectedly called the model") } }
    const options: TurnEngineOptions = { lease, rootTaskId: fixture.ids.rootTaskId, taskId: fixture.ids.rootTaskId,
      scope: { userId: fixture.ids.userId }, goal: "Complete the verified scheduled automation",
      snapshot: { system: [], profile: [], steerHistory: [], toolObservations: [],
        businessRefs: fixture.preparedJobIds.map(id => ({ id, kind: "job" as const, ownerId: fixture.ids.userId })) },
      contextBuilder: { async build(request) { return { schemaVersion: "agent-harness.v2", sessionId: request.sessionId,
        turnId: request.turnId, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "{}" } } },
      store, model, tools: [], executeTool: async ({ call }) => ({ id: call.id, toolName: call.toolName,
        toolVersion: call.toolVersion, status: "completed", errorCode: null }), completionGate,
      recoveredFinalCandidate: recoveredCandidate.candidateText,
      resume: { nextOrdinal: resumeOrdinal + 1, stepCount: resumeOrdinal + 1,
        toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: [],
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } }
    return new TurnEngine(options).run()
  }
  let result: TurnEngineResult
  try { result = await run() }
  catch (error: unknown) {
    throw new Error(`Scheduled Audit root failed with redacted diagnostics: ${JSON.stringify({ ...errorDiagnostic(error), phases })}`)
  }
  if (expectedStatus && result.status !== expectedStatus) {
    const row = debugRecord(result), status = typeof result.status === "string" && safeStatuses.has(result.status) ? result.status : "unknown"
    const errorCode = typeof row?.errorCode === "string" && safeErrorCodes.has(row.errorCode) ? row.errorCode : "unknown"
    throw new Error(`Scheduled Audit root returned an unexpected outcome: ${JSON.stringify({ status, errorCode, phases })}`)
  }
  return result
}

async function readScheduledAuditRootRecoveryTrace(fixture: Fixture) {
  const sourceResult = await pool!.query<{ id: string; ordinal: number | string; status: string; inputTokens: number | string;
    outputTokens: number | string; estimatedCostUsd: number | string; consumedInputIds: unknown; modelProfileSnapshot: unknown }>(
    `SELECT "id", "ordinal", "status", "inputTokens", "outputTokens", "estimatedCostUsd", "consumedInputIds", "modelProfileSnapshot"
       FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
    [fixture.rootQuestionStepId, fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId])
  const sourceRow = sourceResult.rows[0]
  if (!sourceRow) throw new Error("scheduled Audit candidate source Step missing")
  const sourceUsage = numericUsage(sourceRow)
  if (!sourceUsage) throw new Error("scheduled Audit candidate source Step usage missing")
  const sourceStep = { ...sourceRow, ...sourceUsage }
  const candidateResult = await pool!.query<{ id: string; payload: unknown }>(
    `SELECT "id", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
       AND "type" = $4 AND "correlationId" = $5 ORDER BY "sequence" ASC`,
    [fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, SCHEDULED_PIPELINE_CANDIDATE_EVENT, fixture.rootQuestionStepId])
  const candidateEvent = candidateResult.rows[0]
  const candidatePayload = debugRecord(candidateEvent?.payload)
  if (!candidateEvent || !candidatePayload) throw new Error("scheduled Audit candidate source receipt missing")
  const recoveryResult = await pool!.query<{ id: string; ordinal: number | string; attempt: number; status: string;
    errorCode: string | null; inputTokens: number | string; outputTokens: number | string; estimatedCostUsd: number | string;
    consumedInputIds: unknown; modelProfileSnapshot: unknown }>(
    `SELECT "id", "ordinal", "attempt", "status", "errorCode", "inputTokens", "outputTokens", "estimatedCostUsd",
        "consumedInputIds", "modelProfileSnapshot" FROM "agent_steps"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "ordinal" > $4 ORDER BY "ordinal" ASC`,
    [fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, Number(sourceStep.ordinal)])
  const stepIds = recoveryResult.rows.map(step => step.id)
  const events = stepIds.length ? await pool!.query<{ id: string; type: string; payload: unknown; correlationId: string }>(
    `SELECT "id", "type", "payload", "correlationId" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
       AND "taskId" = $3 AND "correlationId" = ANY($4::text[]) ORDER BY "sequence" ASC`,
    [fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, stepIds]) : { rows: [] }
  const waits = stepIds.length ? await pool!.query<{ id: string; stepId: string; status: string; targetTaskIds: unknown;
    mode: string; idempotencyKey: string; result: unknown }>(
    `SELECT "id", "stepId", "status", "targetTaskIds", "mode", "idempotencyKey", "result" FROM "agent_wait_conditions"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "stepId" = ANY($4::text[])`,
    [fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, stepIds]) : { rows: [] }
  const steps = recoveryResult.rows.map(step => {
    const stepEvents = events.rows.filter(event => event.correlationId === step.id)
    const usage = numericUsage(step)
    if (!usage) throw new Error("scheduled Audit recovery Step usage missing")
    return { ...step, ...usage, marker: readScheduledPipelineRecoveryStepProfile(step.modelProfileSnapshot),
      startEvents: stepEvents.filter(event => event.type === "step.started"),
      completionEvents: stepEvents.filter(event => event.type === "step.completed"),
      waits: waits.rows.filter(wait => wait.stepId === step.id) }
  })
  return { sourceStep, candidateEvent, candidateEventCount: candidateResult.rows.length, candidatePayload, steps }
}

function numericUsage(value: unknown): { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null {
  const row = debugRecord(value)
  if (!row) return null
  const inputTokens = numericValue(row.inputTokens), outputTokens = numericValue(row.outputTokens)
  const estimatedCostUsd = numericValue(row.estimatedCostUsd)
  return inputTokens !== null && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && outputTokens !== null && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && estimatedCostUsd !== null && estimatedCostUsd >= 0
    ? { inputTokens, outputTokens, estimatedCostUsd } : null
}

function numericValue(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  if (typeof value === "string" && (!value || value.trim() !== value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function expectScheduledAuditRecoveryTrace(trace: Awaited<ReturnType<typeof readScheduledAuditRootRecoveryTrace>>,
  fixture: Fixture, stepCount: number, status: string, errorCode: string | null): void {
  expect(trace.sourceStep.id).toBe(fixture.rootQuestionStepId)
  expect(trace.candidateEventCount).toBe(1)
  expect(trace.sourceStep).toMatchObject({ inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018, consumedInputIds: [] })
  expect(trace.candidatePayload).toMatchObject({ finalStepId: fixture.rootQuestionStepId,
    finalStepOrdinal: Number(trace.sourceStep.ordinal), candidateText: "Scheduled Gate integration candidate.",
    usage: { inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018 } })
  expect(trace.steps).toHaveLength(stepCount)
  for (const [index, step] of trace.steps.entries()) {
    const previousStepId = index === 0 ? fixture.rootQuestionStepId : trace.steps[index - 1]!.id
    expect(step).toMatchObject({ attempt: 1, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, consumedInputIds: [] })
    expect(step.id).not.toBe(fixture.rootQuestionStepId)
    expect(step.marker).toMatchObject({ kind: "scheduled_pipeline_recovery", recoveryStepId: step.id,
      recoveryCursor: index + 1, predecessorStepId: previousStepId, sourceStepId: fixture.rootQuestionStepId,
      sourceStepOrdinal: Number(trace.sourceStep.ordinal), sourceEventId: trace.candidateEvent.id,
      rootAttemptCount: fixture.owner.rootAttemptCount, owner: { userId: fixture.ids.userId,
        sessionId: fixture.ids.sessionId, turnId: fixture.ids.turnId, rootTaskId: fixture.ids.rootTaskId } })
    expect(step.startEvents).toHaveLength(1)
    expect(debugRecord(step.startEvents[0]?.payload)?.[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]).toMatchObject({
      recoveryStepId: step.id, sourceEventId: trace.candidateEvent.id,
    })
    expect(step.completionEvents).toHaveLength(1)
  }
  expect(trace.steps.at(-1)).toMatchObject({ status, errorCode })
}

async function readRootTurnState(fixture: Fixture): Promise<Readonly<{ turnStatus: string; turnLeaseOwnerId: string | null; sessionStatus: string;
  rootStatus: string; rootResult: Record<string, unknown> | null }>> {
  const result = await pool!.query<{ turnStatus: string; turnLeaseOwnerId: string | null; sessionStatus: string; rootStatus: string; rootResult: unknown }>(
    `SELECT turn."status" AS "turnStatus", turn."leaseOwnerId" AS "turnLeaseOwnerId",
       session."status" AS "sessionStatus", root."status" AS "rootStatus", root."result" AS "rootResult"
       FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
       JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2 AND root."id" = $3`,
    [fixture.ids.turnId, fixture.ids.sessionId, fixture.ids.rootTaskId])
  const row = result.rows[0]
  if (!row) throw new Error("scheduled Audit root Turn state missing")
  return { turnStatus: row.turnStatus, turnLeaseOwnerId: row.turnLeaseOwnerId, sessionStatus: row.sessionStatus,
    rootStatus: row.rootStatus, rootResult: debugRecord(row.rootResult) }
}

async function waitForAuditRetryDue(taskId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = (await pool!.query<{ status: string; attemptCount: number; hasNextAttempt: boolean; retryDue: boolean }>(
      `SELECT "status", "attemptCount", "nextAttemptAt" IS NOT NULL AS "hasNextAttempt",
        COALESCE("nextAttemptAt" <= clock_timestamp(), false) AS "retryDue"
       FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])).rows[0]
    if (!row) throw new Error("scheduled Audit retry task missing while waiting for due time")
    if (row.status !== "queued" || row.attemptCount !== 1 || !row.hasNextAttempt) {
      throw new Error("scheduled Audit retry did not retain its queued first-attempt state")
    }
    if (row.retryDue) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error("scheduled Audit retry did not become due according to the PostgreSQL clock")
}

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
  const customRoleLookups: CustomAgentRoleLookup[] = []
  const customModelCalls: string[] = []
  const fixtureWebDb = await vi.importActual<FixtureWebDatabase>(scheduledWebDbPath)
  const databaseWithoutCustomAgents = new Proxy(fixtureWebDb.db, {
    get(target, property, receiver) {
      if (property !== "customAgentRole") return Reflect.get(target, property, receiver)
      const delegate = Reflect.get(target, property, target)
      if (!delegate || typeof delegate !== "object") return delegate
      return new Proxy(delegate, {
        get(delegateTarget, operation, delegateReceiver) {
          if (operation !== "findMany") return Reflect.get(delegateTarget, operation, delegateReceiver)
          return async (args: unknown) => {
            const where = debugRecord(debugRecord(args)?.where)
            if (where?.userId !== fixture.ids.userId || where.enabled !== true || typeof where.insertAfter !== "string") {
              throw new Error("scheduled Audit fixture custom role lookup escaped its empty user scope")
            }
            customRoleLookups.push({ userId: fixture.ids.userId, insertAfter: where.insertAfter, enabled: true })
            return []
          }
        },
      })
    },
  })
  vi.doMock(scheduledWebDbPath, () => ({ ...fixtureWebDb, db: databaseWithoutCustomAgents }))
  vi.doMock(scheduledModelRouterPath, () => ({ APPLYMATE_BACKING: "fixture",
    loadUserAiConfig: async () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-audit-route" }),
    resolveConfig: () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-audit-route" }),
    modelChat: vi.fn(async (_messages: unknown, config: unknown) => {
      const feature = debugRecord(config)?.usageFeatureKey
      if (typeof feature === "string" && feature.startsWith("custom_")) customModelCalls.push(feature)
      return { text: "fixture model response" }
    }) }))
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
  type AuditChildFenceProbe = {
    lockScheduledTaskGraphAuditChildFence(tx: unknown, input: unknown): Promise<unknown>
    scheduledTaskGraphAuditChildFenceIsCurrent(tx: unknown, input: unknown): Promise<boolean>
  }
  const auditChildFence = await vi.importActual<AuditChildFenceProbe>(scheduledTaskGraphAuditChildFencePath)
  vi.doMock(scheduledTaskGraphAuditChildFencePath, () => ({
    ...auditChildFence,
    lockScheduledTaskGraphAuditChildFence: async (tx: unknown, input: unknown) => {
      try {
        const result = await auditChildFence.lockScheduledTaskGraphAuditChildFence(tx, input)
        continuation.ownerCurrentRecheck = result ? "current" : "rejected"
        return result
      } catch (error) { continuation.ownerCurrentRecheck = "threw"; throw error }
    },
    scheduledTaskGraphAuditChildFenceIsCurrent: async (tx: unknown, input: unknown) => {
      try {
        const result = await auditChildFence.scheduledTaskGraphAuditChildFenceIsCurrent(tx, input)
        continuation.ownerCurrentRecheck = result ? "current" : "rejected"
        return result
      } catch (error) { continuation.ownerCurrentRecheck = "threw"; throw error }
    },
  }))
  type AuditPrepareSourceProbe = {
    validateScheduledTaskGraphAuditPrepareSource(input: unknown): Promise<boolean>
  }
  const auditPrepareSource = await vi.importActual<AuditPrepareSourceProbe>(scheduledTaskGraphAuditPrepareSourcePath)
  vi.doMock(scheduledTaskGraphAuditPrepareSourcePath, () => ({
    ...auditPrepareSource,
    validateScheduledTaskGraphAuditPrepareSource: async (input: unknown) => {
      try {
        const result = await auditPrepareSource.validateScheduledTaskGraphAuditPrepareSource(input)
        continuation.prepareWait = result ? "current" : "rejected"
        return result
      } catch (error) { continuation.prepareWait = "threw"; throw error }
    },
  }))
  type GateInputProbe = {
    loadScheduledTaskGraphGateInput(input: unknown): Promise<unknown>
    scheduledTaskGraphAnalyzeCheckpointForGate(value: unknown): Record<string, unknown> | null
    isScheduledTaskGraphGateProofCurrent(input: unknown, tx: unknown): Promise<boolean>
    isScheduledTaskGraphAuditChildGateProofCurrent(input: unknown, tx: unknown): Promise<boolean>
  }
  const gateInput = await vi.importActual<GateInputProbe>(scheduledTaskGraphGateInputPath)
  vi.doMock(scheduledTaskGraphGateInputPath, () => ({
    ...gateInput,
    isScheduledTaskGraphAuditChildGateProofCurrent: async (input: unknown, tx: unknown) => {
      try {
        const result = await gateInput.isScheduledTaskGraphAuditChildGateProofCurrent(input, tx)
        continuation.gateProofCurrent = result ? "current" : "rejected"
        return result
      } catch (error) { continuation.gateProofCurrent = "threw"; throw error }
    },
  }))
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
    parseScheduledTaskGraphActionRequest(value: unknown): unknown
    scheduledTaskGraphExecuteGateCompletionProof(value: unknown): Record<string, unknown> | null
    scheduledTaskGraphAuditExecutionOwner(request: { owner: AuditRequestOwner }, proof: unknown): AuditExecutionOwner | null
  }>("@/lib/agent/scheduled-taskgraph-gate-rpc")
  const diagnosticWebDb = await vi.importActual<{
    db: { $transaction<T>(work: (tx: DiagnosticAuditReader) => Promise<T>): Promise<T> }
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
              const loadedArtifactRefs = Array.isArray(materials) ? materials.map(value => {
                const row = debugRecord(value)
                return row ? { jobId: row.jobId, kind: row.kind, artifactRef: row.artifactRef } : null
              }) : null
              continuation.preparedArtifactRefs = persistedArtifacts === undefined ? "not_present"
                : loadedArtifactRefs ? debugExactJson(persistedArtifacts, loadedArtifactRefs) ? "matches"
                  : debugSameJson(persistedArtifacts, loadedArtifactRefs) ? "order_only_mismatch" : "mismatch" : "unavailable"
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
  disconnectWebDatabase = () => fixtureWebDb.db.$disconnect()
  const inspectAuditPreflight = async (body: Record<string, unknown>): Promise<AuditPreflightDiagnostics> => {
    const diagnostic = emptyAuditPreflight()
    try {
      const parsed = debugRecord(gateRpc.parseScheduledTaskGraphActionRequest(body))
      if (!isAuditAction(parsed)) return diagnostic
      const completion = gateRpc.scheduledTaskGraphExecuteGateCompletionProof(parsed.gateCompletionProof)
      diagnostic.gateCompletionProofValid = completion !== null
      if (!completion) return diagnostic
      const owner = gateRpc.scheduledTaskGraphAuditExecutionOwner({ owner: parsed.owner }, completion)
      diagnostic.executionOwnerDerived = owner !== null
      diagnostic.prepareProofCanonicalMatch = debugSameJson(completion.prepareProof, parsed.prepareProof)
      if (!owner) return diagnostic
      const gate = debugRecord(completion.gate)
      if (!gate || typeof gate.taskId !== "string" || !Number.isSafeInteger(gate.attemptCount)) return diagnostic
      await diagnosticWebDb.db.$transaction(async tx => {
        let analyzeCheckpoint: Record<string, unknown> | null = null
        let persistedState: Record<string, unknown> | null = null
        try {
          const execution = debugRecord(await tx.agentExecution.findFirst({
            where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId,
              attemptCount: owner.executionAttemptCount },
            select: { id: true, status: true, attemptCount: true, state: true },
          }))
          persistedState = debugRecord(execution?.state)
          analyzeCheckpoint = gateInput.scheduledTaskGraphAnalyzeCheckpointForGate(persistedState)
          diagnostic.executionContext = analyzeCheckpoint ? "passed" : "rejected"
        } catch {
          diagnostic.executionContext = "threw"
        }
        if (persistedState) {
          const marker = debugRecord(persistedState.scheduledTaskGraphContinuation), claim = debugRecord(persistedState.scheduledTaskGraphClaim)
          let expectedKey: string | null = null
          try { expectedKey = continuationCheckpoint.scheduledTaskGraphContinuationKey(owner, parsed.attestation) } catch { /* closed diagnostic false */ }
          diagnostic.markerKeyMatches = expectedKey !== null && marker?.key === expectedKey
          diagnostic.claimKeyMatches = expectedKey !== null && claim?.key === expectedKey
          diagnostic.markerOwnerExact9Matches = diagnosticExactOwnerMatches(marker?.owner, owner)
          diagnostic.markerOwnerStable7Matches = diagnosticStableOwnerMatches(marker?.owner, owner)
          diagnostic.claimOwnerExact9Matches = diagnosticExactOwnerMatches(claim?.owner, owner)
          diagnostic.claimOwnerStable7Matches = diagnosticStableOwnerMatches(claim?.owner, owner)
          diagnostic.claimTokenValid = diagnosticValidId(claim?.claimToken)
          diagnostic.savedScheduledWaitIdMatchesRequest = persistedState.scheduledTaskGraphScheduledWaitId === parsed.scheduledWaitId
        }
        const prepareSourceTrace = emptyPrepareSourceReadTrace()
        const prepareSourceCapture = emptyPrepareSourceTraceCapture()
        const prepareReader = tracePrepareSourceReader(tx as unknown as PrepareSourceDbReader, prepareSourceTrace, prepareSourceCapture)
        const prepareSourceInput = { owner, snapshot: fixture.scheduleSnapshot, proof: parsed.prepareProof,
          ...(parsed.scheduledWaitId === undefined ? {} : { scheduledWaitId: parsed.scheduledWaitId }), reader: prepareReader }
        try {
          diagnostic.prepareSource = await auditPrepareSource.validateScheduledTaskGraphAuditPrepareSource(prepareSourceInput)
            ? "passed" : "rejected"
        } catch {
          diagnostic.prepareSource = "threw"
        }
        const decimalClass = (requireFromWeb("@prisma/client") as unknown as WebPrismaRuntime).Prisma.Decimal
        const webGraphHelperResult = await inspectActualWebRecoveryGraphHelper(prepareReader, prepareSourceCapture, owner)
        populateRecoveryDiagnostics(prepareSourceTrace, prepareSourceCapture, owner, webGraphHelperResult, decimalClass)
        diagnostic.prepareSourceTrace = prepareSourceTrace
        const gateProofInput = { owner, snapshot: fixture.scheduleSnapshot, analyzeCheckpoint,
          analyzeAttestation: parsed.attestation, prepareProof: parsed.prepareProof,
          gate: { taskId: gate.taskId, attemptCount: Number(gate.attemptCount), phase: "completed" as const,
            completionProof: parsed.gateCompletionProof }, auditActor: parsed.auditActor }
        try {
          diagnostic.gateProofCurrent = await gateInput.isScheduledTaskGraphAuditChildGateProofCurrent(gateProofInput, tx)
            ? "passed" : "rejected"
        } catch {
          diagnostic.gateProofCurrent = "threw"
        }
      })
    } catch {
      if (diagnostic.executionContext === "not_checked") diagnostic.executionContext = "threw"
    }
    return diagnostic
  }
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
    let auditPreflight = emptyAuditPreflight()
    expect(request.method).toBe("POST")
    expect(request.headers.get("x-agent-worker-secret")).toBe("scheduled-audit-fixture-secret")
    if (body.action === "scheduled_audit_execute") {
      auditPreflight = await inspectAuditPreflight(body)
      pipelineOutcome = "not_called"
      continuation = { gateResume: "not_called", analyzeCheckpoint: "not_checked", continuationKey: "not_checked", waitBinding: "not_checked",
        ownerCurrentRecheck: "not_checked", prepareWait: "not_checked", gateInputRecheck: "not_checked", gateProofCurrent: "not_checked",
        gateHandoff: "not_called", claimLease: "not_checked", storedStage: "not_checked", completionProof: "not_checked",
        completionPrepareProof: "not_checked", preparedArtifactRefs: "not_checked", gateDecisions: "not_checked",
        persistedGateDecisions: "not_checked", gateOutput: "not_checked",
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
    if (body.action === undefined) return response
    if (body.action !== "scheduled_audit_execute") throw new Error("scheduled Audit action invalid")
    executes += 1
    const auditActor = debugRecord(body.auditActor)
    if (!auditActor || Object.keys(auditActor).sort().join(",") !== "attemptCount,leaseOwner,taskId"
      || typeof auditActor.taskId !== "string") throw new Error("scheduled Audit actor invalid")
    const liveAuditTask = await taskState(auditActor.taskId)
    expect(liveAuditTask.status).toBe("running")
    expect(auditActor).toEqual({ taskId: auditActor.taskId, attemptCount: liveAuditTask.attemptCount,
      leaseOwner: liveAuditTask.leaseOwner })
    expect(liveAuditTask.attemptCount).toBe(executes)
    const payload = debugRecord(await response.clone().json().catch(() => null))
    const keys = payload ? Object.keys(payload).sort() : []
    const reportValid = payload !== null && parseScheduledAuditReport(payload.report) !== null
    if (!payload || response.status !== 200 || payload.status !== "completed" || keys.join(",") !== "report,status" || !reportValid) {
      const errorCode = typeof payload?.errorCode === "string" && diagnosticAuditFailureReasons.has(payload.errorCode)
        ? payload.errorCode : null
      const execution = await readExecutionFailureDiagnostic(fixture)
      executeHttpFailures.push({ status: response.status, errorCode, keys, reportValid, pipelineOutcome,
        auditPreflight, continuation: { ...continuation }, ...execution })
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
    const firstBody = debugRecord(firstExecuteRequest)
    const firstActor = debugRecord(firstBody?.auditActor)
    const currentRequest = { ...body }, firstRequest = { ...(firstBody ?? {}) }
    delete currentRequest.auditActor
    delete firstRequest.auditActor
    expect(currentRequest).toEqual(firstRequest)
    expect(auditActor.attemptCount).toBe(Number(firstActor?.attemptCount) + 1)
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
    customRoleLookups: () => [...customRoleLookups],
    customModelCalls: () => [...customModelCalls],
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
type PrepareSourceDbReader = {
  agentEvent: { findMany(args: unknown): Promise<readonly unknown[]> }
  agentStep: { findFirst(args: unknown): Promise<unknown>; findMany(args: unknown): Promise<readonly unknown[]> }
  agentItem: { findFirst(args: unknown): Promise<unknown>; findMany(args: unknown): Promise<readonly unknown[]> }
  agentWaitCondition: { findMany(args: unknown): Promise<readonly unknown[]> }
  subAgentTask: { findMany(args: unknown): Promise<readonly unknown[]> }
}
type WebRecoveryGraphHelperModule = Readonly<{
  isScheduledTaskGraphAuditRecoveryGraphItem(input: Readonly<{
    reader: PrepareSourceDbReader
    owner: AuditExecutionOwner
    stepId: string
    item: unknown
  }>): Promise<boolean>
}>

function emptyReadTraceCount(): ReadTraceCount { return { reached: false, rowCount: null } }
function emptyPrepareSourceReadTrace(): PrepareSourceReadTrace {
  return { receiptEvents: emptyReadTraceCount(), candidateEvents: emptyReadTraceCount(), sourceStepLookups: [], choiceItemLookups: [],
    tailSteps: { ...emptyReadTraceCount(), statuses: [] }, tailEvents: emptyReadTraceCount(), tailItems: emptyReadTraceCount(),
    tailWaits: emptyReadTraceCount(), targetTasks: emptyReadTraceCount(), graphProposalEvents: emptyReadTraceCount(),
    recoverySteps: [], waitEvidence: [], targetEvidence: [] }
}
function emptyPrepareSourceTraceCapture(): PrepareSourceTraceCapture {
  return { candidateEvents: [], sourceSteps: [], choiceItems: [], tailSteps: [], tailEvents: [], tailItems: [],
    tailWaits: [], targetTasks: [], graphProposalEvents: [] }
}
function tracePrepareSourceReader(reader: PrepareSourceDbReader, trace: PrepareSourceReadTrace,
  capture: PrepareSourceTraceCapture): PrepareSourceDbReader {
  return {
    agentEvent: { findMany: async args => {
      const where = debugRecord(debugRecord(args)?.where)
      const countTrace = eventReadTrace(where, trace)
      if (countTrace) beginReadTrace(countTrace)
      const rows = await reader.agentEvent.findMany(args)
      const count = Array.isArray(rows) ? rows.length : 0
      if (countTrace) completeReadTrace(countTrace, count)
      if (where?.type === 'native_verification.scheduled_candidate_staged') capture.candidateEvents = [...rows]
      else if (where?.type === 'item.delta' && where.actor === 'orchestrator' && Object.hasOwn(where, 'causationId')) {
        capture.graphProposalEvents = [...rows]
      } else if (debugRecord(where?.correlationId) && Array.isArray(debugRecord(where?.correlationId)?.in)) {
        capture.tailEvents = [...rows]
      }
      return rows
    } },
    agentStep: {
      findFirst: async args => {
        const lookup = { found: false, status: null as string | null, cursorType: 'pending' }
        trace.sourceStepLookups.push(lookup)
        const captureIndex = capture.sourceSteps.push(null) - 1
        const result = debugRecord(await reader.agentStep.findFirst(args))
        capture.sourceSteps[captureIndex] = result
        lookup.found = !!result
        lookup.status = safeRecoveryStatus(result?.status)
        lookup.cursorType = cursorType(result?.inputThroughSequence)
        return result
      },
      findMany: async args => {
        beginReadTrace(trace.tailSteps)
        const rows = await reader.agentStep.findMany(args)
        capture.tailSteps = [...rows]
        const statuses = rows.map(value => safeRecoveryStatus(debugRecord(value)?.status) ?? 'other')
        completeReadTrace(trace.tailSteps, rows.length)
        trace.tailSteps.statuses = statuses
        return rows
      },
    },
    agentItem: {
      findFirst: async args => {
        const lookup = { found: false, itemKeys: [] as string[], extraItemKeyCount: 0,
          contentKeys: [] as string[], extraContentKeyCount: 0 }
        trace.choiceItemLookups.push(lookup)
        const captureIndex = capture.choiceItems.push(null) - 1
        const result = debugRecord(await reader.agentItem.findFirst(args)), content = debugRecord(result?.content)
        capture.choiceItems[captureIndex] = result
        const itemFields = ['id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'content']
        const contentFields = ['waitKind', 'questionId', 'toolCallId', 'stage', 'question', 'options', 'answer', 'answerAvailable',
          'scheduledPrepareChoiceBinding', 'answeredAt']
        const keys = result ? Object.keys(result) : [], contentKeys = content ? Object.keys(content) : []
        lookup.found = !!result
        lookup.itemKeys = itemFields.filter(key => keys.includes(key))
        lookup.extraItemKeyCount = keys.filter(key => !itemFields.includes(key)).length
        lookup.contentKeys = contentFields.filter(key => contentKeys.includes(key))
        lookup.extraContentKeyCount = contentKeys.filter(key => !contentFields.includes(key)).length
        return result
      },
      findMany: async args => {
        beginReadTrace(trace.tailItems)
        const rows = await reader.agentItem.findMany(args)
        capture.tailItems = [...rows]
        completeReadTrace(trace.tailItems, rows.length)
        return rows
      },
    },
    agentWaitCondition: { findMany: async args => {
      beginReadTrace(trace.tailWaits)
      const rows = await reader.agentWaitCondition.findMany(args)
      capture.tailWaits = [...rows]
      completeReadTrace(trace.tailWaits, rows.length)
      return rows
    } },
    subAgentTask: { findMany: async args => {
      beginReadTrace(trace.targetTasks)
      const rows = await reader.subAgentTask.findMany(args)
      capture.targetTasks = [...rows]
      completeReadTrace(trace.targetTasks, rows.length)
      return rows
    } },
  }
}
function eventReadTrace(where: Record<string, unknown> | null, trace: PrepareSourceReadTrace): ReadTraceCount | null {
  if (where?.type === 'agent.plan.scheduled_prepare_binding') return trace.receiptEvents
  if (where?.type === 'native_verification.scheduled_candidate_staged') return trace.candidateEvents
  if (where?.type === 'item.delta' && where.actor === 'orchestrator' && Object.hasOwn(where, 'causationId')) {
    return trace.graphProposalEvents
  }
  if (debugRecord(where?.correlationId) && Array.isArray(debugRecord(where?.correlationId)?.in)) return trace.tailEvents
  return null
}
function beginReadTrace(trace: ReadTraceCount): void { trace.reached = true; trace.rowCount = null }
function completeReadTrace(trace: ReadTraceCount, rowCount: number): void { trace.rowCount = rowCount }
async function inspectActualWebRecoveryGraphHelper(reader: PrepareSourceDbReader, capture: PrepareSourceTraceCapture,
  owner: AuditExecutionOwner): Promise<Readonly<{ stepId: string | null; result: 'true' | 'false' | 'threw' | 'not_checked' }>> {
  const item = capture.tailItems.map(debugRecord).find(row => row?.type === TASK_GRAPH_ITEM_TYPE || row?.id === taskGraphItemId(owner.rootTaskId))
  const stepId = diagnosticValidId(item?.stepId) ? item.stepId : null
  if (!item || !stepId) return { stepId, result: 'not_checked' }
  try {
    const module = await vi.importActual<WebRecoveryGraphHelperModule>(
      "@/lib/agent/scheduled-taskgraph-audit-recovery-graph-item")
    type WebRecoveryReader = Parameters<typeof module.isScheduledTaskGraphAuditRecoveryGraphItem>[0]["reader"]
    const result = await module.isScheduledTaskGraphAuditRecoveryGraphItem({
      reader: reader as WebRecoveryReader,
      owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount,
        turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
      stepId,
      item,
    })
    return { stepId, result: result ? 'true' : 'false' }
  } catch { return { stepId, result: 'threw' } }
}
function populateRecoveryDiagnostics(trace: PrepareSourceReadTrace, capture: PrepareSourceTraceCapture,
  owner: AuditExecutionOwner, webGraphHelper: Readonly<{ stepId: string | null; result: 'true' | 'false' | 'threw' | 'not_checked' }>,
  decimalClass: PrismaDecimalClass): void {
  const sourceStep = capture.sourceSteps.map(debugRecord).find(Boolean) ?? null
  const sourceCandidate = sourceStep ? capture.candidateEvents.map(debugRecord).find(event => {
    const payload = debugRecord(event?.payload)
    return payload !== null && payload.finalStepId === sourceStep.id && payload.finalStepOrdinal === sourceStep.ordinal
      && event?.correlationId === sourceStep.id
  }) ?? null : null
  const sourcePayload = debugRecord(sourceCandidate?.payload)
  const sourceCursor = diagnosticCursor(sourceStep?.inputThroughSequence)
  const steps = capture.tailSteps.map(debugRecord).filter((row): row is Record<string, unknown> => row !== null)
  const rows = (values: readonly unknown[]) => values.map(debugRecord).filter((row): row is Record<string, unknown> => row !== null)
  const events = rows([...capture.tailEvents, ...capture.graphProposalEvents])
  const items = rows(capture.tailItems), waits = rows(capture.tailWaits), targets = rows(capture.targetTasks)
  const graphOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId }
  let previousId = typeof sourceStep?.id === 'string' ? sourceStep.id : null
  let previousOrdinal = sourceStep?.ordinal
  let previousCursor = sourceCursor
  let recoveryCursor = 0
  for (const step of steps) {
    const stepId = typeof step.id === 'string' ? step.id : null
    const markerProfile = debugRecord(step.modelProfileSnapshot)
    const markerExists = Boolean(markerProfile && Object.hasOwn(markerProfile, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY))
    const marker = readScheduledPipelineRecoveryStepProfile(step.modelProfileSnapshot)
    const stepCursor = diagnosticCursor(step.inputThroughSequence)
    const ownEvents = stepId ? events.filter(event => event.correlationId === stepId || event.causationId === stepId) : []
    const ownItems = stepId ? items.filter(item => item.stepId === stepId) : []
    const ownWaits = stepId ? waits.filter(wait => wait.stepId === stepId) : []
    const ownTargets = linkedRecoveryTargets(ownItems, ownWaits, targets)
    const classification = stepId ? classifyGraphItem(graphOwner, stepId, ownItems, ownEvents) : 'invalid'
    const cost = step.estimatedCostUsd
    const costString = safeString(cost)
    const decimalCost = cost instanceof decimalClass ? cost : null
    const prismaIsDecimal = typeof decimalClass.isDecimal === 'function' ? safeBoolean(() => decimalClass.isDecimal!(cost)) : null
    const decimalCostZero = decimalCost ? safeBoolean(() => decimalCost.isZero()) : false
    const started = ownEvents.filter(event => event.type === 'step.started')
    const completed = ownEvents.filter(event => event.type === 'step.completed')
    trace.recoverySteps.push({ step: { id: diagnosticValidId(step.id) ? step.id : null,
        taskId: diagnosticValidId(step.taskId) ? step.taskId : null, ordinal: Number.isSafeInteger(step.ordinal) ? Number(step.ordinal) : null,
        attempt: Number.isSafeInteger(step.attempt) ? Number(step.attempt) : null,
        status: safeRecoveryStatus(step.status) ?? 'other', errorCode: safeRecoveryErrorCode(step.errorCode),
        inputThroughSequence: stepCursor, consumedInputIds: diagnosticStringList(step.consumedInputIds),
        recoveryMarker: marker, usageTypes: { inputTokens: cursorType(step.inputTokens), outputTokens: cursorType(step.outputTokens),
        estimatedCostUsd: cursorType(cost), estimatedCostPrismaDecimalInstance: decimalCost !== null,
          estimatedCostPrismaIsDecimal: prismaIsDecimal } },
      status: safeRecoveryStatus(step.status) ?? 'other', taskMatchesRoot: step.taskId === owner.rootTaskId,
      ordinalValid: Number.isSafeInteger(step.ordinal) && Number(step.ordinal) > 0,
      ordinalAfterPredecessor: Number.isSafeInteger(step.ordinal) && Number.isSafeInteger(previousOrdinal)
        && Number(step.ordinal) > Number(previousOrdinal),
      attemptIsOne: step.attempt === 1, cursorType: cursorType(step.inputThroughSequence), hasValidCursor: stepCursor !== null,
      markerExists, markerValid: marker !== null,
      markerOwnerMatches: Boolean(marker && marker.owner.userId === owner.userId && marker.owner.sessionId === owner.sessionId
        && marker.owner.turnId === owner.turnId && marker.owner.rootTaskId === owner.rootTaskId),
      markerRootAttemptMatches: marker?.rootAttemptCount === owner.rootAttemptCount,
      markerSourceEventMatchesCandidate: Boolean(marker && sourceCandidate && marker.sourceEventId === sourceCandidate.id),
      markerSourceStepMatchesCandidate: Boolean(marker && sourcePayload && marker.sourceStepId === sourcePayload.finalStepId
        && marker.sourceStepId === sourceStep?.id),
      markerSourceOrdinalMatchesCandidate: Boolean(marker && sourcePayload && marker.sourceStepOrdinal === sourcePayload.finalStepOrdinal
        && marker.sourceStepOrdinal === sourceStep?.ordinal),
      markerSourceCursorMatchesDb: Boolean(marker && sourceCursor !== null && marker.sourceInputThroughSequence === sourceCursor),
      markerRecoveryStepMatchesDb: Boolean(marker && stepId && marker.recoveryStepId === stepId),
      markerRecoveryCursorMatchesChain: marker?.recoveryCursor === recoveryCursor + 1,
      markerPredecessorMatchesChain: Boolean(marker && previousId && marker.predecessorStepId === previousId),
      markerCursorMatchesDb: Boolean(marker && stepCursor !== null && marker.inputThroughSequence === stepCursor),
      markerCursorDoesNotRegress: Boolean(marker && previousCursor !== null && stepCursor !== null
        && BigInt(stepCursor) >= BigInt(previousCursor)),
      inputTokensType: cursorType(step.inputTokens), inputTokensZero: step.inputTokens === 0 || step.inputTokens === '0',
      outputTokensType: cursorType(step.outputTokens), outputTokensZero: step.outputTokens === 0 || step.outputTokens === '0',
       estimatedCostType: cursorType(cost), estimatedCostPrismaDecimalInstance: decimalCost !== null,
      estimatedCostPrismaIsDecimal: prismaIsDecimal, estimatedCostStringIsCanonicalZero: costString !== null && /^0(?:\.0+)?$/.test(costString),
       estimatedCostZeroByWorkerPredicate: cost === 0 || typeof cost === 'string' && /^0(?:\.0+)?$/.test(cost) || decimalCostZero === true,
      consumedInputIdsEmpty: diagnosticStringList(step.consumedInputIds)?.length === 0,
      startedEventCount: started.length, completedEventCount: completed.length,
      stepEvents: [...started, ...completed].map(event => recoveryEventDiagnostics(event, step, owner, marker, ownWaits)),
      graphItem: graphItemDiagnostics(graphOwner, stepId ?? '', ownItems, ownEvents, classification,
        webGraphHelper.stepId === stepId ? webGraphHelper.result : 'not_checked'),
      waitCount: ownWaits.length, targetCount: ownTargets.length,
    })
    trace.waitEvidence.push(...ownWaits.map(wait => waitDiagnostics(wait, stepId, owner, ownTargets)))
    trace.targetEvidence.push(...ownTargets.map(target => targetDiagnostics(target, owner)))
    if (stepId) previousId = stepId
    if (Number.isSafeInteger(step.ordinal)) previousOrdinal = Number(step.ordinal)
    if (marker) { previousCursor = marker.inputThroughSequence; recoveryCursor = marker.recoveryCursor }
  }
}
function classifyGraphItem(owner: { userId: string; sessionId: string; turnId: string; rootTaskId: string }, stepId: string,
  items: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[]): 'absent' | 'verified_plan' | 'invalid' {
  try { return classifyScheduledPipelineRecoveryGraphItem({ owner, stepId, items, events }) } catch { return 'invalid' }
}
function graphItemDiagnostics(owner: { userId: string; sessionId: string; turnId: string; rootTaskId: string }, stepId: string,
  items: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[], classification: 'absent' | 'verified_plan' | 'invalid',
  webHelperResult: 'true' | 'false' | 'threw' | 'not_checked') {
  const itemId = taskGraphItemId(owner.rootTaskId)
  const graphItems = items.filter(item => item.id === itemId || item.type === TASK_GRAPH_ITEM_TYPE)
  const matches = events.filter(event => graphProposalCandidate(event, itemId, stepId))
  const item = graphItems.length === 1 ? graphItems[0] : null
  const event = matches.length === 1 ? matches[0] : null
  const payload = debugRecord(event?.payload), dto = debugRecord(payload?.item), receipt = debugRecord(payload?.receipt)
  const nodes = Array.isArray(receipt?.nodes) ? receipt.nodes : []
  const node = nodes.length === 1 ? debugRecord(nodes[0]) : null
  const revision = payload?.revision
  const keys = ['content', 'fingerprint', 'item', 'kind', 'receipt', 'revision']
  const snapshot = safeTaskGraphSnapshot(payload?.content, owner.rootTaskId)
  const taskId = node?.taskId
  const auditNode = snapshot?.nodes[4]
  const eventEnvelopeValid = Boolean(event && event.sessionId === owner.sessionId && event.turnId === owner.turnId
    && event.taskId === owner.rootTaskId && event.itemId === itemId && event.type === 'item.delta' && event.actor === 'orchestrator'
    && event.correlationId === owner.turnId && event.causationId === stepId
    && typeof revision === 'number' && Number.isSafeInteger(revision)
    && event.idempotencyKey === taskGraphProposalKey(owner.rootTaskId, revision - 1))
  const proposalEnvelopeValid = Boolean(payload && exactDiagnosticKeys(payload, keys) && payload.kind === 'proposal'
    && typeof payload.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(payload.fingerprint)
    && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 2)
  const receiptValid = Boolean(receipt && exactDiagnosticKeys(receipt, ['nodes', 'readyTaskIds', 'revision', 'status'])
    && receipt.status === 'accepted' && receipt.revision === revision && node
    && exactDiagnosticKeys(node, ['key', 'status', 'taskId']) && node.key === SCHEDULED_AUDIT_TEMPLATE_ID && node.status === 'queued'
    && diagnosticValidId(taskId) && diagnosticArrayEquals(receipt.readyTaskIds, [taskId]))
  const dtoFields = ['completedAt', 'content', 'createdAt', 'id', 'phase', 'revision', 'schemaVersion', 'sessionId', 'startedAt',
    'status', 'stepId', 'taskId', 'turnId', 'type', 'updatedAt']
  const dtoValid = Boolean(dto && exactDiagnosticKeys(dto, dtoFields) && dto.schemaVersion === AGENT_STREAM_SCHEMA_VERSION
    && dto.id === itemId && dto.sessionId === owner.sessionId && dto.turnId === owner.turnId && dto.stepId === stepId
    && dto.taskId === owner.rootTaskId && dto.type === TASK_GRAPH_ITEM_TYPE && dto.status === 'streaming'
    && dto.phase === null && dto.completedAt === null && dto.revision === revision
    && validDiagnosticIso(dto.startedAt) && validDiagnosticIso(dto.createdAt) && validDiagnosticIso(dto.updatedAt))
  const itemValid = Boolean(item && item.id === itemId && item.sessionId === owner.sessionId && item.turnId === owner.turnId
    && item.stepId === stepId && item.taskId === owner.rootTaskId && item.type === TASK_GRAPH_ITEM_TYPE && item.status === 'streaming'
    && item.phase === null && typeof item.revision === 'number' && Number.isSafeInteger(item.revision)
    && typeof revision === 'number' && Number(item.revision) >= revision)
  return { classification, helperVerified: classification === 'verified_plan', webHelperResult, graphItemCount: graphItems.length,
    eventMatchCount: matches.length === 0 ? 'zero' : matches.length === 1 ? 'one' : 'many', itemValid, eventEnvelopeValid,
    proposalEnvelopeValid, receiptValid, snapshotValid: snapshot !== null, auditNodeValid: Boolean(snapshot && auditNode
      && auditNode.key === SCHEDULED_AUDIT_TEMPLATE_ID && auditNode.templateId === SCHEDULED_AUDIT_TEMPLATE_ID
      && auditNode.taskId === taskId && auditNode.depth === 5 && auditNode.goal === SCHEDULED_AUDIT_NODE_GOAL
      && canonicalEqual(auditNode.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA) && canonicalEqual(auditNode.dependsOn, ['gate'])
      && auditNode.verificationDisposition === 'specialized'), dtoValid,
    contentEqual: Boolean(payload && dto && item && canonicalEqual(payload.content, dto.content)
      && canonicalEqual(payload.content, item.content)),
    itemWitness: item ? { fieldKeys: ['id', 'sessionId', 'turnId', 'stepId', 'taskId', 'type', 'status', 'phase', 'revision', 'content']
        .filter(key => Object.hasOwn(item, key)), contentKeys: Object.keys(debugRecord(item.content) ?? {}).sort(),
      revision: Number.isSafeInteger(item.revision) ? Number(item.revision) : null,
      stepId: diagnosticValidId(item.stepId) ? item.stepId : null,
      taskId: diagnosticValidId(item.taskId) ? item.taskId : null, status: safeGraphItemStatus(item.status), phase: item.phase ?? null } : null,
    proposalWitness: event && payload ? { eventFieldKeys: ['id', 'sessionId', 'turnId', 'taskId', 'itemId', 'type', 'actor',
          'correlationId', 'causationId', 'idempotencyKey', 'payload'].filter(key => Object.hasOwn(event, key)),
      eventType: event.type === 'item.delta' ? 'item.delta' : 'other', actor: event.actor === 'orchestrator' ? 'orchestrator' : 'other',
      correlationId: diagnosticValidId(event.correlationId) ? event.correlationId : null,
      causationId: diagnosticValidId(event.causationId) ? event.causationId : null,
      payloadKeys: ['content', 'fingerprint', 'item', 'kind', 'receipt', 'revision'].filter(key => Object.hasOwn(payload, key)),
      revision: Number.isSafeInteger(revision) ? Number(revision) : null,
      fingerprintPresent: typeof payload.fingerprint === 'string', dtoKeys: dto ? Object.keys(dto).sort() : [],
      receiptKeys: receipt ? Object.keys(receipt).sort() : [], receiptStatus: receipt?.status === 'accepted' ? 'accepted' : 'other',
      receiptRevision: Number.isSafeInteger(receipt?.revision) ? Number(receipt?.revision) : null,
      receiptNodeKeys: node ? Object.keys(node).sort() : [], readyTaskCount: Array.isArray(receipt?.readyTaskIds) ? receipt.readyTaskIds.length : null,
      snapshotKeys: debugRecord(payload.content) ? Object.keys(debugRecord(payload.content)!).sort() : [],
      snapshotNodeKeys: snapshot ? snapshot.nodes.map(value => value.key) : [],
      keyMatchesExpected: eventEnvelopeValid } : null }
}
function graphProposalCandidate(event: Record<string, unknown>, itemId: string, stepId: string): boolean {
  const payload = debugRecord(event.payload), dto = debugRecord(payload?.item)
  return event.itemId === itemId || dto?.id === itemId
    || typeof event.idempotencyKey === 'string' && event.idempotencyKey.startsWith(`${itemId}:proposal:`)
    || event.type === 'item.delta' && event.causationId === stepId && payload?.kind === 'proposal'
}
function recoveryEventDiagnostics(event: Record<string, unknown>, step: Record<string, unknown>, owner: AuditExecutionOwner,
  marker: ReturnType<typeof readScheduledPipelineRecoveryStepProfile>, waits: readonly Record<string, unknown>[]) {
  const payload = debugRecord(event.payload), stepId = typeof step.id === 'string' ? step.id : null
  const eventType = ['step.started', 'step.completed', 'final.rejected', 'item.delta'].includes(String(event.type))
    ? String(event.type) : 'other'
  const allowedPayloadKeys = ['stepId', 'status', 'taskId', 'ordinal', 'waitId', 'errorCode', SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY,
    'kind', 'fingerprint', 'revision', 'item', 'receipt', 'content']
  const payloadKeys = payload ? Object.keys(payload) : []
  const isStepEvent = eventType === 'step.started' || eventType === 'step.completed'
  const expectedPayloadKeys = eventType === 'step.started'
    ? ['stepId', 'ordinal', 'taskId', SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]
    : eventType === 'step.completed'
      ? payload && Object.hasOwn(payload, 'errorCode') ? ['stepId', 'status', 'errorCode', 'taskId']
        : payload && Object.hasOwn(payload, 'waitId') ? ['stepId', 'status', 'taskId', 'waitId'] : ['stepId', 'status', 'taskId']
      : null
  const expectedStatus = step.status === 'waiting_for_tool' ? 'waiting_for_dependency' : step.status
  const waitId = payload?.waitId
  const payloadRecoveryMarker = payload?.[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]
  const safePayload: Record<string, unknown> = {}
  if (isStepEvent && payload) {
    for (const key of ['stepId', 'taskId', 'waitId']) if (typeof payload[key] === 'string') safePayload[key] = payload[key]
    if (Number.isSafeInteger(payload.ordinal)) safePayload.ordinal = Number(payload.ordinal)
    const status = safeCompletionStatus(payload.status)
    if (status) safePayload.status = status
    const errorCode = safeRecoveryErrorCode(payload.errorCode)
    if (errorCode) safePayload.errorCode = errorCode
    if (eventType === 'step.started' && marker) safePayload[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY] = marker
  }
  const expectedKey = !stepId ? null : eventType === 'step.started'
    ? `turn:${owner.turnId}:event:step-started:${stepId}`
    : eventType === 'step.completed' ? `turn:${owner.turnId}:event:step-completed:${stepId}` : null
  return { eventType, id: diagnosticValidId(event.id) ? event.id : null,
    actor: event.actor === 'orchestrator' ? 'orchestrator' : event.actor === 'system' ? 'system' : 'other',
    taskId: diagnosticValidId(event.taskId) ? event.taskId : null, itemId: event.itemId === null ? null
      : diagnosticValidId(event.itemId) ? event.itemId : 'other',
    correlationId: diagnosticValidId(event.correlationId) ? event.correlationId : null,
    causationId: !Object.hasOwn(event, 'causationId') ? 'not_selected'
      : diagnosticValidId(event.causationId) ? event.causationId : null,
    key: typeof event.idempotencyKey === 'string' && event.idempotencyKey.length <= 512 ? event.idempotencyKey : null,
    eventSessionScope: Object.hasOwn(event, 'sessionId') ? event.sessionId === owner.sessionId : 'not_selected',
    eventTurnScope: Object.hasOwn(event, 'turnId') ? event.turnId === owner.turnId : 'not_selected',
    eventScopeMatchesSelectedFields: event.taskId === owner.rootTaskId && event.correlationId === stepId
      && event.itemId === null && event.actor === 'orchestrator',
    keyMatchesExpected: expectedKey !== null && event.idempotencyKey === expectedKey,
    payloadKeys: allowedPayloadKeys.filter(key => payloadKeys.includes(key)),
    extraPayloadKeyCount: payloadKeys.filter(key => !allowedPayloadKeys.includes(key)).length,
    payloadKeysMatchExpected: expectedPayloadKeys !== null && !!payload && exactDiagnosticKeys(payload, expectedPayloadKeys),
    payloadStepMatches: payload?.stepId === stepId, payloadTaskMatchesRoot: payload?.taskId === owner.rootTaskId,
    payloadOrdinalMatches: eventType !== 'step.started' || payload?.ordinal === step.ordinal,
    payloadStatusMatches: eventType !== 'step.completed' || payload?.status === expectedStatus,
    payloadErrorCodeMatches: eventType !== 'step.completed' || !Object.hasOwn(payload ?? {}, 'errorCode')
      || payload?.errorCode === step.errorCode && step.errorCode === 'scheduled_audit_completion_unverified',
    payloadWaitIdMatchesOwnedWait: typeof waitId === 'string' && waits.some(wait => wait.id === waitId),
    payloadRecoveryMarkerMatchesProfile: eventType !== 'step.started' || Boolean(marker && debugSameJson(payloadRecoveryMarker, marker)),
    fixedPayload: safePayload }
}
function linkedRecoveryTargets(items: readonly Record<string, unknown>[], waits: readonly Record<string, unknown>[],
  targets: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const ids = new Set<string>()
  for (const wait of waits) for (const id of diagnosticStringList(wait.targetTaskIds) ?? []) ids.add(id)
  for (const item of items) {
    const content = debugRecord(item.content), binding = debugRecord(content?.scheduledGateChoiceBinding)
    if (diagnosticValidId(binding?.gateTaskId)) ids.add(binding.gateTaskId)
  }
  return targets.filter(target => typeof target.id === 'string' && ids.has(target.id))
}
function waitDiagnostics(wait: Record<string, unknown>, stepId: string | null, owner: AuditExecutionOwner,
  targets: readonly Record<string, unknown>[]) {
  const request = debugRecord(debugRecord(wait.result)?.request), targetIds = diagnosticStringList(wait.targetTaskIds)
  const matchedIds = diagnosticStringList(wait.matchedTaskIds), expectedOwnerKeys = ['userId', 'sessionId', 'turnId', 'parentTaskId', 'stepId']
  const requestKeys = request ? Object.keys(request) : []
  const gate = debugRecord(request?.scheduledGate)
  const targetRows = targets.filter(target => targetIds?.includes(String(target.id)))
  const auditTarget = targetRows.find(target => target.role === 'auditor' && target.taskType === SCHEDULED_AUDIT_TASK_TYPE)
  const maxAttempts = auditTarget?.maxAttempts
  let auditKeyMatches = false
  if (typeof wait.idempotencyKey === 'string' && diagnosticValidId(stepId) && diagnosticValidId(targetIds?.[0])) {
    const attempts = Number.isSafeInteger(maxAttempts) && Number(maxAttempts) > 0 && Number(maxAttempts) <= 32 ? Number(maxAttempts) : 32
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const digest = createHash('sha256').update(JSON.stringify([targetIds![0], stepId, attempt]), 'utf8').digest('hex')
      if (wait.idempotencyKey === `scheduled-audit-wait:${digest}`) auditKeyMatches = true
    }
  }
  return { id: diagnosticValidId(wait.id) ? wait.id : null, stepId: diagnosticValidId(wait.stepId) ? wait.stepId : null,
    ownerFields: expectedOwnerKeys.filter(key => Object.hasOwn(wait, key)),
    ownerMatches: { user: wait.userId === owner.userId, session: wait.sessionId === owner.sessionId,
      turn: wait.turnId === owner.turnId, parent: wait.parentTaskId === owner.rootTaskId, step: wait.stepId === stepId },
    mode: wait.mode === 'all' || wait.mode === 'any' ? wait.mode : 'other',
    status: wait.status === 'waiting' || wait.status === 'ready' ? wait.status : 'other',
    targetTaskIds: targetIds, targetIdsUnique: !!targetIds && new Set(targetIds).size === targetIds.length,
    matchedTaskIds: matchedIds, resultKeys: Object.keys(debugRecord(wait.result) ?? {}).filter(key => ['request', 'outcome'].includes(key)),
    requestKeys: ['mode', 'scheduledGate', 'targetTaskIds', 'timeoutMs'].filter(key => requestKeys.includes(key)),
    extraRequestKeyCount: requestKeys.filter(key => !['mode', 'scheduledGate', 'targetTaskIds', 'timeoutMs'].includes(key)).length,
    request: request ? { mode: request.mode === 'all' || request.mode === 'any' ? request.mode : 'other',
      targetTaskIds: diagnosticStringList(request.targetTaskIds),
      timeoutMs: Number.isSafeInteger(request.timeoutMs) ? Number(request.timeoutMs) : null,
      scheduledGate: gate ? { gateTaskId: diagnosticValidId(gate.gateTaskId) ? gate.gateTaskId : null,
        requestAttemptCount: Number.isSafeInteger(gate.requestAttemptCount) ? Number(gate.requestAttemptCount) : null } : null } : null,
    requestModeMatches: request?.mode === wait.mode, requestTargetsMatch: diagnosticArrayEquals(request?.targetTaskIds, targetIds ?? []),
    requestTimeoutValid: request?.timeoutMs === 86_400_000,
    scheduledGate: gate ? { gateTaskId: diagnosticValidId(gate.gateTaskId) ? gate.gateTaskId : null,
      requestAttemptCount: Number.isSafeInteger(gate.requestAttemptCount) ? Number(gate.requestAttemptCount) : null,
      keys: Object.keys(gate).filter(key => ['gateTaskId', 'requestAttemptCount'].includes(key)),
      extraKeyCount: Object.keys(gate).filter(key => !['gateTaskId', 'requestAttemptCount'].includes(key)).length } : null,
    auditKeyMatches, targetCount: targetRows.length }
}
function targetDiagnostics(target: Record<string, unknown>, owner: AuditExecutionOwner) {
  const session = debugRecord(target.session)
  return { id: diagnosticValidId(target.id) ? target.id : null,
    parentTaskId: diagnosticValidId(target.parentTaskId) ? target.parentTaskId : null,
    rootTaskId: diagnosticValidId(target.rootTaskId) ? target.rootTaskId : null,
    sessionId: diagnosticValidId(target.sessionId) ? target.sessionId : null,
    turnId: diagnosticValidId(target.turnId) ? target.turnId : null,
    role: ['auditor', 'prepare'].includes(String(target.role)) ? target.role : 'other',
    taskType: [SCHEDULED_AUDIT_TASK_TYPE, 'scheduled_taskgraph_gate', 'scheduled_application_prepare'].includes(String(target.taskType))
      ? target.taskType : 'other',
    taskStatus: target.status === 'queued' || target.status === 'running' || target.status === 'waiting'
      || target.status === 'completed' || target.status === 'failed' ? target.status : 'not_selected',
    depth: Number.isSafeInteger(target.depth) ? Number(target.depth) : null,
    maxAttempts: Number.isSafeInteger(target.maxAttempts) ? Number(target.maxAttempts) : null,
    sessionUserId: diagnosticValidId(session?.userId) ? session.userId : null,
    ownerMatches: target.parentTaskId === owner.rootTaskId && target.rootTaskId === owner.rootTaskId
      && target.sessionId === owner.sessionId && target.turnId === owner.turnId && session?.userId === owner.userId }
}
function safeCompletionStatus(value: unknown): string | null {
  return typeof value === 'string' && ['waiting_for_dependency', 'waiting_for_user', 'completed'].includes(value) ? value : null
}
function safeGraphItemStatus(value: unknown): string | null {
  return typeof value === 'string' && ['streaming', 'started', 'completed', 'waiting_for_tool', 'waiting_for_user'].includes(value)
    ? value : null
}
function safeGraphNodeKey(value: unknown): string {
  return typeof value === 'string' && ['scout', 'analyst', 'prepare', 'gate', SCHEDULED_AUDIT_TEMPLATE_ID].includes(value)
    ? value : 'other'
}
function safeRecoveryErrorCode(value: unknown): string | null {
  return value === 'scheduled_audit_completion_unverified' ? value : null
}
function safeTaskGraphSnapshot(value: unknown, rootTaskId: string) {
  try {
    const snapshot = parseTaskGraphSnapshot(value)
    const nodes = snapshot.nodes
    const templates = ['scout', 'analyst', 'prepare', 'gate', SCHEDULED_AUDIT_TEMPLATE_ID]
    const fixedKeys = ['prepare', 'gate', SCHEDULED_AUDIT_TEMPLATE_ID]
    const firstKeys = nodes.slice(0, 2).map(node => node.key)
    const keys = nodes.map(node => node.key)
    return canonicalEqual(value, snapshot) && nodes.length === 5
      && canonicalEqual(nodes.map(node => node.templateId), templates)
      && canonicalEqual(keys.slice(2), fixedKeys)
      && firstKeys.every(key => typeof key === 'string' && key.trim().length > 0 && key.length <= 128
        && !fixedKeys.includes(key))
      && new Set(keys).size === 5
      && nodes.every((node, index) => node.depth === index + 1
        && canonicalEqual(node.dependsOn, index === 0 ? [] : [nodes[index - 1]!.key]))
      && snapshot.nodes.every(node => diagnosticValidId(node.taskId) && node.taskId !== rootTaskId)
      && new Set(snapshot.nodes.map(node => node.taskId)).size === 5 ? snapshot : null
  } catch { return null }
}
function exactDiagnosticKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function diagnosticArrayEquals(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && canonicalEqual(value, expected)
}
function diagnosticCursor(value: unknown): string | null {
  const cursor = typeof value === 'bigint' || typeof value === 'number' ? String(value) : value
  if (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(cursor)) return null
  try { return BigInt(cursor) <= 9_223_372_036_854_775_807n ? cursor : null } catch { return null }
}
function diagnosticStringList(value: unknown): string[] | null {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null
}
function safeString(value: unknown): string | null { try { return value === null || value === undefined ? null : String(value) } catch { return null } }
function safeBoolean(callback: () => unknown): boolean | null { try { return Boolean(callback()) } catch { return null } }
function validDiagnosticIso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function cursorType(value: unknown): string { return value === null ? 'null' : typeof value }
function safeRecoveryStatus(value: unknown): string | null {
  return typeof value === 'string' && ['streaming', 'interrupted', 'waiting_for_tool', 'waiting_for_user', 'completed'].includes(value)
    ? value : null
}
function emptyAuditPreflight(): AuditPreflightDiagnostics {
  return { gateCompletionProofValid: false, executionOwnerDerived: false, prepareProofCanonicalMatch: false,
    executionContext: "not_checked", markerKeyMatches: false, claimKeyMatches: false,
    markerOwnerExact9Matches: false, markerOwnerStable7Matches: false, claimOwnerExact9Matches: false,
    claimOwnerStable7Matches: false, claimTokenValid: false, savedScheduledWaitIdMatchesRequest: false,
    prepareSource: "not_checked", prepareSourceTrace: emptyPrepareSourceReadTrace(), gateProofCurrent: "not_checked" }
}
function isAuditAction(value: Record<string, unknown> | null): value is AuditAction {
  return Boolean(value && value.action === "scheduled_audit_execute" && isAuditRequestOwner(value.owner)
    && Object.hasOwn(value, "attestation") && Object.hasOwn(value, "prepareProof") && Object.hasOwn(value, "gateCompletionProof")
    && isAuditActor(value.auditActor) && (value.scheduledWaitId === undefined || diagnosticValidId(value.scheduledWaitId)))
}
function isAuditRequestOwner(value: unknown): value is AuditRequestOwner {
  const row = debugRecord(value), keys = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"]
  return Boolean(row && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
    && [row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId].every(diagnosticValidId)
    && Number.isSafeInteger(row.rootAttemptCount) && Number(row.rootAttemptCount) > 0
    && Number.isSafeInteger(row.turnLeaseVersion) && Number(row.turnLeaseVersion) > 0)
}
function isAuditActor(value: unknown): value is AuditAction["auditActor"] {
  const row = debugRecord(value)
  return Boolean(row && Object.keys(row).length === 3 && Object.hasOwn(row, "taskId") && Object.hasOwn(row, "attemptCount")
    && Object.hasOwn(row, "leaseOwner") && diagnosticValidId(row.taskId) && diagnosticValidId(row.leaseOwner)
    && Number.isSafeInteger(row.attemptCount) && Number(row.attemptCount) > 0)
}
function diagnosticValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function diagnosticExactOwnerMatches(value: unknown, expected: AuditExecutionOwner): boolean {
  const row = debugRecord(value), fields = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount",
    "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"] as const
  return Boolean(row && Object.keys(row).length === fields.length && fields.every(field => Object.hasOwn(row, field)
    && row[field] === expected[field]))
}
function diagnosticStableOwnerMatches(value: unknown, expected: AuditExecutionOwner): boolean {
  const row = debugRecord(value), fields = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount",
    "executionId", "executionAttemptCount"] as const
  return Boolean(row && fields.every(field => row[field] === expected[field]))
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
async function taskState(taskId: string): Promise<{ status: string; attemptCount: number; result: unknown;
  failureReason: string | null; leaseOwner: string | null }> {
  const row = (await pool!.query<{ status: string; attemptCount: number; result: unknown; failureReason: string | null; leaseOwner: string | null }>(
    `SELECT "status", "attemptCount", "result", "failureReason", "leaseOwner" FROM "sub_agent_tasks" WHERE "id"=$1`, [taskId])).rows[0]
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
