import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { createPgApplicationSubmitTool, type ApplicationSubmitProvider } from "../runtime/tools/application-submit-tool.js";
import { runApplyBrowserStrategy, runApplySubmitStrategy } from "./apply-browser-strategy.js";
import { createSubmissionRouteObservation } from "./application-submission-route-observation.js";

vi.mock("../flows/greenhouse-flow.js", () => ({ runGreenhouseFlow: vi.fn() }));
vi.mock("../runtime/tools/application-submit-tool.js", () => ({ createPgApplicationSubmitTool: vi.fn() }));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})) }));

function submitContext(submissionRouteState: {
  work: Promise<void> | null
  observation: ReturnType<typeof createSubmissionRouteObservation> | null
}) {
  return {
    payload: { operation: "submit", userId: "user", jobId: "job", receiptId: "approval", constraintHash: "a".repeat(64), applicationTaskId: "task" },
    submissionIdentity: {}, startedAt: Date.now(),
    state: {
      flow: "greenhouse", approvedTurnScope: { sessionId: "session", turnId: "turn" }, submissionRouteState,
      submissionAcknowledgementUncertain: false, stopController: new AbortController(), queueCatchStarted: false,
    },
  } as never;
}

describe("apply browser strategy", () => {
  beforeEach(() => vi.mocked(runGreenhouseFlow).mockReset());

  it("keeps the known Greenhouse flow ahead of the AI fallback", async () => {
    const result = { status: "manual" as const, turns: 0, durationMs: 4, error: "review", log: [] };
    vi.mocked(runGreenhouseFlow).mockResolvedValue(result);
    const context = {
      payload: { operation: "fill", userId: "user", dryRun: false },
      taskContext: { applyUrl: "https://boards.greenhouse.io/acme" },
      state: { flow: "greenhouse", usedFlow: null, challengeBoundary: null },
    } as never;
    const task = {
      jobId: "job",
      applyUrl: "https://boards.greenhouse.io/acme",
      persona: {},
      jobTitle: "Engineer",
      jobCompany: "Acme",
      resumePath: "/resume.pdf",
    };

    await expect(runApplyBrowserStrategy(context, {} as never, task, async () => true)).resolves.toBe(result);
    expect(runGreenhouseFlow).toHaveBeenCalledOnce();
    expect(vi.mocked(runGreenhouseFlow).mock.calls[0]?.[1]).toBe(task);
  });

  it("routes reviewed submission only through the exact Greenhouse flow and composes the typed guard", async () => {
    const result = { status: "manual" as const, turns: 0, durationMs: 4, error: "review", log: [] };
    vi.mocked(runGreenhouseFlow).mockResolvedValue(result);
    const context = {
      payload: { operation: "submit", userId: "user", dryRun: false },
      taskContext: { applyUrl: "https://boards.greenhouse.io/acme" },
      state: { flow: "greenhouse", usedFlow: null, challengeBoundary: null },
    } as never;
    const existingGuard = vi.fn().mockResolvedValue(true);
    const typedGuard = vi.fn().mockResolvedValue(true);
    const task = {
      jobId: "job", applyUrl: "https://boards.greenhouse.io/acme", persona: { coverLetter: "old application text" },
      jobTitle: "Engineer", jobCompany: "Acme", resumePath: "db:resume", allowSubmit: true, beforeSubmit: existingGuard,
    };
    const reviewedCoverLetter = "reviewed source text";

    await expect(runApplyBrowserStrategy(context, {} as never, task, async () => true, typedGuard, reviewedCoverLetter)).resolves.toBe(result);

    const [, browserTask, options] = vi.mocked(runGreenhouseFlow).mock.calls[0]!;
    expect(options).toEqual({ reviewedCoverLetter, mode: "approved-submit" });
    expect(browserTask.persona.coverLetter).toBe(reviewedCoverLetter);
    expect(task.persona.coverLetter).toBe("old application text");
    expect(await browserTask.beforeSubmit?.()).toBe(true);
    expect(typedGuard).toHaveBeenCalledOnce();
    expect(existingGuard).toHaveBeenCalledOnce();
  });

  it("rejects reviewed submission before challenge, ATS, pattern, or LLM fallback when Greenhouse is not selected", async () => {
    const challengeAllowsAction = vi.fn().mockResolvedValue(true);
    const context = {
      payload: { operation: "submit", userId: "user", dryRun: false },
      taskContext: { applyUrl: "https://unknown.example/apply" },
      state: { flow: null, usedFlow: null, challengeBoundary: null },
    } as never;

    await expect(runApplyBrowserStrategy(context, {} as never, { persona: {} } as never, challengeAllowsAction, undefined, "reviewed"))
      .resolves.toMatchObject({ status: "manual", error: "Reviewed application material is unsupported by this browser path." });
    expect(challengeAllowsAction).not.toHaveBeenCalled();
    expect(runGreenhouseFlow).not.toHaveBeenCalled();
  });

  it("advertises reviewed support only for the exact Greenhouse runner and forwards the exact material", async () => {
    const captured: { provider?: Parameters<typeof createPgApplicationSubmitTool>[0]["submit"] } = {};
    const getCapturedProvider = (): ApplicationSubmitProvider => captured.provider as ApplicationSubmitProvider;
    vi.mocked(createPgApplicationSubmitTool).mockImplementation(({ submit }) => {
      captured.provider = submit;
      return { execute: vi.fn().mockResolvedValue({ status: "failed", errorCode: "submission_attempt_fenced" }) } as never;
    });
    const context = (flow: string, submissionRouteState: {
      work: Promise<void> | null
      observation: ReturnType<typeof createSubmissionRouteObservation> | null
    } = { work: null, observation: null }) => ({
      payload: { operation: "submit", userId: "user", jobId: "job", receiptId: "approval", constraintHash: "a".repeat(64), applicationTaskId: "task" },
      submissionIdentity: {}, startedAt: Date.now(),
      state: {
        flow, approvedTurnScope: { sessionId: "session", turnId: "turn" }, submissionRouteState,
        submissionAcknowledgementUncertain: false, stopController: new AbortController(), queueCatchStarted: false,
      },
    }) as never;
    const runBrowserFlow = vi.fn().mockResolvedValue({ status: "submitted", durationMs: 1 });
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const providerInput = { target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit, reviewedCoverLetter: "reviewed" };

    const page = { url: () => "https://boards.greenhouse.io/acme/confirmation" } as never;
    await runApplySubmitStrategy(context("greenhouse"), page, runBrowserFlow);
    const greenhouseProvider = getCapturedProvider();
    expect(greenhouseProvider?.acceptsReviewedApplicationMaterial).toBe(true);
    await expect(greenhouseProvider!(providerInput)).resolves.toEqual({ confirmationId: "application:task", postSubmitUrl: "https://boards.greenhouse.io/acme/confirmation" });
    expect(runBrowserFlow).toHaveBeenCalledWith(beforeSubmit, "reviewed");

    vi.mocked(createPgApplicationSubmitTool).mockClear();
    captured.provider = undefined;
    await runApplySubmitStrategy(context("lever"), page, runBrowserFlow);
    const leverProvider = getCapturedProvider();
    expect(leverProvider?.acceptsReviewedApplicationMaterial).toBeUndefined();
    await expect(leverProvider!(providerInput)).rejects.toMatchObject({ code: "browser_manual" });
    expect(runBrowserFlow).toHaveBeenCalledTimes(1);
  });

  it("waits for a route callback that arrives after a normal browser result", async () => {
    const routeState = { work: null as Promise<void> | null, observation: null as ReturnType<typeof createSubmissionRouteObservation> | null };
    const observations: ReturnType<typeof createSubmissionRouteObservation>[] = [];
    const captured: { provider?: Parameters<typeof createPgApplicationSubmitTool>[0]["submit"] } = {};
    vi.mocked(createPgApplicationSubmitTool).mockImplementation(({ submit }) => {
      captured.provider = submit;
      return { execute: vi.fn().mockResolvedValue({ status: "failed", errorCode: "submission_attempt_fenced" }) } as never;
    });
    const runBrowserFlow = vi.fn().mockImplementation(async () => {
      const observation = createSubmissionRouteObservation();
      observations.push(observation);
      routeState.observation = observation;
      return { status: "manual", durationMs: 1 };
    });
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    await runApplySubmitStrategy(submitContext(routeState), { url: () => "https://boards.greenhouse.io/acme" } as never, runBrowserFlow);
    const provider = captured.provider as ApplicationSubmitProvider;
    let releaseRoute!: () => void;
    const work = new Promise<void>(resolve => { releaseRoute = resolve; });
    let settled = false;
    const pending = provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit })
      .finally(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    routeState.work = work;
    expect(observations[0]?.observe(work)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseRoute();
    await expect(pending).rejects.toMatchObject({ code: "browser_manual" });
  });

  it("settles held route work before preserving a rejected browser flow", async () => {
    const routeState = { work: null as Promise<void> | null, observation: null as ReturnType<typeof createSubmissionRouteObservation> | null };
    const observations: ReturnType<typeof createSubmissionRouteObservation>[] = [];
    const captured: { provider?: Parameters<typeof createPgApplicationSubmitTool>[0]["submit"] } = {};
    vi.mocked(createPgApplicationSubmitTool).mockImplementation(({ submit }) => {
      captured.provider = submit;
      return { execute: vi.fn().mockResolvedValue({ status: "failed", errorCode: "submission_attempt_fenced" }) } as never;
    });
    const runnerError = new Error("browser runner failed");
    const runBrowserFlow = vi.fn().mockImplementation(async () => {
      const observation = createSubmissionRouteObservation();
      observations.push(observation);
      routeState.observation = observation;
      throw runnerError;
    });
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    await runApplySubmitStrategy(submitContext(routeState), { url: () => "https://boards.greenhouse.io/acme" } as never, runBrowserFlow);
    const provider = captured.provider as ApplicationSubmitProvider;
    let releaseRoute!: () => void;
    const work = new Promise<void>(resolve => { releaseRoute = resolve; });
    let settled = false;
    const pending = provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit })
      .catch(error => { settled = true; throw error; });

    await Promise.resolve();
    expect(settled).toBe(false);
    routeState.work = work;
    expect(observations[0]?.observe(work)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseRoute();
    await expect(pending).rejects.toBe(runnerError);
  });
});
