import { Prisma, type Job } from '@prisma/client'
import { db } from '@/lib/db'
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from '@/lib/model-router'
import { hasEffectiveEntitlement, isFeatureAllowed, resolveAiAccess } from '@/lib/entitlements'
import { pipelineAgentConfigFrom } from '@/app/api/agent/run/run-helpers'
import { automationRunOverrides, withAutomationOverrides } from './automation-overrides'
import { resumeToText } from './types'
import type { ResumeContent } from '@/lib/types'
import { loadRoleConfigs, toRoleConfigMap } from './role-config'
import { isActiveAccount } from './run-service-helpers'
import { AgentExecutionCancelledError } from './execution-control'
import { buildScheduledTaskGraphGateCheckpoint } from './scheduled-taskgraph-gate-checkpoint'
import { isScheduledTaskGraphGateProofCurrent, loadScheduledTaskGraphGateInput,
  scheduledTaskGraphAnalyzeCheckpointForGate } from './scheduled-taskgraph-gate-input'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey,
  type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { scheduledTaskGraphClaimMatches } from './scheduled-taskgraph-pipeline-fence'
import { replayCompletedScheduledTaskGraphReport } from './scheduled-taskgraph-completed-report-replay'
import { runScheduledGate } from './stages/gate'
import { executeScheduledTaskGraphGate } from './scheduled-taskgraph-gate-service'
import { scheduledTaskGraphExecuteGateCompletionProof,
  scheduledTaskGraphGateTaskLeaseIsCurrent, scheduledTaskGraphGateTurnIsCurrent,
  type ScheduledTaskGraphExecuteRpcRequest,
  type ScheduledTaskGraphGateRpcRequest } from './scheduled-taskgraph-gate-rpc'
import { validateScheduledPrepareWaitIdentity } from './scheduled-taskgraph-run-service'
import type { PipelineCtx } from './pipeline-context'

type GateAction = ScheduledTaskGraphGateRpcRequest | ScheduledTaskGraphExecuteRpcRequest
type ExecuteContinuation = Readonly<{ kind: 'execute'; request: ScheduledTaskGraphExecuteRpcRequest }>
type GateFailurePhase = 'owner_assertion' | 'gate_execution'
type GateFailureErrorClass = 'prisma_known_request_error' | 'agent_execution_cancelled' | 'type_error' | 'range_error'
  | 'syntax_error' | 'error' | 'non_error'
type GateFailureDiagnostic = Readonly<{ phase: GateFailurePhase; errorClass: GateFailureErrorClass; prismaCode?: string; safeErrorCode?: string }>
type TurnRow = { id: string; userId: string; sessionId: string; rootTaskId: string | null; source: string; executionMode: string | null;
  input: unknown; status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null }
type OwnerState = { owner: ScheduledTaskGraphPipelineOwner; key: string; snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>;
  state: Record<string, unknown>; claimToken: string; jobs: Job[]; waitId?: string }

const CLAIM_SCHEMA = 'agent-harness.v2.scheduled-pipeline-claim.v1'
const CLAIM_TTL_MS = 600_000
const GATE_SAFE_ERROR_CODES = ['scheduled_taskgraph_gate_result_invalid', 'application_review_session_scope_required'] as const
type GateSafeErrorCode = typeof GATE_SAFE_ERROR_CODES[number]

/** Runs the private Gate action or returns an Execute request after persisted proof validation. */
export async function runScheduledTaskGraphActionRpc(request: GateAction, signal?: AbortSignal): Promise<Response | ExecuteContinuation> {
  if (signal?.aborted) return blocked(409, 'scheduled_pipeline_turn_stale')
  return request.action === 'gate' ? runGateAction(request, signal) : authorizeExecute(request, signal)
}

