import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint";
import { buildScheduledTaskGraphSourceChangeTerminalState, isScheduledTaskGraphSourceChangeTerminal, respondToScheduledTaskGraphAnalyzeSourceChange, terminalizeScheduledTaskGraphSourceChange } from "./scheduled-taskgraph-source-change-terminal";
import { createAnalyzeSourceChangedErrorWithClaims } from "./stages/analyze-model-input";
import { scheduledAnalyzeSourceChangedErrorForUntrustedState } from "./scheduled-taskgraph-source-change-task-cleanup";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), queryRaw: vi.fn(), updateMany: vi.fn(), updateTask: vi.fn(), executionRead: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction, agentExecution: { findFirst: mocks.executionRead } } }));
vi.mock("./scheduled-taskgraph-pipeline-request", () => ({
  blocked: (status: number, errorCode: string) => Response.json({ status: "blocked", errorCode }, { status }),
  matchingTurnSnapshot: (input: unknown) => (input as { scheduledAutomationSnapshot?: unknown })?.scheduledAutomationSnapshot ?? null,
}));
vi.mock("./scheduled-taskgraph-pipeline-checkpoint", () => ({
  scheduledAutomationSnapshotDigest: (snapshot: unknown) => (snapshot as { digest?: string })?.digest ?? "invalid",
}));

const owner: ScheduledTaskGraphPipelineOwner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 3,
  turnLeaseOwnerId: "lease-new", turnLeaseVersion: 8, executionId: "execution-1", executionAttemptCount: 5,
};
const priorOwner = { ...owner, turnLeaseOwnerId: "lease-old", turnLeaseVersion: 7 };
const key = "continuation-1", claimToken = "claim-1", oldDigest = `sha256:${"a".repeat(64)}`;
const currentDigest = `sha256:${"b".repeat(64)}`;

function stateFor(stateOwner: ScheduledTaskGraphPipelineOwner = owner) {
  return {
    nextStage: "analyze", analysisFailed: 1,
    scoutedJobs: [{ id: "job-1" }], scoredJobs: [{ job: { id: "job-1" }, score: 82, analysisFenceAt: "2026-11-01T12:00:00.000Z" }],
    scheduledTaskGraphAnalyzeSourceFingerprints: { "job-1": { version: "agent-harness.v2.analyze-source-input.v1", digest: "a".repeat(64) } },
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner: stateOwner,
      claimedAt: "2026-11-01T12:00:00.000Z", leaseExpiresAt: "2026-11-01T12:10:00.000Z" },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: stateOwner,
      snapshotDigest: oldDigest, graphRevision: 9, evidenceDigest: "c".repeat(64) },
    scheduledTaskGraphAnalyzeJournal: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v2", key,
      owner: stateOwner, attemptsByJob: { "job-1": 1 }, failedJobIds: [], sourceFingerprintsByJob: { "job-1": { version: "agent-harness.v2.analyze-source-input.v1", digest: "a".repeat(64) } } },
    scheduledTaskGraphWait: { schemaVersion: "agent-harness.v2.scheduled-pipeline-wait.v1", waitId: "question-1" },
    scheduledTaskGraphScheduledWaitId: "scheduled-question-1",
  };
}
function liveTurn(digest = oldDigest) {
  return { id: owner.turnId, input: { scheduledAutomationSnapshot: { digest } } };
}
function liveRoot() { return { id: owner.rootTaskId }; }
function resetMocks() {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: mocks.queryRaw, agentExecution: { updateMany: mocks.updateMany }, applicationTask: { updateMany: mocks.updateTask },
  }));
  mocks.queryRaw.mockResolvedValueOnce([liveTurn()]).mockResolvedValueOnce([liveRoot()]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.updateTask.mockResolvedValue({ count: 1 });
}

