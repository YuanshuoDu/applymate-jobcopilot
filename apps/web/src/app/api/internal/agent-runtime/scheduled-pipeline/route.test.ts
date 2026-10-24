import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  turn: vi.fn(), root: vi.fn(), session: vi.fn(), user: vi.fn(), execution: vi.fn(), claim: vi.fn(), jobs: vi.fn(),
  question: vi.fn(), runPipeline: vi.fn(), gateAction: vi.fn(), validatePrepareWait: vi.fn(), snapshot: vi.fn(), loadAi: vi.fn(), resolveConfig: vi.fn(), featureAllowed: vi.fn(), entitlement: vi.fn(), aiAccess: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  agentTurn: { findFirst: mocks.turn }, subAgentTask: { findFirst: mocks.root },
  agentSession: { findFirst: mocks.session }, user: { findUnique: mocks.user },
  agentExecution: { findFirst: mocks.execution, updateMany: mocks.claim }, job: { findMany: mocks.jobs },
  agentItem: { findFirst: mocks.question },
} }));
vi.mock("@/lib/agent/run-service", () => ({ runAgentPipeline: mocks.runPipeline }));
vi.mock("@/lib/agent/scheduled-taskgraph-gate-runtime-rpc", () => ({ runScheduledTaskGraphActionRpc: mocks.gateAction }));
vi.mock("@/lib/agent/scheduled-taskgraph-run-service", () => ({
  isScheduledPrepareChoiceWaitId: (turnId: string, value: unknown) => typeof value === "string" && value.startsWith(`agent-question:${turnId}:canonical:`) && /^[a-f0-9]{64}$/.test(value.slice(`agent-question:${turnId}:canonical:`.length)),
  validateScheduledPrepareWaitIdentity: mocks.validatePrepareWait,
}));
vi.mock("@/lib/model-router", () => ({
  APPLYMATE_BACKING: "platform", loadUserAiConfig: mocks.loadAi, resolveConfig: mocks.resolveConfig,
}));
vi.mock("@/lib/agent/scheduled-automation-snapshot", () => ({ parseScheduledAutomationSnapshot: mocks.snapshot }));
vi.mock("@/lib/agent/scheduled-taskgraph-pipeline-checkpoint", () => ({
  scheduledAutomationSnapshotDigest: () => "sha256:" + "a".repeat(64),
  scheduledTaskGraphContinuationKey: () => "continuation-4",
  buildScheduledTaskGraphPrepareCheckpoint: (input: { owner: Record<string, unknown>; attestation: Record<string, unknown>; ownedJobs: Array<{ id: string }>;
    existingCheckpoint: Record<string, unknown> }) => {
    const marker = input.existingCheckpoint.scheduledTaskGraphContinuation as Record<string, unknown> | undefined;
    const markerOwner = marker?.owner as Record<string, unknown> | undefined;
    const evidence = input.attestation.evidenceDigest;
    const candidateIds = (input.attestation.scout as { candidateJobIds: string[] }).candidateJobIds;
    const jobsMatch = input.ownedJobs.length === candidateIds.length && candidateIds.every((id, index) => input.ownedJobs[index]?.id === id);
    const savedJobs = input.existingCheckpoint.scoutedJobs as Array<{ id?: string }> | undefined;
    const savedScores = input.existingCheckpoint.scoredJobs as Array<{ job?: { id?: string }; score?: number; analysisFenceAt?: string }> | undefined;
    const savedRowsMatch = savedJobs?.length === candidateIds.length
      && candidateIds.every((id, index) => savedJobs[index]?.id === id);
    const savedScoresMatch = savedScores?.length === candidateIds.length
      && candidateIds.every((id, index) => savedScores[index]?.job?.id === id
        && Number.isSafeInteger(savedScores[index]?.score) && savedScores[index]!.score! >= 0 && savedScores[index]!.score! <= 100
        && typeof savedScores[index]?.analysisFenceAt === "string" && Number.isFinite(Date.parse(savedScores[index]!.analysisFenceAt!)));
    const alreadyPersisted = Boolean(marker && markerOwner && markerOwner.turnLeaseVersion === input.owner.turnLeaseVersion
      && markerOwner.executionId === input.owner.executionId && markerOwner.executionAttemptCount === input.owner.executionAttemptCount
      && marker.key === "continuation-4" && marker.snapshotDigest === input.attestation.snapshotDigest
      && marker.graphRevision === input.attestation.graphRevision && marker.evidenceDigest === evidence && jobsMatch
      && savedRowsMatch && savedScoresMatch && input.existingCheckpoint.analysisFailed === 0);
    return { checkpoint: input.existingCheckpoint, continuationKey: "continuation-4", alreadyPersisted };
  },
}));
vi.mock("@/lib/entitlements", () => ({
  hasEffectiveEntitlement: mocks.entitlement, isFeatureAllowed: mocks.featureAllowed, resolveAiAccess: mocks.aiAccess,
}));

