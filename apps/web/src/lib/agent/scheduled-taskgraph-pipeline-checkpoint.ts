import { createHash } from "node:crypto"
import { types as nodeTypes } from "node:util"
import type { Job } from "@prisma/client"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import type { AnalyzeOutput, PipelineCheckpointState, ScoredJob, StageResult } from "./types"

const ATTESTATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-attestation.v1"
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1"
const HEX_DIGEST = /^[a-f0-9]{64}$/
const SNAPSHOT_DIGEST = /^sha256:[a-f0-9]{64}$/
const PIPELINE_STAGES = new Set(["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"])

export interface ScheduledTaskGraphPipelineOwner {
  userId: string; sessionId: string; turnId: string; rootTaskId: string;
  rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
}
interface AttestationOwner { userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; turnLeaseOwnerId: string; turnLeaseVersion: number }
interface DiscoveryReceipt { status: "complete"; taskId: string; attemptCount: number; completedCalls: number; candidateCount: number; providerFailures: number; materializationFailures: number; hasMore: boolean; receiptDigest: string }

interface ScheduledPipelineAttestation {
  schemaVersion: typeof ATTESTATION_SCHEMA; owner: AttestationOwner; snapshotDigest: string; graphRevision: number;
  scout: { taskId: string; attemptCount: number; status: "completed"; verification: "passed"; resultDigest: string; candidateJobIds: string[]; discoveryReceipt: DiscoveryReceipt };
  analyst: { taskId: string; attemptCount: number; status: "completed"; verification: "passed"; resultDigest: string; dependsOnTaskIds: string[]; jobIds: string[] }; evidenceDigest: string
}
export interface ScheduledTaskGraphPipelineCheckpoint extends PipelineCheckpointState { scheduledTaskGraphContinuation: { schemaVersion: typeof CONTINUATION_SCHEMA; key: string; owner: ScheduledTaskGraphPipelineOwner; snapshotDigest: string; graphRevision: number; evidenceDigest: string } }
export interface BuildScheduledTaskGraphCheckpointInput {
  owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; ownedJobs: readonly Job[];
  analyzeResult?: StageResult<AnalyzeOutput>; existingCheckpoint?: unknown; now?: Date
}
export interface BuildScheduledTaskGraphCheckpointResult { checkpoint: ScheduledTaskGraphPipelineCheckpoint; continuationKey: string; alreadyPersisted: boolean }
export type ScheduledTaskGraphCheckpointReason = "invalid_owner" | "invalid_snapshot" | "invalid_attestation" | "owner_mismatch" | "snapshot_mismatch" | "discovery_incomplete" | "checkpoint_conflict" | "jobs_mismatch" | "analysis_invalid"
export class ScheduledTaskGraphCheckpointError extends Error {
  readonly code = "scheduled_taskgraph_checkpoint_blocked"
  constructor(readonly reason: ScheduledTaskGraphCheckpointReason) {
    super("Scheduled TaskGraph evidence cannot continue to Prepare."); this.name = "ScheduledTaskGraphCheckpointError"
  }
}

export function scheduledAutomationSnapshotDigest(value: unknown): string {
  let snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>
  try { snapshot = parseScheduledAutomationSnapshot(value) }
  catch { throw new ScheduledTaskGraphCheckpointError("invalid_snapshot") }
  const projection = [snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations, snapshot.minScore,
    snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]
  return "sha256:" + createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
}

export function scheduledTaskGraphContinuationKey(owner: ScheduledTaskGraphPipelineOwner, value: unknown): string {
  validateOwner(owner)
  const attestation = parseAttestation(value)
  assertAttestationOwner(attestation.owner, owner)
  assertDiscoveryReceipt(attestation.scout)
  return createContinuationKey(owner, attestation)
}

