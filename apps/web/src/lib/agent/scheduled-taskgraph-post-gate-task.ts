import type { Job } from '@prisma/client'
import { parseScheduledPipelineAttestation } from '@jobcopilot/agent-protocol'
import { db } from '@/lib/db'
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'
import { pipelineAgentConfigFrom } from '@/app/api/agent/run/run-helpers'
import { automationRunOverrides, withAutomationOverrides } from './automation-overrides'
import { loadRoleConfigs, toRoleConfigMap } from './role-config'
import { resumeToText, type ApplicationPackage, type PipelineCheckpointState, type RunReport } from './types'
import type { PipelineCtx } from './pipeline-context'
import { runExecute } from './stages/execute'
import { runAudit } from './stages/audit'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { scheduledTaskGraphAttestationCandidates } from './scheduled-taskgraph-attestation-candidates'
import { scheduledTaskGraphExecuteGateCompletionProof } from './scheduled-taskgraph-gate-rpc'
import { loadScheduledTaskGraphPostGateGateInput } from './scheduled-taskgraph-gate-input'
import type { ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import { parseScheduledPostGateExecuteEnvelope, parseScheduledPostGateHandoff, type ScheduledPostGateHandoff } from './scheduled-taskgraph-post-gate-proof'
import { parseScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-prepare-proof'
import type { ScheduledTaskGraphPostGateActor } from './scheduled-taskgraph-audit-child-fence'

const ACTIONS = ['scheduled_post_gate_execute', 'scheduled_post_gate_audit'] as const
type PostGateAction = typeof ACTIONS[number]
type Request = Readonly<{ action: PostGateAction; owner: ScheduledTaskGraphPipelineOwner; handoff: ScheduledPostGateHandoff;
  attestation: ReturnType<typeof parseScheduledPipelineAttestation>; actor: ScheduledTaskGraphPostGateActor; packageRefs?: readonly string[] }>

export function isScheduledTaskGraphPostGateAction(value: unknown): boolean { return ACTIONS.includes(record(value)?.action as PostGateAction) }

/** Runs only the existing non-submitting Execute or Gmail-free scheduled Audit stage for a fenced child lease. */
export async function runScheduledTaskGraphPostGateTask(value: unknown, signal?: AbortSignal): Promise<Response> {
  const request = parseRequest(value)
  if (!request) return blocked(400, 'scheduled_post_gate_request_invalid')
  if (signal?.aborted) return blocked(409, 'scheduled_post_gate_actor_fenced')
  try {
    const loaded = await loadInputs(request)
    if (!loaded) return blocked(409, 'scheduled_post_gate_proof_invalid')
    const ctx = await buildPipelineContext(request, loaded.snapshot, signal)
    if (!ctx) return blocked(409, 'scheduled_post_gate_context_unavailable')
    if (request.action === 'scheduled_post_gate_execute') {
      const packages = selectPackages(loaded.gateInput.packages, request.packageRefs ?? [])
      if (!packages) return blocked(409, 'scheduled_post_gate_package_binding_invalid')
      const result = await runExecute([...packages], ctx)
      if (!result.ok || !result.data || result.data.queued.length !== 0 || result.data.failed.length !== 0 || signal?.aborted) {
        return blocked(409, 'scheduled_post_gate_execute_result_invalid')
      }
      if (!await postGateIsCurrent(request, loaded)) return blocked(409, 'scheduled_post_gate_actor_fenced')
      return Response.json({ status: 'completed', structuredResult: { queued: [], failed: [] } })
    }
    const childOutput = await loadCompletedExecuteResults(request)
    if (!childOutput || signal?.aborted) return blocked(409, 'scheduled_post_gate_execute_dependencies_invalid')
    const audit = await runAudit(childOutput, [...loaded.ownedJobs], ctx, { syncGmail: false })
    if (!audit.ok || !audit.data || signal?.aborted) return blocked(409, 'scheduled_post_gate_audit_invalid')
    if (!await postGateIsCurrent(request, loaded)) return blocked(409, 'scheduled_post_gate_actor_fenced')
    const report = reportFromCheckpoint(loaded.checkpoint, loaded.gateInput.packages, loaded.gateInput.gateResult!, childOutput)
    return report ? Response.json({ status: 'completed', report }) : blocked(409, 'scheduled_post_gate_report_invalid')
  } catch {
    return blocked(409, signal?.aborted ? 'scheduled_post_gate_actor_fenced' : 'scheduled_post_gate_execution_failed')
  }
}

type Loaded = Readonly<{ snapshot: NonNullable<ReturnType<typeof parseScheduledAutomationSnapshot>>; checkpoint: Record<string, unknown>;
  gateInput: NonNullable<Awaited<ReturnType<typeof loadScheduledTaskGraphPostGateGateInput>>>; ownedJobs: Job[] }>

async function loadInputs(request: Request): Promise<Loaded | null> {
  const [turn, execution, user] = await Promise.all([
    db.agentTurn.findFirst({ where: { id: request.owner.turnId, userId: request.owner.userId, sessionId: request.owner.sessionId },
      select: { id: true, userId: true, sessionId: true, rootTaskId: true, source: true, executionMode: true, input: true } }),
    db.agentExecution.findFirst({ where: { id: request.owner.executionId, userId: request.owner.userId, sessionId: request.owner.sessionId },
      select: { id: true, userId: true, sessionId: true, status: true, attemptCount: true, state: true } }),
    db.user.findUnique({ where: { id: request.owner.userId }, select: { accountStatus: true } }),
  ])
  if (!turn || !execution || user?.accountStatus !== 'active' || turn.source !== 'automation'
    || turn.executionMode !== 'canonical_task_graph' || turn.rootTaskId !== request.owner.rootTaskId
    || execution.id !== request.owner.executionId || execution.attemptCount !== request.owner.executionAttemptCount
    || !['running', 'paused', 'completed'].includes(execution.status)) return null
  const turnInput = record(turn.input), snapshot = parseScheduledAutomationSnapshot(turnInput?.scheduledAutomationSnapshot)
  const checkpoint = record(execution.state)
  if (!snapshot || turnInput?.automationRunMode !== 'scheduled' || !checkpoint) return null
  const analyzeCheckpoint = scheduledCheckpointForGate(checkpoint)
  const gateProof = scheduledTaskGraphExecuteGateCompletionProof(request.handoff.gateProof), attestation = request.attestation
  if (!analyzeCheckpoint || !gateProof || !attestation || scheduledAutomationSnapshotDigest(snapshot) !== request.handoff.snapshotDigest
    || scheduledTaskGraphContinuationKey(request.owner, attestation) !== request.handoff.continuationKey
    || !attestationOwnerMatches(attestation, request.owner)) return null
  const ownedIds = [...scheduledTaskGraphAttestationCandidates(attestation).selectedJobIds]
  const ownedJobs = await db.job.findMany({ where: { userId: request.owner.userId, id: { in: ownedIds } } }) as Job[]
  if (ownedJobs.length !== ownedIds.length || new Set(ownedJobs.map(job => job.id)).size !== ownedIds.length) return null
  const node = request.handoff.executeNodes.find(value => value.taskId === request.actor.taskId)
  const gateInput = await loadScheduledTaskGraphPostGateGateInput({ owner: request.owner, snapshot, analyzeCheckpoint,
    analyzeAttestation: attestation, prepareProof: gateProof.prepareProof,
    gate: { taskId: gateProof.gate.taskId, attemptCount: gateProof.gate.attemptCount, phase: 'completed', completionProof: gateProof },
    postGate: { actor: request.actor, handoff: request.handoff, ...(request.action === 'scheduled_post_gate_execute' ? { packageRefs: request.packageRefs } : {}) } })
  if (!gateInput?.gateResult || request.action === 'scheduled_post_gate_execute' && (!node || !gateInput.packages)) return null
  return { snapshot, checkpoint, gateInput, ownedJobs }
}

async function postGateIsCurrent(request: Request, loaded: Loaded): Promise<boolean> {
  const proof = scheduledTaskGraphExecuteGateCompletionProof(request.handoff.gateProof)
  if (!proof) return false
  return Boolean(await loadScheduledTaskGraphPostGateGateInput({ owner: request.owner, snapshot: loaded.snapshot,
    analyzeCheckpoint: scheduledCheckpointForGate(loaded.checkpoint), analyzeAttestation: request.attestation,
    prepareProof: proof.prepareProof,
    gate: { taskId: proof.gate.taskId, attemptCount: proof.gate.attemptCount, phase: 'completed', completionProof: proof },
    postGate: { actor: request.actor, handoff: request.handoff,
      ...(request.action === 'scheduled_post_gate_execute' ? { packageRefs: request.packageRefs } : {}) } }))
}

async function loadCompletedExecuteResults(request: Request): Promise<{ queued: string[]; failed: string[] } | null> {
  const refs = request.handoff.executeNodes.map(node => node.taskId)
  const tasks = await db.subAgentTask.findMany({ where: { id: { in: refs }, sessionId: request.owner.sessionId,
    turnId: request.owner.turnId, rootTaskId: request.owner.rootTaskId, parentTaskId: request.owner.rootTaskId,
    session: { is: { userId: request.owner.userId } } }, select: { id: true, status: true, result: true } })
  if (tasks.length !== refs.length || new Set(tasks.map(task => task.id)).size !== refs.length) return null
  const output = { queued: [] as string[], failed: [] as string[] }
  for (const task of tasks) {
    const value = parseScheduledPostGateExecuteEnvelope(task.result)
    if (!value || task.status !== 'completed' || value.queued.length || value.failed.length) return null
    output.queued.push(...value.queued); output.failed.push(...value.failed)
  }
  return output
}

async function buildPipelineContext(request: Request, snapshot: NonNullable<ReturnType<typeof parseScheduledAutomationSnapshot>>,
  signal?: AbortSignal): Promise<PipelineCtx | null> {
  const agentConfig = await db.agentConfig.findUnique({ where: { userId: request.owner.userId } })
  const resume = await db.resume.findFirst({ where: { userId: request.owner.userId, isDefault: true } })
    ?? await db.resume.findFirst({ where: { userId: request.owner.userId }, orderBy: { createdAt: 'desc' } })
  if (!agentConfig || !resume) return null
  const configured = await loadUserAiConfig(request.owner.userId, 'autoApply')
  const aiConfig = configured.resolvedKey ? { ...configured, usageUserId: request.owner.userId,
    usageFeatureKey: 'autoApply', usageRuntime: 'worker' as const }
    : { ...resolveConfig(APPLYMATE_BACKING), usageUserId: request.owner.userId, usageFeatureKey: 'autoApply', usageRuntime: 'worker' as const }
  return { userId: request.owner.userId, sessionId: request.owner.sessionId, turnId: request.owner.turnId,
    questionProjectionMode: 'canonical', agentCfg: withAutomationOverrides(pipelineAgentConfigFrom(agentConfig), automationRunOverrides({ automation: snapshot })),
    roleConfigs: toRoleConfigMap(await loadRoleConfigs(request.owner.userId)),
    resumeText: resumeToText(resume.content as unknown as ResumeContent).slice(0, 2500), resumeContent: resume.content as unknown as ResumeContent,
    defaultResume: { id: resume.id, name: resume.name, templateId: resume.templateId ?? null, templateOptions: resume.templateOptions,
      directionId: resume.directionId ?? null, basicsDetached: resume.basicsDetached ?? false }, aiConfig,
    executionAttempt: { id: request.owner.executionId, attemptCount: request.owner.executionAttemptCount },
    autonomous: snapshot.autoApply, emit: () => undefined, signal }
}

function reportFromCheckpoint(checkpoint: Record<string, unknown>, packages: readonly ScheduledTaskGraphPreparedPackageRow[],
  gate: NonNullable<Loaded['gateInput']['gateResult']>, execute: { queued: string[]; failed: string[] }): RunReport | null {
  const started = typeof checkpoint.startedAt === 'string' ? Date.parse(checkpoint.startedAt) : Number.NaN
  const scouted = dense(checkpoint.scoutedJobs), analysisFailed = checkpoint.analysisFailed
  if (!Number.isFinite(started) || !scouted || !Number.isSafeInteger(analysisFailed) || Number(analysisFailed) < 0) return null
  const ids = new Set(packages.map(pkg => pkg.jobId)), counts = { processed: scouted.length, applied: 0,
    queued: execute.queued.length, pending: gate.pendingJobIds.length, skipped: gate.skippedJobIds.length + Number(analysisFailed), failed: execute.failed.length,
    durationMs: Math.max(0, Date.now() - started) }
  if (gate.approvedJobIds.some(id => !ids.has(id)) || gate.pendingJobIds.some(id => !ids.has(id)) || gate.skippedJobIds.some(id => !ids.has(id))) return null
  return counts
}

function selectPackages(packages: readonly ScheduledTaskGraphPreparedPackageRow[], refs: readonly string[]): ApplicationPackage[] | null {
  const byId = new Map(packages.map(row => [row.jobId, row]))
  const selected = refs.map(id => byId.get(id))
  return selected.every((row, index) => row?.package.job.id === refs[index]) && new Set(refs).size === refs.length
    ? selected.map(row => row!.package) : null
}
function scheduledCheckpointForGate(value: Record<string, unknown>): Record<string, unknown> | null {
  return value.nextStage === 'completed' ? { ...value, nextStage: 'execute' } : value
}
function parseRequest(value: unknown): Request | null {
  const row = record(value), action = row?.action
  if (!row || !ACTIONS.includes(action as PostGateAction)) return null
  const keys = action === 'scheduled_post_gate_execute' ? ['action', 'owner', 'handoff', 'attestation', 'actor', 'packageRefs']
    : ['action', 'owner', 'handoff', 'attestation', 'actor']
  const owner = parseScheduledTaskGraphPipelineOwner(row.owner), handoff = parseScheduledPostGateHandoff(row.handoff)
  const actorRow = exactRecord(row.actor, ['taskId', 'attemptCount', 'leaseOwner']), attestation = parseScheduledPipelineAttestation(row.attestation)
  const packageRefs = action === 'scheduled_post_gate_execute' ? strings(row.packageRefs, 50) : undefined
  if (!exactRecord(row, keys) || !owner || !handoff || !attestation || !actorRow || !validId(actorRow.taskId)
    || !positive(actorRow.attemptCount) || !validId(actorRow.leaseOwner) || !sameOwner(handoff.owner, owner)
    || !attestationOwnerMatches(attestation, owner) || action === 'scheduled_post_gate_execute' && !packageRefs
    || action === 'scheduled_post_gate_audit' && Object.hasOwn(row, 'packageRefs')) return null
  const kind = action === 'scheduled_post_gate_execute' ? 'execute' : 'audit'
  const actor = { kind, taskId: actorRow.taskId as string, attemptCount: Number(actorRow.attemptCount), leaseOwner: actorRow.leaseOwner as string } as ScheduledTaskGraphPostGateActor
  if (kind === 'execute') {
    const node = handoff.executeNodes.find(item => item.taskId === actor.taskId)
    if (!node || !sameStrings(packageRefs, node.packageRefs)) return null
  } else if (handoff.auditTaskId !== actor.taskId) return null
  return { action: action as PostGateAction, owner, handoff, attestation, actor, ...(packageRefs ? { packageRefs } : {}) }
}
function attestationOwnerMatches(attestation: NonNullable<ReturnType<typeof parseScheduledPipelineAttestation>>, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount'].every(key => record(attestation.owner)?.[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
}
function sameOwner(left: ScheduledTaskGraphPipelineOwner, right: ScheduledTaskGraphPipelineOwner): boolean {
  return ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount']
    .every(key => left[key as keyof ScheduledTaskGraphPipelineOwner] === right[key as keyof ScheduledTaskGraphPipelineOwner])
}
function blocked(status: number, errorCode: string): Response { return Response.json({ status: 'blocked', errorCode }, { status }) }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value), own = row && Reflect.ownKeys(row)
  return row && own?.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) ? row : null
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function dense(value: unknown): unknown[] | null { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null }
function strings(value: unknown, max: number): string[] | null { const list = dense(value); return list && list.length <= max && list.every(validId) && new Set(list).size === list.length ? list as string[] : null }
function sameStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]) }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
