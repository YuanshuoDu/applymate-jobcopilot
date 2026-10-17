import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol";
import { hashAgentReceiptValue } from "@jobcopilot/shared";

const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  transaction: vi.fn(),
  transactionCommit: vi.fn(),
  txTaskFindFirst: vi.fn(),
  txTaskUpdateMany: vi.fn(),
  approvalLock: vi.fn(),
  txTaskEventFindMany: vi.fn(),
  txTaskEventCreate: vi.fn(),
  outboxFindUnique: vi.fn(),
  outboxCreate: vi.fn(),
  txActivityCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskFindFirst: vi.fn(),
  taskEventCreate: vi.fn(),
  resumeFindFirst: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  activityCreate: vi.fn(),
  enqueueApplyTask: vi.fn(),
  runtimeFeatureEnabled: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
  startApplicationFillForReview: vi.fn(),
}));
let transactionClient: unknown;

vi.mock("@/lib/db", () => ({
  db: {
    agentApproval: { findFirst: mocks.approvalFindFirst },
    $transaction: mocks.transaction,
    applicationTask: { findFirst: mocks.taskFindFirst, update: mocks.taskUpdate, updateMany: mocks.taskUpdate },
    resume: { findFirst: mocks.resumeFindFirst },
    coverLetter: { findFirst: mocks.coverLetterFindFirst },
    applicationTaskEvent: { create: mocks.taskEventCreate },
    job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    user: { findUnique: mocks.userFindUnique },
    activity: { create: mocks.activityCreate },
  },
}));

vi.mock("@/lib/apply-queue-client", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/apply-queue-client")>()),
  enqueueApplyTask: mocks.enqueueApplyTask,
}));
vi.mock("@/lib/runtime-feature-flags", () => ({ isRuntimeFeatureEnabled: mocks.runtimeFeatureEnabled }));
vi.mock("@/lib/entitlements", () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement, isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }));
vi.mock("@/lib/agent/control-plane/commands/agent-command-service", () => ({
  AgentCommandService: class {
    constructor(_db: unknown) {}
    startApplicationFillForReview = mocks.startApplicationFillForReview
  },
}));

