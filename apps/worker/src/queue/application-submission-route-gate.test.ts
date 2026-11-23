import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationSubmissionRouteHandler, loadApprovedTurnScope } from "./application-submission-route-gate.js";
import { createSubmissionRouteObservation } from "./application-submission-route-observation.js";

const mocks = vi.hoisted(() => ({ inspectSubmission: vi.fn(), legacyStartFence: vi.fn(), finishTask: vi.fn() }));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})) }));
vi.mock("../db/application-task-state.js", () => ({
  finishApplicationTask: mocks.finishTask,
  isConfirmedApplicationTaskFinish: (result: string) => result === "current" || result === "already_current",
}));
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

function routeGateHarness(options: { fenceState?: "ready" | "stopped" | "uncertain"; continueRoute?: () => Promise<void> } = {}) {
  let acknowledge!: () => void;
  let routeCalled!: () => void;
  const continuation = new Promise<void>(resolve => { acknowledge = resolve; });
  const continued = new Promise<void>(resolve => { routeCalled = resolve; });
  const scope = { ...identity, turnId: identity.fillTurnId, workerTaskId: "worker-task", executionId: "execution" };
  const order: string[] = [];
  const stagedStartFence = vi.fn().mockResolvedValue({ state: options.fenceState ?? "ready", release: vi.fn() });
  const stopController = new AbortController();
  const observation = createSubmissionRouteObservation(stopController.signal);
  const state = {
    queueCatchStarted: false, stopController, approvedTurnScope: scope,
    armedSubmissionIntent: { url: "https://jobs.example/apply", method: "POST" },
    submissionCandidateSeen: false, submissionRequestStarted: false, submissionFenceTimer: null,
    submissionFenceUnavailable: false, turnStopped: false, pendingSubmissionFence: null as null | { release(commit: boolean): Promise<void> },
    submissionRouteState: { work: null, cleanup: null, observation }, applicationTaskFinalized: false,
  };
  const releaseSubmissionFence = vi.fn(async (commit: boolean) => {
    order.push(`release:${commit}`);
    const fence = state.pendingSubmissionFence;
    state.pendingSubmissionFence = null;
    await fence?.release(commit);
  });
  const onContinuationAcknowledged = vi.fn((_scope: typeof scope) => { order.push("acknowledged"); });
  const lifecycle = {
    closeActivePage: vi.fn().mockResolvedValue(undefined),
    closeActiveSubmissionContext: vi.fn().mockResolvedValue(undefined),
    interruptStoppedTurn: vi.fn().mockResolvedValue(undefined),
    releaseSubmissionFence,
    markSubmissionUncertain: vi.fn().mockResolvedValue("written"),
  };
  const page = {};
  const frame = { page: () => page };
  const context = {
    payload: { applicationTaskId: identity.applicationTaskId }, state,
    submissionIdentity: identity,
    stagedSubmissionStopProtocol: { isStopped: vi.fn(), acquireStartFence: stagedStartFence, onContinuationAcknowledged },
    lifecycle,
  };
  const handler = createApplicationSubmissionRouteHandler(
    context as never, page as never, { url: "https://jobs.example/apply", method: "POST" }, frame as never, new Set([page as never]),
  );
  const route = {
    request: () => ({ url: () => "https://jobs.example/apply", method: () => "POST", frame: () => frame, isNavigationRequest: () => true }),
    continue: vi.fn(() => { order.push("continue"); routeCalled(); return options.continueRoute ? options.continueRoute() : continuation; }),
    abort: vi.fn().mockResolvedValue(undefined), fallback: vi.fn().mockResolvedValue(undefined),
  };
  return { acknowledge, continued, handler, lifecycle, observation, onContinuationAcknowledged, order, releaseSubmissionFence, route, scope, stagedStartFence, state };
}

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
    mocks.finishTask.mockReset().mockResolvedValue("current");
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
    const harness = routeGateHarness();
    const handling = harness.handler(harness.route as never);
    await harness.continued;
    expect(harness.stagedStartFence).toHaveBeenCalledWith(harness.scope);
    expect(mocks.legacyStartFence).not.toHaveBeenCalled();
    expect(harness.onContinuationAcknowledged).not.toHaveBeenCalled();
    expect(harness.releaseSubmissionFence).not.toHaveBeenCalled();
    harness.acknowledge();
    await handling;
    expect(harness.onContinuationAcknowledged).toHaveBeenCalledOnce();
    expect(harness.onContinuationAcknowledged).toHaveBeenCalledWith(harness.scope);
    expect(harness.order).toEqual(["continue", "acknowledged", "release:true"]);
    expect(harness.releaseSubmissionFence).toHaveBeenLastCalledWith(true);
  });

  it("publishes the assigned exact route work before awaiting its continuation", async () => {
    const harness = routeGateHarness();
    const handling = harness.handler(harness.route as never);
    await harness.continued;
    const observed = await harness.observation.pending;

    expect(observed.kind).toBe("matched");
    if (observed.kind === "matched") expect(observed.work).toBe(harness.state.submissionRouteState.work);
    expect(harness.order).toEqual(["continue"]);
    harness.acknowledge();
    await handling;
  });

  it("does not admit a later route after the armed observation is aborted", async () => {
    const harness = routeGateHarness();
    harness.state.stopController.abort();
    await expect(harness.observation.pending).resolves.toEqual({ kind: "no_match" });

    await harness.handler(harness.route as never);

    expect(harness.route.abort).toHaveBeenCalledWith("aborted");
    expect(harness.route.continue).not.toHaveBeenCalled();
    expect(harness.stagedStartFence).not.toHaveBeenCalled();
  });

  it("does not acknowledge a rejected route continuation", async () => {
    const harness = routeGateHarness({ continueRoute: () => Promise.reject(new Error("route rejected")) });
    await harness.handler(harness.route as never);
    expect(harness.onContinuationAcknowledged).not.toHaveBeenCalled();
    expect(harness.releaseSubmissionFence).toHaveBeenLastCalledWith(true);
  });

  it("does not acknowledge a synchronous route continuation throw", async () => {
    const harness = routeGateHarness({ continueRoute: () => { throw new Error("route threw"); } });
    await harness.handler(harness.route as never);
    expect(harness.onContinuationAcknowledged).not.toHaveBeenCalled();
    expect(harness.releaseSubmissionFence).toHaveBeenLastCalledWith(true);
  });

  it("does not acknowledge a timed-out route continuation", async () => {
    vi.useFakeTimers();
    try {
      const harness = routeGateHarness({ continueRoute: () => new Promise<void>(() => undefined) });
      const handling = harness.handler(harness.route as never);
      await harness.continued;
      await vi.advanceTimersByTimeAsync(8_001);
      await handling;
      expect(harness.onContinuationAcknowledged).not.toHaveBeenCalled();
      expect(harness.releaseSubmissionFence).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acknowledge or continue a stop-first route fence", async () => {
    const harness = routeGateHarness({ fenceState: "stopped" });
    await harness.handler(harness.route as never);
    expect(harness.route.continue).not.toHaveBeenCalled();
    expect(harness.onContinuationAcknowledged).not.toHaveBeenCalled();
    expect(harness.releaseSubmissionFence).not.toHaveBeenCalled();
    expect(harness.lifecycle.interruptStoppedTurn).toHaveBeenCalledOnce();
  });

  it.each([
    ["unconfirmed", false],
    ["already_current", true],
  ] as const)("finalizes an ambiguous start only for %s task result", async (result, finalized) => {
    mocks.finishTask.mockResolvedValueOnce(result);
    const harness = routeGateHarness({ fenceState: "uncertain" });

    await harness.handler(harness.route as never);

    expect(harness.route.abort).toHaveBeenCalledWith("failed");
    expect(harness.route.continue).not.toHaveBeenCalled();
    expect(harness.state.applicationTaskFinalized).toBe(finalized);
    expect(mocks.finishTask).toHaveBeenCalledOnce();
  });
});
