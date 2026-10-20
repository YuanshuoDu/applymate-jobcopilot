import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@prisma/client";
import { createScheduledTaskGraphWaitState, finishScheduledTaskGraphExecution, loadDurableScheduledTaskGraphWait, loadScheduledTaskGraphWaitQuestion, persistScheduledTaskGraphWaitMarker, readScheduledTaskGraphWaitMarker, rebindScheduledTaskGraphWaitState, saveScheduledTaskGraphCheckpoint } from "./scheduled-taskgraph-pipeline-fence";
import { buildScheduledTaskGraphPrepareCheckpoint, scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey } from "./scheduled-taskgraph-pipeline-checkpoint";

const mocks = vi.hoisted(() => ({ turn: vi.fn(), root: vi.fn(), execution: vi.fn(), executionUpdateMany: vi.fn(), transaction: vi.fn(), item: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    agentTurn: { findFirst: mocks.turn },
    subAgentTask: { findFirst: mocks.root },
    agentExecution: { findFirst: mocks.execution, updateMany: mocks.executionUpdateMany },
    agentItem: { findFirst: mocks.item },
  },
}));

const owner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 2, turnLeaseOwnerId: "worker-1", turnLeaseVersion: 4,
  executionId: "execution-1", executionAttemptCount: 0,
};
const key = "continuation-key", claimToken = "claim-token-a";
const claim = { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner };
const waitId = "agent-question:turn-1:canonical:q1", waitStage = "writer";
let transactionClient: unknown;
const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 5, requireApproval: true, autoApply: false };

function proofFor(evidenceOwner: typeof owner) {
  const proofOwner = { userId: evidenceOwner.userId, sessionId: evidenceOwner.sessionId, turnId: evidenceOwner.turnId,
    rootTaskId: evidenceOwner.rootTaskId, rootAttemptCount: evidenceOwner.rootAttemptCount,
    turnLeaseOwnerId: evidenceOwner.turnLeaseOwnerId, turnLeaseVersion: evidenceOwner.turnLeaseVersion };
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner: proofOwner,
    snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
    scout: { taskId: "scout-task", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "a".repeat(64),
      candidateJobIds: ["job-1"], discoveryReceipt: { status: "complete", taskId: "scout-task", attemptCount: 1,
        completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false, receiptDigest: "b".repeat(64) } },
    analyst: { taskId: "analyst-task", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "c".repeat(64),
      dependsOnTaskIds: ["scout-task"], jobIds: ["job-1"] }, evidenceDigest: "d".repeat(64) };
}

function durableWaitingState() {
  return createScheduledTaskGraphWaitState({ nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
    scheduledTaskGraphClaim: claim,
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
      snapshotDigest: "sha256:" + "a".repeat(64), graphRevision: 9, evidenceDigest: "b".repeat(64) } },
    owner, key, claimToken, waitId, waitStage);
}

function unansweredQuestion() {
  return { id: `agent-wait:question:${waitId}`, sessionId: owner.sessionId, turnId: owner.turnId, type: "question",
    status: "started", startedAt: new Date(), completedAt: null, content: {
      waitKind: "question", questionId: waitId, stage: waitStage, answerAvailable: false, answer: null,
    } };
}