export function buildScheduledTaskGraphPrepareCheckpoint(
  input: BuildScheduledTaskGraphCheckpointInput,
): BuildScheduledTaskGraphCheckpointResult {
  validateOwner(input.owner)
  const snapshotDigest = scheduledAutomationSnapshotDigest(input.snapshot)
  const attestation = parseAttestation(input.attestation)
  assertAttestationOwner(attestation.owner, input.owner)
  if (attestation.snapshotDigest !== snapshotDigest) fail("snapshot_mismatch")
  assertDiscoveryReceipt(attestation.scout)
  const continuationKey = scheduledTaskGraphContinuationKey(input.owner, input.attestation)
  const existing = parseExistingCheckpoint(input.existingCheckpoint)
  const candidateIds = attestation.scout.candidateJobIds
  const ownedJobs = validateOwnedJobs(input.ownedJobs, candidateIds, input.owner.userId)
  if (existing?.marker) {
    if (existing.marker.key !== continuationKey || !sameOwner(existing.marker.owner, input.owner)
      || existing.marker.snapshotDigest !== snapshotDigest || existing.marker.graphRevision !== attestation.graphRevision
      || existing.marker.evidenceDigest !== attestation.evidenceDigest) fail("checkpoint_conflict")
    const persisted = validatePersistedCheckpoint(existing.value, ownedJobs, candidateIds, attestation.analyst.jobIds)
    return { checkpoint: { ...existing.value, ...persisted, scheduledTaskGraphContinuation: existing.value.scheduledTaskGraphContinuation } as unknown as ScheduledTaskGraphPipelineCheckpoint, continuationKey, alreadyPersisted: true }
  }

  const scoredJobs = candidateIds.length === 0
    ? validateZeroCandidateAnalysis(input.analyzeResult)
    : validateAnalysis(input.analyzeResult, ownedJobs, candidateIds, attestation.analyst.jobIds)
  const now = input.now ?? new Date()
  if (!Number.isFinite(now.getTime())) fail("invalid_owner")
  const previous = existing?.value
  const checkpoint: ScheduledTaskGraphPipelineCheckpoint = {
    ...previous,
    ...(typeof previous?.startedAt === "string" ? { startedAt: previous.startedAt } : { startedAt: now.toISOString() }),
    ...(typeof previous?.eventIndex === "number" && Number.isSafeInteger(previous.eventIndex) && previous.eventIndex >= 0
      ? { eventIndex: previous.eventIndex } : {}),
    ...(typeof previous?.autonomous === "boolean" ? { autonomous: previous.autonomous } : {}),
    nextStage: "prepare",
    scoutedJobs: ownedJobs.map(job => ({ ...job, coverLetter: null })),
    scoredJobs: scoredJobs.map(row => ({ ...row, job: { ...row.job, coverLetter: null } })),
    analysisFailed: input.analyzeResult?.data?.failed ?? 0,
    scheduledTaskGraphContinuation: {
      schemaVersion: CONTINUATION_SCHEMA,
      key: continuationKey,
      owner: { ...input.owner },
      snapshotDigest,
      graphRevision: attestation.graphRevision,
      evidenceDigest: attestation.evidenceDigest,
    },
  }
  return { checkpoint, continuationKey, alreadyPersisted: false }
}
function validateOwner(owner: ScheduledTaskGraphPipelineOwner): void {
  if (!owner || typeof owner !== "object"
    || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    || !positiveInteger(owner.rootAttemptCount) || !positiveInteger(owner.turnLeaseVersion) || !safeCount(owner.executionAttemptCount)) fail("invalid_owner")
}
function parseAttestation(value: unknown): ScheduledPipelineAttestation {
  if (!safeJsonData(value) || !exactRecord(value, ["schemaVersion", "owner", "snapshotDigest", "graphRevision", "scout", "analyst", "evidenceDigest"])) fail("invalid_attestation")
  const row = value as Record<string, unknown>
  const owner = parseOwner(row.owner)
  if (row.schemaVersion !== ATTESTATION_SCHEMA || !isSnapshotDigest(row.snapshotDigest)
    || !positiveInteger(row.graphRevision) || !isDigest(row.evidenceDigest)) fail("invalid_attestation")
  const scoutRow = exactRecord(row.scout, ["taskId", "attemptCount", "status", "verification", "resultDigest", "candidateJobIds", "discoveryReceipt"])
  const analystRow = exactRecord(row.analyst, ["taskId", "attemptCount", "status", "verification", "resultDigest", "dependsOnTaskIds", "jobIds"])
  if (!scoutRow || !analystRow || !owner) fail("invalid_attestation")
  const scout = parseScout(scoutRow)
  const analyst = parseAnalyst(analystRow)
  if (!scout || !analyst || analyst.dependsOnTaskIds.length !== 1 || analyst.dependsOnTaskIds[0] !== scout.taskId
    || analyst.jobIds.some(id => !scout.candidateJobIds.includes(id))) fail("invalid_attestation")
  return { schemaVersion: ATTESTATION_SCHEMA, owner, snapshotDigest: row.snapshotDigest, graphRevision: row.graphRevision as number, scout, analyst, evidenceDigest: row.evidenceDigest }
}
function parseOwner(value: unknown): AttestationOwner | null {
  if (!exactRecord(value, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"])) return null
  const row = value as Record<string, unknown>
  return [row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId].every(validId)
    && positiveInteger(row.rootAttemptCount) && positiveInteger(row.turnLeaseVersion)
    ? { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string, rootTaskId: row.rootTaskId as string, rootAttemptCount: row.rootAttemptCount as number, turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: row.turnLeaseVersion as number }
    : null
}
function parseScout(row: Record<string, unknown>): ScheduledPipelineAttestation["scout"] | null {
  const candidateJobIds = uniqueIds(row.candidateJobIds)
  const receipt = parseDiscoveryReceipt(row.discoveryReceipt)
  if (!validId(row.taskId) || !positiveInteger(row.attemptCount) || row.status !== "completed" || row.verification !== "passed"
    || !isDigest(row.resultDigest) || !candidateJobIds || !receipt) return null
  return { taskId: row.taskId, attemptCount: row.attemptCount as number, status: "completed", verification: "passed", resultDigest: row.resultDigest, candidateJobIds, discoveryReceipt: receipt }
}
function parseAnalyst(row: Record<string, unknown>): ScheduledPipelineAttestation["analyst"] | null {
  const dependsOnTaskIds = uniqueIds(row.dependsOnTaskIds)
  const jobIds = uniqueIds(row.jobIds)
  if (!validId(row.taskId) || !positiveInteger(row.attemptCount) || row.status !== "completed" || row.verification !== "passed"
    || !isDigest(row.resultDigest) || !dependsOnTaskIds || !jobIds) return null
  return { taskId: row.taskId, attemptCount: row.attemptCount as number, status: "completed", verification: "passed", resultDigest: row.resultDigest, dependsOnTaskIds, jobIds }
}
function parseDiscoveryReceipt(value: unknown): DiscoveryReceipt | null {
  if (!exactRecord(value, ["status", "taskId", "attemptCount", "completedCalls", "candidateCount", "providerFailures", "materializationFailures", "hasMore", "receiptDigest"])) return null
  const row = value as Record<string, unknown>
  if (row.status !== "complete" || !validId(row.taskId) || !positiveInteger(row.attemptCount)
    || !safeCount(row.completedCalls) || !safeCount(row.candidateCount) || !safeCount(row.providerFailures)
    || !safeCount(row.materializationFailures) || typeof row.hasMore !== "boolean" || !isDigest(row.receiptDigest)) return null
  return { status: "complete", taskId: row.taskId, attemptCount: row.attemptCount as number, completedCalls: row.completedCalls as number, candidateCount: row.candidateCount as number, providerFailures: row.providerFailures as number, materializationFailures: row.materializationFailures as number, hasMore: row.hasMore, receiptDigest: row.receiptDigest }
}
function assertDiscoveryReceipt(scout: ScheduledPipelineAttestation["scout"]): void {
  const receipt = scout.discoveryReceipt
  if (receipt.taskId !== scout.taskId || receipt.attemptCount !== scout.attemptCount || receipt.completedCalls < 1
    || receipt.candidateCount !== scout.candidateJobIds.length || receipt.providerFailures !== 0
    || receipt.materializationFailures !== 0 || receipt.hasMore) fail("discovery_incomplete")
}
function assertAttestationOwner(actual: AttestationOwner, expected: ScheduledTaskGraphPipelineOwner): void {
  if (actual.userId !== expected.userId || actual.sessionId !== expected.sessionId || actual.turnId !== expected.turnId
    || actual.rootTaskId !== expected.rootTaskId || actual.rootAttemptCount !== expected.rootAttemptCount) fail("owner_mismatch")
}
function validateOwnedJobs(rows: readonly Job[] | undefined, candidateIds: readonly string[], userId: string): Job[] {
  if (!Array.isArray(rows) || rows.length !== candidateIds.length) fail("jobs_mismatch")
  const byId = new Map<string, Job>()
  for (const job of rows) {
    if (!job || !validId(job.id) || job.userId !== userId || byId.has(job.id)) fail("jobs_mismatch")
    byId.set(job.id, job)
  }
  const ordered = candidateIds.map(id => byId.get(id))
  if (ordered.some(job => !job)) fail("jobs_mismatch")
  return ordered as Job[]
}
function validateZeroCandidateAnalysis(result: StageResult<AnalyzeOutput> | undefined): ScoredJob[] {
  if (result && (result.stage !== "analyze" || !result.ok || !result.data || result.data.scoredJobs.length !== 0 || result.data.failed !== 0)) fail("analysis_invalid")
  return []
}
function validatePersistedCheckpoint(state: Record<string, unknown>, ownedJobs: readonly Job[], candidateIds: readonly string[], analystJobIds: readonly string[]): Pick<ScheduledTaskGraphPipelineCheckpoint, "scoutedJobs" | "scoredJobs" | "analysisFailed"> {
  const savedJobs = state.scoutedJobs, rawScores = state.scoredJobs, failed = state.analysisFailed
  if (!Array.isArray(savedJobs) || savedJobs.length !== candidateIds.length
    || savedJobs.some((job, index) => record(job)?.id !== candidateIds[index])) fail("jobs_mismatch")
  if (!Array.isArray(rawScores) || !safeCount(failed)) fail("analysis_invalid")
  const jobsById = new Map(ownedJobs.map(job => [job.id, job]))
  const scoredJobs = rawScores.map(raw => {
    const row = record(raw), id = record(row?.job)?.id
    if (!row || typeof id !== "string" || !jobsById.has(id)) fail("analysis_invalid")
    const job = jobsById.get(id)!
    return { job, score: row.score, matchedKeywords: row.matchedKeywords, missingKeywords: row.missingKeywords,
      recommendation: row.recommendation, analysisFenceAt: row.analysisFenceAt } as unknown as ScoredJob
  })
  const result: StageResult<AnalyzeOutput> = { stage: "analyze", ok: true, data: { scoredJobs, failed }, metrics: { durationMs: 0, count: scoredJobs.length } }
  const safeScores = (candidateIds.length === 0 ? validateZeroCandidateAnalysis(result) : validateAnalysis(result, ownedJobs, candidateIds, analystJobIds)).map(row => ({ ...row, job: { ...row.job, coverLetter: null } }))
  return { scoutedJobs: ownedJobs.map(job => ({ ...job, coverLetter: null })), scoredJobs: safeScores, analysisFailed: failed }
}
function validateAnalysis(
  result: StageResult<AnalyzeOutput> | undefined,
  ownedJobs: readonly Job[],
  candidateIds: readonly string[],
  analystJobIds: readonly string[],
): ScoredJob[] {
  if (!result || result.stage !== "analyze" || !result.ok || !result.data || !Array.isArray(result.data.scoredJobs)
    || !safeCount(result.data.failed) || result.data.failed + result.data.scoredJobs.length > candidateIds.length) fail("analysis_invalid")
  const jobsById = new Map(ownedJobs.map(job => [job.id, job]))
  const candidateSet = new Set(candidateIds)
  const scoresById = new Map<string, ScoredJob>()
  for (const scored of result.data.scoredJobs) {
    if (!scored || !scored.job || !candidateSet.has(scored.job.id) || scoresById.has(scored.job.id)
      || jobsById.get(scored.job.id) !== scored.job || !Number.isSafeInteger(scored.score) || scored.score < 0 || scored.score > 100
      || !stringList(scored.matchedKeywords) || !stringList(scored.missingKeywords)
      || typeof scored.recommendation !== "string" || !isRealFence(scored.analysisFenceAt)) fail("analysis_invalid")
    scoresById.set(scored.job.id, scored)
  }
  if (scoresById.size === 0) fail("analysis_invalid")
  const rankedIds = [...analystJobIds, ...candidateIds.filter(id => !analystJobIds.includes(id))]
  return rankedIds.map(id => scoresById.get(id)).filter((job): job is ScoredJob => job !== undefined)
}
function parseExistingCheckpoint(value: unknown): { value: Partial<PipelineCheckpointState> & Record<string, unknown>; marker?: { key: string; owner: ScheduledTaskGraphPipelineOwner; snapshotDigest: string; graphRevision: number; evidenceDigest: string } } | null {
  if (value === undefined || value === null) return null
  if (!safeJsonData(value) || typeof value !== "object" || Array.isArray(value)) fail("checkpoint_conflict")
  const row = value as Record<string, unknown>
  if (typeof row.nextStage !== "string" || !PIPELINE_STAGES.has(row.nextStage)) fail("checkpoint_conflict")
  const markerValue = row.scheduledTaskGraphContinuation
  if (markerValue === undefined) {
    if (row.nextStage !== "scout") fail("checkpoint_conflict")
    return { value: row as Partial<PipelineCheckpointState> & Record<string, unknown> }
  }
  const marker = exactRecord(markerValue, ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"])
  if (!marker || marker.schemaVersion !== CONTINUATION_SCHEMA || !validId(marker.key)
    || !isSnapshotDigest(marker.snapshotDigest) || !positiveInteger(marker.graphRevision) || !isDigest(marker.evidenceDigest)) fail("checkpoint_conflict")
  const owner = parseExecutionOwner(marker.owner)
  if (!owner) fail("checkpoint_conflict")
  return { value: row as Partial<PipelineCheckpointState> & Record<string, unknown>, marker: { key: marker.key as string, owner, snapshotDigest: marker.snapshotDigest as string, graphRevision: marker.graphRevision as number, evidenceDigest: marker.evidenceDigest as string } }
}
function parseExecutionOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  if (!exactRecord(value, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"])) return null
  const row = value as Record<string, unknown>
  if (![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    || !positiveInteger(row.rootAttemptCount) || !positiveInteger(row.turnLeaseVersion) || !safeCount(row.executionAttemptCount)) return null
  return { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string,
    rootTaskId: row.rootTaskId as string, rootAttemptCount: row.rootAttemptCount as number,
    turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: row.turnLeaseVersion as number,
    executionId: row.executionId as string, executionAttemptCount: row.executionAttemptCount as number }
}
function createContinuationKey(owner: ScheduledTaskGraphPipelineOwner, attestation: ScheduledPipelineAttestation): string {
  const receipt = attestation.scout.discoveryReceipt
  const evidence = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    owner.executionId, owner.executionAttemptCount, attestation.snapshotDigest, attestation.graphRevision,
    attestation.scout.taskId, attestation.scout.attemptCount, attestation.scout.resultDigest,
    attestation.analyst.taskId, attestation.analyst.attemptCount, attestation.analyst.resultDigest,
    attestation.evidenceDigest, receipt.receiptDigest]
  return "scheduled-taskgraph:sha256:" + createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex")
}
function sameOwner(left: ScheduledTaskGraphPipelineOwner, right: ScheduledTaskGraphPipelineOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
    ? value as Record<string, unknown> : null
}
function safeJsonData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      return keys.length === value.length + 1 && keys.includes("length") && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
        && Array.from({ length: value.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); return Boolean(d?.enumerable && Object.hasOwn(d, "value") && safeJsonData(d.value, seen)) }).every(Boolean)
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
    return Reflect.ownKeys(value).every(key => typeof key === "string" && (() => {
      const d = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(d?.enumerable && Object.hasOwn(d, "value") && safeJsonData(d.value, seen))
    })())
  } catch { return false }
  finally { seen.delete(value) }
}
function uniqueIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(validId) || new Set(value).size !== value.length) return null
  return [...value]
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string") }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): value is string { return typeof value === "string" && HEX_DIGEST.test(value) }
function isSnapshotDigest(value: unknown): value is string { return typeof value === "string" && SNAPSHOT_DIGEST.test(value) }
function isRealFence(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function fail(reason: ScheduledTaskGraphCheckpointReason): never { throw new ScheduledTaskGraphCheckpointError(reason) }
