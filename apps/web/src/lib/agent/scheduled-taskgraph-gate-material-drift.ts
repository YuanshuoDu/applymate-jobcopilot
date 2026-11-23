import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { hashArtifactContent } from './artifacts/hash'
import type { ScheduledTaskGraphArtifactReference } from './scheduled-taskgraph-gate-checkpoint'
import { scheduledTaskGraphGateSourceFingerprintProjection } from './scheduled-taskgraph-gate-source'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const ERROR_CODE = 'scheduled_prepare_material_source_changed'
const PROOF_SCHEMA = 'agent-harness.v2.scheduled-prepare-material-drift-proof.v1'
const MARKER_SCHEMA = 'agent-harness.v2.scheduled-prepare-material-drift-terminal.v1'
const MARKER_REASON = 'scheduled_prepare_material_source_changed'
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
const GATE_KEYS = ['taskId', 'leaseOwnerId', 'attemptCount'] as const
const DRIFT_PROOF_BY_ERROR = new WeakMap<object, ScheduledTaskGraphGateMaterialDriftProof>()

type EvidenceRow = Readonly<{
  jobId: string
  kind: 'resume' | 'cover_letter'
  taskId: string
  artifactRef: ScheduledTaskGraphArtifactReference
  toolCallId: string
  requestHash: string
  baseId: string
  baseHash: string
  constraintHash: string
  provenanceRefs: readonly string[]
  evidenceRefs: readonly string[]
  currentSourceDigest: string
}>

export type ScheduledTaskGraphGateMaterialDriftEvidence = Readonly<{
  artifactDigest: string
  currentMaterialDigest: string
}>

export type ScheduledTaskGraphGateMaterialDriftProof = Readonly<{
  schemaVersion: typeof PROOF_SCHEMA
  owner: ScheduledTaskGraphPipelineOwner
  gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>
  snapshotDigest: string
  analyzeFingerprintDigest: string
  prepareProofDigest: string
  artifactDigest: string
  currentMaterialDigest: string
  proofDigest: string
}>

/** Hashes only already-validated immutable artifact metadata and current source digests. */
export function createScheduledTaskGraphGateMaterialDriftEvidence(value: unknown): ScheduledTaskGraphGateMaterialDriftEvidence | null {
  const rows = denseArray(value)?.map(parseEvidenceRow)
  if (!rows || rows.length === 0 || rows.some(row => !row)) return null
  const validRows = rows as EvidenceRow[]
  const pairs = new Set<string>(), currentByJob = new Map<string, string>()
  for (const row of validRows) {
    const pair = `${row.jobId}\u0000${row.kind}`
    if (pairs.has(pair) || currentByJob.has(row.jobId) && currentByJob.get(row.jobId) !== row.currentSourceDigest) return null
    pairs.add(pair)
    currentByJob.set(row.jobId, row.currentSourceDigest)
  }
  if (!validRows.some(row => row.currentSourceDigest !== row.artifactRef.sourceDigest)) return null
  validRows.sort((a, b) => compare(a.jobId, b.jobId) || compare(a.kind, b.kind))
  const artifacts = validRows.map(({ currentSourceDigest: _current, ...row }) => row)
  const currentSources = [...currentByJob].sort(([a], [b]) => compare(a, b))
  try {
    return Object.freeze({ artifactDigest: hashArtifactContent({ schemaVersion: PROOF_SCHEMA, artifacts }),
      currentMaterialDigest: hashArtifactContent({ schemaVersion: PROOF_SCHEMA, currentSources }) })
  } catch { return null }
}

