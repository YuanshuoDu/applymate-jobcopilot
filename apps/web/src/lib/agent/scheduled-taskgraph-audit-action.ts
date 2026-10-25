import { Prisma, type Job } from '@prisma/client'
import { db } from '@/lib/db'
import { lockScheduledTaskGraphAuditChildFence, scheduledTaskGraphAuditChildFenceIsCurrent, type ScheduledTaskGraphAuditActor } from './scheduled-taskgraph-audit-child-fence'
import { createScheduledTaskGraphAuditChildOwnerFence, createScheduledTaskGraphOwnerFence, isScheduledTaskGraphAuditChildOwnerCurrent } from './scheduled-taskgraph-analysis-journal'
import { isScheduledTaskGraphOwnerCurrent, scheduledTaskGraphOwnerMatches } from './scheduled-taskgraph-pipeline-fence'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { isScheduledTaskGraphAuditChildGateProofCurrent, isScheduledTaskGraphGateProofCurrent,
  loadScheduledTaskGraphAuditChildGateInput, loadScheduledTaskGraphGateInput, type ScheduledTaskGraphGateInputRequest } from './scheduled-taskgraph-gate-input'
import { scheduledTaskGraphAuditExecutionOwner, scheduledTaskGraphExecuteGateCompletionProof,
  type ScheduledTaskGraphAuditExecuteRpcRequest } from './scheduled-taskgraph-gate-rpc'
import type { PipelineCtx } from './pipeline-context'
import { markScheduledTaskGraphAuditRuntime } from './scheduled-taskgraph-audit-runtime'

type AuditOwner = ScheduledTaskGraphPipelineOwner
type RootOwner = Pick<AuditOwner, 'userId' | 'sessionId' | 'turnId' | 'rootTaskId' | 'rootAttemptCount' | 'turnLeaseOwnerId' | 'turnLeaseVersion'>
const CLAIM_SCHEMA = 'agent-harness.v2.scheduled-pipeline-claim.v1'
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId',
  'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
export type ScheduledTaskGraphRequestOwner = RootOwner
export type ScheduledTaskGraphContinuationFence =
  | Readonly<{ mode: 'root'; owner: AuditOwner; key: string; claimToken: string }>
  | Readonly<{ mode: 'audit'; owner: AuditOwner; auditActor: ScheduledTaskGraphAuditActor; key: string; claimToken: string }>
export type ScheduledTaskGraphRunInput = Readonly<{
  owner: AuditOwner; snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string; ownedJobs: readonly Job[]
  prepareProof?: unknown; scheduledWaitId?: string; gateCompletionProof?: unknown
}> & (Readonly<{ action?: 'execute'; auditActor?: never }> | Readonly<{ action: 'scheduled_audit_execute'; auditActor: ScheduledTaskGraphAuditActor }>)
type ScheduledTaskGraphRunInputBase = Omit<ScheduledTaskGraphRunInput, 'action' | 'auditActor'>
export type ScheduledTaskGraphRunInputMode = Readonly<{ kind: 'root' }> | Readonly<{ kind: 'audit'; auditActor: ScheduledTaskGraphAuditActor }>
export type ScheduledTaskGraphGateResumeInput = Readonly<{
  owner: AuditOwner; snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string
  ownedJobs: readonly Job[]; persistedCheckpoint: unknown; prepareProof: unknown; scheduledWaitId?: string; gateCompletionProof?: unknown
}> & (Readonly<{ auditActor?: never }> | Readonly<{ auditActor: ScheduledTaskGraphAuditActor }>)
export { validateScheduledTaskGraphAuditPrepareSource } from './scheduled-taskgraph-audit-prepare-source'

export function scheduledTaskGraphRunContext(context: PipelineCtx, resumeState: PipelineCtx['resumeState'],
  scheduled?: ScheduledTaskGraphRunInput): PipelineCtx {
  const runContext = { ...context, resumeState }
  if (scheduled?.action === 'scheduled_audit_execute') markScheduledTaskGraphAuditRuntime(runContext)
  return runContext
}

