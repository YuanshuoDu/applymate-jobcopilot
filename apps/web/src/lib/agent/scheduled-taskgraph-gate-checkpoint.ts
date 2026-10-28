import { createHash } from 'node:crypto'
import type { Job } from '@prisma/client'
import type { ApplicationPackage, PipelineCheckpointState, ScoredJob } from './types'
import { hashArtifactContent } from './artifacts/hash'
import { buildScheduledTaskGraphPrepareCheckpoint, type ScheduledTaskGraphPipelineCheckpoint, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphPrepareResultDigest,
  scheduledTaskGraphPrepareProofMatchesAttestation, scheduledTaskGraphPrepareReceiptKey, type ParsedScheduledTaskGraphPrepareProof,
  type ScheduledTaskGraphArtifactReference } from './scheduled-taskgraph-prepare-proof'
export { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphPrepareResultDigest } from './scheduled-taskgraph-prepare-proof'
export type { ParsedScheduledTaskGraphPrepareProof, ScheduledTaskGraphArtifactReference,
  ScheduledTaskGraphPrepareProofNode, ScheduledTaskGraphPrepareProofResult } from './scheduled-taskgraph-prepare-proof'
const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const CLAIM_SCHEMA = 'agent-harness.v2.scheduled-pipeline-claim.v1'
const RECEIPT_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1'
const COMPLETION_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1'
const HEX = /^[a-f0-9]{64}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/
const PACKAGE_KEYS = ['job', 'score', 'matchedKeywords', 'missingKeywords', 'recommendation', 'analysisFenceAt', 'coverLetter', 'coverLetterId', 'tailoredKeywords', 'tailoredResumeId', 'tailoredResumeName', 'tailoredResumeArtifact', 'coverLetterArtifact', 'artifactReview', 'artifactReviews'] as const
export type ScheduledTaskGraphPreparedPackageRow = Readonly<{ userId: string; sessionId: string; jobId: string; package: ApplicationPackage }>
export type ScheduledTaskGraphPreparedMaterialRow = Readonly<{ userId: string; sessionId: string; jobId: string; kind: 'resume' | 'cover_letter'; artifactRef: ScheduledTaskGraphArtifactReference }>
export type ScheduledTaskGraphGateCheckpointInput = Readonly<{
  analyze: Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; ownedJobs: readonly Job[]; persistedCheckpoint: unknown; activeClaimToken: string }>
  proof: unknown; packages: readonly ScheduledTaskGraphPreparedPackageRow[]; materials: readonly ScheduledTaskGraphPreparedMaterialRow[]
}>
export type ScheduledTaskGraphGateHandoff = Readonly<{
  /** Serializable Gate checkpoint. Prepared resume/letter bodies never enter this state. */
  checkpoint: PipelineCheckpointState & Pick<ScheduledTaskGraphPipelineCheckpoint, 'scheduledTaskGraphContinuation'>
  /** Owner-verified packages kept in memory only for the current Gate/Execute invocation. */
  packages: readonly ApplicationPackage[]
}>

