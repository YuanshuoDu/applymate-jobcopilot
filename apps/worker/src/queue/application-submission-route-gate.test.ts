import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationSubmissionRouteHandler, loadApprovedTurnScope } from "./application-submission-route-gate.js";

const mocks = vi.hoisted(() => ({ inspectSubmission: vi.fn(), legacyStartFence: vi.fn() }));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})) }));
vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmission: mocks.inspectSubmission })),
}));
vi.mock("../runtime/interrupt/application-submission-probe.js", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/interrupt/application-submission-probe.js")>(),
  acquireApplicationSubmissionStartFence: mocks.legacyStartFence,
}));

const identity = {
  applicationTaskId: "task",
  userId: "user",
  jobId: "job",
  sessionId: "session",
  fillTurnId: "turn",
  approvalId: "approval",
  constraintHash: "a".repeat(64),
};

describe("approved application route scope", () => {
  beforeEach(() => {
    mocks.inspectSubmission.mockReset().mockResolvedValue({
      id: "approval",
      type: "submit_application",
      scope: {
        action: "submit_application",
        userId: "user",
        sessionId: "session",
        turnId: "turn",
        jobId: "job",
        toolCallId: "application-submit:task",
      },
      payload: { applicationTaskId: "task", jobId: "job" },
    });
    mocks.legacyStartFence.mockReset();
  });

  it("binds the approved scope to the exact queue execution", async () => {
    await expect(loadApprovedTurnScope(identity, "execution", "worker-task")).resolves.toEqual({
      ...identity, executionId: "execution", workerTaskId: "worker-task", turnId: "turn",
    });
  });

  it("rejects an approval for another job", async () => {
    mocks.inspectSubmission.mockResolvedValueOnce({
      id: "approval",
      type: "submit_application",
      scope: {
        action: "submit_application",
        userId: "user",
        sessionId: "session",
        turnId: "turn",
        jobId: "other-job",
        toolCallId: "application-submit:task",
      },
      payload: { applicationTaskId: "task", jobId: "other-job" },
    });
    await expect(loadApprovedTurnScope(identity, "execution", "worker-task")).rejects.toThrow(
      "Approval receipt does not match the queued application task lineage.",
    );
  });

  it("uses the staged fence only when explicitly injected and holds it through route acknowledgement", async () => {
    let acknowledge!: () => void;
    let routeCalled!: () => void;
    const continuation = new Promise<void>(resolve => { acknowledge = resolve; });
    const continued = new Promise<void>(resolve => { routeCalled = resolve; });
    const scope = { ...identity, turnId: identity.fillTurnId, workerTaskId: "worker-task", executionId: "execution" };
    const stagedStartFence = vi.fn().mockResolvedValue({ state: "ready", release: vi.fn() });
    const state = {
      queueCatchStarted: false, stopController: new AbortController(), approvedTurnScope: scope,
      armedSubmissionIntent: { url: "https://jobs.example/apply", method: "POST" },
      submissionCandidateSeen: false, submissionRequestStarted: false, submissionFenceTimer: null,
      submissionFenceUnavailable: false, turnStopped: false, pendingSubmissionFence: null as null | { release(commit: boolean): Promise<void> },
      submissionRouteState: { work: null, cleanup: null },
    };
    const releaseSubmissionFence = vi.fn(async (commit: boolean) => {
      const fence = state.pendingSubmissionFence;
      state.pendingSubmissionFence = null;
      await fence?.release(commit);
    });
    const page = {};
    const frame = { page: () => page };
    const context = {
      payload: { applicationTaskId: identity.applicationTaskId }, state,
      submissionIdentity: identity,
      stagedSubmissionStopProtocol: { isStopped: vi.fn(), acquireStartFence: stagedStartFence },
      lifecycle: { releaseSubmissionFence },
    };
    const handler = createApplicationSubmissionRouteHandler(
      context as never, page as never, { url: "https://jobs.example/apply", method: "POST" }, frame as never, new Set([page as never]),
    );
    const route = {
      request: () => ({ url: () => "https://jobs.example/apply", method: () => "POST", frame: () => frame, isNavigationRequest: () => true }),
      continue: vi.fn(() => { routeCalled(); return continuation; }), abort: vi.fn().mockResolvedValue(undefined),
      fallback: vi.fn().mockResolvedValue(undefined),
    };

    const handling = handler(route as never);
    await continued;
    expect(stagedStartFence).toHaveBeenCalledWith(scope);
    expect(mocks.legacyStartFence).not.toHaveBeenCalled();
    expect(releaseSubmissionFence).not.toHaveBeenCalled();
    acknowledge();
    await handling;
    expect(releaseSubmissionFence).toHaveBeenCalledOnce();
    expect(releaseSubmissionFence).toHaveBeenLastCalledWith(true);
  });
});
