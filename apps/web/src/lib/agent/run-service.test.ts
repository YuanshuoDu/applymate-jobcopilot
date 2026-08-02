import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHistory: vi.fn(),
  executionFindFirst: vi.fn(),
  executionUpdateMany: vi.fn(),
  executionUpsert: vi.fn(),
  findConfig: vi.fn(),
  findTranscript: vi.fn(),
  findResume: vi.fn(),
  finalize: vi.fn(),
  loadRoleConfigs: vi.fn(),
  record: vi.fn(),
  pause: vi.fn(),
  runPipeline: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    agentConfig: { findUnique: mocks.findConfig },
    agentRun: { create: mocks.createHistory },
    agentExecution: { findFirst: mocks.executionFindFirst, updateMany: mocks.executionUpdateMany, upsert: mocks.executionUpsert },
    agentTranscriptEvent: { findFirst: mocks.findTranscript },
    resume: { findFirst: mocks.findResume },
  },
}));
vi.mock("@/lib/agent/pipeline", () => ({ runPipeline: mocks.runPipeline }));
vi.mock("@/lib/agent/session/run-recorder", () => ({
  createRunSessionRecorder: vi.fn().mockResolvedValue({ sessionId: "session_1", record: mocks.record, finalize: mocks.finalize, pause: mocks.pause }),
}));
vi.mock("@/lib/agent/role-config", () => ({
  loadRoleConfigs: mocks.loadRoleConfigs,
  toRoleConfigMap: vi.fn(() => ({})),
}));
vi.mock("@/lib/agent/types", () => ({ resumeToText: vi.fn(() => "resume text") }));

const config = {
  id: "config_1", userId: "user_1", isRunning: false, dailyLimit: 10, minMatchScore: 70,
  autoApply: false, requireApproval: true, targetLocations: ["Dublin"], targetRoles: ["Engineer"],
  excludeCompanies: [], priorityCompanies: [], autoCoverLetter: false, coverTone: "professional",
  useTailoredCV: false, model: "MiniMax-M3",
};

describe("runAgentPipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.createHistory.mockResolvedValue({});
    mocks.executionUpsert.mockResolvedValue({ id: "execution_1" });
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.record.mockResolvedValue({});
    mocks.finalize.mockResolvedValue({});
    mocks.pause.mockResolvedValue({});
    mocks.findConfig.mockResolvedValue(config);
    mocks.findTranscript.mockResolvedValue({ data: {
      automation: { targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"], minScore: 85,
        dailyCap: 4, requireApproval: false, autoApply: true },
    } });
    mocks.findResume.mockResolvedValue({
      id: "resume_1", name: "CV", content: {}, templateId: null, templateOptions: null,
      directionId: null, basicsDetached: false,
    });
    mocks.loadRoleConfigs.mockResolvedValue([]);
    mocks.runPipeline.mockResolvedValue({ processed: 1, queued: 1, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 });
  });

  it("uses the saved automation snapshot but preserves the per-job authorization boundary", async () => {
    const { runAgentPipeline } = await import("./run-service");
    await runAgentPipeline({
      userId: "user_1", sessionId: "session_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    });

    expect(mocks.runPipeline).toHaveBeenCalledWith(expect.objectContaining({
      autonomous: false,
      sessionId: "session_1",
      agentCfg: expect.objectContaining({
        targetRoles: ["Backend Engineer"], targetLocations: ["Berlin"], minMatchScore: 85,
        dailyLimit: 4, autoApply: true, requireApproval: false,
      }),
    }));
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("records a failed session when the user has not configured the Agent", async () => {
    mocks.findConfig.mockResolvedValue(null);
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: true,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.record).toHaveBeenCalledWith("error", expect.objectContaining({ message: expect.stringContaining("not configured") }));
    expect(mocks.finalize).toHaveBeenCalledWith({ status: "failed", report: null });
  });

  it("keeps a user-cancelled execution cancelled when the pipeline returns late", async () => {
    mocks.executionUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toBeNull();

    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("keeps a completed run visible for review when application packages are pending", async () => {
    mocks.runPipeline.mockResolvedValue({ processed: 2, queued: 0, applied: 0, pending: 2, skipped: 0, failed: 0, durationMs: 10 });
    const { runAgentPipeline } = await import("./run-service");

    await expect(runAgentPipeline({
      userId: "user_1", autonomous: false,
      aiConfig: { provider: "minimax", model: "MiniMax-M3", apiKey: "key" },
    })).resolves.toMatchObject({ pending: 2 });

    expect(mocks.pause).toHaveBeenCalledWith(expect.stringContaining("2 application packages"), "reviewer");
    expect(mocks.finalize).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});