/** Hashes authoritative Analyze facts; job and material bodies are excluded. */
export function scheduledTaskGraphAnalyzeCheckpointDigest(value: unknown): string | null { try { return analyzeCheckpointDigest(value) } catch { return null } }
function analyzeCheckpointDigest(value: unknown): string | null {
  const state = record(value), marker = exactRecord(state?.scheduledTaskGraphContinuation, ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
  const owner = parseOwner(marker?.owner)
  const scoutedJobs = denseArray(state?.scoutedJobs), scoredJobs = denseArray(state?.scoredJobs)
  if (!state || state.nextStage !== 'prepare' || !marker || marker.schemaVersion !== CONTINUATION_SCHEMA || !owner
    || !validContinuationKey(marker.key) || !isSnapshotDigest(marker.snapshotDigest) || !isPositiveInteger(marker.graphRevision)
    || !isHex(marker.evidenceDigest) || !safeCount(state.analysisFailed) || !scoutedJobs || !scoredJobs) return null
  const scoutedIds = new Set<string>()
  for (const raw of scoutedJobs) {
    const job = record(raw)
    if (!job || !validId(job.id) || job.userId !== owner.userId || scoutedIds.has(job.id)) return null
    scoutedIds.add(job.id)
  }
  if (Number(state.analysisFailed) + scoredJobs.length !== scoutedIds.size) return null
  const scoredIds = new Set<string>()
  const scoredRows: Array<Record<string, unknown>> = []
  for (const raw of scoredJobs) {
    const row = record(raw), job = record(row?.job)
    if (!row || !job || !validId(job.id) || job.userId !== owner.userId || !scoutedIds.has(job.id) || scoredIds.has(job.id)
      || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100 || !denseStringArray(row.matchedKeywords)
      || !denseStringArray(row.missingKeywords) || typeof row.recommendation !== 'string' || row.recommendation.length > 8192) return null
    const hasFence = Object.hasOwn(row, 'analysisFenceAt')
    if (!exactKeysAllowed(row, hasFence ? ['job', 'score', 'matchedKeywords', 'missingKeywords', 'recommendation', 'analysisFenceAt'] : ['job', 'score', 'matchedKeywords', 'missingKeywords', 'recommendation'])) return null
    if (hasFence && !validIsoTimestamp(row.analysisFenceAt)) return null
    scoredIds.add(job.id)
    scoredRows.push({ jobId: job.id, score: row.score, matchedKeywords: [...row.matchedKeywords as string[]], missingKeywords: [...row.missingKeywords as string[]], recommendation: row.recommendation, ...(hasFence ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  const projection = { owner: stableOwnerValues(owner), snapshotDigest: marker.snapshotDigest, evidenceDigest: marker.evidenceDigest, analyzeGraphRevision: marker.graphRevision, analysisFailed: state.analysisFailed, scoredJobs: scoredRows }
  try { return createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex') }
  catch { return null }
}
/** Returns a Gate-ready checkpoint only when the Worker proof and owner-scoped rows agree exactly. */
export function buildScheduledTaskGraphGateCheckpoint(input: ScheduledTaskGraphGateCheckpointInput, now = Date.now()): ScheduledTaskGraphGateHandoff | null {
  try {
    if (!Number.isFinite(now)) return null
    const priorState = record(input.analyze.persistedCheckpoint)
    const prior = buildScheduledTaskGraphPrepareCheckpoint({ owner: input.analyze.owner, snapshot: input.analyze.snapshot, attestation: input.analyze.attestation, ownedJobs: input.analyze.ownedJobs, existingCheckpoint: input.analyze.persistedCheckpoint })
    if (!prior.alreadyPersisted || priorState?.nextStage !== 'prepare' || prior.checkpoint.nextStage !== 'prepare') return null
    const checkpoint = prior.checkpoint
    const claim = parseClaim(checkpoint.scheduledTaskGraphClaim, input.analyze.owner, prior.continuationKey, now)
    if (!claim || claim.claimToken !== input.analyze.activeClaimToken) return null
    const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint)
    const proof = parseScheduledTaskGraphPrepareProof(input.proof)
    const continuation = record(checkpoint.scheduledTaskGraphContinuation)
    const prepareNode = proof?.nodes[proof.nodes.length - 1]
    if (!checkpointDigest || !proof || !continuation || !prepareNode
      || !scheduledTaskGraphPrepareProofMatchesAttestation(proof, input.analyze.attestation)
      || !receiptMatches(proof.receipt, input.analyze.owner, continuation, checkpointDigest)) return null
    const snapshot = parseScheduledAutomationSnapshot(input.analyze.snapshot)
    const scoredJobs = checkpoint.scoredJobs ?? []
    const byJob = new Map(scoredJobs.map(scored => [scored.job.id, scored]))
    const eligible = scoredJobs.filter(scored => scored.score >= snapshot.minScore).slice(0, snapshot.dailyCap)
    if (!prepareResultMatches(proof.result.raw, prepareNode, eligible, checkpointDigest, continuation.snapshotDigest)) return null
    const packages = hydratePackages(input, eligible, proof.result.raw)
    if (!packages) return null
    return {
      checkpoint: { startedAt: checkpoint.startedAt, eventIndex: checkpoint.eventIndex, autonomous: checkpoint.autonomous, nextStage: 'gate',
        scoutedJobs: checkpoint.scoutedJobs ?? [], scoredJobs: scoredJobs.map(scored => ({ ...scored, job: byJob.get(scored.job.id)!.job })),
        analysisFailed: checkpoint.analysisFailed, scheduledTaskGraphContinuation: checkpoint.scheduledTaskGraphContinuation!, scheduledTaskGraphClaim: claim },
      packages,
    }
  } catch { return null }
}
function parseClaim(value: unknown, expectedOwner: ScheduledTaskGraphPipelineOwner, key: string, now: number): NonNullable<PipelineCheckpointState['scheduledTaskGraphClaim']> | null {
  const row = exactRecord(value, ['schemaVersion', 'key', 'claimToken', 'owner', 'claimedAt', 'leaseExpiresAt']), owner = parseOwner(row?.owner)
  if (!row || row.schemaVersion !== CLAIM_SCHEMA || row.key !== key || !validContinuationKey(key) || !owner || !sameOwner(owner, expectedOwner)
    || !validId(row.claimToken) || !validIsoTimestamp(row.claimedAt) || !validIsoTimestamp(row.leaseExpiresAt) || Date.parse(row.leaseExpiresAt as string) <= now) return null
  return row as unknown as NonNullable<PipelineCheckpointState['scheduledTaskGraphClaim']>
}
function receiptMatches(receipt: Record<string, unknown>, ownerValue: unknown, continuation: Record<string, unknown>, digest: string): boolean {
  const owner = parseOwner(receipt.owner), expected = parseOwner(ownerValue), prepareRevision = receipt.prepareScheduleRevision
  if (receipt.schemaVersion !== RECEIPT_SCHEMA || !owner || !expected || !sameLineageOwner(owner, expected)
    || receipt.snapshotDigest !== continuation.snapshotDigest || !isSnapshotDigest(receipt.snapshotDigest)
    || receipt.evidenceDigest !== continuation.evidenceDigest || !isHex(receipt.evidenceDigest)
    || receipt.checkpointDigest !== digest || !isHex(receipt.checkpointDigest)
    || receipt.analyzeGraphRevision !== continuation.graphRevision || !isPositiveInteger(receipt.analyzeGraphRevision)
    || !isPositiveInteger(prepareRevision) || prepareRevision !== Number(receipt.analyzeGraphRevision) + 1) return false
  return receipt.continuationKey === scheduledTaskGraphPrepareReceiptKey(expected, {
    ...receipt, continuationKey: continuation.key, snapshotDigest: continuation.snapshotDigest, checkpointDigest: digest,
    analyzeGraphRevision: continuation.graphRevision, prepareScheduleRevision: prepareRevision,
  })
}
function prepareResultMatches(result: Record<string, unknown>, prepareNode: Record<string, unknown>, eligible: readonly ScoredJob[], digest: string, snapshotDigest: unknown): boolean {
  const jobs = denseArray(result.jobs), materials = denseArray(result.materials), expected = eligible.map(item => item.job.id)
  if (result.taskId !== prepareNode.taskId || result.attemptCount !== prepareNode.attemptCount || scheduledTaskGraphPrepareResultDigest(result) !== prepareNode.resultDigest
    || result.checkpointDigest !== digest || result.snapshotDigest !== snapshotDigest || !jobs || !materials) return false
  const preparedJobs = jobs.map(record)
  if (preparedJobs.length !== expected.length || preparedJobs.some(job => !job) || new Set(preparedJobs.map(job => job?.jobId)).size !== expected.length || !sameIds(preparedJobs.map(job => String(job?.jobId)), expected)) return false
  const preparedIds = preparedJobs.filter(job => job?.status === 'prepared').map(job => String(job?.jobId))
  const resumeCounts = new Map<string, number>()
  for (const value of materials) {
    const material = record(value)
    if (!material || !preparedIds.includes(String(material.jobId))) return false
    if (material.kind === 'resume') resumeCounts.set(String(material.jobId), (resumeCounts.get(String(material.jobId)) ?? 0) + 1)
  }
  return preparedIds.every(id => resumeCounts.get(id) === 1)
}
function hydratePackages(input: ScheduledTaskGraphGateCheckpointInput, eligible: readonly ScoredJob[], result: Record<string, unknown>): ApplicationPackage[] | null {
  const packageRows = denseArray(input.packages), preparedRows = denseArray(input.materials), resultMaterialsRaw = denseArray(result.materials)
  if (!packageRows || !preparedRows || !resultMaterialsRaw) return null
  const packagesById = new Map<string, ApplicationPackage>()
  for (const value of packageRows) {
    const row = exactRecord(value, ['userId', 'sessionId', 'jobId', 'package']), pkg = readPackage(row?.package)
    if (!row || row.userId !== input.analyze.owner.userId || row.sessionId !== input.analyze.owner.sessionId || !validId(row.jobId) || !pkg || pkg.job.id !== row.jobId || pkg.job.userId !== row.userId || packagesById.has(row.jobId)) return null
    packagesById.set(row.jobId, pkg)
  }
  const resultJobs = denseArray(result.jobs)?.map(record) ?? []
  const preparedIds = resultJobs.filter(row => row?.status === 'prepared').map(row => String(row?.jobId))
  const expectedIds = eligible.map(score => score.job.id).filter(id => preparedIds.includes(id))
  if (packagesById.size !== expectedIds.length || expectedIds.some(id => !packagesById.has(id))) return null
  for (const score of eligible.filter(item => preparedIds.includes(item.job.id))) {
    const pkg = packagesById.get(score.job.id)!
    if (pkg.score !== score.score || !sameStringArray(pkg.matchedKeywords, score.matchedKeywords) || !sameStringArray(pkg.missingKeywords, score.missingKeywords) || pkg.recommendation !== score.recommendation || pkg.analysisFenceAt !== score.analysisFenceAt || (pkg.tailoredKeywords !== undefined && !sameStringArray(pkg.tailoredKeywords, score.missingKeywords))) return null
  }
  const materialRows = new Map<string, ScheduledTaskGraphPreparedMaterialRow>()
  for (const value of preparedRows) {
    const row = exactRecord(value, ['userId', 'sessionId', 'jobId', 'kind', 'artifactRef']), ref = parseArtifactRef(row?.artifactRef)
    if (!row || row.userId !== input.analyze.owner.userId || row.sessionId !== input.analyze.owner.sessionId || !validId(row.jobId) || (row.kind !== 'resume' && row.kind !== 'cover_letter') || !ref) return null
    const key = `${row.jobId}\u0000${row.kind}`
    if (materialRows.has(key)) return null
    const pkg = packagesById.get(row.jobId)
    if (!pkg || !packageArtifactMatches(pkg, row.kind, ref)) return null
    materialRows.set(key, { userId: row.userId as string, sessionId: row.sessionId as string, jobId: row.jobId as string, kind: row.kind, artifactRef: ref })
  }
  for (const id of expectedIds) {
    const pkg = packagesById.get(id)!
    if (Boolean(pkg.tailoredResumeArtifact) !== materialRows.has(`${id}\u0000resume`) || Boolean(pkg.coverLetterArtifact) !== materialRows.has(`${id}\u0000cover_letter`)
      || (pkg.tailoredResumeId !== undefined) !== Boolean(pkg.tailoredResumeArtifact) || (pkg.coverLetterId !== undefined) !== Boolean(pkg.coverLetterArtifact)
      || (pkg.coverLetter !== undefined) !== Boolean(pkg.coverLetterArtifact)) return null
  }
  const resultMaterials = resultMaterialsRaw as Array<{ jobId: string; kind: string; artifactRef: ScheduledTaskGraphArtifactReference }>
  if (materialRows.size !== resultMaterials.length) return null
  const seen = new Set<string>()
  for (const material of resultMaterials) {
    const key = `${material.jobId}\u0000${material.kind}`, row = materialRows.get(key)
    if (!row || seen.has(key) || !sameArtifactRef(row.artifactRef, material.artifactRef)) return null
    seen.add(key)
  }
  return eligible.filter(score => preparedIds.includes(score.job.id)).map(score => {
    const pkg = packagesById.get(score.job.id)!
    return { job: score.job, score: score.score, matchedKeywords: [...score.matchedKeywords], missingKeywords: [...score.missingKeywords], recommendation: score.recommendation,
      ...(score.analysisFenceAt ? { analysisFenceAt: score.analysisFenceAt } : {}), ...(typeof pkg.coverLetter === 'string' ? { coverLetter: pkg.coverLetter } : {}), ...(pkg.coverLetterId ? { coverLetterId: pkg.coverLetterId } : {}),
      ...(pkg.tailoredResumeId ? { tailoredResumeId: pkg.tailoredResumeId } : {}), ...(pkg.tailoredResumeName ? { tailoredResumeName: pkg.tailoredResumeName } : {}), ...(pkg.tailoredResumeArtifact ? { tailoredResumeArtifact: pkg.tailoredResumeArtifact } : {}),
      ...(pkg.coverLetterArtifact ? { coverLetterArtifact: pkg.coverLetterArtifact } : {}), ...(pkg.tailoredKeywords ? { tailoredKeywords: [...pkg.tailoredKeywords] } : {}) }
  })
}
function readPackage(value: unknown): ApplicationPackage | null {
  const row = allowedRecord(value, PACKAGE_KEYS), job = record(row?.job)
  if (!row || !job || !validId(job.id) || !validId(job.userId) || !Number.isSafeInteger(row.score) || !Array.isArray(row.matchedKeywords) || !sameStringArray(row.matchedKeywords, row.matchedKeywords)
    || !Array.isArray(row.missingKeywords) || !sameStringArray(row.missingKeywords, row.missingKeywords) || typeof row.recommendation !== 'string' || (row.analysisFenceAt !== undefined && !validIsoTimestamp(row.analysisFenceAt))) return null
  if ((row.coverLetter !== undefined && typeof row.coverLetter !== 'string') || (row.coverLetterId !== undefined && !validId(row.coverLetterId)) || (row.tailoredResumeId !== undefined && !validId(row.tailoredResumeId))
    || (row.tailoredResumeName !== undefined && typeof row.tailoredResumeName !== 'string') || (row.tailoredKeywords !== undefined && !sameStringArray(row.tailoredKeywords, row.tailoredKeywords)) || row.artifactReview !== undefined || row.artifactReviews !== undefined) return null
  return row as unknown as ApplicationPackage
}
function packageArtifactMatches(pkg: ApplicationPackage, kind: string, ref: ScheduledTaskGraphArtifactReference): boolean {
  const summary = exactRecord(kind === 'resume' ? pkg.tailoredResumeArtifact : pkg.coverLetterArtifact, ['id', 'kind', 'lifecycle', 'version', 'hash', 'sourceDigest', 'baseArtifactId', 'baseHash', 'constraintHash', 'provenance'])
  const provenance = denseArray(summary?.provenance)
  return Boolean(summary && summary.id === ref.artifactId && summary.kind === kind && summary.version === ref.version && ['base', 'draft', 'approved', 'stale'].includes(String(summary.lifecycle)) && summary.hash === ref.contentHash
    && summary.sourceDigest === ref.sourceDigest && validId(summary.baseArtifactId) && isSha256(summary.baseHash) && isSha256(summary.constraintHash)
    && provenance !== null && provenance.length > 0 && provenance.every(validProvenance)
    && (kind === 'resume' ? pkg.tailoredResumeId === ref.artifactId : pkg.coverLetterId === ref.artifactId && typeof pkg.coverLetter === 'string'
      && pkg.coverLetter.trim().length > 0 && hashArtifactContent(pkg.coverLetter) === ref.contentHash))
}
function validProvenance(value: unknown): boolean {
  const item = exactRecord(value, ['sourceType', 'sourceRef', 'evidenceHash'])
  return Boolean(item && ['resume', 'persona_fact', 'persona_evidence'].includes(String(item.sourceType))
    && validId(item.sourceRef) && isSha256(item.evidenceHash))
}
function parseArtifactRef(value: unknown): ScheduledTaskGraphArtifactReference | null {
  const ref = exactRecord(value, ['artifactId', 'version', 'contentHash', 'sourceDigest'])
  if (!ref || !validId(ref.artifactId) || !isPositiveInteger(ref.version) || !isSha256(ref.contentHash) || !isSha256(ref.sourceDigest)) return null
  return { artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }
}
function parseOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = exactRecord(value, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'])
  if (!row || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId) || !isPositiveInteger(row.rootAttemptCount) || !isPositiveInteger(row.turnLeaseVersion) || !safeCount(row.executionAttemptCount)) return null
  return row as unknown as ScheduledTaskGraphPipelineOwner
}
function ownerValues(owner: ScheduledTaskGraphPipelineOwner): readonly (string | number)[] { return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.turnLeaseOwnerId, owner.turnLeaseVersion, owner.executionId, owner.executionAttemptCount] }
function sameOwner(a: ScheduledTaskGraphPipelineOwner, b: ScheduledTaskGraphPipelineOwner): boolean { return ownerValues(a).every((value, index) => value === ownerValues(b)[index]) }
function stableOwnerValues(owner: ScheduledTaskGraphPipelineOwner): readonly (string | number)[] { return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount] }
function sameLineageOwner(a: ScheduledTaskGraphPipelineOwner, b: ScheduledTaskGraphPipelineOwner): boolean { return stableOwnerValues(a).every((value, index) => value === stableOwnerValues(b)[index]) }
function sameIds(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every(id => b.includes(id)) }
function sameStringArray(a: unknown, b: unknown): boolean { return denseStringArray(a) && denseStringArray(b) && a.length === b.length && a.every((value, index) => value === (b as string[])[index]) }
function sameArtifactRef(a: ScheduledTaskGraphArtifactReference, b: ScheduledTaskGraphArtifactReference): boolean { return a.artifactId === b.artifactId && a.version === b.version && a.contentHash === b.contentHash && a.sourceDigest === b.sourceDigest }
function validContinuationKey(value: unknown): boolean { return typeof value === 'string' && /^scheduled-taskgraph:(?:v2:)?sha256:[a-f0-9]{64}$/.test(value) } function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
function isSnapshotDigest(value: unknown): boolean { return typeof value === 'string' && SHA256.test(value) } function isSha256(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value) }
function isHex(value: unknown): value is string { return typeof value === 'string' && HEX.test(value) } function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validIsoTimestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try { if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null; return Reflect.ownKeys(value).every(key => typeof key === 'string' && (() => { const d = Object.getOwnPropertyDescriptor(value, key); return Boolean(d?.enumerable && Object.hasOwn(d, 'value')) })()) ? value as Record<string, unknown> : null } catch { return null }
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try { const row = record(value), own = row && Reflect.ownKeys(row); return row && own && own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) && keys.every(key => { const d = Object.getOwnPropertyDescriptor(row, key); return Boolean(d?.enumerable && Object.hasOwn(d, 'value')) }) ? row : null } catch { return null }
}
function allowedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try { const row = record(value); return row && Reflect.ownKeys(row).every(key => typeof key === 'string' && keys.includes(key) && (() => { const d = Object.getOwnPropertyDescriptor(row, key); return Boolean(d?.enumerable && Object.hasOwn(d, 'value')) })()) ? row : null } catch { return null }
}
function denseArray(value: unknown): unknown[] | null {
  try { if (!Array.isArray(value)) return null; const keys = Reflect.ownKeys(value); if (keys.length !== value.length + 1 || !keys.includes('length') || !keys.every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)) return null; const result: unknown[] = []; for (let index = 0; index < value.length; index++) { const d = Object.getOwnPropertyDescriptor(value, String(index)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return null; result.push(d.value as unknown) } return result } catch { return null }
}
function denseStringArray(value: unknown): value is string[] { const items = denseArray(value); return Boolean(items && items.every(item => typeof item === 'string')) }
function exactKeysAllowed(row: Record<string, unknown>, keys: readonly string[]): boolean { return Reflect.ownKeys(row).every(key => typeof key === 'string' && keys.includes(key)) && keys.every(key => Object.hasOwn(row, key)) }
function exactIdArray(value: unknown, expected: readonly string[]): boolean { return denseStringArray(value) && value.length === expected.length && value.every((id, index) => id === expected[index]) }
