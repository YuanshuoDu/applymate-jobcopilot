import type { Job } from '@prisma/client'
import { db } from '@/lib/db'
import { completedScheduledTaskGraphReport } from './scheduled-taskgraph-analysis-journal'
import { isScheduledTaskGraphGateProofCurrent } from './scheduled-taskgraph-gate-input'
import type { ScheduledTaskGraphExecuteRpcRequest } from './scheduled-taskgraph-gate-rpc'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey,
  type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { priorScheduledTaskGraphContinuation } from './scheduled-taskgraph-pipeline-fence'
import { validateScheduledPrepareWaitIdentity } from './scheduled-taskgraph-run-service'

type GateCompletion = Readonly<{ taskId: string; attemptCount: number }>
const completedReportKeys = ['processed', 'applied', 'queued', 'pending', 'skipped', 'failed', 'durationMs'] as const
type CompletedReportKey = typeof completedReportKeys[number]

/** Returns a completed replay only after read-only owner, report, Prepare, and Gate proof checks. */
export async function replayCompletedScheduledTaskGraphReport(request: ScheduledTaskGraphExecuteRpcRequest,
  gate: GateCompletion, signal?: AbortSignal): Promise<Response | null> {
  if (signal?.aborted) return blocked(409, 'scheduled_pipeline_turn_stale')
  try { return await replayPersistedCompletedReport(request, gate, signal) }
  catch { return blocked(409, 'scheduled_pipeline_execution_mismatch') }
}

async function replayPersistedCompletedReport(request: ScheduledTaskGraphExecuteRpcRequest, gate: GateCompletion,
  signal?: AbortSignal): Promise<Response | null> {
  const execution = await db.agentExecution.findFirst({ where: { userId: request.owner.userId, sessionId: request.owner.sessionId },
    select: { id: true, status: true, attemptCount: true, state: true } })
  if (execution?.status !== 'completed') return null
  if (!validId(execution.id) || !Number.isSafeInteger(execution.attemptCount) || execution.attemptCount < 0) {
    return blocked(409, 'scheduled_pipeline_execution_mismatch')
  }
  const owner: ScheduledTaskGraphPipelineOwner = { ...request.owner, executionId: execution.id, executionAttemptCount: execution.attemptCount }
  const [turn, root, session] = await Promise.all([
    db.agentTurn.findFirst({ where: { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId },
      select: { id: true, userId: true, sessionId: true, rootTaskId: true, source: true, executionMode: true, input: true, status: true,
        leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true } }),
    db.subAgentTask.findFirst({ where: { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
      parentTaskId: null, session: { userId: owner.userId } },
      select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, status: true, attemptCount: true,
        interruptRequestedAt: true, closedAt: true } }),
    db.agentSession.findFirst({ where: { id: owner.sessionId, userId: owner.userId }, select: { id: true, status: true } }),
  ])
  if (!turn || !root || !session || ['aborted', 'archived'].includes(session.status) || turn.userId !== owner.userId
    || turn.sessionId !== owner.sessionId || turn.rootTaskId !== owner.rootTaskId || root.id !== owner.rootTaskId
    || root.sessionId !== owner.sessionId || root.turnId !== owner.turnId || root.rootTaskId !== owner.rootTaskId
    || root.parentTaskId !== null || root.attemptCount !== owner.rootAttemptCount || root.status !== 'running'
    || root.interruptRequestedAt || root.closedAt) return blocked(409, 'scheduled_pipeline_owner_mismatch')
  const input = record(turn.input)
  let snapshot: ReturnType<typeof parseScheduledAutomationSnapshot> | null = null
  if (input?.automationRunMode === 'scheduled') try { snapshot = parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot) } catch { /* invalid snapshot */ }
  if (turn.source !== 'automation' || turn.executionMode !== 'canonical_task_graph' || !snapshot) {
    return blocked(409, 'scheduled_pipeline_mode_mismatch')
  }
  if (!reportLeaseCurrent(turn, owner)) return blocked(409, 'scheduled_pipeline_turn_stale')
  const state = record(execution.state), ids = candidateIds(request.attestation)
  if (!ids) return blocked(409, 'scheduled_pipeline_attestation_invalid')
  if (!state || state.nextStage !== 'completed') return blocked(409, 'scheduled_pipeline_execution_mismatch')
  let key: string
  try { key = scheduledTaskGraphContinuationKey(owner, request.attestation) }
  catch { return blocked(409, 'scheduled_pipeline_attestation_invalid') }
  if (record(request.attestation)?.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot)) {
    return blocked(409, 'scheduled_pipeline_snapshot_mismatch')
  }
  const jobs = await db.job.findMany({ where: { userId: owner.userId, id: { in: ids } } }) as Job[]
  if (jobs.length !== ids.length || new Set(jobs.map(job => job.id)).size !== ids.length) return blocked(409, 'scheduled_pipeline_jobs_mismatch')
  const storedWaitId = state.scheduledTaskGraphScheduledWaitId
  if (!snapshot.requireApproval && (storedWaitId !== undefined || request.scheduledWaitId !== undefined)
    || snapshot.requireApproval && storedWaitId === undefined
    || storedWaitId !== undefined && (!validId(storedWaitId) || request.scheduledWaitId !== storedWaitId)) {
    return blocked(409, 'scheduled_pipeline_claim_conflict')
  }
  if (!await validateScheduledPrepareWaitIdentity({ owner, snapshot, proof: request.prepareProof,
    ...(request.scheduledWaitId ? { scheduledWaitId: request.scheduledWaitId } : {}) }).catch(() => false)) {
    return blocked(409, 'scheduled_pipeline_claim_conflict')
  }
  const exact = completedScheduledTaskGraphReport({ execution, key, owner, snapshot, attestation: request.attestation, ownedJobs: jobs })
  const prior = exact ? null : priorScheduledTaskGraphContinuation({ state, owner, snapshot, attestation: request.attestation, ownedJobs: jobs })
  if (prior && (prior.owner.executionId !== owner.executionId || prior.owner.executionAttemptCount !== owner.executionAttemptCount)) {
    return blocked(409, 'scheduled_pipeline_execution_mismatch')
  }
  const report = exact ?? (prior && completedScheduledTaskGraphReport({ execution, key: prior.key, owner: prior.owner, snapshot,
    attestation: request.attestation, ownedJobs: jobs, checkpointValidatedByPrior: true }))
  if (!isExactCompletedReport(report)) return blocked(409, 'scheduled_pipeline_execution_mismatch')
  const proofCurrent = await db.$transaction(tx => isScheduledTaskGraphGateProofCurrent({ owner, snapshot, analyzeCheckpoint: state,
    analyzeAttestation: request.attestation, prepareProof: request.prepareProof,
    gate: { taskId: gate.taskId, attemptCount: gate.attemptCount, phase: 'completed', completionProof: request.gateCompletionProof } }, tx)).catch(() => false)
  if (signal?.aborted) return blocked(409, 'scheduled_pipeline_turn_stale')
  return proofCurrent ? Response.json({ status: 'completed', report }) : blocked(409, 'scheduled_pipeline_gate_proof_invalid')
}