describe("scheduled TaskGraph source-change terminalization", () => {
  beforeEach(resetMocks);

  it("builds a terminal marker only from a valid scheduled source checkpoint", () => {
    const expectedState = stateFor();
    expect(buildScheduledTaskGraphSourceChangeTerminalState({ owner, attestationSnapshotDigest: oldDigest, expectedState }))
      .toMatchObject({ scheduledTaskGraphSourceChangeTerminal: { schemaVersion: "agent-harness.v2.scheduled-pipeline-source-change-terminal.v1" } });
    expect(buildScheduledTaskGraphSourceChangeTerminalState({ owner, attestationSnapshotDigest: oldDigest,
      expectedState: { ...expectedState, scheduledTaskGraphClaim: { ...expectedState.scheduledTaskGraphClaim, claimToken: "" } } }))
      .toBeNull();
  });

  it("terminalizes source drift for the exact current owner and clears only stale scheduled checkpoints", async () => {
    const state = stateFor();
    const result = await terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) });

    expect(result).toBe("terminalized");
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    const queries = mocks.queryRaw.mock.calls.map(([query]) => (query as { sql: string }).sql);
    expect(queries.map(query => query.match(/FROM "([^"]+)"/)?.[1])).toEqual(["agent_turns", "sub_agent_tasks"]);
    expect(queries.every(query => query.includes("FOR UPDATE"))).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, status: "running",
        attemptCount: owner.executionAttemptCount, state: { equals: state } },
      data: { status: "failed", error: "scheduled_pipeline_source_changed", completedAt: expect.any(Date),
        state: expect.objectContaining({ nextStage: "analyze", analysisFailed: 1,
          scheduledTaskGraphWait: state.scheduledTaskGraphWait, scheduledTaskGraphScheduledWaitId: "scheduled-question-1",
          scheduledTaskGraphSourceChangeTerminal: { schemaVersion: "agent-harness.v2.scheduled-pipeline-source-change-terminal.v1",
            owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
              rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId,
              executionAttemptCount: owner.executionAttemptCount } },
        }),
      },
    });
    const savedState = mocks.updateMany.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    for (const keyToClear of ["scoutedJobs", "scoredJobs", "scheduledTaskGraphAnalyzeJournal",
      "scheduledTaskGraphContinuation", "scheduledTaskGraphClaim", "scheduledTaskGraphAnalyzeSourceFingerprints"]) expect(savedState).not.toHaveProperty(keyToClear);
  });
  it("rechecks the live snapshot digest under the Turn lock after route preflight", async () => {
    const state = stateFor();
    mocks.queryRaw.mockReset().mockResolvedValueOnce([liveTurn(currentDigest)]);

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) }))
      .resolves.toBe("snapshot_changed");

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("returns the original snapshot-mismatch API response when the Turn changes after preflight", async () => {
    const state = stateFor();
    mocks.executionRead.mockResolvedValue({ id: owner.executionId, status: "running",
      attemptCount: owner.executionAttemptCount, state, error: null });
    mocks.queryRaw.mockReset().mockResolvedValueOnce([liveTurn(currentDigest)]);

    const response = await respondToScheduledTaskGraphAnalyzeSourceChange({ owner, key, claimToken,
      attestationSnapshotDigest: oldDigest,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_snapshot_mismatch" });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("can terminalize a validated Analyze source error before the first continuation is persisted", async () => {
    const state = stateFor();
    delete (state as Record<string, unknown>).scheduledTaskGraphContinuation;

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("terminalized");
  });

  it("only terminalizes Analyze drift when the persisted claim token and full live owner match", async () => {
    const state = stateFor(owner);
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("terminalized");
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateTask).toHaveBeenCalledWith({
      where: { userId: owner.userId, jobId: "job-1", sessionId: owner.sessionId, status: "analyzing", checkpoint: "match_analysis", updatedAt: new Date("2026-11-01T12:00:00.000Z"),
        AND: [{ OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"] } }] }] },
      data: { status: "failed", checkpoint: "analyze_source_changed", error: "scheduled_pipeline_source_changed", completedAt: expect.any(Date) },
    });

    resetMocks();
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken: "other-claim",
      attestationSnapshotDigest: oldDigest, expectedStatus: "running", expectedState: state,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("not_confirmed");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("terminalizes when a scored task has already left the exact analyzing fence", async () => {
    const state = stateFor();
    mocks.updateTask.mockResolvedValueOnce({ count: 0 });

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("terminalized");
    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("terminalizes legacy source state only for the same stable owner with a strictly prior lease", async () => {
    const raw = stateFor(priorOwner), journal = raw.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>
    const legacy = { ...raw, scheduledTaskGraphAnalyzeJournal: { ...journal,
      schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1" } }
    delete (legacy.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>).sourceFingerprintsByJob
    delete (legacy as Record<string, unknown>).scheduledTaskGraphAnalyzeSourceFingerprints
    const error = scheduledAnalyzeSourceChangedErrorForUntrustedState(legacy)

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: legacy, sourceChangeError: error,
      allowPriorLease: true })).resolves.toBe("terminalized")

    const turnQuery = (mocks.queryRaw.mock.calls[0]?.[0] as { sql: string }).sql
    expect(turnQuery).toContain('"leaseVersion" =')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ attemptCount: owner.executionAttemptCount, state: { equals: legacy } }),
    }))
  });
  it("rejects a prior-lease checkpoint after stable owner or lease ordering changes", async () => {
    const sourceChangeError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]);
    const changedOwners = [
      stateFor({ ...priorOwner, rootAttemptCount: owner.rootAttemptCount + 1 }),
      stateFor({ ...priorOwner, executionAttemptCount: owner.executionAttemptCount + 1 }),
      stateFor({ ...priorOwner, turnLeaseVersion: owner.turnLeaseVersion }),
      stateFor({ ...priorOwner, turnLeaseVersion: owner.turnLeaseVersion + 1 }),
    ];

    for (const expectedState of changedOwners) {
      await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
        expectedStatus: "running", expectedState, sourceChangeError, allowPriorLease: true })).resolves.toBe("not_confirmed");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("refuses to clear state when the source-change error has no server-only claims", async () => {
    const state = stateFor();
    const sourceChangeError = Object.assign(new Error("source changed"), {
      name: "AnalyzeSourceChangedError", code: "scheduled_pipeline_source_changed",
    });

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, sourceChangeError })).resolves.toBe("not_confirmed");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("terminalizes Analyze drift for live and ownerless waiting Turn lease forms", async () => {
    const state = stateFor(owner);
    mocks.queryRaw.mockReset().mockResolvedValueOnce([liveTurn()]).mockResolvedValueOnce([liveRoot()]);

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "waiting_for_user", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("terminalized");

    const turnQuery = (mocks.queryRaw.mock.calls[0]?.[0] as { sql: string }).sql;
    expect(turnQuery).toContain('"leaseVersion" =');
    expect(turnQuery).toContain("IN ('in_progress', 'waiting_for_user')");
    expect(turnQuery).toContain("\"status\" = 'waiting_for_user' AND \"leaseOwnerId\" IS NULL AND \"leaseExpiresAt\" IS NULL");
    expect(turnQuery).not.toContain("'completed'");
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "waiting_for_user", attemptCount: owner.executionAttemptCount,
        state: { equals: state } }),
    }));
  });
  it("does not terminalize source drift for another execution or Root attempt", async () => {
    const sourceChangeError = createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]);
    const wrongExecutionAttempt = stateFor({ ...priorOwner, executionAttemptCount: owner.executionAttemptCount + 1 });
    const wrongRootAttempt = stateFor({ ...priorOwner, rootAttemptCount: owner.rootAttemptCount + 1 });

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: wrongExecutionAttempt, claimToken, sourceChangeError })).resolves.toBe("not_confirmed");
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: wrongRootAttempt, claimToken, sourceChangeError })).resolves.toBe("not_confirmed");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("does not clear data when the current Turn lease or Root attempt changed", async () => {
    const state = stateFor();
    resetMocks();
    mocks.queryRaw.mockReset().mockResolvedValueOnce([]);
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("owner_changed");
    expect(mocks.updateMany).not.toHaveBeenCalled();

    resetMocks();
    mocks.queryRaw.mockReset().mockResolvedValueOnce([liveTurn()]).mockResolvedValueOnce([]);
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("owner_changed");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("does not terminalize or clean tasks when the exact full-state CAS loses", async () => {
    const state = stateFor();
    resetMocks();
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state, claimToken,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).resolves.toBe("state_changed");
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("keeps task cleanup and terminal state inside one transaction when cleanup fails", async () => {
    const state = stateFor();
    const failure = new Error("database failed");
    mocks.updateTask.mockRejectedValueOnce(failure);

    await expect(terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken, attestationSnapshotDigest: oldDigest,
      expectedStatus: "running", expectedState: state,
      sourceChangeError: createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job-1", analysisFenceAt: "2026-11-01T12:00:00.000Z" }]) })).rejects.toBe(failure);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
  });

  it("recognizes only the failed terminal record for the same stable owner and execution attempt", () => {
    const state = { nextStage: "analyze", scheduledTaskGraphSourceChangeTerminal: {
      schemaVersion: "agent-harness.v2.scheduled-pipeline-source-change-terminal.v1",
      owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId,
        executionAttemptCount: owner.executionAttemptCount },
    } };
    const base = { owner, status: "failed", error: "scheduled_pipeline_source_changed", state };
    expect(isScheduledTaskGraphSourceChangeTerminal(base)).toBe(true);
    expect(isScheduledTaskGraphSourceChangeTerminal({ ...base, owner: { ...owner, rootAttemptCount: 4 } })).toBe(false);
    expect(isScheduledTaskGraphSourceChangeTerminal({ ...base, owner: { ...owner, executionAttemptCount: 6 } })).toBe(false);
    expect(isScheduledTaskGraphSourceChangeTerminal({ ...base, error: "other_error" })).toBe(false);
  });
});