const owner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 2, turnLeaseOwnerId: "worker-1", turnLeaseVersion: 4,
};
const fullOwner = { ...owner, executionId: "execution-1", executionAttemptCount: 0 };
const key = "continuation-4";
const claimToken = "claim-token-4";
const attestation = { owner, snapshotDigest: "sha256:" + "a".repeat(64), graphRevision: 9, evidenceDigest: "b".repeat(64), scout: { candidateJobIds: ["job-1"] } };
const report = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 9 };
const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 80, dailyCap: 5, requireApproval: true, autoApply: false };
const analyzeProof = { status: "analyze_checkpointed", continuationKey: "continuation-4", checkpointDigest: "c".repeat(64),
  executionId: "execution-1", executionAttemptCount: 0 };
const initialExecution = { id: "execution-1", status: "running", attemptCount: 0, state: { nextStage: "scout" } };
const analysisFenceAt = new Date().toISOString();

function scoredJobRow() {
  return { job: { id: "job-1", userId: owner.userId }, score: 82, matchedKeywords: ["TypeScript"],
    missingKeywords: ["AWS"], recommendation: "Apply after tailoring.", analysisFenceAt };
}
function completedState(previousOwner = fullOwner, previousKey = key, reportValue = report, evidenceDigest = attestation.evidenceDigest) {
  return { nextStage: "completed", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [scoredJobRow()], analysisFailed: 0,
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: previousKey,
      owner: previousOwner, snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision,
      evidenceDigest }, report: reportValue };
}

function request(body: unknown = { owner, attestation }) {
  return new Request("https://local.test/api/internal/agent-runtime/scheduled-pipeline", {
    method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": "worker-secret" },
    body: JSON.stringify(body),
  });
}
function waitingState(previousOwner = fullOwner, previousKey = key) {
  return { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [scoredJobRow()], analysisFailed: 0,
    scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: previousKey,
      claimToken, owner: previousOwner, claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
      key: previousKey, owner: previousOwner, snapshotDigest: attestation.snapshotDigest,
      graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest },
    scheduledTaskGraphWait: { schemaVersion: "agent-harness.v2.scheduled-pipeline-wait.v1", key: previousKey, claimToken,
      owner: previousOwner, waitId: "agent-question:turn-1:canonical:q1", stage: "writer" },
  };
}
function ownerClaim(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key, claimToken, owner: fullOwner,
    claimedAt: new Date().toISOString(), leaseExpiresAt: expiresAt };
}
function canonicalQuestion(waitId: string, answer: string | null = null, patch: Record<string, unknown> = {}) {
  const answered = answer !== null;
  return { id: `agent-wait:question:${waitId}`, sessionId: owner.sessionId, turnId: owner.turnId, type: "question",
    status: answered ? "completed" : "started", startedAt: new Date(), completedAt: answered ? new Date() : null,
    content: { waitKind: "question", questionId: waitId, stage: "writer", answer,
      answerAvailable: answered, ...patch } };
}