function reportLeaseCurrent(value: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const turn = record(value), expiry = turn?.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
    : typeof turn?.leaseExpiresAt === 'string' ? Date.parse(turn.leaseExpiresAt) : Number.NaN
  return Boolean(turn && turn.leaseVersion === owner.turnLeaseVersion && (['in_progress', 'waiting_for_user'].includes(String(turn.status))
    && turn.leaseOwnerId === owner.turnLeaseOwnerId ? Number.isFinite(expiry) && expiry > Date.now()
    : ['waiting_for_user', 'completed'].includes(String(turn.status)) && turn.leaseOwnerId === null && turn.leaseExpiresAt === null))
}
function candidateIds(attestation: unknown): string[] | null {
  const ids = record(record(attestation)?.scout)?.candidateJobIds
  return Array.isArray(ids) && ids.length <= 100 && ids.every(validId) && new Set(ids).size === ids.length ? [...ids] : null
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function isExactCompletedReport(value: unknown): value is Record<CompletedReportKey, number> {
  const report = record(value), keys = report ? Reflect.ownKeys(report) : []
  if (!report || keys.length !== completedReportKeys.length || !keys.every(key => typeof key === 'string'
    && completedReportKeys.includes(key as CompletedReportKey) && Object.prototype.propertyIsEnumerable.call(report, key))) return false
  return completedReportKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(report, key)
    return Boolean(descriptor && 'value' in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0)
  })
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function blocked(status: number, errorCode: string): Response { return Response.json({ status: 'blocked', errorCode }, { status }) }