export function scheduledTaskGraphRunInput(base: ScheduledTaskGraphRunInputBase, mode: ScheduledTaskGraphRunInputMode): ScheduledTaskGraphRunInput {
  return mode.kind === 'audit' ? { ...base, action: 'scheduled_audit_execute', auditActor: mode.auditActor } : base
}

/** Resolves the current persisted owner for an Audit child without trusting its historical Root lease. */
export function resolveScheduledTaskGraphAuditClaimOwner(input: {
  requestOwner: AuditOwner; proofOwner: AuditOwner | null; state: unknown; key: string; claimToken: unknown
}): AuditOwner | null {
  const state = record(input.state), claim = record(state?.scheduledTaskGraphClaim)
  const continuation = record(state?.scheduledTaskGraphContinuation)
  const requested = parseAuditOwner(input.requestOwner), proofOwner = parseAuditOwner(input.proofOwner)
  const claimOwner = parseAuditOwner(claim?.owner)
  const continuationOwner = parseAuditOwner(continuation?.owner)
  if (!requested || !proofOwner || !claim || !continuation || !claimOwner || !continuationOwner
    || !validId(input.key) || !validId(input.claimToken) || claim.schemaVersion !== CLAIM_SCHEMA
    || claim.key !== input.key || claim.claimToken !== input.claimToken
    || continuation.schemaVersion !== 'agent-harness.v2.scheduled-pipeline-continuation.v1' || continuation.key !== input.key
    || !scheduledTaskGraphOwnerMatches(continuation.owner, claimOwner)
    || !sameAuditStableOwner(proofOwner, requested) || !sameAuditStableOwner(claimOwner, requested)) return null
  return claimOwner
}

export function scheduledTaskGraphPrepareWaitId(request: { owner: { turnId: string }; scheduledWaitId?: string },
  state: Record<string, unknown> | null, requireApproval: boolean): string | undefined | null {
  const stored = state?.scheduledTaskGraphScheduledWaitId, supplied = request.scheduledWaitId
  if (stored !== undefined && (typeof stored !== 'string' || supplied !== undefined && supplied !== stored)) return null
  const id = typeof stored === 'string' ? stored : supplied
  if (!requireApproval) return id === undefined ? undefined : null
  return typeof id === 'string' && id.startsWith(`agent-question:${request.owner.turnId}:canonical:`) ? id : null
}

export function scheduledTaskGraphGateResumeOwnerIsCurrent(input: ScheduledTaskGraphGateResumeInput): Promise<boolean> {
  const fence = input.auditActor ? { mode: 'audit' as const, owner: input.owner, auditActor: input.auditActor,
    key: input.continuationKey, claimToken: input.claimToken }
    : { mode: 'root' as const, owner: input.owner, key: input.continuationKey, claimToken: input.claimToken }
  return scheduledTaskGraphContinuationOwnerIsCurrent(fence)
}

export function loadScheduledTaskGraphResumeGateInput(input: ScheduledTaskGraphGateResumeInput, analyzeCheckpoint: unknown,
  completionGate?: { taskId: string; attemptCount: number }) {
  const gateInput = { owner: input.owner, snapshot: input.snapshot, analyzeCheckpoint,
    analyzeAttestation: input.attestation, prepareProof: input.prepareProof,
    ...(completionGate ? { gate: { ...completionGate, phase: 'completed' as const, completionProof: input.gateCompletionProof } } : {}) }
  return input.auditActor ? loadScheduledTaskGraphAuditChildGateInput({ ...gateInput, auditActor: input.auditActor })
    : loadScheduledTaskGraphGateInput(gateInput)
}

