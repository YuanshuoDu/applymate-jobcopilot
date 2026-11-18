import { createHash } from "node:crypto"

const FINGERPRINT_FIELD = "scheduledTaskGraphAnalyzeSourceFingerprints"
const FINGERPRINT_VERSION = "agent-harness.v2.analyze-source-input.v1"
const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1"
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1"
const JOURNAL_SCHEMA = "agent-harness.v2.scheduled-taskgraph-analysis-journal.v2"
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId",
  "turnLeaseVersion", "executionId", "executionAttemptCount"] as const
const CLAIM_KEYS = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"] as const
const CONTINUATION_KEYS = ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"] as const
const JOURNAL_KEYS = ["schemaVersion", "key", "owner", "attemptsByJob", "failedJobIds", "sourceFingerprintsByJob"] as const
type Row = Record<string, unknown>
export type ScheduledAnalyzeSourceFingerprintRow = readonly [jobId: string, version: string, digest: string]

export type ScheduledAnalyzeCheckpointDigestInput = Readonly<{
  state: unknown
  owner: readonly unknown[]
  snapshotDigest: string
  evidenceDigest: string
  analyzeGraphRevision: number
  analysisFailed: number
  scoredJobs: readonly Row[]
}>

/** Builds the single Worker digest projection shared with Web's scheduled Gate checkpoint. */
export function scheduledAnalyzeCheckpointDigest(input: ScheduledAnalyzeCheckpointDigestInput): string | null {
  const scoredJobIds: string[] = []
  for (const row of input.scoredJobs) {
    if (!validId(row.jobId)) return null
    scoredJobIds.push(row.jobId)
  }
  const sourceFingerprints = scheduledAnalyzeSourceFingerprintProjection(input.state, scoredJobIds)
  if (!sourceFingerprints) return null
  try {
    return createHash("sha256").update(JSON.stringify({ owner: [...input.owner], snapshotDigest: input.snapshotDigest,
      evidenceDigest: input.evidenceDigest, analyzeGraphRevision: input.analyzeGraphRevision,
      analysisFailed: input.analysisFailed, scoredJobs: input.scoredJobs, sourceFingerprints }), "utf8").digest("hex")
  } catch { return null }
}

/** Uses the canonical UTC timestamp shape accepted by the Web checkpoint verifier. */
export function isCanonicalAnalyzeCheckpointTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}

/** Returns the same sorted source-fingerprint rows used by the Web checkpoint digest. */
export function scheduledAnalyzeSourceFingerprintProjection(
  value: unknown,
  scoredJobIds: readonly string[],
): readonly ScheduledAnalyzeSourceFingerprintRow[] | null {
  const state = record(value)
  if (!state || scoredJobIds.some(jobId => !validId(jobId)) || new Set(scoredJobIds).size !== scoredJobIds.length) return null
  const fingerprintsValue = state[FINGERPRINT_FIELD], fingerprints = record(fingerprintsValue)
  if (scoredJobIds.length === 0) return safeEmptyAnalyzeCheckpoint(state, fingerprintsValue) ? [] : null
  if (!fingerprints) return null
  const ids = [...scoredJobIds].sort(), keys = Object.keys(fingerprints).sort()
  if (keys.length !== ids.length || keys.some((key, index) => key !== ids[index])) return null
  const projection: ScheduledAnalyzeSourceFingerprintRow[] = []
  for (const jobId of ids) {
    const fingerprint = record(fingerprints[jobId])
    if (!fingerprint || !exactKeys(fingerprint, ["digest", "version"]) || fingerprint.version !== FINGERPRINT_VERSION
      || !validText(fingerprint.digest, /^[0-9a-f]{64}$/)) return null
    projection.push([jobId, fingerprint.version, fingerprint.digest])
  }
  return projection
}

function safeEmptyAnalyzeCheckpoint(state: Row, fingerprintsValue: unknown): boolean {
  if (!(
    ["prepare", "gate", "execute", "audit", "completed"].includes(String(state.nextStage))
    && Array.isArray(state.scoutedJobs) && state.scoutedJobs.length === 0 && Array.isArray(state.scoredJobs) && state.scoredJobs.length === 0
    && state.analysisFailed === 0 && (state.scheduledTaskGraphPreparedArtifacts === undefined
      || Array.isArray(state.scheduledTaskGraphPreparedArtifacts) && state.scheduledTaskGraphPreparedArtifacts.length === 0)
    && state.scheduledTaskGraphScheduledWaitId === undefined
    && (!Object.hasOwn(state, FINGERPRINT_FIELD) || emptyFingerprintMap(fingerprintsValue)))) return false
  const claim = record(state.scheduledTaskGraphClaim), continuation = record(state.scheduledTaskGraphContinuation)
  const owner = record(claim?.owner), continuationOwner = record(continuation?.owner)
  if (!claim || !exactKeys(claim, CLAIM_KEYS) || claim.schemaVersion !== CLAIM_SCHEMA || !validId(claim.key) || !validId(claim.claimToken)
    || !validOwner(owner) || !validIso(claim.claimedAt) || !validIso(claim.leaseExpiresAt)
    || !continuation || !exactKeys(continuation, CONTINUATION_KEYS) || continuation.schemaVersion !== CONTINUATION_SCHEMA
    || continuation.key !== claim.key || !validOwner(continuationOwner) || !owner || !OWNER_KEYS.every(key => continuationOwner[key] === owner[key])
    || typeof continuation.snapshotDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(continuation.snapshotDigest)
    || !positive(continuation.graphRevision) || typeof continuation.evidenceDigest !== "string" || !/^[0-9a-f]{64}$/.test(continuation.evidenceDigest)) return false
  const decisions = record(state.scheduledTaskGraphGateDecisions)
  if (state.scheduledTaskGraphGateDecisions !== undefined && (!decisions || !exactKeys(decisions, ["approvedJobIds", "pendingJobIds", "skippedJobIds"])
    || ![decisions.approvedJobIds, decisions.pendingJobIds, decisions.skippedJobIds].every(value => Array.isArray(value) && value.length === 0))) return false
  const journalValue = state.scheduledTaskGraphAnalyzeJournal
  if (journalValue === undefined) return true
  const journal = record(journalValue), journalOwner = record(journal?.owner), attempts = record(journal?.attemptsByJob)
  return Boolean(journal && exactKeys(journal, JOURNAL_KEYS) && journal.schemaVersion === JOURNAL_SCHEMA && journal.key === claim.key
    && validOwner(journalOwner) && owner && OWNER_KEYS.every(key => journalOwner[key] === owner[key]) && attempts && Object.keys(attempts).length === 0
    && Array.isArray(journal.failedJobIds) && journal.failedJobIds.length === 0 && emptyFingerprintMap(journal.sourceFingerprintsByJob))
}

function validOwner(value: unknown): value is Row {
  const owner = record(value)
  return Boolean(owner && exactKeys(owner, OWNER_KEYS) && [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId,
    owner.turnLeaseOwnerId, owner.executionId].every(validId) && positive(owner.rootAttemptCount) && positive(owner.turnLeaseVersion)
    && Number.isSafeInteger(owner.executionAttemptCount) && Number(owner.executionAttemptCount) >= 0)
}
function emptyFingerprintMap(value: unknown): boolean { const row = record(value); return Boolean(row && Object.keys(row).length === 0) }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function validText(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validIso(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