/** Mints an opaque proof after Analyze, Prepare, Gate, and material evidence were checked in a fenced transaction. */
export function createScheduledTaskGraphGateMaterialDriftError(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>
  snapshotDigest: string
  analyzeCheckpoint: unknown
  prepareProof: unknown
  evidence: ScheduledTaskGraphGateMaterialDriftEvidence
}>): Error | null {
  const owner = parseOwner(input.owner), gate = parseGate(input.gate)
  const fingerprints = scheduledTaskGraphGateSourceFingerprintProjection(input.analyzeCheckpoint)
  if (!owner || !gate || !fingerprints || !isDigest(input.snapshotDigest)
    || !isDigest(input.evidence?.artifactDigest) || !isDigest(input.evidence?.currentMaterialDigest)) return null
  try {
    const body = { schemaVersion: PROOF_SCHEMA as typeof PROOF_SCHEMA, owner, gate, snapshotDigest: input.snapshotDigest,
      analyzeFingerprintDigest: hashArtifactContent(fingerprints), prepareProofDigest: hashArtifactContent(input.prepareProof),
      artifactDigest: input.evidence.artifactDigest, currentMaterialDigest: input.evidence.currentMaterialDigest }
    const proof = Object.freeze({ ...body, proofDigest: hashArtifactContent(body) })
    const error = new Error(ERROR_CODE)
    error.name = 'ScheduledPrepareMaterialDriftError'
    DRIFT_PROOF_BY_ERROR.set(error, proof)
    return error
  } catch { return null }
}

export function throwForScheduledTaskGraphGateMaterialDrift(owner: ScheduledTaskGraphPipelineOwner,
  request: Readonly<{ gateTaskId: string; gateLeaseOwnerId: string; gateAttemptCount: number; prepareProof: unknown }>,
  snapshot: unknown, checkpoint: unknown, inspection: unknown): void {
  const result = record(inspection)
  if (result?.kind !== 'material_source_drift') return
  const error = createScheduledTaskGraphGateMaterialDriftError({ owner,
    gate: { taskId: request.gateTaskId, leaseOwnerId: request.gateLeaseOwnerId, attemptCount: request.gateAttemptCount },
    snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), analyzeCheckpoint: checkpoint,
    prepareProof: request.prepareProof, evidence: result.evidence as ScheduledTaskGraphGateMaterialDriftEvidence })
  if (error) throw error
}

export function readScheduledTaskGraphGateMaterialDriftProof(error: unknown): ScheduledTaskGraphGateMaterialDriftProof | null {
  if (!error || typeof error !== 'object') return null
  const proof = DRIFT_PROOF_BY_ERROR.get(error)
  return proof && validProof(proof) ? proof : null
}

export function scheduledTaskGraphGateMaterialDriftProofMatches(
  expected: ScheduledTaskGraphGateMaterialDriftProof,
  current: ScheduledTaskGraphGateMaterialDriftProof,
): boolean {
  return validProof(expected) && validProof(current) && expected.proofDigest === current.proofDigest
    && sameOwner(expected.owner, current.owner) && sameGate(expected.gate, current.gate)
}

export function buildScheduledTaskGraphGateMaterialDriftTerminalState(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>
  snapshotDigest: string
  expectedState: unknown
  proof: ScheduledTaskGraphGateMaterialDriftProof
}>): Record<string, unknown> | null {
  const owner = parseOwner(input.owner), gate = parseGate(input.gate)
  const state = record(input.expectedState)
  if (!owner || !gate || !validProof(input.proof) || !sameOwner(owner, input.proof.owner)
    || !sameGate(gate, input.proof.gate) || input.snapshotDigest !== input.proof.snapshotDigest || !state
    || state.scheduledTaskGraphSourceChangeTerminal !== undefined || state.scheduledTaskGraphMaterialDriftTerminal !== undefined) return null
  const nextState = { ...state }
  nextState.scheduledTaskGraphMaterialDriftTerminal = {
    schemaVersion: MARKER_SCHEMA, reason: MARKER_REASON,
    owner, gate,
    analyzeFingerprintDigest: input.proof.analyzeFingerprintDigest, prepareProofDigest: input.proof.prepareProofDigest,
    artifactDigest: input.proof.artifactDigest, currentMaterialDigest: input.proof.currentMaterialDigest,
    proofDigest: input.proof.proofDigest,
  }
  return nextState
}

