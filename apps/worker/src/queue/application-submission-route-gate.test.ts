import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationSubmissionRouteHandler, loadApprovedTurnScope } from "./application-submission-route-gate.js";
import { createApplyJobFinalization } from "./apply-job-finalization.js";
import { createObjectiveSubmissionRouteLifecycle } from "./objective-submission-route-lifecycle.js";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import type { Page, Frame, Route } from "playwright-core";

const mocks = vi.hoisted(() => ({ inspectSubmission: vi.fn(), pool: { connect: vi.fn() }, turn: vi.fn(), fence: vi.fn(), finish: vi.fn() }));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => mocks.pool) }));
vi.mock("../db/reviewed-application-submit-request-fence.js", () => ({
  readSubmissionTurnState: mocks.turn, withReviewedApplicationSubmitRequestFence: mocks.fence,
}));
vi.mock("../db/application-task-state.js", async importOriginal => {
  const original = await importOriginal<typeof import("../db/application-task-state.js")>();
  return { ...original, finishApplicationTask: mocks.finish };
});
vi.mock("../db/objective-submission-uncertain.js", () => ({
  markExactStartedObjectiveSubmissionUncertain: async (pool: unknown, scope: { applicationTaskId: string }, message: string) => {
    const result = await mocks.finish(pool, scope.applicationTaskId, "waiting_for_user", "submission_uncertain", message, "submit", scope);
    return result === "superseded" ? "superseded" : "written";
  },
}));
vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmission: mocks.inspectSubmission })),
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
  beforeEach(() => mocks.inspectSubmission.mockReset().mockResolvedValue({
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
  }));

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
});