export function createScheduledTaskGraphContinuationFence(input: ScheduledTaskGraphContinuationFence | undefined) {
  return input?.mode === 'audit' ? createScheduledTaskGraphAuditChildOwnerFence({ owner: input.owner,
    auditActor: input.auditActor, key: input.key, claimToken: input.claimToken })
    : createScheduledTaskGraphOwnerFence(input ? { owner: input.owner, key: input.key, claimToken: input.claimToken } : undefined)
}
export function scheduledTaskGraphContinuationOwnerIsCurrent(input: ScheduledTaskGraphContinuationFence): Promise<boolean> {
  return input.mode === 'audit' ? isScheduledTaskGraphAuditChildOwnerCurrent({ owner: input.owner,
    auditActor: input.auditActor, key: input.key, claimToken: input.claimToken })
    : isScheduledTaskGraphOwnerCurrent(input.owner, input.key, input.claimToken)
}
export function scheduledTaskGraphRunOwnerFence(scheduled?: ScheduledTaskGraphRunInput) {
  const input = scheduled && (scheduled.action === 'scheduled_audit_execute'
    ? { mode: 'audit' as const, owner: scheduled.owner, auditActor: scheduled.auditActor, key: scheduled.continuationKey, claimToken: scheduled.claimToken }
    : { mode: 'root' as const, owner: scheduled.owner, key: scheduled.continuationKey, claimToken: scheduled.claimToken })
  return { assertCurrent: createScheduledTaskGraphContinuationFence(input),
    isCurrent: () => input ? scheduledTaskGraphContinuationOwnerIsCurrent(input) : Promise.resolve(true) }
}
export async function scheduledTaskGraphRunCheckpointIsCurrent(input: {
  scheduled: ScheduledTaskGraphRunInput; proofInput: ScheduledTaskGraphGateInputRequest
  tx: Prisma.TransactionClient; assertOwnerCurrent: (tx: Prisma.TransactionClient) => Promise<boolean>
}): Promise<boolean> {
  if (!await input.assertOwnerCurrent(input.tx)) return false
  return input.scheduled.action === 'scheduled_audit_execute'
    ? isScheduledTaskGraphAuditChildGateProofCurrent({ ...input.proofInput, auditActor: input.scheduled.auditActor }, input.tx)
    : isScheduledTaskGraphGateProofCurrent(input.proofInput, input.tx)
}

export function scheduledRootIdentityMatches(value: unknown, owner: RootOwner): boolean {
  const root = record(value)
  return Boolean(root && root.id === owner.rootTaskId && root.sessionId === owner.sessionId
    && root.turnId === owner.turnId && root.rootTaskId === owner.rootTaskId && root.parentTaskId === null
    && root.attemptCount === owner.rootAttemptCount)
}
export function scheduledRootIsCurrent(value: unknown, owner: RootOwner): boolean {
  const root = record(value)
  return scheduledRootIdentityMatches(value, owner) && root?.status === 'running'
    && root.interruptRequestedAt === null && root.closedAt === null
}
export function scheduledTurnLeaseIsCurrent(value: unknown, owner: RootOwner): boolean {
  const turn = record(value), expiry = dateNumber(turn?.leaseExpiresAt)
  return Boolean(turn && turn.status === 'in_progress' && turn.leaseOwnerId === owner.turnLeaseOwnerId
    && turn.leaseVersion === owner.turnLeaseVersion && Number.isFinite(expiry) && expiry > Date.now())
}

/** Reads the child authority through the same ordered DB locks used by writes. */
export function scheduledAuditChildIsCurrent(owner: AuditOwner, auditActor: ScheduledTaskGraphAuditActor): Promise<boolean> {
  return db.$transaction(tx => scheduledTaskGraphAuditChildFenceIsCurrent(tx, { owner, auditActor }))
}

export async function lockScheduledAuditContinuation<T>(input: {
  owner: AuditOwner; auditActor: ScheduledTaskGraphAuditActor
  load: (tx: Prisma.TransactionClient) => Promise<T | null>
}): Promise<{ status: 'actor_fenced' } | { status: 'proof_invalid' } | { status: 'locked'; value: T }> {
  return db.$transaction(async tx => {
    if (!await lockScheduledTaskGraphAuditChildFence(tx, { owner: input.owner, auditActor: input.auditActor })) return { status: 'actor_fenced' }
    const value = await input.load(tx)
    return value === null ? { status: 'proof_invalid' } : { status: 'locked', value }
  })
}

