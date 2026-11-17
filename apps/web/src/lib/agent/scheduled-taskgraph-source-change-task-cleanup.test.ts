import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readClaims: vi.fn() }));
vi.mock("./stages/analyze-model-input", () => ({
  MAX_ANALYZE_SOURCE_CHANGE_CLAIMS: 128,
  readAnalyzeSourceChangedClaims: mocks.readClaims,
  createAnalyzeSourceChangedErrorWithClaims: (claims: readonly unknown[]) => {
    mocks.readClaims.mockReturnValue(claims);
    return new Error("source changed");
  },
  hasCompleteAnalyzeSourceFingerprints: (jobIds: readonly string[], value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return jobIds.length === 0 && value === undefined;
    const row = value as Record<string, unknown>;
    return Object.keys(row).sort().join(",") === [...jobIds].sort().join(",")
      && Object.values(row).every(fingerprint => Boolean(fingerprint && typeof fingerprint === "object"
        && (fingerprint as { version?: unknown }).version === "agent-harness.v2.analyze-source-input.v1"
        && /^[0-9a-f]{64}$/.test(String((fingerprint as { digest?: unknown }).digest))));
  },
}));

import { scheduledAnalyzeSourceChangedErrorForUntrustedState, scheduledAnalyzeSourceProofIsUntrusted,
  scheduledSourceChangeTaskClaims, terminalizeScheduledAnalyzeSourceChangedTasks } from "./scheduled-taskgraph-source-change-task-cleanup";

const userId = "user_1", sessionId = "session_1";
const firstFence = "2026-11-16T10:00:00.001Z", secondFence = "2026-11-16T10:00:00.002Z";
const fingerprint = { version: "agent-harness.v2.analyze-source-input.v1", digest: "a".repeat(64) };
const state = { scoutedJobs: [{ id: "job_1" }, { id: "job_2" }],
  scoredJobs: [{ job: { id: "job_1" }, analysisFenceAt: firstFence }] };
const error = new Error("source changed");
const emptyOwner = { userId, sessionId, turnId: "turn_1", rootTaskId: "root_1", rootAttemptCount: 1,
  turnLeaseOwnerId: "worker_1", turnLeaseVersion: 2, executionId: "execution_1", executionAttemptCount: 0 };
type EmptyCheckpoint = { nextStage: string; scoutedJobs: unknown[]; scoredJobs: unknown[]; analysisFailed: number;
  scheduledTaskGraphClaim: Record<string, unknown>; scheduledTaskGraphContinuation: Record<string, unknown>; [key: string]: unknown };
