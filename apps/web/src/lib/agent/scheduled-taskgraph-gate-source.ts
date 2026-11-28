import type { Prisma } from '@prisma/client'
import { isSafeEmptyScheduledAnalyzeCheckpoint } from './scheduled-taskgraph-source-change-task-cleanup'
import { AnalyzeSourceChangedError, createAnalyzeSourceChangedErrorWithClaims, createAnalyzeSourceFingerprint, hasCompleteAnalyzeSourceFingerprints,
  isAnalyzeSourceChangedError, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS, readAnalyzeSourceChangedClaims, type AnalyzeSourceChangedClaim } from './stages/analyze-model-input'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import type { ScheduledGateReplayOwnerFence } from './approval/gate-replay'
import type { ScheduledReceiptSourceHooks } from './approval/receipt-issue-owner'
import type { ApprovalScopeInput } from './approval/types'
import { acquireSourceMaterialFence } from './source-material-fence'
import { resumeToText } from './types'
import type { ResumeContent } from '@/lib/types'

const FINGERPRINT_FIELD = 'scheduledTaskGraphAnalyzeSourceFingerprints'
const JOB_INPUT_SELECT = { company: true, role: true, location: true, description: true, source: true, url: true } as const
type GateSourceOwner = Pick<ScheduledTaskGraphPipelineOwner, 'userId' | 'sessionId' | 'executionId' | 'executionAttemptCount'>
type SourceFingerprintRow = readonly [jobId: string, version: string, digest: string]

export async function acquireScheduledTaskGraphGateSourceFence(
  tx: Prisma.TransactionClient,
  userId: string,
  ownerUserId: string,
): Promise<void> {
  if (userId !== ownerUserId) throw new AnalyzeSourceChangedError()
  await acquireSourceMaterialFence(tx, [userId])
}

export function isScheduledTaskGraphGateSourceChangedError(error: unknown): boolean {
  const claims = readAnalyzeSourceChangedClaims(error)
  return isAnalyzeSourceChangedError(error) && Boolean(claims?.length)
}

export function isScheduledTaskGraphGateSourceProofInvalidError(error: unknown): boolean {
  return isAnalyzeSourceChangedError(error) && !isScheduledTaskGraphGateSourceChangedError(error)
}

/** Caller must already hold the source fence and validate the owner/proof in this transaction. */
export async function assertScheduledTaskGraphGateSourcesCurrent(
  tx: Prisma.TransactionClient,
  input: Readonly<{ owner: GateSourceOwner; checkpoint?: unknown; jobId?: string }>,
): Promise<void> {
  const checkpoint = input.checkpoint === undefined ? await liveCheckpoint(tx, input.owner) : input.checkpoint
  const state = scheduledTaskGraphGateRecord(checkpoint), rows = state?.scoredJobs
  const jobIds = scoredJobIds(rows, input.owner.userId)
  if (!state || !jobIds) throw new AnalyzeSourceChangedError()
  if (input.jobId !== undefined && (!validId(input.jobId) || !jobIds.includes(input.jobId))) throw new AnalyzeSourceChangedError()
  if (jobIds.length === 0) {
    if (!isSafeEmptyScheduledAnalyzeCheckpoint(state)) throw new AnalyzeSourceChangedError()
    return
  }
  const expected = state[FINGERPRINT_FIELD]
  if (!hasCompleteAnalyzeSourceFingerprints(jobIds, expected)) throw new AnalyzeSourceChangedError()
  const resume = await tx.resume.findFirst({ where: { userId: input.owner.userId, isDefault: true }, select: { id: true, content: true } })
    ?? await tx.resume.findFirst({ where: { userId: input.owner.userId }, orderBy: { createdAt: 'desc' }, select: { id: true, content: true } })
  if (!resume) throw sourceChangedError(state, input.owner.userId)
  const resumeText = resumeToText(resume.content as unknown as ResumeContent).slice(0, 2000)
  for (const jobId of [...jobIds].sort()) {
    const job = await tx.job.findFirst({ where: { id: jobId, userId: input.owner.userId }, select: JOB_INPUT_SELECT })
    if (!job || createAnalyzeSourceFingerprint({ userId: input.owner.userId, jobId, job, resumeId: resume.id, resumeText }).digest
      !== expected[jobId]?.digest) throw sourceChangedError(state, input.owner.userId)
  }
}