describe("auto-apply authorization", () => {
  const input = {
    userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", approvalId: "approval_1",
    receiptNonce: "nonce_1", sessionId: "session_1",
    applyUrl: "https://jobs.lever.co/acme/123",
  };

  type MaterialSnapshot = {
    applicationTaskId: string;
    jobId: string;
    resumeId: string;
    coverLetterId: string | null;
  };
  const materialSnapshot = (): MaterialSnapshot => ({
    applicationTaskId: "application_1",
    jobId: "job_1",
    resumeId: "resume_1",
    coverLetterId: null,
  });
  const makeApproval = async (confirmedAnswers: unknown = null, material: MaterialSnapshot = materialSnapshot(), status = "approved") => {
    const expiresAt = new Date(Date.now() + 60_000), nonceHash = await hashApprovalNonce(input.receiptNonce!);
    const materialHash = await hashAgentReceiptValue("material", material), answersHash = await hashAgentReceiptValue("answers", confirmedAnswers ?? null);
    const scopeHash = await hashApprovalScope({
      userId: input.userId, sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "call_1",
      action: "submit_application", resourceHash: "r".repeat(64), materialHash, answersHash, revision: 0,
      nonceHash, expiresAt: expiresAt.toISOString(),
    });
    return {
      id: "approval_1", status, nonceHash, resourceHash: "r".repeat(64), payload: material, taskId: null,
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt, scopeHash, materialHash, answersHash,
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.approvalFindFirst.mockResolvedValue(await makeApproval());
    mocks.taskFindFirst.mockResolvedValue({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.txTaskFindFirst.mockResolvedValue({ status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null, resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null, question: null });
    mocks.txTaskEventFindMany.mockResolvedValue([]);
    mocks.resumeFindFirst.mockResolvedValue({ id: "resume_1" });
    mocks.coverLetterFindFirst.mockResolvedValue({ id: "cover_1" });
    mocks.jobFindFirst.mockResolvedValue({
      company: "Acme", description: "Join the platform team with Acme. Build products.", source: "lever", url: input.applyUrl,
    });
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" });
    mocks.approvalLock.mockResolvedValue([{ id: "approval_1" }]);
    transactionClient = {
      applicationTask: { findFirst: mocks.txTaskFindFirst, updateMany: mocks.txTaskUpdateMany },
      resume: { findFirst: mocks.resumeFindFirst },
      coverLetter: { findFirst: mocks.coverLetterFindFirst },
      job: { updateMany: mocks.jobUpdateMany },
      applicationTaskEvent: { findMany: mocks.txTaskEventFindMany, create: mocks.txTaskEventCreate },
      agentOutbox: { findUnique: mocks.outboxFindUnique, create: mocks.outboxCreate },
      activity: { create: mocks.txActivityCreate },
      $queryRaw: mocks.approvalLock,
    };
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      if (typeof callback === "function") {
        const result = await callback(transactionClient);
        mocks.transactionCommit();
        return result;
      }
      return Promise.all(callback);
    });
    mocks.txTaskUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.jobUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.enqueueApplyTask.mockResolvedValue("worker_1");
    mocks.runtimeFeatureEnabled.mockResolvedValue(true);
    mocks.hasEffectiveEntitlement.mockResolvedValue(true);
    mocks.activityCreate.mockResolvedValue({});
    mocks.taskUpdate.mockResolvedValue({});
    mocks.taskEventCreate.mockResolvedValue({});
    mocks.txTaskEventCreate.mockResolvedValue({});
    mocks.outboxFindUnique.mockResolvedValue(null);
    mocks.outboxCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
    mocks.txActivityCreate.mockResolvedValue({});
    mocks.isFeatureAllowed.mockResolvedValue(true);
    mocks.resolveAiAccess.mockResolvedValue('allowed');
    mocks.startApplicationFillForReview.mockResolvedValue({ inputId: "input_1", turnId: "turn_fill_1", sequence: "1", disposition: "started" });
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "0");
  });

  it("queues only after matching explicit per-job authorization", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const result = await queueAutonomousApplication(input);
    expect(result.taskId).toMatch(/^apply-submit-[a-f0-9]{64}$/);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", fillTurnId: "turn_1", workerTaskId: null,
        resumeId: "resume_1", coverLetterId: null, confirmedAnswers: { equals: Prisma.DbNull } }),
      data: expect.objectContaining({ workerTaskId: result.taskId }),
    }));
    expect(mocks.txTaskEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        taskId: "application_1", type: "submission_queued",
        data: expect.objectContaining({ applicationTaskId: "application_1", userId: "user_1", jobId: "job_1",
          sessionId: "session_1", fillTurnId: "turn_1", approvalId: "approval_1", receiptId: "approval_1", workerTaskId: result.taskId }),
      }),
    }));
    expect(mocks.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      topic: "application.submit.dispatch", aggregateId: "session_1", idempotencyKey: expect.stringMatching(/^application-submit:/),
      payload: expect.objectContaining({ workerTaskId: result.taskId, receiptId: "approval_1", submitPayload: expect.objectContaining({ receiptId: "approval_1" }) }),
    }) }));
    expect(mocks.transaction).toHaveBeenCalled();
  }, 15_000);

  it("rejects an approval whose answer hash is stale before any submission state changes", async () => {
    const approval = await makeApproval();
    mocks.approvalFindFirst.mockResolvedValueOnce({ ...approval, answersHash: "a".repeat(64) });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects an approval whose material hash is stale before any submission state changes", async () => {
    const approval = await makeApproval();
    mocks.approvalFindFirst.mockResolvedValueOnce({ ...approval, materialHash: "b".repeat(64) });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("queues an unchanged non-null material and answer snapshot bound to approval hashes", async () => {
    const confirmedAnswers = { Location: "Dublin", authorizedToWork: true };
    const material = materialSnapshot();
    mocks.approvalFindFirst.mockResolvedValueOnce(await makeApproval(confirmedAnswers, material));
    mocks.taskFindFirst.mockResolvedValueOnce({
      sessionId: "session_1", fillTurnId: "turn_1", resumeId: material.resumeId,
      coverLetterId: material.coverLetterId, confirmedAnswers,
    });
    mocks.txTaskFindFirst.mockResolvedValueOnce({
      status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null,
      resumeId: material.resumeId, coverLetterId: material.coverLetterId, confirmedAnswers, question: null,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).resolves.toMatchObject({ taskId: expect.stringMatching(/^apply-submit-/) });
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        resumeId: material.resumeId,
        coverLetterId: material.coverLetterId,
        confirmedAnswers: { equals: confirmedAnswers },
      }),
    }));
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("resolves duplicate requests to the same committed submit intent and job ID", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const first = await queueAutonomousApplication(input);
    const outbox = mocks.outboxCreate.mock.calls[0]?.[0]?.data;
    const event = mocks.txTaskEventCreate.mock.calls[0]?.[0]?.data?.data;
    mocks.txTaskFindFirst.mockResolvedValueOnce({ status: "filling", checkpoint: "submission_authorized", workerTaskId: first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.outboxFindUnique.mockResolvedValueOnce(outbox);
    mocks.txTaskEventFindMany.mockResolvedValueOnce([{ data: event }]);

    await expect(queueAutonomousApplication(input)).resolves.toEqual(first);
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.outboxCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it.each([
    ["after the Worker claims it", "filling", "browser_active"],
    ["after the Worker verifies submission", "submitted", "submission_verified"],
  ] as const)("replays the committed intent %s without another dispatch", async (_stage, status, checkpoint) => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const approval = await makeApproval();
    mocks.approvalFindFirst.mockResolvedValue(approval);
    const first = await queueAutonomousApplication(input);
    const outbox = mocks.outboxCreate.mock.calls[0]?.[0]?.data;
    const event = mocks.txTaskEventCreate.mock.calls[0]?.[0]?.data?.data;
    mocks.approvalFindFirst.mockResolvedValueOnce({ ...approval, status: "consumed" });
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", workerTaskId: first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.txTaskFindFirst.mockResolvedValueOnce({ status, checkpoint, workerTaskId: first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.outboxFindUnique.mockResolvedValueOnce(outbox);
    mocks.txTaskEventFindMany.mockResolvedValueOnce([{ data: event }]);

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).resolves.toEqual(first);
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.txTaskEventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.outboxCreate).toHaveBeenCalledTimes(1);
    expect(mocks.txActivityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("recovers an approved replay once and resolves concurrent requests to its deterministic intent", async () => {
    const approval = await makeApproval();
    mocks.approvalFindFirst.mockResolvedValue(approval);
    const current: Record<string, unknown> = { status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null, question: null };
    let outbox: unknown = null;
    const events: unknown[] = [];
    let transactionQueue = Promise.resolve();
    mocks.txTaskFindFirst.mockImplementation(async () => ({ ...current }));
    mocks.txTaskUpdateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.status !== current.status || where.checkpoint !== current.checkpoint || where.workerTaskId !== current.workerTaskId) return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    });
    mocks.outboxFindUnique.mockImplementation(async () => outbox);
    mocks.outboxCreate.mockImplementation(async ({ data }: { data: unknown }) => { outbox = data; return data; });
    mocks.txTaskEventFindMany.mockImplementation(async () => events);
    mocks.txTaskEventCreate.mockImplementation(async ({ data }: { data: { data: unknown } }) => { events.push({ data: data.data }); return {}; });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const previous = transactionQueue;
      let release!: () => void;
      transactionQueue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { const result = await callback(transactionClient); mocks.transactionCommit(); return result; }
      finally { release(); }
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    const results = await Promise.all([
      queueAutonomousApplication({ ...input, replayOnly: true }),
      queueAutonomousApplication({ ...input, replayOnly: true }),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.txTaskEventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.outboxCreate).toHaveBeenCalledTimes(1);
    expect(mocks.approvalLock).toHaveBeenCalledTimes(1);
    expect(mocks.outboxCreate.mock.calls[0]?.[0]?.data.payload.submitPayload.applyUrl).toBe(input.applyUrl);
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ url: input.applyUrl }) }));
    expect(mocks.runtimeFeatureEnabled).toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a consumed approval when no submit intent exists", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(await makeApproval(null, materialSnapshot(), "consumed"));
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.approvalLock).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects an expired approved receipt before replay can create a missing intent", async () => {
    const approval = await makeApproval();
    approval.expiresAt = new Date(Date.now() - 60_000);
    approval.scopeHash = await hashApprovalScope({
      userId: input.userId, sessionId: approval.sessionId, turnId: approval.turnId, jobId: input.jobId,
      toolCallId: approval.toolCallId, action: "submit_application", resourceHash: approval.resourceHash,
      materialHash: approval.materialHash, answersHash: approval.answersHash, revision: approval.revision,
      nonceHash: approval.nonceHash, expiresAt: approval.expiresAt.toISOString(),
    });
    mocks.approvalFindFirst.mockResolvedValueOnce(approval);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).rejects.toThrow("approval expired");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rolls back task and job claims when the transaction cannot lock the approved receipt", async () => {
    mocks.approvalLock.mockResolvedValueOnce([]);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).rejects.toThrow("receipt changed");
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.txActivityCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it.each([
    ["uncertain outcome", { status: "waiting_for_user", checkpoint: "submission_uncertain", workerTaskId: null }],
    ["another attempt", { status: "filling", checkpoint: "browser_active", workerTaskId: "apply-submit-other" }],
  ] as const)("fails closed when the persisted attempt is in an %s state", async (_name, state) => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    const approval = await makeApproval();
    mocks.approvalFindFirst.mockResolvedValue(approval);
    const first = await queueAutonomousApplication(input);
    const consumedApproval = { ...approval, status: "consumed" };
    const outbox = mocks.outboxCreate.mock.calls[0]?.[0]?.data;
    const event = mocks.txTaskEventCreate.mock.calls[0]?.[0]?.data?.data;
    mocks.approvalFindFirst.mockResolvedValueOnce(consumedApproval);
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", workerTaskId: state.workerTaskId ?? first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.txTaskFindFirst.mockResolvedValueOnce({ ...state, workerTaskId: state.workerTaskId ?? first.taskId,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    mocks.outboxFindUnique.mockResolvedValueOnce(outbox);
    mocks.txTaskEventFindMany.mockResolvedValueOnce([{ data: event }]);
    mocks.txTaskUpdateMany.mockClear();
    mocks.jobUpdateMany.mockClear();
    mocks.txTaskEventCreate.mockClear();
    mocks.outboxCreate.mockClear();
    mocks.txActivityCreate.mockClear();
    mocks.enqueueApplyTask.mockClear();

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("scopes a committed-intent replay lookup to the authenticated user", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, userId: "user_other", replayOnly: true })).rejects.toThrow("explicit approval");
    expect(mocks.approvalFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "approval_1", userId: "user_other", status: { in: ["approved", "consumed"] } }),
    }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a replay with a stale fill Turn or receipt nonce before opening the transaction", async () => {
    const approval = await makeApproval(null, materialSnapshot(), "consumed");
    mocks.approvalFindFirst.mockResolvedValueOnce({ ...approval, turnId: "turn_old" });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, replayOnly: true })).rejects.toThrow("explicit approval");
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.approvalFindFirst.mockResolvedValueOnce(approval);
    await expect(queueAutonomousApplication({ ...input, receiptNonce: "wrong_nonce", replayOnly: true })).rejects.toThrow("explicit approval");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it.each([
    ["resume", { resumeId: "resume_2" }],
    ["cover letter", { coverLetterId: "cover_2" }],
    ["confirmed answers", { confirmedAnswers: { Location: "Cork" } }],
  ] as const)("rejects when transactionally re-read approved %s drift", async (_field, changed) => {
    mocks.txTaskFindFirst.mockResolvedValueOnce({
      status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null,
      resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null, question: null, ...changed,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a missing current fill Turn before enqueueing submission", async () => {
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: null, resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an approval bound to another fill Turn or session", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      id: "approval_1",
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_other", turnId: "turn_other", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: "s".repeat(64),
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a caller session that does not match the current task", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication({ ...input, sessionId: "session_other" })).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rolls back the claim when outbox persistence fails and never dispatches Redis work", async () => {
    mocks.outboxCreate.mockRejectedValueOnce(new Error("outbox unavailable"));
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("outbox unavailable");
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.txTaskEventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  })

  it("restores task, Job, event, and outbox state when a post-outbox transaction write fails", async () => {
    type ProducerState = { task: Record<string, unknown>; job: Record<string, unknown>; events: unknown[]; outbox: unknown[] };
    const state: ProducerState = {
      task: { id: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_1",
        status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null, resumeId: "resume_1",
        coverLetterId: null, confirmedAnswers: null, question: null },
      job: { id: "job_1", userId: "user_1", url: input.applyUrl, status: "saved", workflowState: "ready_to_apply" },
      events: [], outbox: [],
    };
    const taskBefore = structuredClone(state.task), jobBefore = structuredClone(state.job);
    let taskWrites = 0, jobWrites = 0, eventWrites = 0, outboxWrites = 0, activityWrites = 0;
    const tx = {
      applicationTask: {
        findFirst: async () => structuredClone(state.task),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.status !== state.task.status || where.checkpoint !== state.task.checkpoint || where.workerTaskId !== state.task.workerTaskId) return { count: 0 };
          taskWrites++; Object.assign(state.task, data); return { count: 1 };
        },
      },
      resume: { findFirst: async () => ({ id: "resume_1" }) },
      coverLetter: { findFirst: async () => ({ id: "cover_1" }) },
      job: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.url !== state.job.url || where.workflowState !== state.job.workflowState) return { count: 0 };
        jobWrites++; Object.assign(state.job, data); return { count: 1 };
      } },
      applicationTaskEvent: {
        findMany: async () => state.events,
        create: async ({ data }: { data: unknown }) => { eventWrites++; state.events.push(structuredClone(data)); return data; },
      },
      agentOutbox: {
        findUnique: async () => null,
        create: async ({ data }: { data: unknown }) => { outboxWrites++; state.outbox.push(structuredClone(data)); return data; },
      },
      activity: { create: async () => { activityWrites++; throw new Error("post-outbox write failed"); } },
      $queryRaw: mocks.approvalLock,
    };
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const before: ProducerState = structuredClone(state);
      try {
        const result = await callback(tx);
        mocks.transactionCommit();
        return result;
      } catch (error) {
        state.task = before.task; state.job = before.job; state.events = before.events; state.outbox = before.outbox;
        throw error;
      }
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("post-outbox write failed");

    expect(taskWrites).toBe(1);
    expect(jobWrites).toBe(1);
    expect(eventWrites).toBe(1);
    expect(outboxWrites).toBe(1);
    expect(activityWrites).toBe(1);
    expect(state.task).toEqual(taskBefore);
    expect(state.job).toEqual(jobBefore);
    expect(state.events).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rolls back the task claim when the canonical Job URL changes after the request snapshot", async () => {
    const changedUrl = "https://jobs.lever.co/acme/changed";
    mocks.jobUpdateMany.mockImplementationOnce(async ({ where }: { where: Record<string, unknown> }) => ({ count: where.url === changedUrl ? 1 : 0 }));
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");
    expect(mocks.txTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ url: input.applyUrl }) }));
    expect(mocks.transactionCommit).not.toHaveBeenCalled();
    expect(mocks.txTaskEventCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  })

  it("rejects autonomous submission when the current plan lacks auto-apply", async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(false);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("not included in your current plan");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("rejects autonomous submission when monthly AI credits are exhausted", async () => {
    mocks.resolveAiAccess.mockResolvedValueOnce('exhausted');
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("Monthly AI credits exhausted");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("queues a fill-only pass without changing the job into a submission", async () => {
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({});
    const { queueApplicationFill } = await import("./auto-apply");
    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
    })).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith(expect.objectContaining({ operation: "fill" }));
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("routes a user-input resume through the TaskGraph resume transaction", async () => {
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "1");
    mocks.taskFindFirst.mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_waiting" });
    const { queueApplicationFill } = await import("./auto-apply");

    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
      resumeAfterUserInput: true,
    })).resolves.toMatchObject({ taskId: "turn_fill_1", turnId: "turn_fill_1", disposition: "started" });

    expect(mocks.startApplicationFillForReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1",
      clientMessageId: "application-fill-resume:application_1", resumeAfterUserInput: true,
    }));
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("keeps TaskGraph fill disabled by default and uses the existing ApplyQueue fallback", async () => {
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 });
    const { applicationFillTaskGraphEnabled, queueApplicationFill } = await import("./auto-apply");
    expect(applicationFillTaskGraphEnabled(undefined)).toBe(false);
    await expect(queueApplicationFill(input)).resolves.toEqual({ taskId: "worker_1" });
    expect(mocks.enqueueApplyTask).toHaveBeenCalledWith(expect.objectContaining({ operation: "fill" }));
    expect(mocks.startApplicationFillForReview).not.toHaveBeenCalled();
  });

  it("routes enabled fill-for-review to one deterministic canonical Turn without enqueuing ApplyQueue", async () => {
    vi.stubEnv("ENABLE_APPLICATION_FILL_TASKGRAPH", "1");
    const { queueApplicationFill } = await import("./auto-apply");
    await expect(queueApplicationFill(input)).resolves.toEqual({ taskId: "turn_fill_1", turnId: "turn_fill_1", disposition: "started" });
    expect(mocks.startApplicationFillForReview).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1", clientMessageId: "application-fill:application_1",
    }));
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("does not queue unattended browser work when the platform control is disabled", async () => {
    mocks.runtimeFeatureEnabled.mockResolvedValueOnce(false);
    mocks.taskUpdate.mockResolvedValueOnce({ count: 1 });
    const { queueApplicationFill } = await import("./auto-apply");

    await expect(queueApplicationFill({
      userId: "user_1", jobId: "job_1", applicationTaskId: "application_1", applyUrl: input.applyUrl,
    })).rejects.toThrow("temporarily unavailable");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a global setting or unrelated approval as submission consent", async () => {
    mocks.approvalFindFirst.mockResolvedValue({
      payload: { applicationTaskId: "other", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a legacy approval that has no canonical scope hash", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      payload: { applicationTaskId: "application_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null },
      sessionId: "session_1", turnId: "turn_1", toolCallId: "call_1", jobId: "job_1", revision: 0,
      expiresAt: new Date(Date.now() + 60_000), scopeHash: null,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("explicit approval");
    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a stale task whose resume does not belong to this job or the current default", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce(await makeApproval());
    mocks.taskFindFirst
      .mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null })
      .mockResolvedValueOnce({ resumeId: "resume_1", coverLetterId: null });
    mocks.resumeFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects a task whose stored cover letter belongs to a different application", async () => {
    mocks.taskFindFirst
      .mockResolvedValueOnce({ sessionId: "session_1", fillTurnId: "turn_1", resumeId: "resume_1", coverLetterId: "cover_other", confirmedAnswers: null })
      .mockResolvedValueOnce({ resumeId: "resume_1", coverLetterId: "cover_other" });
    mocks.txTaskFindFirst.mockResolvedValueOnce({ status: "waiting_for_authorization", checkpoint: "form_filled", workerTaskId: null, resumeId: "resume_1", coverLetterId: "cover_other", question: null });
    mocks.approvalFindFirst.mockResolvedValueOnce(await makeApproval(null, { ...materialSnapshot(), coverLetterId: "cover_other" }));
    mocks.coverLetterFindFirst.mockResolvedValueOnce(null);
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("no longer ready");

    expect(mocks.enqueueApplyTask).not.toHaveBeenCalled();
  });

  it("rejects blocked job-board URLs before reading or changing state", async () => {
    const { queueAutonomousApplication } = await import("./auto-apply");
    await expect(queueAutonomousApplication({ ...input, applyUrl: "https://www.linkedin.com/jobs/view/123" })).rejects.toThrow("direct supported ATS");
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a direct ATS URL when the saved job identity conflicts with its description", async () => {
    mocks.jobFindFirst.mockResolvedValueOnce({
      company: "Questionmark", description: "Join Future of EdTech with Learnosity. At Learnosity, build products.", source: "lever", url: input.applyUrl,
    });
    const { queueAutonomousApplication } = await import("./auto-apply");

    await expect(queueAutonomousApplication(input)).rejects.toThrow("does not match")
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });
});