function emptyCheckpoint(): EmptyCheckpoint {
  const key = "continuation_1";
  return { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken: "token_1",
      owner: emptyOwner, claimedAt: firstFence, leaseExpiresAt: "2026-11-16T10:10:00.000Z" },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key,
      owner: emptyOwner, snapshotDigest: `sha256:${"a".repeat(64)}`, graphRevision: 1, evidenceDigest: "b".repeat(64) } };
}
function legacyEmptyJournalCheckpoint() {
  const key = "continuation_legacy";
  return { nextStage: "scout", scoutedJobs: [{ id: "job_1" }, { id: "job_2" }], scoredJobs: [], analysisFailed: 0,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken: "token_legacy",
      owner: emptyOwner, claimedAt: firstFence, leaseExpiresAt: "2026-11-16T10:10:00.000Z" },
    scheduledTaskGraphAnalyzeJournal: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1", key,
      owner: emptyOwner, attemptsByJob: { job_1: 1 }, failedJobIds: [] } };
}
function v2EmptyJournalCheckpoint() {
  const key = "continuation_v2";
  return { nextStage: "scout", scoutedJobs: [{ id: "job_1" }, { id: "job_2" }], scoredJobs: [], analysisFailed: 1,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken: "token_v2",
      owner: emptyOwner, claimedAt: firstFence, leaseExpiresAt: "2026-11-16T10:10:00.000Z" },
    scheduledTaskGraphAnalyzeJournal: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v2", key,
      owner: emptyOwner, attemptsByJob: { job_1: 1, job_2: 1 }, failedJobIds: ["job_1"], sourceFingerprintsByJob: {} } };
}
function makeTx(updateMany = vi.fn(async () => ({ count: 1 }))) {
  return { applicationTask: { updateMany } } as never;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("scheduled Analyze source-change task cleanup", () => {
  it("blocks legacy v1 and missing full-checkpoint provenance before lease rebind", () => {
    const legacy = { ...state, scheduledTaskGraphAnalyzeJournal: {
      schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1", key: "continuation",
      owner: {}, attemptsByJob: { job_1: 1 }, failedJobIds: [],
    } };
    const complete = { ...state, scheduledTaskGraphContinuation: {},
      scheduledTaskGraphAnalyzeSourceFingerprints: { job_1: fingerprint } };

    expect(scheduledAnalyzeSourceProofIsUntrusted(legacy)).toBe(true);
    expect(scheduledAnalyzeSourceChangedErrorForUntrustedState(legacy)).toBeInstanceOf(Error);
    expect(scheduledAnalyzeSourceProofIsUntrusted(complete)).toBe(false);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...state, scheduledTaskGraphContinuation: {} })).toBe(true);
  });

  it("accepts missing provenance only for a strictly valid zero-score checkpoint", () => {
    const empty = emptyCheckpoint();
    expect(scheduledAnalyzeSourceProofIsUntrusted(empty)).toBe(false);
    expect(scheduledAnalyzeSourceChangedErrorForUntrustedState(empty)).toBeNull();
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scheduledTaskGraphAnalyzeSourceFingerprints: {} })).toBe(false);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scoredJobs: [{ job: { id: "job_1" }, analysisFenceAt: firstFence }] })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scoredJobs: undefined })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scoredJobs: [null] })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scheduledTaskGraphAnalyzeSourceFingerprints: null })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scheduledTaskGraphAnalyzeSourceFingerprints: undefined })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scoutedJobs: [{ id: "job_1" }] })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, analysisFailed: 1 })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scheduledTaskGraphClaim: {
      ...(empty.scheduledTaskGraphClaim), owner: { ...emptyOwner, executionId: "foreign_execution" },
    } })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...empty, scheduledTaskGraphContinuation: {
      ...empty.scheduledTaskGraphContinuation, snapshotDigest: "bad",
    } })).toBe(true);
  });

  it("does not source-terminalize a structurally valid zero-score v1 partial journal", () => {
    const legacy = legacyEmptyJournalCheckpoint();
    expect(scheduledAnalyzeSourceProofIsUntrusted(legacy)).toBe(false);
    expect(scheduledAnalyzeSourceChangedErrorForUntrustedState(legacy)).toBeNull();
    expect(scheduledAnalyzeSourceProofIsUntrusted(legacy, ["job_1", "job_2"])).toBe(false);
    expect(scheduledAnalyzeSourceProofIsUntrusted(legacy, ["job_1"])).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...legacy, scoredJobs: [{ job: { id: "job_1" }, analysisFenceAt: firstFence }] })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...legacy, scheduledTaskGraphAnalyzeSourceFingerprints: {} })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...legacy, scoutedJobs: [{ id: "job_1" }, { id: "job_1" }] })).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...legacy, analysisFailed: 1 })).toBe(true);
    const wrongOwner = { ...legacy, scheduledTaskGraphAnalyzeJournal: {
      ...legacy.scheduledTaskGraphAnalyzeJournal, owner: { ...emptyOwner, executionId: "foreign_execution" },
    } };
    expect(scheduledAnalyzeSourceProofIsUntrusted(wrongOwner)).toBe(true);
    const invalidAttempts = { ...legacy, scheduledTaskGraphAnalyzeJournal: {
      ...legacy.scheduledTaskGraphAnalyzeJournal, attemptsByJob: { foreign_job: 1 },
    } };
    expect(scheduledAnalyzeSourceProofIsUntrusted(invalidAttempts)).toBe(true);
  });

  it("allows a reader-valid scoreless v2 partial journal with an exact failed ledger", () => {
    const partial = v2EmptyJournalCheckpoint();
    expect(scheduledAnalyzeSourceProofIsUntrusted(partial, ["job_1", "job_2"])).toBe(false);
    expect(scheduledAnalyzeSourceProofIsUntrusted(partial, ["job_1"])).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...partial, analysisFailed: 0 }, ["job_1", "job_2"])).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...partial, scheduledTaskGraphAnalyzeJournal: {
      ...partial.scheduledTaskGraphAnalyzeJournal, failedJobIds: ["job_1", "job_1"],
    } }, ["job_1", "job_2"])).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...partial, scheduledTaskGraphAnalyzeJournal: {
      ...partial.scheduledTaskGraphAnalyzeJournal, attemptsByJob: { foreign_job: 1 },
    } }, ["job_1", "job_2"])).toBe(true);
    expect(scheduledAnalyzeSourceProofIsUntrusted({ ...partial, scheduledTaskGraphAnalyzeJournal: {
      ...partial.scheduledTaskGraphAnalyzeJournal, sourceFingerprintsByJob: { job_1: fingerprint },
    } }, ["job_1", "job_2"])).toBe(true);
  });

  it("accepts only exact server claims scoped to persisted candidates and score fences", () => {
    mocks.readClaims.mockReturnValue([
      { jobId: "job_1", analysisFenceAt: firstFence },
      { jobId: "job_2", analysisFenceAt: secondFence },
    ]);
    const claims = scheduledSourceChangeTaskClaims(error, state);

    expect(claims).toEqual([
      { jobId: "job_1", analysisFenceAt: new Date(firstFence) },
      { jobId: "job_2", analysisFenceAt: new Date(secondFence) },
    ]);
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).not.toContain("job_1");
  });

  it("allows an empty claim set only when there are no persisted scores", () => {
    mocks.readClaims.mockReturnValue([]);
    expect(scheduledSourceChangeTaskClaims(error, { scoutedJobs: [], scoredJobs: [] })).toEqual([]);
    expect(scheduledSourceChangeTaskClaims(error, state)).toBeNull();
  });

  it.each([
    ["missing metadata", null, state],
    ["extra token fields", [{ jobId: "job_1", analysisFenceAt: firstFence, userId }], state],
    ["duplicate jobs", [{ jobId: "job_1", analysisFenceAt: firstFence }, { jobId: "job_1", analysisFenceAt: secondFence }], state],
    ["noncanonical fence", [{ jobId: "job_1", analysisFenceAt: "2026-11-16T10:00:00Z" }], state],
    ["foreign job", [{ jobId: "other_job", analysisFenceAt: firstFence }], state],
    ["mismatched saved score fence", [{ jobId: "job_1", analysisFenceAt: secondFence }], state],
    ["omitted saved score claim", [{ jobId: "job_2", analysisFenceAt: secondFence }], state],
    ["invalid persisted score fence", [{ jobId: "job_1", analysisFenceAt: firstFence }], { ...state, scoredJobs: [{ job: { id: "job_1" }, analysisFenceAt: "bad" }] }],
  ])("rejects %s before task writes", (_label, claims, expectedState) => {
    mocks.readClaims.mockReturnValue(claims);
    expect(scheduledSourceChangeTaskClaims(error, expectedState)).toBeNull();
  });

  it("rejects an over-bound claim list before cleanup", () => {
    mocks.readClaims.mockReturnValue(Array.from({ length: 129 }, (_, index) => ({
      jobId: `job_${index}`, analysisFenceAt: firstFence,
    })));
    expect(scheduledSourceChangeTaskClaims(error, { scoutedJobs: [], scoredJobs: [] })).toBeNull();
  });

  it("CASes only exact user, session, candidate, Analyze state and fence; misses stay untouched", async () => {
    const claims = [
      { jobId: "job_1", analysisFenceAt: new Date(firstFence) },
      { jobId: "job_2", analysisFenceAt: new Date(secondFence) },
    ];
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await terminalizeScheduledAnalyzeSourceChangedTasks(makeTx(updateMany), { userId, sessionId, claims });

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ userId, sessionId, jobId: "job_1", status: "analyzing",
        checkpoint: "match_analysis", updatedAt: new Date(firstFence) }),
      data: expect.objectContaining({ status: "failed", checkpoint: "analyze_source_changed",
        error: "scheduled_pipeline_source_changed" }),
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ userId, sessionId, jobId: "job_2", status: "analyzing",
        checkpoint: "match_analysis", updatedAt: new Date(secondFence) }),
    }));
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("other_job");
  });

  it("propagates database errors so the enclosing owner transaction can roll back atomically", async () => {
    const failure = new Error("database failed");
    const tx = makeTx(vi.fn().mockRejectedValue(failure));
    await expect(terminalizeScheduledAnalyzeSourceChangedTasks(tx, {
      userId, sessionId, claims: [{ jobId: "job_1", analysisFenceAt: new Date(firstFence) }],
    })).rejects.toBe(failure);
  });

  it.each([
    ["empty", []],
    ["duplicate", [{ jobId: "job_1", analysisFenceAt: new Date(firstFence) }, { jobId: "job_1", analysisFenceAt: new Date(secondFence) }]],
    ["invalid date", [{ jobId: "job_1", analysisFenceAt: new Date("invalid") }]],
    ["over-bound", Array.from({ length: 129 }, (_, index) => ({ jobId: `job_${index}`, analysisFenceAt: new Date(firstFence) }))],
  ])("rejects %s cleanup claims before the first write", async (_label, claims) => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await expect(terminalizeScheduledAnalyzeSourceChangedTasks(makeTx(updateMany), {
      userId, sessionId, claims: claims as never,
    })).rejects.toThrow("scheduled source-change claims are invalid");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