describe("Objective request with the real submission fence", () => {
  const objectiveSource = { schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
    approvalId: "objective-review:proof:2", reviewTurnId: "review-turn", materialProofHash: "b".repeat(64) };
  const scope = { ...identity, turnId: "turn", workerTaskId: "worker", executionId: "execution" };

  function setup(stopped = false) {
    const events: string[] = [];
    const clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
    mocks.pool.connect.mockReset().mockImplementation(async () => {
      const name = clients.length === 0 ? "marker" : "boundary";
      const query = vi.fn(async (sql: string) => {
        if (sql === "COMMIT" || sql === "ROLLBACK") events.push(`${name}:${sql}`);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config") || sql.includes("submission_execution_started")) return { rows: [], rowCount: 1 };
        throw new Error("Unexpected test query");
      });
      const release = vi.fn(() => { events.push(`${name}:release`); });
      const client = { query, release };
      clients.push(client);
      return client;
    });
    mocks.turn.mockReset().mockResolvedValue({ sessionStatus: "running", turnStatus: stopped ? "interrupted" : "in_progress", interrupted: stopped });
    mocks.fence.mockReset().mockImplementation(async (_client: unknown, actual: unknown, phase: string, expected: unknown, work: () => Promise<unknown>) => {
      expect(actual).toEqual(scope);
      expect(expected).toEqual(phase === "marker" ? undefined : { kind: "objective", source: objectiveSource });
      return { kind: "current", value: await work(), sourceTurnId: null, objectiveSource };
    });
    let resolveContinue!: () => void;
    let rejectContinue!: (error: Error) => void;
    let entered!: () => void;
    const enteredContinue = new Promise<void>(resolve => { entered = resolve; });
    const continuation = new Promise<void>((resolve, reject) => { resolveContinue = resolve; rejectContinue = reject; });
    const page = {} as Page;
    const frame = { page: () => page } as Frame;
    const intent = { url: "https://boards.greenhouse.io/acme/jobs/1/application", method: "POST" };
    const request = { url: () => intent.url, method: () => "POST", isNavigationRequest: () => true, frame: () => frame };
    const route = { request: () => request, continue: vi.fn(() => { events.push("continue"); entered(); return continuation; }),
      abort: vi.fn().mockResolvedValue(undefined), fallback: vi.fn().mockResolvedValue(undefined) } as unknown as Route;
    const observation = { accept: vi.fn(() => true), forward: vi.fn(() => true), reject: vi.fn() };
    const markUncertain = vi.fn().mockResolvedValue("written");
    const context = { payload: { applicationTaskId: "task" }, submissionIdentity: identity,
      state: { objectiveMode: true, objectiveSubmissionObservation: { current: observation },
        objectiveSubmissionRouteLifecycle: createObjectiveSubmissionRouteLifecycle(), armedSubmissionIntent: intent,
        submissionCandidateSeen: false, submissionRequestStarted: false, submissionRequestForwarded: false,
        submissionFenceUnavailable: false, queueCatchStarted: false, turnStopped: false, stopController: new AbortController(),
        approvedTurnScope: scope, pendingSubmissionFence: null, submissionFenceTimer: null,
        submissionRouteState: { work: null, cleanup: null }, applicationTaskFinalized: false },
    } as unknown as ApplyJobRunContext;
    context.lifecycle = {
      closeActivePage: vi.fn().mockResolvedValue(undefined),
      closeActiveSubmissionContext: vi.fn(() => { events.push("close"); return Promise.resolve(); }),
      interruptStoppedTurn: vi.fn().mockResolvedValue(undefined),
      markSubmissionUncertain: markUncertain,
      releaseSubmissionFence: vi.fn(async commit => {
        const pending = context.state.pendingSubmissionFence;
        context.state.pendingSubmissionFence = null;
        if (pending) await pending.release(commit);
      }),
    };
    return { context, route, request, intent, page, frame, events, clients, observation, markUncertain,
      enteredContinue, resolveContinue, rejectContinue };
  }

  it("holds the boundary transaction until the browser acknowledges the exact request", async () => {
    const s = setup();
    const work = createApplicationSubmissionRouteHandler(s.context, s.page, s.intent, s.frame, new Set())(s.route);
    await s.enteredContinue;
    expect(s.clients).toHaveLength(2);
    expect(s.events).not.toContain("boundary:COMMIT");
    expect(s.clients[1]!.release).not.toHaveBeenCalled();
    expect(s.context.state.submissionRequestForwarded).toBe(false);
    s.resolveContinue();
    await work;
    expect(s.clients[1]!.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(s.clients[1]!.release).toHaveBeenCalledOnce();
    expect(s.observation.forward).toHaveBeenCalledOnce();
    expect(s.context.state.submissionRequestForwarded).toBe(true);
  });

  it("does not continue if Stop wins the marker transaction", async () => {
    const s = setup(true);
    await createApplicationSubmissionRouteHandler(s.context, s.page, s.intent, s.frame, new Set())(s.route);
    expect(s.route.continue).not.toHaveBeenCalled();
    expect(s.clients).toHaveLength(1);
    expect(s.clients[0]!.release).toHaveBeenCalledOnce();
  });

  it("bounds a stuck COMMIT with the real lifecycle even when the query never settles after client destruction", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      let unlock!: () => void;
      let commitStarted!: () => void;
      const unlocked = new Promise<void>(resolve => { unlock = resolve; });
      const enteredCommit = new Promise<void>(resolve => { commitStarted = resolve; });
      mocks.finish.mockReset().mockImplementation(async () => { s.events.push("uncertain-wait"); await unlocked; s.events.push("uncertain-written"); return "updated"; });
      Object.assign(s.context.state, {
        activePageCloseRef: { current: null }, activeSubmissionContextClose: () => { s.events.push("close"); return Promise.resolve(); },
        activeSubmissionContextClosePromise: null, submissionFenceOwner: null, submissionFenceAbortAttempted: false,
        submissionFenceRelease: null, submissionUncertainWrite: null, submissionSuperseded: false,
      });
      s.context.lifecycle = createApplyJobFinalization(s.context);
      const work = createApplicationSubmissionRouteHandler(s.context, s.page, s.intent, s.frame, new Set())(s.route);
      await s.enteredContinue;
      s.clients[1]!.query.mockImplementation(async (sql: string) => {
        if (sql === "COMMIT") { s.events.push("boundary:COMMIT"); commitStarted(); return new Promise(() => undefined); }
        throw new Error("Unexpected test query");
      });
      s.clients[1]!.release.mockImplementation((error: unknown) => { s.events.push("boundary:release"); if (error) unlock(); });
      s.resolveContinue();
      await enteredCommit;
      let complete = false;
      void work.then(() => { complete = true; });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(complete).toBe(true);
      await work;
      expect(s.events.indexOf("close")).toBeLessThan(s.events.indexOf("boundary:release"));
      expect(s.events.indexOf("boundary:release")).toBeLessThan(s.events.indexOf("uncertain-written"));
      expect(s.clients[1]!.release).toHaveBeenCalledOnce();
      expect(s.clients[1]!.release).toHaveBeenCalledWith(expect.any(Error));
      expect(mocks.finish).toHaveBeenCalledOnce();
      expect(s.context.state.submissionRequestForwarded).toBe(false);
      expect(s.observation.forward).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("aborts a stuck Stop rollback after the marker with the real lifecycle and never continues", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      let unlock!: () => void;
      const unlocked = new Promise<void>(resolve => { unlock = resolve; });
      mocks.finish.mockReset().mockImplementation(async () => { s.events.push("uncertain-wait"); await unlocked; s.events.push("uncertain-written"); return "updated"; });
      Object.assign(s.context.state, {
        activePageCloseRef: { current: null }, activeSubmissionContextClose: () => { s.events.push("close"); return Promise.resolve(); },
        activeSubmissionContextClosePromise: null, submissionFenceOwner: null, submissionFenceAbortAttempted: false,
        submissionFenceRelease: null, submissionUncertainWrite: null, submissionSuperseded: false,
      });
      s.context.lifecycle = createApplyJobFinalization(s.context);
      mocks.fence.mockImplementation(async (_client: unknown, actual: unknown, phase: string, expected: unknown, work: () => Promise<unknown>) => {
        expect(actual).toEqual(scope);
        expect(expected).toEqual(phase === "marker" ? undefined : { kind: "objective", source: objectiveSource });
        const value = await work();
        if (phase === "boundary") {
          s.clients[1]!.query.mockImplementation(async (sql: string) => {
            if (sql === "ROLLBACK") { s.events.push("boundary:ROLLBACK"); return new Promise(() => undefined); }
            throw new Error("Unexpected test query");
          });
          s.clients[1]!.release.mockImplementation((error: unknown) => { s.events.push("boundary:release"); if (error) unlock(); });
          s.context.state.stopController.abort(new Error("Stop"));
        }
        return { kind: "current", value, sourceTurnId: null, objectiveSource };
      });
      const work = createApplicationSubmissionRouteHandler(s.context, s.page, s.intent, s.frame, new Set())(s.route);
      let complete = false;
      void work.then(() => { complete = true; });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(complete).toBe(true);
      await work;
      expect(s.route.continue).not.toHaveBeenCalled();
      expect(s.events.indexOf("close")).toBeLessThan(s.events.indexOf("boundary:release"));
      expect(s.events.indexOf("boundary:release")).toBeLessThan(s.events.indexOf("uncertain-written"));
      expect(s.clients[1]!.release).toHaveBeenCalledOnce();
      expect(s.clients[1]!.release).toHaveBeenCalledWith(expect.any(Error));
      expect(mocks.finish).toHaveBeenCalledOnce();
      expect(s.context.state.submissionRequestForwarded).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each(["reject", "timeout"] as const)("closes before releasing and keeps %s acknowledgement uncertain", async mode => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const work = createApplicationSubmissionRouteHandler(s.context, s.page, s.intent, s.frame, new Set())(s.route);
      await s.enteredContinue;
      if (mode === "reject") s.rejectContinue(new Error("unconfirmed"));
      else await vi.advanceTimersByTimeAsync(8_001);
      await work;
      expect(s.events.indexOf("close")).toBeGreaterThanOrEqual(0);
      expect(s.events.indexOf("close")).toBeLessThan(s.events.indexOf("boundary:release"));
      expect(s.events).not.toContain("boundary:COMMIT");
      expect(s.clients[1]!.release).toHaveBeenCalledOnce();
      expect(s.clients[1]!.release).toHaveBeenCalledWith(expect.any(Error));
      expect(s.markUncertain).toHaveBeenCalledOnce();
      expect(s.context.state.submissionAcknowledgementUncertain).toBe(true);
      expect(s.context.state.submissionRequestForwarded).toBe(false);
      if (mode === "timeout") { s.resolveContinue(); await Promise.resolve(); }
      expect(s.observation.forward).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