async function runGateAction(request: ScheduledTaskGraphGateRpcRequest, signal?: AbortSignal): Promise<Response> {
  const turn = await db.agentTurn.findFirst({ where: { id: request.owner.turnId, userId: request.owner.userId,
    sessionId: request.owner.sessionId, rootTaskId: request.owner.rootTaskId }, select: { input: true } })
  const snapshot = scheduledSnapshot(turn?.input)
  if (!snapshot) return blocked(409, 'scheduled_pipeline_mode_mismatch')
  const denied = await admission(request.owner.userId, snapshot)
  if (denied) return denied

  const locked = await db.$transaction(tx => lockOwner(tx, request, signal, true))
  if (!locked) return blocked(409, 'scheduled_pipeline_turn_stale')
  const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(locked.state)
  const loaded = checkpoint && await loadScheduledTaskGraphGateInput({ owner: locked.owner, snapshot, analyzeCheckpoint: checkpoint,
    analyzeAttestation: request.attestation, prepareProof: request.prepareProof,
    gate: { taskId: request.gateTaskId, attemptCount: request.gateAttemptCount, phase: 'running' } })
  if (!loaded) return blocked(409, 'scheduled_pipeline_attestation_invalid')
  const handoff = buildScheduledTaskGraphGateCheckpoint({ analyze: { owner: locked.owner, snapshot, attestation: request.attestation,
    ownedJobs: locked.jobs, persistedCheckpoint: checkpoint, activeClaimToken: locked.claimToken }, proof: request.prepareProof,
    packages: loaded.packages, materials: loaded.materials })
  if (!handoff) return blocked(409, 'scheduled_pipeline_attestation_invalid')

  const assertCurrent = (tx: Prisma.TransactionClient) => assertGateActionCurrent(tx, request, locked, signal)
  const assertFenceCurrent = (tx: Prisma.TransactionClient) => assertGateActionCurrent(tx, request, locked, signal, loaded.materials)
  const assertFreshCurrent = async () => {
    if (signal?.aborted) return false
    const fresh = await loadScheduledTaskGraphGateInput({ owner: locked.owner, snapshot, analyzeCheckpoint: checkpoint,
      analyzeAttestation: request.attestation, prepareProof: request.prepareProof,
      gate: { taskId: request.gateTaskId, attemptCount: request.gateAttemptCount, phase: 'running' } })
    return Boolean(fresh && sameJson(materialRefs(fresh.materials), materialRefs(loaded.materials))
      && !signal?.aborted && await db.$transaction(assertCurrent))
  }
  const configured = await loadUserAiConfig(locked.owner.userId, 'autoApply')
  const aiConfig = configured.resolvedKey
    ? { ...configured, usageUserId: locked.owner.userId, usageFeatureKey: 'autoApply', usageRuntime: 'worker' as const }
    : { ...resolveConfig(APPLYMATE_BACKING), usageUserId: locked.owner.userId, usageFeatureKey: 'autoApply', usageRuntime: 'worker' as const }
  const agentConfig = await db.agentConfig.findUnique({ where: { userId: locked.owner.userId } })
  if (!agentConfig) return blocked(409, 'scheduled_pipeline_agent_unavailable')
  const resume = await db.resume.findFirst({ where: { userId: locked.owner.userId, isDefault: true } })
    ?? await db.resume.findFirst({ where: { userId: locked.owner.userId }, orderBy: { createdAt: 'desc' } })
  if (!resume) return blocked(409, 'scheduled_pipeline_resume_unavailable')
  const overrides = automationRunOverrides({ automation: snapshot })
  const roleConfigs = toRoleConfigMap(await loadRoleConfigs(locked.owner.userId))
  const context: PipelineCtx = {
    userId: locked.owner.userId, sessionId: locked.owner.sessionId, turnId: locked.owner.turnId,
    questionProjectionMode: 'canonical', agentCfg: withAutomationOverrides(pipelineAgentConfigFrom(agentConfig), overrides),
    roleConfigs, resumeText: resumeToText(resume.content as unknown as ResumeContent).slice(0, 2500),
    resumeContent: resume.content as unknown as ResumeContent,
    defaultResume: { id: resume.id, name: resume.name, templateId: resume.templateId ?? null,
      templateOptions: resume.templateOptions, directionId: resume.directionId ?? null, basicsDetached: resume.basicsDetached ?? false },
    aiConfig, executionAttempt: { id: locked.owner.executionId, attemptCount: locked.owner.executionAttemptCount },
    scheduledTaskGraphOwnerFence: { owner: locked.owner, key: locked.key, claimToken: locked.claimToken, assertCurrent: assertFenceCurrent },
    assertExecutionCurrent: assertFreshCurrent,
    autonomous: snapshot.autoApply, emit: () => undefined, signal,
  }
  let failurePhase: GateFailurePhase = 'owner_assertion'
  try {
    if (!await context.assertExecutionCurrent?.()) throw new AgentExecutionCancelledError()
    failurePhase = 'gate_execution'
    const result = await executeScheduledTaskGraphGate({ handoff, context,
      ...(request.validatedChoice !== undefined ? { validatedChoice: request.validatedChoice } : {}),
      priorChoices: request.priorChoices ?? [] }, runScheduledGate)
    return Response.json(result)
  } catch (error) {
    return blocked(error instanceof AgentExecutionCancelledError ? 409 : 500,
      error instanceof AgentExecutionCancelledError ? 'scheduled_pipeline_turn_stale' : 'scheduled_pipeline_execution_failed',
      gateFailureDiagnostic(failurePhase, error))
  }
}

