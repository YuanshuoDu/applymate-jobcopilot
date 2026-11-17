import type { Prisma } from "@prisma/client";
import { AgentExecutionCancelledError } from "./execution-control";
import { isStructurallySafeScorelessScheduledAnalyzePartial, upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim } from "./scheduled-taskgraph-analysis-journal";
import type { PipelineCtx } from "./pipeline-context";
import { MAX_ANALYZE_SOURCE_CHANGE_CLAIMS, createAnalyzeSourceChangedErrorWithClaims,
  hasCompleteAnalyzeSourceFingerprints, readAnalyzeSourceChangedClaims, validateAnalyzeSourceFingerprints,
  type AnalyzeSourceChangedClaim } from "./stages/analyze-model-input";

const PROTECTED_CHECKPOINTS = ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"];
const SOURCE_CHANGED_CHECKPOINT = "analyze_source_changed";
const JOURNAL_V2 = "agent-harness.v2.scheduled-taskgraph-analysis-journal.v2";
const JOURNAL_V1 = "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1";
const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1";
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1";
const FINGERPRINT_FIELD = "scheduledTaskGraphAnalyzeSourceFingerprints";
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId",
  "turnLeaseVersion", "executionId", "executionAttemptCount"] as const;
type SourceChangeTaskClaim = Readonly<{ jobId: string; analysisFenceAt: Date }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}
function canonicalFence(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function emptyFingerprintMap(value: unknown): boolean {
  const row = record(value);
  return Boolean(row && Object.keys(row).length === 0);
}
function validEmptyOwner(value: unknown): value is Record<string, unknown> {
  const owner = record(value);
  return Boolean(owner && exactKeys(owner, OWNER_KEYS)
    && [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    && Number.isSafeInteger(owner.rootAttemptCount) && Number(owner.rootAttemptCount) > 0
    && Number.isSafeInteger(owner.turnLeaseVersion) && Number(owner.turnLeaseVersion) > 0
    && Number.isSafeInteger(owner.executionAttemptCount) && Number(owner.executionAttemptCount) >= 0);
}
export function isSafeEmptyScheduledAnalyzeCheckpoint(value: unknown): boolean {
  const state = record(value);
  if (!state) return false;
  if (!(["prepare", "gate", "execute", "audit", "completed"].includes(String(state.nextStage))
    && Array.isArray(state.scoutedJobs) && state.scoutedJobs.length === 0
    && Array.isArray(state.scoredJobs) && state.scoredJobs.length === 0 && state.analysisFailed === 0
    && (state.scheduledTaskGraphPreparedArtifacts === undefined
      || Array.isArray(state.scheduledTaskGraphPreparedArtifacts) && state.scheduledTaskGraphPreparedArtifacts.length === 0)
    && state.scheduledTaskGraphScheduledWaitId === undefined
    && (!Object.hasOwn(state, FINGERPRINT_FIELD) || emptyFingerprintMap(state[FINGERPRINT_FIELD])))) return false;
  const claim = record(state.scheduledTaskGraphClaim), continuation = record(state.scheduledTaskGraphContinuation);
  if (!claim || !exactKeys(claim, ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"])
    || claim.schemaVersion !== CLAIM_SCHEMA || !validId(claim.key) || !validId(claim.claimToken)
    || !validEmptyOwner(claim.owner) || typeof claim.claimedAt !== "string" || !canonicalFence(claim.claimedAt)
    || typeof claim.leaseExpiresAt !== "string" || !canonicalFence(claim.leaseExpiresAt)) return false;
  const owner = record(claim.owner);
  if (!continuation || !exactKeys(continuation, ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"])
    || continuation.schemaVersion !== CONTINUATION_SCHEMA || continuation.key !== claim.key
    || !validEmptyOwner(continuation.owner) || !owner || !OWNER_KEYS.every(key => record(continuation.owner)?.[key] === owner[key])
    || typeof continuation.snapshotDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(continuation.snapshotDigest)
    || !Number.isSafeInteger(continuation.graphRevision) || Number(continuation.graphRevision) <= 0
    || typeof continuation.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(continuation.evidenceDigest)) return false;
  const decisions = record(state.scheduledTaskGraphGateDecisions);
  if (state.scheduledTaskGraphGateDecisions !== undefined
    && (!decisions || !exactKeys(decisions, ["approvedJobIds", "pendingJobIds", "skippedJobIds"])
      || ![decisions.approvedJobIds, decisions.pendingJobIds, decisions.skippedJobIds].every(value => Array.isArray(value) && value.length === 0))) return false;
  const journalValue = state.scheduledTaskGraphAnalyzeJournal;
  if (journalValue === undefined) return true;
  const journal = record(journalValue);
  return Boolean(journal && exactKeys(journal, ["schemaVersion", "key", "owner", "attemptsByJob", "failedJobIds", "sourceFingerprintsByJob"])
    && journal.schemaVersion === JOURNAL_V2 && journal.key === claim.key
    && validEmptyOwner(journal.owner) && OWNER_KEYS.every(key => record(journal.owner)?.[key] === owner?.[key])
    && record(journal.attemptsByJob) && Object.keys(record(journal.attemptsByJob)!).length === 0
    && Array.isArray(journal.failedJobIds) && journal.failedJobIds.length === 0
    && emptyFingerprintMap(journal.sourceFingerprintsByJob));
}
function persistedScoreClaims(state: Record<string, unknown>): readonly { jobId: string; analysisFenceAt: string }[] | null {
  if (!Array.isArray(state.scoredJobs)) return null;
  const seen = new Set<string>(), claims: { jobId: string; analysisFenceAt: string }[] = [];
  for (const raw of state.scoredJobs) {
    const score = record(raw), jobId = record(score?.job)?.id, fence = score?.analysisFenceAt;
    if (!validId(jobId) || typeof fence !== "string" || !canonicalFence(fence) || seen.has(jobId)) return null;
    seen.add(jobId); claims.push({ jobId, analysisFenceAt: fence });
  }
  return Object.freeze(claims);
}

/** Detects saved Analyze state whose score inputs cannot be proven before any lease rebind. */
export function scheduledAnalyzeSourceProofIsUntrusted(value: unknown, expectedCandidateJobIds?: readonly string[]): boolean {
  const state = record(value);
  if (!state) return false;
  if (isStructurallySafeScorelessScheduledAnalyzePartial(value)
    && (!expectedCandidateJobIds || scorelessPartialCandidateSetMatches(state, expectedCandidateJobIds))) return false;
  const journalValue = state.scheduledTaskGraphAnalyzeJournal, journal = record(journalValue);
  if (journalValue !== undefined) {
    const claims = persistedScoreClaims(state), fingerprints = journal?.sourceFingerprintsByJob;
    const trusted = Boolean(journal && journal.schemaVersion === JOURNAL_V2 && Object.hasOwn(journal, "sourceFingerprintsByJob")
      && claims && hasCompleteAnalyzeSourceFingerprints(claims.map(claim => claim.jobId), fingerprints));
    return !trusted || claims?.length === 0 && !isSafeEmptyScheduledAnalyzeCheckpoint(state);
  }
  if (state.scheduledTaskGraphContinuation === undefined
    && !["prepare", "gate", "execute", "audit", "completed"].includes(String(state.nextStage))) return false;
  const claims = persistedScoreClaims(state), fingerprints = state[FINGERPRINT_FIELD];
  if (!claims) return true;
  if (claims.length === 0) return !isSafeEmptyScheduledAnalyzeCheckpoint(state);
  return !Object.hasOwn(state, FINGERPRINT_FIELD)
    || !hasCompleteAnalyzeSourceFingerprints(claims.map(claim => claim.jobId), fingerprints);
}

/** Called only after the route validates the exact expired same-owner claim; v1 migration remains strict. */
export function renewExpiredScheduledAnalyzeClaim(input: {
  state: unknown; owner: Parameters<typeof upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim>[0]["owner"];
  key: string; currentClaimToken: string; claimToken: string; candidateJobIds: readonly string[];
}): Record<string, unknown> | null {
  const state = record(input.state), claim = record(record(input.state)?.scheduledTaskGraphClaim);
  if (!state || !claim || claim.claimToken !== input.currentClaimToken) return null;
  const now = new Date(), claimedAt = now.toISOString(), leaseExpiresAt = new Date(now.getTime() + 600_000).toISOString();
  if (record(state.scheduledTaskGraphAnalyzeJournal)?.schemaVersion === JOURNAL_V1) {
    return upgradeScorelessV1AnalyzeJournalForSameLeaseExpiredClaim({ ...input, state, now: claimedAt, claimedAt, leaseExpiresAt });
  }
  return { ...state, scheduledTaskGraphClaim: { ...claim, claimToken: input.claimToken, claimedAt, leaseExpiresAt } };
}

function scorelessPartialCandidateSetMatches(state: Record<string, unknown>, expectedCandidateJobIds: readonly string[]): boolean {
  if (!Array.isArray(state.scoutedJobs)) return false;
  const actual = new Set<string>(), expected = new Set<string>();
  for (const row of state.scoutedJobs) {
    const id = record(row)?.id;
    if (!validId(id) || actual.has(id)) return false;
    actual.add(id);
  }
  for (const id of expectedCandidateJobIds) {
    if (!validId(id) || expected.has(id)) return false;
    expected.add(id);
  }
  return actual.size === expected.size && [...actual].every(id => expected.has(id));
}

/** Creates a typed source error only from exact persisted score fences; tokens remain in the Analyze WeakMap. */
export function scheduledAnalyzeSourceChangedErrorForUntrustedState(value: unknown) {
  if (!scheduledAnalyzeSourceProofIsUntrusted(value)) return null;
  const state = record(value), claims = state && persistedScoreClaims(state);
  return claims?.length ? createAnalyzeSourceChangedErrorWithClaims(claims, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS) : null;
}

/** Revalidates a persisted score checkpoint under the same transaction as its owner CAS. */
export async function assertScheduledTaskGraphAnalyzeCheckpointSourcesCurrent(
  tx: Prisma.TransactionClient,
  context: PipelineCtx,
  checkpoint: unknown,
): Promise<void> {
  const state = record(checkpoint), rows = state?.scoredJobs;
  if (!state || !Array.isArray(rows)) throw new AgentExecutionCancelledError();
  if (rows.length === 0) {
    if (!isSafeEmptyScheduledAnalyzeCheckpoint(state)) throw new AgentExecutionCancelledError();
    const resumeId = context.defaultResume.id;
    if (typeof resumeId !== "string" || !resumeId.trim() || resumeId.length > 256) {
      throw createAnalyzeSourceChangedErrorWithClaims([], MAX_ANALYZE_SOURCE_CHANGE_CLAIMS);
    }
    const journal = record(state.scheduledTaskGraphAnalyzeJournal);
    const fingerprints = Object.hasOwn(state, FINGERPRINT_FIELD) ? state[FINGERPRINT_FIELD] : journal?.sourceFingerprintsByJob;
    await validateAnalyzeSourceFingerprints(tx, {
      userId: context.userId, resumeId, resumeText: context.resumeText.slice(0, 2000),
      jobIds: [], sourceFingerprintsByJob: fingerprints, claimTokens: [],
    });
    return;
  }
  const jobIds: string[] = [], claimTokens: AnalyzeSourceChangedClaim[] = [], seen = new Set<string>();
  for (const raw of rows) {
    const row = record(raw), jobId = record(row?.job)?.id, fence = row?.analysisFenceAt;
    if (typeof jobId !== "string" || !jobId.trim() || jobId.length > 256 || seen.has(jobId)
      || typeof fence !== "string" || !Number.isFinite(Date.parse(fence)) || new Date(fence).toISOString() !== fence) {
      throw new AgentExecutionCancelledError();
    }
    seen.add(jobId); jobIds.push(jobId); claimTokens.push({ jobId, analysisFenceAt: fence });
  }
  if (!Object.hasOwn(state, FINGERPRINT_FIELD)) {
    throw createAnalyzeSourceChangedErrorWithClaims(claimTokens, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS);
  }
  const resumeId = context.defaultResume.id;
  if (typeof resumeId !== "string" || !resumeId.trim() || resumeId.length > 256) {
    throw createAnalyzeSourceChangedErrorWithClaims(claimTokens, MAX_ANALYZE_SOURCE_CHANGE_CLAIMS);
  }
  await validateAnalyzeSourceFingerprints(tx, {
    userId: context.userId, resumeId, resumeText: context.resumeText.slice(0, 2000),
    jobIds, sourceFingerprintsByJob: state[FINGERPRINT_FIELD], claimTokens,
  });
}

/** Accepts only exact server-only claims that still correspond to this persisted Analyze state. */
export function scheduledSourceChangeTaskClaims(error: unknown, expectedState: unknown): readonly SourceChangeTaskClaim[] | null {
  const rawClaims = readAnalyzeSourceChangedClaims(error), state = record(expectedState);
  if (!Array.isArray(rawClaims) || rawClaims.length > MAX_ANALYZE_SOURCE_CHANGE_CLAIMS
    || !state || !Array.isArray(state.scoutedJobs) || !Array.isArray(state.scoredJobs)) return null;
  const candidateIds = new Set<string>();
  for (const raw of state.scoutedJobs) {
    const id = record(raw)?.id;
    if (!validId(id) || candidateIds.has(id)) return null;
    candidateIds.add(id);
  }
  const scoreFences = new Map<string, string>();
  for (const raw of state.scoredJobs) {
    const score = record(raw), jobId = record(score?.job)?.id, fence = score?.analysisFenceAt;
    if (!validId(jobId) || typeof fence !== "string" || !canonicalFence(fence) || scoreFences.has(jobId)) return null;
    scoreFences.set(jobId, fence);
  }
  const seen = new Set<string>(), claims: SourceChangeTaskClaim[] = [];
  for (const raw of rawClaims) {
    const row = record(raw);
    if (!row || Reflect.ownKeys(row).length !== 2 || !Object.hasOwn(row, "jobId") || !Object.hasOwn(row, "analysisFenceAt")
      || !validId(row.jobId) || typeof row.analysisFenceAt !== "string" || !canonicalFence(row.analysisFenceAt)
      || !candidateIds.has(row.jobId) || seen.has(row.jobId)) return null;
    const savedFence = scoreFences.get(row.jobId);
    if (savedFence !== undefined && savedFence !== row.analysisFenceAt) return null;
    seen.add(row.jobId);
    claims.push(Object.freeze({ jobId: row.jobId, analysisFenceAt: new Date(row.analysisFenceAt) }));
  }
  for (const jobId of scoreFences.keys()) if (!seen.has(jobId)) return null;
  return Object.freeze(claims);
}

/** Runs only after the scheduled execution owner/state CAS, in that same transaction. */
export async function terminalizeScheduledAnalyzeSourceChangedTasks(
  tx: Prisma.TransactionClient,
  input: { userId: string; sessionId: string; claims: readonly SourceChangeTaskClaim[] },
): Promise<void> {
  if (!Array.isArray(input.claims) || input.claims.length === 0 || input.claims.length > MAX_ANALYZE_SOURCE_CHANGE_CLAIMS) {
    throw new Error("scheduled source-change claims are invalid");
  }
  const seen = new Set<string>();
  for (const claim of input.claims) {
    if (!claim || Reflect.ownKeys(claim).length !== 2 || !validId(claim.jobId)
      || !(claim.analysisFenceAt instanceof Date) || !Number.isFinite(claim.analysisFenceAt.getTime())
      || seen.has(claim.jobId)) throw new Error("scheduled source-change claims are invalid");
    seen.add(claim.jobId);
  }
  for (const claim of input.claims) {
    await tx.applicationTask.updateMany({
      where: { userId: input.userId, jobId: claim.jobId, sessionId: input.sessionId,
        status: "analyzing", checkpoint: "match_analysis", updatedAt: claim.analysisFenceAt,
        AND: [{ OR: [{ checkpoint: null }, { checkpoint: { notIn: PROTECTED_CHECKPOINTS } }] }] },
      data: { status: "failed", checkpoint: SOURCE_CHANGED_CHECKPOINT,
        error: "scheduled_pipeline_source_changed", completedAt: new Date() },
    });
  }
}