describe("scheduled pipeline continuation route", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    process.env.AGENT_WORKER_SECRET = "worker-secret";
    mocks.snapshot.mockReturnValue(scheduledSnapshot);
    mocks.turn.mockResolvedValue({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.root.mockResolvedValue({ id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, parentTaskId: null, status: "running", attemptCount: owner.rootAttemptCount,
      interruptRequestedAt: null, closedAt: null });
    mocks.session.mockResolvedValue({ id: owner.sessionId });
    mocks.user.mockResolvedValue({ accountStatus: "active" });
    mocks.execution.mockResolvedValue(initialExecution);
    mocks.claim.mockResolvedValue({ count: 1 });
    mocks.jobs.mockResolvedValue([{ id: "job-1", userId: owner.userId }]);
    mocks.question.mockResolvedValue(null);
    mocks.runPipeline.mockResolvedValue(report);
    mocks.validatePrepareWait.mockResolvedValue(true);
    mocks.loadAi.mockResolvedValue({ resolvedKey: "api-key", provider: "openai", model: "test-model" });
    mocks.resolveConfig.mockReturnValue({ provider: "minimax", model: "MiniMax-M3", apiKey: "platform-key" });
    mocks.featureAllowed.mockResolvedValue(true);
    mocks.entitlement.mockResolvedValue(true);
    mocks.aiAccess.mockResolvedValue("available");
  });

  it("authenticates the Worker before reading owner state", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("https://local.test", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "blocked", errorCode: "scheduled_pipeline_unauthorized" });
    expect(mocks.turn).not.toHaveBeenCalled();
  }, 30_000);

  it("returns only the opaque Analyze proof after one owner-scoped claim", async () => {
    mocks.runPipeline.mockResolvedValueOnce(analyzeProof);
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(analyzeProof);
    expect(Object.keys(body as Record<string, unknown>).sort())
      .toEqual(["checkpointDigest", "continuationKey", "executionAttemptCount", "executionId", "status"]);
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "execution-1", status: "running", attemptCount: 0,
        state: { equals: initialExecution.state } }),
    }));
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, executionId: "execution-1",
      scheduledTaskGraph: expect.objectContaining({ owner: fullOwner, continuationKey: key, attestation, ownedJobs: [{ id: "job-1", userId: owner.userId }] }),
    }));
    expect(mocks.jobs).toHaveBeenCalledWith({ where: { userId: owner.userId, id: { in: ["job-1"] } } });
  });

  it("passes a Worker-verified Prepare proof through the existing internal route", async () => {
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"a".repeat(64)}`;
    mocks.runPipeline.mockResolvedValueOnce({ status: "gate_checkpointed" });
    mocks.execution.mockResolvedValueOnce({ ...initialExecution, state: { nextStage: "prepare", scheduledTaskGraphClaim: ownerClaim(),
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: fullOwner,
        snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest } } });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof, scheduledWaitId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "gate_checkpointed" });
    expect(mocks.validatePrepareWait).toHaveBeenCalledWith({ owner: fullOwner, snapshot: scheduledSnapshot, proof: prepareProof, scheduledWaitId });
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      scheduledTaskGraph: expect.objectContaining({ prepareProof, scheduledWaitId, claimToken }),
    }));
  });

  it("rejects a changed choice ID after it has been saved in the scheduled checkpoint", async () => {
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"a".repeat(64)}`;
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    mocks.execution.mockResolvedValueOnce({ ...initialExecution, state: { ...initialExecution.state, scheduledTaskGraphScheduledWaitId: scheduledWaitId } });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof,
      scheduledWaitId: `agent-question:${owner.turnId}:canonical:${"b".repeat(64)}` }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.validatePrepareWait).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("requires a scheduled wait identity whenever a Prepare proof is submitted", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof: { receipt: {}, completion: {}, result: {} } }));
    expect(response.status).toBe(409);
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("continues an approval-free Prepare proof without a scheduled choice ID", async () => {
    const snapshot = { ...scheduledSnapshot, requireApproval: false };
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    mocks.snapshot.mockReturnValue(snapshot);
    mocks.execution.mockResolvedValueOnce({ ...initialExecution, state: { nextStage: "prepare", scheduledTaskGraphClaim: ownerClaim(),
      scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: fullOwner,
        snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest } } });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report });
    expect(mocks.validatePrepareWait).toHaveBeenCalledWith({ owner: fullOwner, snapshot, proof: prepareProof });
    expect(mocks.runPipeline.mock.calls[0]?.[0]?.scheduledTaskGraph).not.toHaveProperty("scheduledWaitId");
  });

  it("replays a completed approval-free Prepare proof without a saved choice ID", async () => {
    const snapshot = { ...scheduledSnapshot, requireApproval: false };
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    mocks.snapshot.mockReturnValue(snapshot);
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState() });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report });
    expect(mocks.validatePrepareWait).toHaveBeenCalledWith({ owner: fullOwner, snapshot, proof: prepareProof });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a completed approval-required Prepare proof without a saved choice ID", async () => {
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"a".repeat(64)}`;
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState() });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof, scheduledWaitId }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.validatePrepareWait).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a scheduled choice ID when the persisted snapshot disables approval", async () => {
    const prepareProof = { receipt: { schemaVersion: "receipt" }, completion: { schemaVersion: "completion" }, result: { role: "prepare" } };
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"a".repeat(64)}`;
    mocks.snapshot.mockReturnValue({ ...scheduledSnapshot, requireApproval: false });
    const { POST } = await import("./route");
    const response = await POST(request({ owner, attestation, prepareProof, scheduledWaitId }));
    expect(response.status).toBe(409);
    expect(mocks.validatePrepareWait).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("returns retryable accepted for a concurrent same-key claim without running the scorer", async () => {
    mocks.claim.mockResolvedValueOnce({ count: 0 });
    mocks.execution.mockResolvedValueOnce(initialExecution).mockResolvedValueOnce({ ...initialExecution,
      state: { nextStage: "scout", scheduledTaskGraphClaim: ownerClaim() } });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted", duplicate: true });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("replays a persisted wait while its question is publishing under the exact current Turn lease", async () => {
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"c".repeat(64)}`;
    const state = { ...waitingState(), scheduledTaskGraphScheduledWaitId: scheduledWaitId };
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1", stage: "writer", scheduledWaitId });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rotates the claim nonce when reclaiming an expired prepared continuation", async () => {
    const prior = waitingState();
    Reflect.deleteProperty(prior, "scheduledTaskGraphWait");
    (prior.scheduledTaskGraphClaim as Record<string, unknown>).leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    const nextState = mocks.claim.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    const nextClaim = nextState.scheduledTaskGraphClaim as Record<string, unknown>;
    expect(nextClaim.claimToken).toEqual(expect.any(String));
    expect(nextClaim.claimToken).not.toBe(claimToken);
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      scheduledTaskGraph: expect.objectContaining({ claimToken: nextClaim.claimToken }),
    }));
  });

  it("reclaims an expired same-owner markerless claim only at the Scout stage", async () => {
    const prior = { nextStage: "scout", scheduledTaskGraphClaim: ownerClaim(new Date(Date.now() - 1).toISOString()) };
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(200);
    const nextState = mocks.claim.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    const nextClaim = nextState.scheduledTaskGraphClaim as Record<string, unknown>;
    expect(nextState.nextStage).toBe("scout");
    expect(nextState).not.toHaveProperty("scheduledTaskGraphContinuation");
    expect(nextClaim.claimToken).toEqual(expect.any(String));
    expect(nextClaim.claimToken).not.toBe(claimToken);
    expect(nextClaim.owner).toEqual(fullOwner);
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      scheduledTaskGraph: expect.objectContaining({ owner: fullOwner, continuationKey: key, claimToken: nextClaim.claimToken }),
    }));
  });

  it("atomically rebinds a partial Analyze journal with the claim when the Turn lease rolls over", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const nextFullOwner = { ...nextOwner, executionId: fullOwner.executionId, executionAttemptCount: fullOwner.executionAttemptCount };
    const priorState = { nextStage: "scout", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: ownerClaim(),
      scheduledTaskGraphAnalyzeJournal: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1", key, owner: fullOwner,
        attemptsByJob: { "job-1": 1 }, failedJobIds: [] } };
    mocks.turn.mockResolvedValueOnce({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.root.mockResolvedValueOnce({ id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, parentTaskId: null, status: "running", attemptCount: owner.rootAttemptCount,
      interruptRequestedAt: null, closedAt: null });
    mocks.execution.mockResolvedValueOnce({ ...initialExecution, state: priorState });
    const nextAttestation = { ...attestation, owner: nextOwner };
    const { POST } = await import("./route");

    const response = await POST(request({ owner: nextOwner, attestation: nextAttestation }));

    expect(response.status).toBe(200);
    const update = mocks.claim.mock.calls[0]?.[0];
    const nextState = update?.data?.state as Record<string, unknown>;
    const nextClaim = nextState.scheduledTaskGraphClaim as Record<string, unknown>;
    const journal = nextState.scheduledTaskGraphAnalyzeJournal as Record<string, unknown>;
    expect(update?.where.state.equals).toBe(priorState);
    expect(nextClaim).toMatchObject({ key, owner: nextFullOwner });
    expect(journal).toMatchObject({ key, owner: nextFullOwner, attemptsByJob: { "job-1": 1 } });
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      scheduledTaskGraph: expect.objectContaining({ owner: nextFullOwner, continuationKey: key, claimToken: nextClaim.claimToken }),
    }));
  });

  it.each(["missing expiry", "malformed expiry", "malformed claimedAt", "invalid token", "unexpected field"])(
    "rejects markerless recovery with a %s persisted claim",
    async defect => {
      const claim = ownerClaim(new Date(Date.now() - 1).toISOString());
      if (defect === "missing expiry") Reflect.deleteProperty(claim, "leaseExpiresAt");
      if (defect === "malformed expiry") claim.leaseExpiresAt = "not-a-timestamp";
      if (defect === "malformed claimedAt") claim.claimedAt = "not-a-timestamp";
      if (defect === "invalid token") claim.claimToken = "";
      if (defect === "unexpected field") Object.assign(claim, { legacy: true });
      const prior = { nextStage: "scout", scheduledTaskGraphClaim: claim };
      mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
      const { POST } = await import("./route");

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.runPipeline).not.toHaveBeenCalled();
    },
  );

  it("rejects prepared recovery with a malformed persisted lease expiry", async () => {
    const prior = waitingState();
    Reflect.deleteProperty(prior, "scheduledTaskGraphWait");
    (prior.scheduledTaskGraphClaim as Record<string, unknown>).leaseExpiresAt = "not-a-timestamp";
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it.each(["analyze", "prepare", "gate", "execute", "audit"])(
    "rejects an expired same-owner markerless claim at the %s stage",
    async nextStage => {
      const state = { nextStage, scheduledTaskGraphClaim: ownerClaim(new Date(Date.now() - 1).toISOString()) };
      mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state });
      const { POST } = await import("./route");

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_analysis_interrupted" });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.runPipeline).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["root attempt", { ...fullOwner, rootAttemptCount: fullOwner.rootAttemptCount + 1 }, key],
    ["execution attempt", { ...fullOwner, executionAttemptCount: fullOwner.executionAttemptCount + 1 }, key],
    ["evidence key", { ...fullOwner, turnLeaseOwnerId: "worker-old", turnLeaseVersion: 3 }, "continuation-stale-evidence"],
  ])("rejects an expired markerless claim with a mismatched %s", async (_label, priorOwner, priorKey) => {
    const state = { nextStage: "scout", scheduledTaskGraphClaim: { ...ownerClaim(new Date(Date.now() - 1).toISOString()),
      owner: priorOwner, key: priorKey } };
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("does not start another pipeline when markerless claim recovery loses its CAS", async () => {
    const prior = { nextStage: "scout", scheduledTaskGraphClaim: ownerClaim(new Date(Date.now() - 1).toISOString()) };
    const competingClaim = { ...ownerClaim(new Date(Date.now() + 60_000).toISOString()), claimToken: "claim-token-other" };
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior })
      .mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0,
        state: { nextStage: "scout", scheduledTaskGraphClaim: competingClaim } });
    mocks.claim.mockResolvedValueOnce({ count: 0 });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted", duplicate: true });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("replays a completed report for the same persisted continuation without claiming or rerunning", async () => {
    const scheduledWaitId = `agent-question:${owner.turnId}:canonical:${"d".repeat(64)}`;
    const state = { ...completedState(), scheduledTaskGraphScheduledWaitId: scheduledWaitId };
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report, scheduledWaitId });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("does not replay an exact report after the Turn lease rotates", async () => {
    const currentTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) };
    mocks.turn.mockResolvedValueOnce(currentTurn).mockResolvedValueOnce({ ...currentTurn,
      leaseOwnerId: "worker-2", leaseVersion: owner.turnLeaseVersion + 1 });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState() });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_turn_stale" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects completed replay when nonempty attested candidates have empty saved checkpoint arrays", async () => {
    const emptyCheckpoint = completedState();
    emptyCheckpoint.scoutedJobs = [];
    emptyCheckpoint.scoredJobs = [];
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0, state: emptyCheckpoint });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it.each(["waiting_for_user", "completed"] as const)(
    "replays the report after the same lease is released into %s",
    async status => {
      const currentTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
        status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
        input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
        leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) };
      mocks.turn.mockResolvedValueOnce(currentTurn).mockResolvedValueOnce({ ...currentTurn, status,
        leaseOwnerId: null, leaseExpiresAt: null });
      mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
        state: completedState() });
      const { POST } = await import("./route");
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "completed", report });
    },
  );

  it("replays the persisted completed report to a new current lease using the old continuation proof", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const currentAttestation = { ...attestation, owner: nextOwner };
    const currentTurn = { id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) };
    mocks.turn.mockResolvedValueOnce(currentTurn).mockResolvedValue(currentTurn);
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState() });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("refuses old-report replay when the request lease is not the persisted current lease", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: "worker-3", leaseVersion: 6, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState() });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: { ...attestation, owner: nextOwner } }));
    expect(response.status).toBe(409);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it.each([
    ["stable owner", { ...fullOwner, rootAttemptCount: 3 }, attestation.evidenceDigest],
    ["evidence", fullOwner, "c".repeat(64)],
  ])("rejects completed replay when the stored %s differs", async (_label, priorOwner, evidenceDigest) => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const currentAttestation = { ...attestation, owner: nextOwner };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0,
      state: completedState(priorOwner, key, report, evidenceDigest) });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_execution_mismatch" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("takes over an in-flight prepared claim across a lease version and preserves its checkpoint", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const currentAttestation = { ...attestation, owner: nextOwner };
    const prior = { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [scoredJobRow()], analysisFailed: 0,
      scheduledTaskGraphClaim: ownerClaim(), scheduledTaskGraphContinuation: {
        schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: fullOwner,
        snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest,
      } };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
    expect(response.status).toBe(200);
    const rebound = mocks.claim.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    expect(rebound).toMatchObject({ nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [scoredJobRow()], analysisFailed: 0,
      scheduledTaskGraphClaim: { key, claimToken: expect.any(String), owner: { ...fullOwner, ...nextOwner } },
      scheduledTaskGraphContinuation: { key, owner: { ...fullOwner, ...nextOwner }, evidenceDigest: attestation.evidenceDigest },
    });
    expect((rebound.scheduledTaskGraphClaim as Record<string, unknown>).claimToken).not.toBe(claimToken);
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      scheduledTaskGraph: expect.objectContaining({ continuationKey: key, owner: { ...fullOwner, ...nextOwner } }),
    }));
  });

  it.each([["still current", "worker-2", 5, 200], ["rotated during CAS", "worker-3", 6, 409]] as const)(
    "replays a prior completion after a lost takeover CAS only while the lease is %s",
    async (_label, persistedOwnerId, persistedVersion, expectedStatus) => {
      const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
      const currentAttestation = { ...attestation, owner: nextOwner };
      const prior = { nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }], scoredJobs: [scoredJobRow()], analysisFailed: 0,
        scheduledTaskGraphClaim: ownerClaim(), scheduledTaskGraphContinuation: {
          schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: fullOwner,
          snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest,
        } };
      const completed = { ...prior, nextStage: "completed", report };
      const currentTurn = { id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
        status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
        input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
        leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) };
      mocks.turn.mockResolvedValueOnce(currentTurn).mockResolvedValueOnce({ ...currentTurn,
        leaseOwnerId: persistedOwnerId, leaseVersion: persistedVersion });
      mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior })
        .mockResolvedValueOnce({ id: "execution-1", status: "completed", attemptCount: 0, state: completed });
      mocks.claim.mockResolvedValueOnce({ count: 0 });
      const { POST } = await import("./route");
      const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) expect(await response.json()).toEqual({ status: "completed", report });
      else expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
      expect(mocks.claim).toHaveBeenCalledTimes(1);
      expect(mocks.runPipeline).not.toHaveBeenCalled();
    },
  );

  it("rebinds a markerless claim only at the exact pre-checkpoint Scout stage", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const currentAttestation = { ...attestation, owner: nextOwner };
    const prior = { nextStage: "scout", scheduledTaskGraphClaim: ownerClaim() };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
    expect(response.status).toBe(200);
    const rebound = mocks.claim.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    expect(rebound).toMatchObject({ nextStage: "scout", scheduledTaskGraphClaim: {
      key, claimToken: expect.any(String), owner: { ...fullOwner, ...nextOwner },
    } });
    expect(rebound).not.toHaveProperty("scheduledTaskGraphContinuation");
  });

  it.each([
    ["stable owner", { ...fullOwner, rootAttemptCount: 3 }, attestation.evidenceDigest],
    ["evidence", fullOwner, "c".repeat(64)],
  ])("rejects in-flight takeover when the stored %s differs", async (_label, priorOwner, evidenceDigest) => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const currentAttestation = { ...attestation, owner: nextOwner };
    const prior = { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0,
      scheduledTaskGraphClaim: { ...ownerClaim(), owner: priorOwner }, scheduledTaskGraphContinuation: {
        schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key, owner: priorOwner,
        snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest,
      } };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: prior });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: currentAttestation }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("persists and returns only a proven durable unanswered question wait", async () => {
    const pause = { status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1", stage: "writer" };
    const waitState = waitingState();
    mocks.runPipeline.mockImplementationOnce(async rawInput => {
      const claim = (rawInput as { scheduledTaskGraph: { claimToken: string } }).scheduledTaskGraph.claimToken;
      (waitState.scheduledTaskGraphClaim as Record<string, unknown>).claimToken = claim;
      (waitState.scheduledTaskGraphWait as Record<string, unknown>).claimToken = claim;
      return pause;
    });
    mocks.execution.mockResolvedValueOnce(initialExecution).mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitState });
    mocks.turn.mockResolvedValueOnce({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) }).mockResolvedValueOnce({ status: "in_progress",
        leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion, leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.question.mockResolvedValueOnce(canonicalQuestion(pause.waitId));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", waitId: pause.waitId, stage: "writer" });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "running", attemptCount: 0 }),
      data: { status: "running", state: expect.objectContaining({ scheduledTaskGraphClaim: expect.objectContaining({ key }) }) },
    }));
  });

  it.each(["running", "waiting_for_user"] as const)(
    "replays the same verified unanswered wait when execution is %s under the current Turn lease",
    async status => {
      const pause = { waitId: "agent-question:turn-1:canonical:q1", stage: "writer" };
      mocks.execution.mockResolvedValueOnce({ id: "execution-1", status, attemptCount: 0, state: waitingState() });
      mocks.question.mockResolvedValueOnce(canonicalQuestion(pause.waitId));
      const { POST } = await import("./route");
      const response = await POST(request());

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "waiting_for_user", ...pause });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.runPipeline).not.toHaveBeenCalled();
    },
  );

  it("replays the original unanswered wait after a lease takeover with the same stable owner and checkpoint", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const pause = { waitId: "agent-question:turn-1:canonical:q1", stage: "writer" };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitingState() });
    mocks.question.mockResolvedValueOnce(canonicalQuestion(pause.waitId));
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: { ...attestation, owner: nextOwner } }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", ...pause });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("fails closed when a lease takeover cannot verify the persisted canonical question", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitingState() });
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation: { ...attestation, owner: nextOwner } }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects the old Worker lease after another Worker has taken over the Turn", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitingState() });
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode: "scheduled_pipeline_turn_stale" });
    expect(mocks.question).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("returns the exact typed wait when an answer races the route response", async () => {
    const waitState = waitingState();
    mocks.runPipeline.mockImplementationOnce(async rawInput => {
      const token = (rawInput as { scheduledTaskGraph: { claimToken: string } }).scheduledTaskGraph.claimToken;
      (waitState.scheduledTaskGraphClaim as Record<string, unknown>).claimToken = token;
      (waitState.scheduledTaskGraphWait as Record<string, unknown>).claimToken = token;
      return null;
    });
    mocks.execution.mockResolvedValueOnce(initialExecution).mockResolvedValueOnce({
      id: "execution-1", status: "running", attemptCount: 0, state: waitState,
    });
    mocks.question.mockResolvedValue(canonicalQuestion("agent-question:turn-1:canonical:q1", "keep_resume"));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1", stage: "writer" });
  });

  it("rebinds an answered wait to the fresh lease and resumes the saved checkpoint with its exact questionId", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const nextFullOwner = { ...nextOwner, executionId: fullOwner.executionId, executionAttemptCount: fullOwner.executionAttemptCount };
    const priorKey = key, nextKey = key, prior = waitingState();
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: prior });
    mocks.question.mockResolvedValueOnce(canonicalQuestion("agent-question:turn-1:canonical:q1", "keep_resume"));
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report });
    const rebound = mocks.claim.mock.calls[0]?.[0]?.data?.state as Record<string, unknown>;
    expect(rebound).toMatchObject({ nextStage: "prepare", scoutedJobs: [{ id: "job-1", userId: owner.userId }],
      scoredJobs: [scoredJobRow()], analysisFailed: 0,
      scheduledTaskGraphClaim: { key: nextKey, claimToken: expect.any(String), owner: nextFullOwner },
      scheduledTaskGraphContinuation: { key: nextKey, owner: nextFullOwner,
        snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest },
    });
    expect(rebound).not.toHaveProperty("scheduledTaskGraphWait");
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "waiting_for_user" }), data: expect.objectContaining({ status: "running" }),
    }));
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({ questionId: "agent-question:turn-1:canonical:q1",
      scheduledTaskGraph: expect.objectContaining({ owner: nextFullOwner, continuationKey: nextKey, claimToken: expect.any(String) }) }));
  });

  it("rebinds an answered wait after wake even while execution still reports running", async () => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "running", attemptCount: 0, state: waitingState() });
    mocks.question.mockResolvedValue(canonicalQuestion("agent-question:turn-1:canonical:q1", "keep_resume"));
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", report });
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "running" }), data: expect.objectContaining({ status: "running" }),
    }));
    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      questionId: "agent-question:turn-1:canonical:q1",
      scheduledTaskGraph: expect.objectContaining({ owner: { ...nextOwner, executionId: "execution-1", executionAttemptCount: 0 } }),
    }));
  });

  it("returns only the verified persisted wait ID for an Execute-tail 202", async () => {
    const waitId = "agent-question:turn-1:canonical:q1";
    const prior = waitingState();
    mocks.turn.mockResolvedValueOnce({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "waiting_for_user", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: prior });
    mocks.question.mockResolvedValueOnce(canonicalQuestion(waitId));
    mocks.gateAction.mockImplementationOnce(async (parsed: unknown) => ({ kind: "execute", request: parsed as never }));
    const { POST } = await import("./route");
    const response = await POST(request({ action: "execute", owner, attestation, prepareProof: {}, scheduledWaitId: waitId,
      gateCompletionProof: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 1,
        prepareProof: {}, gate: { taskId: "gate-1", attemptCount: 1, resultDigest: "sha256:" + "a".repeat(64), completedEventRevision: 1 } } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", waitId });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted wait marker instead of returning it to Execute", async () => {
    const malformed = waitingState();
    (malformed.scheduledTaskGraphWait as Record<string, unknown>).waitId = " ";
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: malformed });
    mocks.gateAction.mockImplementationOnce(async (parsed: unknown) => ({ kind: "execute", request: parsed as never }));
    const { POST } = await import("./route");
    const response = await POST(request({ action: "execute", owner, attestation, prepareProof: {},
      gateCompletionProof: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 1,
        prepareProof: {}, gate: { taskId: "gate-1", attemptCount: 1, resultDigest: "sha256:" + "a".repeat(64), completedEventRevision: 1 } } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it("rejects an existing canonical question that no longer matches the persisted wait", async () => {
    const waitId = "agent-question:turn-1:canonical:q1";
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitingState() });
    mocks.question.mockResolvedValueOnce(canonicalQuestion(waitId, null, { questionId: "agent-question:turn-1:canonical:q2" }))
      .mockResolvedValueOnce({ id: `agent-wait:question:${waitId}` });
    mocks.gateAction.mockImplementationOnce(async (parsed: unknown) => ({ kind: "execute", request: parsed as never }));
    const { POST } = await import("./route");
    const response = await POST(request({ action: "execute", owner, attestation, prepareProof: {}, scheduledWaitId: waitId,
      gateCompletionProof: { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 1,
        prepareProof: {}, gate: { taskId: "gate-1", attemptCount: 1, resultDigest: "sha256:" + "a".repeat(64), completedEventRevision: 1 } } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });
  it("keeps an answered wait typed while its Turn has not resumed", async () => {
    mocks.turn.mockResolvedValueOnce({ id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId,
      status: "waiting_for_user", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: owner.rootTaskId,
      leaseOwnerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: waitingState() });
    mocks.question.mockResolvedValueOnce(canonicalQuestion("agent-question:turn-1:canonical:q1", "keep_resume"));
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "waiting_for_user", waitId: "agent-question:turn-1:canonical:q1", stage: "writer" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it.each([
    ["evidence mismatch", "keep_resume", "c".repeat(64), {}, "scheduled_pipeline_claim_conflict"],
    ["scope-mismatched", "keep_resume", attestation.evidenceDigest, { turnId: "other-turn" }, "scheduled_pipeline_claim_conflict"],
  ])("rejects an %s persisted wait before claiming or resuming", async (_label, answer, evidenceDigest, itemPatch, errorCode) => {
    const nextOwner = { ...owner, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 5 };
    const prior = waitingState();
    if (evidenceDigest !== attestation.evidenceDigest) {
      (prior.scheduledTaskGraphContinuation as Record<string, unknown>).evidenceDigest = evidenceDigest;
    }
    mocks.turn.mockResolvedValueOnce({ id: nextOwner.turnId, userId: nextOwner.userId, sessionId: nextOwner.sessionId,
      status: "in_progress", source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: {} }, rootTaskId: nextOwner.rootTaskId,
      leaseOwnerId: nextOwner.turnLeaseOwnerId, leaseVersion: nextOwner.turnLeaseVersion,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: prior });
    const item = canonicalQuestion("agent-question:turn-1:canonical:q1", answer);
    if (Object.hasOwn(itemPatch, "turnId")) Object.assign(item, itemPatch);
    else Object.assign(item.content, itemPatch);
    mocks.question.mockResolvedValueOnce(item);
    const { POST } = await import("./route");
    const response = await POST(request({ owner: nextOwner, attestation }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it.each([
    ["different root attempt", { ...fullOwner, rootAttemptCount: 1 }, "agent-question:turn-1:canonical:q1"],
    ["different execution attempt", { ...fullOwner, executionAttemptCount: 1 }, "agent-question:turn-1:canonical:q1"],
    ["different canonical question", fullOwner, "agent-question:turn-1:canonical:q2"],
  ])("fails closed for a persisted wait with a %s", async (_label, priorOwner, itemQuestionId) => {
    const prior = waitingState(priorOwner);
    const waitId = "agent-question:turn-1:canonical:q1";
    mocks.execution.mockResolvedValueOnce({ id: "execution-1", status: "waiting_for_user", attemptCount: 0, state: prior });
    mocks.question.mockResolvedValue(canonicalQuestion(waitId, null, { questionId: itemQuestionId }));
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "blocked", errorCode: "scheduled_pipeline_claim_conflict" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });
});
