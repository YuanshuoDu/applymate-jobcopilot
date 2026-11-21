import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApplyJobProcessor } from "./apply-job-runner.js";

const mocks = vi.hoisted(() => ({
  isUserActive: vi.fn(), checkRateLimit: vi.fn(), evaluateControl: vi.fn(), loadTaskContext: vi.fn(),
  inspectScope: vi.fn(), legacyStopCheck: vi.fn(), startStopProbe: vi.fn(), claim: vi.fn(),
  stagedStopCheck: vi.fn(), acquireStartFence: vi.fn(), runBrowser: vi.fn(), persistStopped: vi.fn(),
  finalize: vi.fn(), handleFailure: vi.fn(), events: [] as string[],
  lifecycle: { closeActivePage: vi.fn(), closeActiveSubmissionContext: vi.fn(), interruptStoppedTurn: vi.fn(),
    releaseSubmissionFence: vi.fn(), markSubmissionUncertain: vi.fn() },
}));

vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})) }));
vi.mock("../db/application-task-state.js", () => ({ claimApplicationTask: vi.fn(), finishApplicationTask: vi.fn(), isUserActive: mocks.isUserActive }));
vi.mock("../db/load-task-context.js", () => ({ loadTaskContext: mocks.loadTaskContext }));
vi.mock("../db/submission-guard.js", () => ({ claimUnattendedSubmission: mocks.claim }));
vi.mock("../rate-limit.js", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("./unattended-apply-control.js", () => ({ evaluateUnattendedApplyControl: mocks.evaluateControl }));
vi.mock("../runtime/interrupt/application-submission-probe.js", () => ({
  isApplicationSubmissionStopped: mocks.legacyStopCheck,
  startApplicationSubmissionStopProbe: mocks.startStopProbe,
}));
vi.mock("../runtime/approval/pg-store.js", () => ({ createPgApprovalStore: vi.fn(() => ({ inspectSubmission: mocks.inspectScope })) }));
vi.mock("./application-submission-route-gate.js", () => ({
  loadApprovedTurnScope: mocks.inspectScope,
  startApplyJobSubmissionStopProbe: (context: { state: { approvedTurnScope: unknown } }, stopCheck?: unknown) => {
    mocks.events.push("probe");
    return mocks.startStopProbe({ scope: context.state.approvedTurnScope, stopCheck });
  },
}));
vi.mock("./apply-browser-session.js", () => ({ runApplyBrowserSession: mocks.runBrowser }));
vi.mock("./apply-job-outcomes.js", () => ({ handOffUnavailableUnattendedTask: vi.fn() }));
vi.mock("./apply-job-finalization.js", () => ({
  APPLY_TIMEOUT_MS: 0,
  createApplyJobFinalization: vi.fn(() => mocks.lifecycle),
  finalizeApplyJob: mocks.finalize,
  handleApplyJobFailure: mocks.handleFailure,
  persistStoppedSubmission: mocks.persistStopped,
}));

const payload = {
  applicationTaskId: "application-task", userId: "user", jobId: "job", sessionId: "session",
  fillTurnId: "fill-turn", receiptId: "approval", constraintHash: "a".repeat(64), operation: "submit",
  applyUrl: "https://jobs.example/apply", personaId: "persona", resumePath: "",
};
const scope = {
  applicationTaskId: payload.applicationTaskId, userId: payload.userId, jobId: payload.jobId,
  sessionId: payload.sessionId, fillTurnId: payload.fillTurnId, turnId: payload.fillTurnId,
  approvalId: payload.receiptId, constraintHash: payload.constraintHash, workerTaskId: "worker-task",
  executionId: "execution",
};

describe("apply job runner staged Stop composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.isUserActive.mockResolvedValue(true);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.evaluateControl.mockResolvedValue({ allowed: true, flow: null });
    mocks.loadTaskContext.mockResolvedValue({ applyUrl: payload.applyUrl, persona: {}, coverLetterText: "", jobTitle: "Engineer", jobCompany: "Example", jobKeywords: "", resumeTempPath: null });
    mocks.inspectScope.mockResolvedValue(scope);
    mocks.legacyStopCheck.mockImplementation(async () => { mocks.events.push("legacy-check"); return false; });
    mocks.startStopProbe.mockImplementation(() => ({ pollNow: vi.fn(), stop: vi.fn() }));
    mocks.claim.mockImplementation(async () => { mocks.events.push("claim"); return "claimed"; });
    mocks.stagedStopCheck.mockImplementation(async () => { mocks.events.push("staged-check"); return false; });
    mocks.acquireStartFence.mockResolvedValue({ state: "ready", release: vi.fn() });
    mocks.runBrowser.mockImplementation(async () => { mocks.events.push("browser"); });
    mocks.persistStopped.mockResolvedValue(true);
    mocks.handleFailure.mockResolvedValue(false);
  });

  it("leaves the default legacy check, probe, and claim order unchanged", async () => {
    const processJob = createApplyJobProcessor({ isQueuePaused: vi.fn().mockResolvedValue(false) });
    await processJob({ id: "worker-task", data: payload } as never);
    expect(mocks.events).toEqual(["legacy-check", "probe", "claim", "browser"]);
    expect(mocks.stagedStopCheck).not.toHaveBeenCalled();
    expect(mocks.startStopProbe).toHaveBeenCalledWith(expect.objectContaining({ stopCheck: undefined }));
  });

  it("claims before the staged exact preflight and starts its poll before browser work", async () => {
    const stagedSubmissionStopProtocol = { isStopped: mocks.stagedStopCheck, acquireStartFence: mocks.acquireStartFence };
    const processJob = createApplyJobProcessor({ isQueuePaused: vi.fn().mockResolvedValue(false), stagedSubmissionStopProtocol });
    await processJob({ id: "worker-task", data: payload } as never);
    expect(mocks.events).toEqual(["claim", "staged-check", "probe", "browser"]);
    expect(mocks.stagedStopCheck).toHaveBeenCalledWith(scope);
    expect(mocks.startStopProbe).toHaveBeenCalledWith(expect.objectContaining({ stopCheck: mocks.stagedStopCheck }));
    expect(mocks.legacyStopCheck).not.toHaveBeenCalled();
  });

  it("records a staged preflight denial after the exact claim and never starts browser work", async () => {
    mocks.stagedStopCheck.mockImplementationOnce(async () => { mocks.events.push("staged-check"); return true; });
    const processJob = createApplyJobProcessor({ isQueuePaused: vi.fn().mockResolvedValue(false),
      stagedSubmissionStopProtocol: { isStopped: mocks.stagedStopCheck, acquireStartFence: mocks.acquireStartFence } });
    await processJob({ id: "worker-task", data: payload } as never);
    expect(mocks.events).toEqual(["claim", "staged-check"]);
    expect(mocks.persistStopped).toHaveBeenCalledOnce();
    expect(mocks.startStopProbe).not.toHaveBeenCalled();
    expect(mocks.runBrowser).not.toHaveBeenCalled();
  });
});