describe("scheduled TaskGraph pipeline owner fence", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 });
    transactionClient = { agentExecution: { updateMany: mocks.executionUpdateMany } };
    mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work(transactionClient));
    mocks.turn.mockResolvedValue({ status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.root.mockResolvedValue({ status: "running", attemptCount: owner.rootAttemptCount,
      interruptRequestedAt: null, closedAt: null });
    mocks.execution.mockResolvedValue({ state: { scheduledTaskGraphClaim: claim } });
  });

  it("matches an exact owner, including the execution attempt and lease identity", async () => {
    const fence = await import("./scheduled-taskgraph-pipeline-fence");
    expect(fence.scheduledTaskGraphOwnerMatches({ ...owner }, owner)).toBe(true);
    expect(fence.scheduledTaskGraphOwnerMatches({ ...owner, turnLeaseVersion: 3 }, owner)).toBe(false);
    expect(fence.scheduledTaskGraphOwnerMatches({ ...owner, executionAttemptCount: 1 }, owner)).toBe(false);
    expect(fence.scheduledTaskGraphOwnerMatches({ ...owner, extra: true }, owner)).toBe(false);
  });

  it("requires the persisted claim schema, deterministic key, and exact owner", async () => {
    const fence = await import("./scheduled-taskgraph-pipeline-fence");
    expect(fence.scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: claim }, key, owner)).toBe(true);
    expect(fence.scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: { ...claim, key: "other" } }, key, owner)).toBe(false);
    expect(fence.scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: { ...claim, owner: { ...owner, turnLeaseVersion: 5 } } }, key, owner)).toBe(false);
    expect(fence.scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: { ...claim, schemaVersion: "unknown" } }, key, owner)).toBe(false);
    expect(fence.scheduledTaskGraphClaimMatches({ scheduledTaskGraphClaim: { ...claim, claimToken: "claim-token-b" } }, key, owner, claimToken)).toBe(false);
  });

  it("validates prior checkpoints against fresh owner-scoped Jobs before accepting or rebinding", async () => {
    const fence = await import("./scheduled-taskgraph-pipeline-fence");
    const priorOwner = { ...owner, turnLeaseOwnerId: "worker-old", turnLeaseVersion: 3 };
    const priorAttestation = proofFor(priorOwner), currentAttestation = proofFor(owner);
    const row = { id: "job-1", userId: owner.userId } as Job;
    const prepared = buildScheduledTaskGraphPrepareCheckpoint({ owner: priorOwner, snapshot, attestation: priorAttestation,
      ownedJobs: [row], analyzeResult: { stage: "analyze", ok: true, data: { scoredJobs: [{ job: row, score: 80,
        matchedKeywords: ["TypeScript"], missingKeywords: [], recommendation: "Apply.", analysisFenceAt: "2026-10-19T12:00:00.123Z" }], failed: 0 },
        metrics: { durationMs: 1, count: 1 } } });
    const input = { state: prepared.checkpoint, owner, snapshot, attestation: currentAttestation, ownedJobs: [{ ...row }] as Job[] };

    expect(fence.priorScheduledTaskGraphContinuation(input)).toEqual({ owner: priorOwner,
      key: scheduledTaskGraphContinuationKey(priorOwner, priorAttestation) });
    expect(fence.priorScheduledTaskGraphContinuation({ ...input, ownedJobs: [] })).toBeNull();
    expect(fence.priorScheduledTaskGraphContinuation({ ...input,
      state: { ...prepared.checkpoint, scoutedJobs: [], scoredJobs: [] } })).toBeNull();
  });

  it("accepts only a live Turn lease, active root attempt, and matching running execution claim", async () => {
    const fence = await import("./scheduled-taskgraph-pipeline-fence");
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(true);
    expect(mocks.turn).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
    } }));
    expect(mocks.root).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, session: { userId: owner.userId },
      rootTaskId: owner.rootTaskId, parentTaskId: null,
    } }));
    expect(mocks.execution).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId,
      status: "running", attemptCount: owner.executionAttemptCount,
    } }));

    mocks.turn.mockResolvedValueOnce({ status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() - 1) });
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
    mocks.turn.mockResolvedValueOnce({ status: "in_progress", leaseOwnerId: "stale-worker",
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
    mocks.root.mockResolvedValueOnce({ status: "running", attemptCount: 1, interruptRequestedAt: null, closedAt: null });
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
    mocks.execution.mockResolvedValueOnce({ state: { scheduledTaskGraphClaim: { ...claim, key: "other" } } });
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
    mocks.execution.mockResolvedValueOnce({ state: { scheduledTaskGraphClaim: { ...claim, claimToken: "new-claim" } } });
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
  });

  it("fails closed if any durable owner read fails", async () => {
    const fence = await import("./scheduled-taskgraph-pipeline-fence");
    mocks.root.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(fence.isScheduledTaskGraphOwnerCurrent(owner, key, claimToken)).resolves.toBe(false);
  });

  it("persists an exact wait and rebinds only the same checkpoint to a fresh lease", () => {
    const snapshotDigest = "sha256:" + "a".repeat(64), evidenceDigest = "b".repeat(64), graphRevision = 9;
    const checkpoint = {
      nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: claim,
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
        key, owner, snapshotDigest, graphRevision, evidenceDigest },
    };
    const waiting = createScheduledTaskGraphWaitState(checkpoint, owner, key, claimToken, "agent-question:turn-1:canonical:q1", "writer");
    expect(readScheduledTaskGraphWaitMarker(waiting)).toEqual({
      schemaVersion: "agent-harness.v2.scheduled-pipeline-wait.v1", key, claimToken, owner,
      waitId: "agent-question:turn-1:canonical:q1", stage: "writer",
    });

    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const rebound = rebindScheduledTaskGraphWaitState({ state: waiting, owner: nextOwner, key: "continuation-key-2", claimToken: "claim-token-b",
      snapshotDigest, graphRevision, evidenceDigest });
    expect(rebound).toMatchObject({ waitId: "agent-question:turn-1:canonical:q1", stage: "writer" });
    expect(rebound?.state).toMatchObject({ nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: { key: "continuation-key-2", claimToken: "claim-token-b", owner: nextOwner },
      scheduledTaskGraphContinuation: { key: "continuation-key-2", owner: nextOwner, snapshotDigest, graphRevision, evidenceDigest },
    });
    expect(rebound?.state).not.toHaveProperty("scheduledTaskGraphWait");
    expect(rebindScheduledTaskGraphWaitState({ state: waiting, owner: nextOwner, key: "continuation-key-2", claimToken: "claim-token-b",
      snapshotDigest, graphRevision: graphRevision + 1, evidenceDigest })).toBeNull();
    expect(rebindScheduledTaskGraphWaitState({ state: waiting, owner: { ...nextOwner, rootAttemptCount: 3 }, key: "continuation-key-2", claimToken: "claim-token-b",
      snapshotDigest, graphRevision, evidenceDigest })).toBeNull();
  });

  it("CAS-persists the exact wait marker before the question becomes visible", async () => {
    const checkpoint = { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: claim,
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
        key, owner, snapshotDigest: "sha256:" + "a".repeat(64), graphRevision: 9, evidenceDigest: "b".repeat(64) } };
    const waiting = await persistScheduledTaskGraphWaitMarker({ state: checkpoint, owner, key, claimToken,
      waitId: "agent-question:turn-1:canonical:q1", stage: "writer", assertOwnerCurrent: async () => true });
    expect(waiting).toMatchObject({ scheduledTaskGraphWait: { key, owner,
      waitId: "agent-question:turn-1:canonical:q1", stage: "writer" } });
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId,
        status: "running", attemptCount: 0, state: { equals: checkpoint } }),
    }));
    mocks.executionUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(persistScheduledTaskGraphWaitMarker({ state: checkpoint, owner, key, claimToken,
      waitId: "agent-question:turn-1:canonical:q1", stage: "writer", assertOwnerCurrent: async () => true })).resolves.toBeNull();
  });

  it("reads only the exact canonical wait item and recognizes an answered wake", async () => {
    const waitId = "agent-question:turn-1:canonical:q1", stage = "writer";
    const item = { id: `agent-wait:question:${waitId}`, sessionId: owner.sessionId, turnId: owner.turnId, type: "question",
      status: "completed", startedAt: new Date(), completedAt: new Date(), content: {
        waitKind: "question", questionId: waitId, stage, answerAvailable: true, answer: "keep_resume",
      } };
    mocks.item.mockResolvedValueOnce(item);
    await expect(loadScheduledTaskGraphWaitQuestion(owner, waitId, stage)).resolves.toEqual({ answered: true });
    expect(mocks.item).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: item.id, sessionId: owner.sessionId, turnId: owner.turnId, type: "question",
    } }));
    mocks.item.mockResolvedValueOnce({ ...item, turnId: "other-turn" });
    await expect(loadScheduledTaskGraphWaitQuestion(owner, waitId, stage)).resolves.toBeNull();

    const waiting = createScheduledTaskGraphWaitState({ nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: claim,
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
        snapshotDigest: "sha256:" + "a".repeat(64), graphRevision: 9, evidenceDigest: "b".repeat(64) } },
      owner, key, claimToken, waitId, stage);
    mocks.execution.mockResolvedValueOnce({ status: "running", state: waiting });
    mocks.turn.mockResolvedValueOnce({ status: "in_progress" });
    mocks.item.mockResolvedValueOnce(item);
    await expect(loadDurableScheduledTaskGraphWait({ owner, key, claimToken, answeredOnly: true })).resolves.toEqual({ waitId, stage });
    mocks.execution.mockResolvedValueOnce({ status: "running", state: waiting });
    mocks.turn.mockResolvedValueOnce({ status: "in_progress" });
    mocks.item.mockResolvedValueOnce({ ...item, status: "started", completedAt: null,
      content: { ...item.content, answerAvailable: false, answer: null } });
    await expect(loadDurableScheduledTaskGraphWait({ owner, key, claimToken, answeredOnly: true })).resolves.toBeNull();
  });

  it("accepts an unanswered durable wait while the exact Turn lease is still in progress", async () => {
    mocks.execution.mockResolvedValueOnce({ status: "waiting_for_user", state: durableWaitingState() });
    mocks.turn.mockResolvedValueOnce({ status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.item.mockResolvedValueOnce(unansweredQuestion());

    await expect(loadDurableScheduledTaskGraphWait({ owner, key, claimToken })).resolves.toEqual({ waitId, stage: waitStage });
    expect(mocks.turn).toHaveBeenCalledWith(expect.objectContaining({ select: {
      status: true, leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true,
    } }));
  });

  it.each([
    ["different lease owner", { status: "in_progress", leaseOwnerId: "worker-2", leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) }],
    ["different lease version", { status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion + 1,
      leaseExpiresAt: new Date(Date.now() + 60_000) }],
    ["expired lease", { status: "in_progress", leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() - 1) }],
  ])("rejects an unanswered durable wait with a %s", async (_label, turn) => {
    mocks.execution.mockResolvedValueOnce({ status: "waiting_for_user", state: durableWaitingState() });
    mocks.turn.mockResolvedValueOnce(turn);
    mocks.item.mockResolvedValueOnce(unansweredQuestion());

    await expect(loadDurableScheduledTaskGraphWait({ owner, key, claimToken })).resolves.toBeNull();
  });

  it("continues accepting an unanswered wait after the Turn has entered waiting_for_user", async () => {
    mocks.execution.mockResolvedValueOnce({ status: "waiting_for_user", state: durableWaitingState() });
    mocks.turn.mockResolvedValueOnce({ status: "waiting_for_user", leaseOwnerId: null,
      leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: null });
    mocks.item.mockResolvedValueOnce(unansweredQuestion());

    await expect(loadDurableScheduledTaskGraphWait({ owner, key, claimToken })).resolves.toEqual({ waitId, stage: waitStage });
  });

  it("CAS-fences Prepare checkpoints and terminal state by the current claim token", async () => {
    const expectedState = { nextStage: "scout", scheduledTaskGraphClaim: claim };
    const checkpoint = { nextStage: "prepare" as const, scheduledTaskGraphClaim: claim } as unknown as import("./types").PipelineCheckpointState;
    const assertOwnerCurrent = vi.fn(async (tx: unknown) => tx === transactionClient);
    expect(await saveScheduledTaskGraphCheckpoint({ expectedState, state: checkpoint, owner, key, claimToken, assertOwnerCurrent })).toBe(true);
    expect(assertOwnerCurrent).toHaveBeenCalledWith(transactionClient);
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, status: "running", attemptCount: 0,
      state: { equals: expectedState },
    }) }));
    const stale = { ...claim, claimToken: "claim-token-b" };
    const staleCheckpoint = { ...checkpoint, scheduledTaskGraphClaim: stale } as unknown as import("./types").PipelineCheckpointState;
    await expect(saveScheduledTaskGraphCheckpoint({ expectedState, state: staleCheckpoint, owner, key, claimToken, assertOwnerCurrent })).resolves.toBe(false);
    await expect(finishScheduledTaskGraphExecution({ state: expectedState, owner, key, claimToken: "claim-token-b", status: "completed", assertOwnerCurrent })).resolves.toBe(false);
    expect(await finishScheduledTaskGraphExecution({ state: expectedState, owner, key, claimToken, status: "completed", assertOwnerCurrent })).toBe(true);
  });

  it("rejects checkpoint, wait, and terminal writes after a Turn owner takeover", async () => {
    const expectedState = { nextStage: "scout", scheduledTaskGraphClaim: claim };
    const checkpoint = { nextStage: "prepare" as const, scheduledTaskGraphClaim: claim } as unknown as import("./types").PipelineCheckpointState;
    const waitState = { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: claim,
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner,
        snapshotDigest: "sha256:" + "a".repeat(64), graphRevision: 9, evidenceDigest: "b".repeat(64) } };
    const assertOwnerCurrent = vi.fn(async (_tx: unknown) => false);

    await expect(saveScheduledTaskGraphCheckpoint({ expectedState, state: checkpoint, owner, key, claimToken, assertOwnerCurrent })).resolves.toBe(false);
    await expect(persistScheduledTaskGraphWaitMarker({ state: waitState, owner, key, claimToken,
      waitId, stage: waitStage, assertOwnerCurrent })).resolves.toBeNull();
    await expect(finishScheduledTaskGraphExecution({ state: expectedState, owner, key, claimToken, status: "completed", assertOwnerCurrent })).resolves.toBe(false);

    expect(assertOwnerCurrent).toHaveBeenCalledTimes(3);
    expect(assertOwnerCurrent.mock.calls.map(([tx]) => tx)).toEqual([transactionClient, transactionClient, transactionClient]);
    expect(mocks.executionUpdateMany).not.toHaveBeenCalled();
  });
});
