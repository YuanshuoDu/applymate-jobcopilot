import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentHarness } from "./agent-harness.js";
import type { Page } from "playwright-core";

// Mock the shared LLM module
vi.mock("@jobcopilot/shared/llm", () => ({
  loadWorkerAiConfig: vi.fn().mockResolvedValue({
    provider: "minimax",
    model: "MiniMax-M2.7",
  }),
  callLlmText: vi.fn(),
}));

/** Mock perceived fields */
function mockFields() {
  return [
    { selector: "#name", type: "text" as const, label: "Full Name", required: true, currentValue: "" },
    { selector: "#email", type: "email" as const, label: "Email", required: true, currentValue: "" },
    { selector: "#resume", type: "file" as const, label: "Upload Resume", required: true, currentValue: "" },
  ];
}

/** Create a mock Page */
function mockPage(url: string = "https://jobs.example.com/apply"): Page {
  return {
    url: () => url,
    evaluate: vi.fn().mockResolvedValue(mockFields()),
    focus: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("AgentHarness", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-mock fields (vi.clearAllMocks clears evaluate return)
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockReset();
  });

  it("happy path: 3 turns → done", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText)
      .mockResolvedValueOnce('{"type": "fill", "selector": "#name", "value": "John Doe", "field": "fullName", "reasoning": "Fill name"}')
      .mockResolvedValueOnce('{"type": "click", "selector": "#next", "reasoning": "Click next"}')
      .mockResolvedValueOnce('{"type": "done", "reasoning": "Form submitted"}');

    const harness = new AgentHarness({
      userId: "user-1", maxTurns: 30, dryRun: false, mode: "dom",
    });

    const page = mockPage();
    const result = await harness.run(page, {
      jobId: "job-1",
      applyUrl: "https://jobs.example.com/apply",
      persona: { fullName: "John Doe", email: "john@example.com" },
      jobTitle: "Software Engineer",
      jobCompany: "Acme Corp",
      resumePath: "/resume.pdf",
    });

    expect(result.status).toBe("submitted");
    expect(result.error).toBeNull();
    expect(result.fieldMappings).toEqual({ "#name": "fullName" });
  });

  it("maxTurns exceeded → failed result", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValue(
      '{"type": "fill", "selector": "#field", "value": "data", "reasoning": "filling"}'
    );

    const harness = new AgentHarness({
      userId: "user-1", maxTurns: 3, dryRun: false, mode: "dom",
    });

    const page = mockPage();
    const result = await harness.run(page, {
      jobId: "job-2",
      applyUrl: "https://jobs.example.com/apply",
      persona: {},
      jobTitle: "Engineer",
      jobCompany: "Corp",
      resumePath: "/r.pdf",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Max turns");
  });

  it("dry-run: fill action logged, page.fill NOT called", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText)
      .mockResolvedValueOnce('{"type": "fill", "selector": "#name", "value": "Test", "reasoning": "Fill name"}')
      .mockResolvedValueOnce('{"type": "done", "reasoning": "Done"}');

    const harness = new AgentHarness({
      userId: "user-1", maxTurns: 10, dryRun: true, mode: "dom",
    });

    const page = mockPage();
    await harness.run(page, {
      jobId: "job-3",
      applyUrl: "https://jobs.example.com/apply",
      persona: {},
      jobTitle: "Dev",
      jobCompany: "Inc",
      resumePath: "/r.pdf",
    });

    expect(page.fill).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
  });

  it("manual escalation: LLM returns 'manual' → correct result type", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type": "manual", "reasoning": "CAPTCHA detected, cannot proceed"}'
    );

    const harness = new AgentHarness({
      userId: "user-1", maxTurns: 30, dryRun: false, mode: "dom",
    });

    const page = mockPage();
    const result = await harness.run(page, {
      jobId: "job-4",
      applyUrl: "https://jobs.example.com/apply",
      persona: {},
      jobTitle: "Dev",
      jobCompany: "Inc",
      resumePath: "/r.pdf",
    });

    expect(result.status).toBe("manual");
    expect(result.error).toContain("CAPTCHA");
  });
});