export function isScheduledTaskGraphGateMaterialDriftTerminal(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>
  status: string
  error: unknown
  state: unknown
}>): boolean {
  const owner = parseOwner(input.owner), gate = parseGate(input.gate), state = record(input.state)
  const marker = record(state?.scheduledTaskGraphMaterialDriftTerminal)
  const markerOwner = parseOwner(marker?.owner), markerGate = parseGate(marker?.gate)
  const markerKeys = ['schemaVersion', 'reason', 'owner', 'gate', 'analyzeFingerprintDigest', 'prepareProofDigest', 'artifactDigest', 'currentMaterialDigest', 'proofDigest']
  return Boolean(owner && gate && state && marker && exactKeys(marker, markerKeys)
    && input.status === 'failed' && input.error === ERROR_CODE && state.scheduledTaskGraphSourceChangeTerminal === undefined
    && marker.schemaVersion === MARKER_SCHEMA && marker.reason === MARKER_REASON && markerOwner && sameOwner(owner, markerOwner)
    && markerGate && sameGate(gate, markerGate) && isDigest(marker.artifactDigest)
    && isDigest(marker.analyzeFingerprintDigest) && isDigest(marker.prepareProofDigest)
    && isDigest(marker.currentMaterialDigest) && isDigest(marker.proofDigest))
}

export async function scheduledTaskGraphGateMaterialDriftTerminalForRequest(input: Readonly<{ owner: Pick<ScheduledTaskGraphPipelineOwner, 'userId' | 'sessionId' | 'turnId' | 'rootTaskId' | 'rootAttemptCount' | 'turnLeaseOwnerId' | 'turnLeaseVersion'>; gateTaskId: string; gateLeaseOwnerId: string; gateAttemptCount: number }>): Promise<boolean> {
  const execution = await db.agentExecution.findFirst({ where: { userId: input.owner.userId, sessionId: input.owner.sessionId },
    select: { id: true, status: true, attemptCount: true, error: true, state: true } })
  if (!execution || !Number.isSafeInteger(execution.attemptCount) || execution.attemptCount < 0) return false
  return isScheduledTaskGraphGateMaterialDriftTerminal({ owner: { ...input.owner, executionId: execution.id,
    executionAttemptCount: execution.attemptCount }, gate: { taskId: input.gateTaskId, leaseOwnerId: input.gateLeaseOwnerId,
    attemptCount: input.gateAttemptCount }, status: execution.status, error: execution.error, state: execution.state })
}

export async function persistScheduledTaskGraphGateMaterialDriftTerminal(input: Readonly<{ tx: Prisma.TransactionClient; owner: ScheduledTaskGraphPipelineOwner; gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>; executionId: string; executionAttemptCount: number; snapshotDigest: string; expectedState: Record<string, unknown>; proof: ScheduledTaskGraphGateMaterialDriftProof }>): Promise<'not_confirmed' | 'state_changed' | 'terminalized'> {
  const state = buildScheduledTaskGraphGateMaterialDriftTerminalState({ owner: input.owner, gate: input.gate,
    snapshotDigest: input.snapshotDigest, expectedState: input.expectedState, proof: input.proof })
  if (!state) return 'not_confirmed'
  const saved = await input.tx.agentExecution.updateMany({ where: { id: input.executionId, userId: input.owner.userId,
    sessionId: input.owner.sessionId, status: 'running', attemptCount: input.executionAttemptCount,
    state: { equals: input.expectedState as Prisma.InputJsonValue } },
    data: { status: 'failed', error: ERROR_CODE, completedAt: new Date(), state: state as Prisma.InputJsonValue } })
  return saved.count === 1 ? 'terminalized' : 'state_changed'
}