export async function authorizeScheduledAuditContinuation<T extends { owner: AuditOwner; waitId?: string }>(input: {
  request: ScheduledTaskGraphAuditExecuteRpcRequest; matchesProof: (left: unknown, right: unknown) => boolean
  replay: (gate: { taskId: string; attemptCount: number }) => Promise<Response | null>
  load: (tx: Prisma.TransactionClient, gate: { taskId: string; attemptCount: number }) => Promise<T | null>
}): Promise<Response | Readonly<{ kind: 'scheduled_audit_execute'; request: ScheduledTaskGraphAuditExecuteRpcRequest }>> {
  const proof = scheduledTaskGraphExecuteGateCompletionProof(input.request.gateCompletionProof)
  const gate = record(proof?.gate), owner = scheduledTaskGraphAuditExecutionOwner(input.request, proof)
  if (!proof || !gate || !owner || !input.matchesProof(proof.prepareProof, input.request.prepareProof)) {
    return Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_audit_gate_proof_invalid' }, { status: 409 })
  }
  const gateIdentity = { taskId: String(gate.taskId), attemptCount: Number(gate.attemptCount) }
  const replay = await input.replay(gateIdentity)
  if (replay) return replay
  const locked = await lockScheduledAuditContinuation({ owner, auditActor: input.request.auditActor,
    load: tx => input.load(tx, gateIdentity) })
  if (locked.status === 'locked') return { kind: 'scheduled_audit_execute',
    request: { ...input.request, owner: auditRequestOwner(locked.value.owner), ...(locked.value.waitId ? { scheduledWaitId: locked.value.waitId } : {}) } }
  return Response.json({ status: 'blocked', errorCode: locked.status === 'actor_fenced'
    ? 'scheduled_pipeline_audit_child_fenced' : 'scheduled_pipeline_audit_gate_proof_invalid' }, { status: 409 })
}

export async function scheduledAuditClaimRaceResponse(result: Promise<Response | { kind: string }>): Promise<Response> {
  const response = await result
  return response instanceof Response ? response : Response.json({ status: 'blocked', errorCode: 'scheduled_pipeline_execution_mismatch' }, { status: 409 })
}

/** Claims the persisted root continuation only while this exact Audit lease remains current. */
export async function claimScheduledAuditExecution(input: {
  owner: AuditOwner
  auditActor: ScheduledTaskGraphAuditActor
  key: string
  currentClaimToken: string
  executionStatus: 'running'
  executionAttemptCount: number
  currentState: unknown
  nextState: unknown
}): Promise<boolean> {
  return db.$transaction(async tx => {
    const assertCurrent = createScheduledTaskGraphAuditChildOwnerFence({ owner: input.owner, auditActor: input.auditActor,
      key: input.key, claimToken: input.currentClaimToken })
    if (!await assertCurrent(tx)) return false
    const saved = await tx.agentExecution.updateMany({
      where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
        status: input.executionStatus, attemptCount: input.executionAttemptCount,
        state: { equals: input.currentState as Prisma.InputJsonValue } },
      data: { status: 'running', state: input.nextState as Prisma.InputJsonValue },
    })
    return saved.count === 1
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function parseAuditOwner(value: unknown): AuditOwner | null {
  const row = record(value)
  if (!row || Reflect.ownKeys(row).length !== OWNER_KEYS.length || !OWNER_KEYS.every(key => Object.hasOwn(row, key))
    || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    || !Number.isSafeInteger(row.rootAttemptCount) || Number(row.rootAttemptCount) < 1
    || !Number.isSafeInteger(row.turnLeaseVersion) || Number(row.turnLeaseVersion) < 1
    || !Number.isSafeInteger(row.executionAttemptCount) || Number(row.executionAttemptCount) < 0) return null
  return { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string,
    rootTaskId: row.rootTaskId as string, rootAttemptCount: row.rootAttemptCount as number,
    turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: row.turnLeaseVersion as number,
    executionId: row.executionId as string, executionAttemptCount: row.executionAttemptCount as number }
}
function sameAuditStableOwner(left: AuditOwner, right: AuditOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function auditRequestOwner(owner: AuditOwner): RootOwner {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function dateNumber(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN
}