export function createScheduledTaskGraphGateOwnerFence(
  locked: Readonly<{ owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string }>,
  gateTaskId: string,
  assertCurrent: (tx: Prisma.TransactionClient) => Promise<boolean>,
) {
  const { owner, key, claimToken } = locked
  return { owner, key, claimToken, gateTaskId, assertCurrent, sourceHooks: {
    acquireFence: (tx: Prisma.TransactionClient, userId: string) => acquireScheduledTaskGraphGateSourceFence(tx, userId, owner.userId),
    validateSource: (tx: Prisma.TransactionClient, jobId: string) => assertScheduledTaskGraphGateSourcesCurrent(tx, { owner, jobId }),
  } }
}

export function scheduledTaskGraphGateReceiptSourceHooks(fence: ScheduledGateReplayOwnerFence): ScheduledReceiptSourceHooks | null {
  const source = fence.sourceHooks
  if (!source) return null
  return { acquireFence: source.acquireFence, validateFinalSource: async (tx, scope: ApprovalScopeInput) => {
    if (scope.userId !== fence.owner.userId || scope.sessionId !== fence.owner.sessionId || scope.turnId !== fence.owner.turnId) {
      throw new AnalyzeSourceChangedError()
    }
    return source.validateSource(tx, scope.jobId)
  } }
}

/** Canonical digest input for the exact scored-job to source-fingerprint map. */
export function scheduledTaskGraphGateSourceFingerprintProjection(value: unknown): readonly SourceFingerprintRow[] | null {
  const state = scheduledTaskGraphGateRecord(value), jobIds = scoredJobIds(state?.scoredJobs)
  if (!state || !jobIds) return null
  if (jobIds.length === 0) return isSafeEmptyScheduledAnalyzeCheckpoint(state) ? [] : null
  const fingerprints = state[FINGERPRINT_FIELD]
  if (!hasCompleteAnalyzeSourceFingerprints(jobIds, fingerprints)) return null
  return jobIds.sort().map(jobId => [jobId, fingerprints[jobId]!.version, fingerprints[jobId]!.digest] as const)
}

export function scheduledTaskGraphGateMaterialReferences(rows: readonly { jobId: string; kind: string; artifactRef: unknown }[]) {
  return rows.map(row => [row.jobId, row.kind, row.artifactRef]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))
    || String(a[1]).localeCompare(String(b[1])))
}

async function liveCheckpoint(tx: Prisma.TransactionClient, owner: GateSourceOwner): Promise<unknown> {
  const execution = await tx.agentExecution.findFirst({ where: { id: owner.executionId, userId: owner.userId,
    sessionId: owner.sessionId, status: 'running', attemptCount: owner.executionAttemptCount }, select: { state: true } })
  if (!execution) throw new AnalyzeSourceChangedError()
  return execution.state
}

function scoredJobIds(value: unknown, ownerUserId?: string): string[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return null
  const ids: string[] = [], seen = new Set<string>()
  for (const raw of value) {
    const row = scheduledTaskGraphGateRecord(raw), job = scheduledTaskGraphGateRecord(row?.job), id = job?.id
    if (!row || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100
      || !validId(id) || ownerUserId !== undefined && job?.userId !== ownerUserId || seen.has(id)) return null
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function sourceChangedError(state: Record<string, unknown>, userId: string): AnalyzeSourceChangedError {
  const rows = state.scoredJobs
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ANALYZE_SOURCE_CHANGE_CLAIMS) return new AnalyzeSourceChangedError()
  const seen = new Set<string>(), claims: AnalyzeSourceChangedClaim[] = []
  for (const value of rows) {
    const row = scheduledTaskGraphGateRecord(value), job = scheduledTaskGraphGateRecord(row?.job)
    const jobId = job?.id, analysisFenceAt = row?.analysisFenceAt
    if (!validId(jobId) || job?.userId !== userId || typeof analysisFenceAt !== 'string'
      || !canonicalDate(analysisFenceAt) || seen.has(jobId)) return new AnalyzeSourceChangedError()
    seen.add(jobId)
    claims.push({ jobId, analysisFenceAt })
  }
  return createAnalyzeSourceChangedErrorWithClaims(claims, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS)
}

function canonicalDate(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
export function scheduledTaskGraphGateRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