function parseEvidenceRow(value: unknown): EvidenceRow | null {
  const row = record(value), ref = record(row?.artifactRef)
  if (!row || !ref || !exactKeys(row, ['jobId', 'kind', 'taskId', 'artifactRef', 'toolCallId', 'requestHash', 'baseId',
    'baseHash', 'constraintHash', 'provenanceRefs', 'evidenceRefs', 'currentSourceDigest'])
    || !validId(row.jobId) || row.kind !== 'resume' && row.kind !== 'cover_letter' || !validId(row.taskId)
    || !exactKeys(ref, ['artifactId', 'version', 'contentHash', 'sourceDigest']) || !validId(ref.artifactId)
    || !Number.isSafeInteger(ref.version) || Number(ref.version) <= 0 || !isDigest(ref.contentHash) || !isDigest(ref.sourceDigest)
    || !validId(row.toolCallId) || !isDigest(row.requestHash) || !validId(row.baseId)
    || !isDigest(row.baseHash) || !isDigest(row.constraintHash) || !stringArray(row.provenanceRefs)
    || !stringArray(row.evidenceRefs) || !isDigest(row.currentSourceDigest)) return null
  const provenanceRefs = row.provenanceRefs as string[], evidenceRefs = row.evidenceRefs as string[]
  if (!sameStrings(provenanceRefs, evidenceRefs) || !provenanceRefs.includes(`job:${row.jobId}`)) return null
  return { jobId: row.jobId, kind: row.kind, taskId: row.taskId,
    artifactRef: { artifactId: ref.artifactId, version: Number(ref.version), contentHash: ref.contentHash, sourceDigest: ref.sourceDigest },
    toolCallId: row.toolCallId, requestHash: row.requestHash, baseId: row.baseId, baseHash: row.baseHash,
    constraintHash: row.constraintHash, provenanceRefs: [...provenanceRefs], evidenceRefs: [...evidenceRefs],
    currentSourceDigest: row.currentSourceDigest }
}

function validProof(value: unknown): value is ScheduledTaskGraphGateMaterialDriftProof {
  const proof = record(value), owner = parseOwner(proof?.owner), gate = parseGate(proof?.gate)
  if (!proof || !owner || !gate || !exactKeys(proof, ['schemaVersion', 'owner', 'gate', 'snapshotDigest',
    'analyzeFingerprintDigest', 'prepareProofDigest', 'artifactDigest', 'currentMaterialDigest', 'proofDigest'])
    || proof.schemaVersion !== PROOF_SCHEMA || !isDigest(proof.snapshotDigest) || !isDigest(proof.analyzeFingerprintDigest)
    || !isDigest(proof.prepareProofDigest) || !isDigest(proof.artifactDigest) || !isDigest(proof.currentMaterialDigest)
    || !isDigest(proof.proofDigest)) return false
  const { proofDigest, ...body } = proof
  try { return hashArtifactContent(body) === proofDigest } catch { return false }
}
function parseOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = record(value)
  if (!row || !exactKeys(row, OWNER_KEYS) || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    || !positive(row.rootAttemptCount) || !positive(row.turnLeaseVersion) || !nonNegative(row.executionAttemptCount)) return null
  return Object.fromEntries(OWNER_KEYS.map(key => [key, row[key]])) as unknown as ScheduledTaskGraphPipelineOwner
}
function parseGate(value: unknown): Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }> | null {
  const row = record(value)
  if (!row || !exactKeys(row, GATE_KEYS) || !validId(row.taskId) || !validId(row.leaseOwnerId) || !positive(row.attemptCount)) return null
  return { taskId: row.taskId, leaseOwnerId: row.leaseOwnerId, attemptCount: row.attemptCount as number }
}
function sameOwner(a: ScheduledTaskGraphPipelineOwner, b: ScheduledTaskGraphPipelineOwner): boolean {
  return OWNER_KEYS.every(key => a[key] === b[key])
}
function sameGate(a: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>, b: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>): boolean {
  return GATE_KEYS.every(key => a[key] === b[key])
}
function sameStrings(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]) }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 && value.every(item => typeof item === 'string') }
function denseArray(value: unknown): unknown[] | null { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