async function authorizeExecute(request: ScheduledTaskGraphExecuteRpcRequest, signal?: AbortSignal): Promise<Response | ExecuteContinuation> {
  const proof = scheduledTaskGraphExecuteGateCompletionProof(request.gateCompletionProof), gate = record(proof?.gate)
  if (!proof || !gate || !sameJson(proof.prepareProof, request.prepareProof)) return blocked(409, 'scheduled_pipeline_gate_proof_invalid')
  const replay = await replayCompletedScheduledTaskGraphReport(request, { taskId: String(gate.taskId), attemptCount: Number(gate.attemptCount) }, signal)
  if (replay) return replay
  const locked = await db.$transaction(tx => lockOwner(tx, request, signal, false, {
    taskId: String(gate.taskId), attemptCount: Number(gate.attemptCount), completionProof: request.gateCompletionProof }))
  if (!locked) return blocked(409, 'scheduled_pipeline_gate_proof_invalid')
  return { kind: 'execute', request: { ...request, ...(locked.waitId ? { scheduledWaitId: locked.waitId } : {}) } }
}

async function lockOwner(tx: Prisma.TransactionClient, request: GateAction, signal?: AbortSignal, renew = false,
  gateCompletion?: { taskId: string; attemptCount: number; completionProof: unknown }): Promise<OwnerState | null> {
  if (signal?.aborted) return null
  const session = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_sessions"
    WHERE "id" = ${request.owner.sessionId} AND "userId" = ${request.owner.userId} FOR UPDATE
  `)
  if (signal?.aborted || session.length !== 1 || ['aborted', 'archived'].includes(session[0]!.status)) return null
  const turns = await tx.$queryRaw<TurnRow[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input", "status",
      "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
    WHERE "id" = ${request.owner.turnId} AND "userId" = ${request.owner.userId}
      AND "sessionId" = ${request.owner.sessionId} FOR UPDATE
  `)
  const turn = turns[0]
  if (!turn || turn.rootTaskId !== request.owner.rootTaskId || turn.source !== 'automation'
    || turn.executionMode !== 'canonical_task_graph'
    || !scheduledTaskGraphGateTurnIsCurrent(turn, { owner: request.owner,
      mode: request.action === 'gate' ? 'gate_child' : 'root_execute' })) return null
  const snapshot = scheduledSnapshot(turn.input)
  if (!snapshot) return null
  const roots = await tx.$queryRaw<Array<{ id: string; sessionId: string; turnId: string; rootTaskId: string;
    parentTaskId: string | null; status: string; attemptCount: number; interruptRequestedAt: Date | null; closedAt: Date | null }>>(Prisma.sql`
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "attemptCount", "interruptRequestedAt", "closedAt"
    FROM "sub_agent_tasks" WHERE "id" = ${request.owner.rootTaskId} AND "sessionId" = ${request.owner.sessionId}
      AND "turnId" = ${request.owner.turnId} AND "rootTaskId" = ${request.owner.rootTaskId} AND "parentTaskId" IS NULL FOR UPDATE
  `)
  const root = roots[0]
  if (!root || root.status !== 'running' || root.attemptCount !== request.owner.rootAttemptCount || root.interruptRequestedAt || root.closedAt) return null
  const taskId = request.action === 'gate' ? request.gateTaskId : gateCompletion!.taskId
  const attemptCount = request.action === 'gate' ? request.gateAttemptCount : gateCompletion!.attemptCount
  const gateRows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType", "status", "attemptCount",
      "maxAttempts", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "closedAt", "expectedOutputSchema", "allowedActions"
    FROM "sub_agent_tasks" WHERE "id" = ${taskId} AND "sessionId" = ${request.owner.sessionId}
      AND "turnId" = ${request.owner.turnId} AND "rootTaskId" = ${request.owner.rootTaskId} FOR UPDATE
  `)
  const gateTask = gateRows[0]
  if (request.action === 'gate' && !scheduledTaskGraphGateTaskLeaseIsCurrent(gateTask,
    { owner: request.owner, taskId, leaseOwnerId: request.gateLeaseOwnerId, attemptCount })) return null
  const executions = await tx.$queryRaw<Array<{ id: string; status: string; attemptCount: number; checkpoint: string; state: unknown }>>(Prisma.sql`
    SELECT "id", "status", "attemptCount", "checkpoint", "state" FROM "agent_executions"
    WHERE "userId" = ${request.owner.userId} AND "sessionId" = ${request.owner.sessionId} FOR UPDATE
  `)
  const execution = executions[0]
  if (signal?.aborted || !execution || execution.status !== 'running' || !Number.isSafeInteger(execution.attemptCount)) return null
  if (request.action === 'execute' && !liveRootLease(turn, request.owner)) return null
  const owner: ScheduledTaskGraphPipelineOwner = { ...request.owner, executionId: execution.id, executionAttemptCount: execution.attemptCount }
  let key: string
  try { key = scheduledTaskGraphContinuationKey(owner, request.attestation) } catch { return null }
  if (record(request.attestation)?.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot)) return null
  const state = record(execution.state), waitId = persistedPrepareWait(request, state, snapshot)
  if (waitId === null) return null
  const claim = record(state?.scheduledTaskGraphClaim), claimToken = claim?.claimToken
  if (!state || !['gate', 'execute', 'audit'].includes(String(state.nextStage)) || !validClaim(claim, owner, key, claimToken)
    || !scheduledTaskGraphClaimMatches(state, key, owner, claimToken as string)
    || request.action === 'gate' && state.nextStage !== 'gate') return null
  const continuation = record(state.scheduledTaskGraphContinuation)
  if (!continuation || continuation.key !== key || !sameLineageOwner(continuation.owner, owner)) return null
  const gate = request.action === 'gate'
    ? { taskId: request.gateTaskId, attemptCount: request.gateAttemptCount, phase: 'running' as const }
    : { taskId: gateCompletion!.taskId, attemptCount: gateCompletion!.attemptCount, phase: 'completed' as const, completionProof: gateCompletion!.completionProof }
  const proofInput = { owner, snapshot, analyzeCheckpoint: state, analyzeAttestation: request.attestation, prepareProof: request.prepareProof, gate }
  if (!await isScheduledTaskGraphGateProofCurrent(proofInput, tx)
    || !await validateScheduledPrepareWaitIdentity({ owner, snapshot, proof: request.prepareProof, ...(waitId ? { scheduledWaitId: waitId } : {}) }).catch(() => false)) return null
  const ids = candidateIds(request.attestation)
  if (!ids) return null
  const jobs = await tx.job.findMany({ where: { userId: owner.userId, id: { in: ids } } }) as Job[]
  if (jobs.length !== ids.length || new Set(jobs.map(job => job.id)).size !== ids.length) return null
  if (renew) {
    const now = new Date(), nextState = { ...state, scheduledTaskGraphClaim: { ...claim, claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS).toISOString() } }
    const update = await tx.agentExecution.updateMany({ where: { id: execution.id, userId: owner.userId, sessionId: owner.sessionId,
      status: 'running', attemptCount: owner.executionAttemptCount, state: { equals: state as Prisma.InputJsonValue } },
      data: { state: nextState as Prisma.InputJsonValue } })
    if (update.count !== 1) return null
    return { owner, key, snapshot, state: nextState, claimToken: claimToken as string, jobs, ...(waitId ? { waitId } : {}) }
  }
  return { owner, key, snapshot, state, claimToken: claimToken as string, jobs, ...(waitId ? { waitId } : {}) }
}

async function assertGateActionCurrent(tx: Prisma.TransactionClient, request: ScheduledTaskGraphGateRpcRequest, locked: OwnerState,
  signal: AbortSignal | undefined, expectedMaterials?: readonly { jobId: string; kind: string; artifactRef: unknown }[]): Promise<boolean> {
  if (signal?.aborted) return false
  const current = await lockOwner(tx, request, signal)
  if (!current || current.owner.executionId !== locked.owner.executionId || current.owner.executionAttemptCount !== locked.owner.executionAttemptCount
    || current.key !== locked.key || current.claimToken !== locked.claimToken) return false
  if (!expectedMaterials) return true
  const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(current.state)
  const fresh = checkpoint && await loadScheduledTaskGraphGateInput({ owner: current.owner, snapshot: current.snapshot,
    analyzeCheckpoint: checkpoint, analyzeAttestation: request.attestation, prepareProof: request.prepareProof,
    gate: { taskId: request.gateTaskId, attemptCount: request.gateAttemptCount, phase: 'running' } })
  return Boolean(fresh && sameJson(materialRefs(fresh.materials), materialRefs(expectedMaterials)))
}

async function admission(userId: string, snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>): Promise<Response | null> {
  if (!await isActiveAccount(userId)) return blocked(403, 'scheduled_pipeline_account_unavailable')
  if (!await isFeatureAllowed(userId, 'auto_apply')) return blocked(403, 'scheduled_pipeline_entitlement_required')
  const access = await resolveAiAccess(userId)
  if (access === 'disabled') return blocked(403, 'scheduled_pipeline_ai_unavailable')
  if (access === 'exhausted') return blocked(429, 'scheduled_pipeline_ai_budget_exhausted')
  if (snapshot.autoApply && !await hasEffectiveEntitlement(userId, 'auto_apply')) return blocked(403, 'scheduled_pipeline_entitlement_required')
  return null
}
function scheduledSnapshot(value: unknown) {
  const input = record(value)
  if (input?.automationRunMode !== 'scheduled') return null
  try { return parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot) } catch { return null }
}
function persistedPrepareWait(request: GateAction, state: Record<string, unknown> | null, snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>): string | undefined | null {
  const stored = state?.scheduledTaskGraphScheduledWaitId, supplied = request.scheduledWaitId
  if (stored !== undefined && (typeof stored !== 'string' || supplied !== undefined && supplied !== stored)) return null
  const id = typeof stored === 'string' ? stored : supplied
  if (!snapshot.requireApproval) return id === undefined ? undefined : null
  return typeof id === 'string' && id.startsWith(`agent-question:${request.owner.turnId}:canonical:`) ? id : null
}
function candidateIds(attestation: unknown): string[] | null {
  const scout = record(record(attestation)?.scout), ids = scout?.candidateJobIds
  return Array.isArray(ids) && ids.length <= 100 && ids.every(validId) && new Set(ids).size === ids.length ? [...ids] : null
}
function validClaim(claim: Record<string, unknown> | null, owner: ScheduledTaskGraphPipelineOwner, key: string, token: unknown): boolean {
  return Boolean(claim && Object.keys(claim).length === 6 && claim.schemaVersion === CLAIM_SCHEMA && claim.key === key
    && validId(token) && claim.claimToken === token && sameLineageOwner(claim.owner, owner)
    && typeof claim.claimedAt === 'string' && Number.isFinite(Date.parse(claim.claimedAt))
    && typeof claim.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(claim.leaseExpiresAt)))
}
function liveRootLease(turn: TurnRow, owner: ScheduledTaskGraphGateRpcRequest['owner']): boolean {
  return turn.status === 'in_progress' && turn.leaseOwnerId === owner.turnLeaseOwnerId && turn.leaseVersion === owner.turnLeaseVersion
    && turn.leaseExpiresAt instanceof Date && turn.leaseExpiresAt.getTime() > Date.now()
}
function sameLineageOwner(value: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const row = record(value)
  return Boolean(row && ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
    .every(key => row[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner]))
}
function materialRefs(rows: readonly { jobId: string; kind: string; artifactRef: unknown }[]) {
  return rows.map(row => [row.jobId, row.kind, row.artifactRef]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))
}
function sameJson(left: unknown, right: unknown): boolean { try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false } }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  const row = record(value)
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, canonical(row[key])])) : value
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function gateFailureDiagnostic(phase: GateFailurePhase, error: unknown): GateFailureDiagnostic {
  const safeErrorCode = error instanceof Error && GATE_SAFE_ERROR_CODES.includes(error.message as GateSafeErrorCode)
    ? error.message as GateSafeErrorCode : undefined
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaCode = /^P\d{4}$/.test(error.code) ? error.code : undefined
    return { phase, errorClass: 'prisma_known_request_error', ...(prismaCode ? { prismaCode } : {}),
      ...(safeErrorCode ? { safeErrorCode } : {}) }
  }
  const errorClass: GateFailureErrorClass = error instanceof AgentExecutionCancelledError ? 'agent_execution_cancelled'
    : error instanceof TypeError ? 'type_error' : error instanceof RangeError ? 'range_error'
      : error instanceof SyntaxError ? 'syntax_error' : error instanceof Error ? 'error' : 'non_error'
  return { phase, errorClass, ...(safeErrorCode ? { safeErrorCode } : {}) }
}
function blocked(status: number, errorCode: string, testDiagnostic?: GateFailureDiagnostic): Response {
  return Response.json({ status: 'blocked', errorCode,
    ...(process.env.NODE_ENV === 'test' && testDiagnostic ? { testDiagnostic } : {}) }, { status })
}
