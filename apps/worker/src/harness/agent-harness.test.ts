import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentHarness } from "./agent-harness.js";
import type { Page } from "playwright-core";

// Mock the shared LLM module
vi.mock("@jobcopilot/shared/llm", () => ({
  loadWorkerAiConfig: vi.fn().mockResolvedValue({
    provider: "minimax",
    model: "MiniMax-M3",
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
function mockPage(
  url: string = "https://jobs.example.com/apply",
  clickMaySubmit = false,
  fields = mockFields(),
): Page {
  return {
    url: () => url,
    evaluate: vi.fn().mockResolvedValue(fields),
    $eval: vi.fn().mockResolvedValue(clickMaySubmit),
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

  it("does not let the model fill a sensitive answer without a matching user confirmation", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"fill","selector":"#visa","value":"No","field":"visaSponsorship","reasoning":"answer"}'
    );
    const page = mockPage();
    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-5", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf",
    });

    expect(result.status).toBe("manual");
    expect(page.fill).not.toHaveBeenCalled();
  });

  it("uses the perceived field label when guarding sensitive answers", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"fill","selector":"#salary","value":"100000","field":"role","reasoning":"answer"}',
    );
    const page = mockPage("https://jobs.example.com/apply", false, [
      { selector: "#salary", type: "text", label: "Salary expectation", required: true, currentValue: "" },
    ]);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-5a", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf",
    });

    expect(result.status).toBe("manual");
    expect(page.fill).not.toHaveBeenCalled();
  });

  it("never lets the model choose an arbitrary upload path", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText)
      .mockResolvedValueOnce(
        '{"type":"upload","selector":"#resume","filePath":"/var/run/secrets/app.env","field":"resume","reasoning":"upload"}',
      )
      .mockResolvedValueOnce('{"type":"done","reasoning":"complete"}');
    const page = mockPage();

    await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-9", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/safe/resume.pdf",
    });

    expect(page.setInputFiles).toHaveBeenCalledWith("#resume", "/safe/resume.pdf");
    expect(page.setInputFiles).not.toHaveBeenCalledWith("#resume", "/var/run/secrets/app.env");
  });

  it("does not accept a final agent completion after submission authorization is revoked", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce('{"type":"done","reasoning":"Form submitted"}');
    const beforeSubmit = vi.fn().mockResolvedValue(false);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(mockPage(), {
      jobId: "job-6", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });

  it("does not execute a submit-like click after submission authorization is revoked", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"click","selector":"#submit","reasoning":"Submit the application"}'
    );
    const beforeSubmit = vi.fn().mockResolvedValue(false);
    const page = mockPage(undefined, true);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-7", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(page.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });

  it("does not execute an explicit submit after submission authorization is revoked", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"submit","selector":"#submit","reasoning":"Submit the application"}'
    );
    const beforeSubmit = vi.fn().mockResolvedValue(false);
    const page = mockPage();

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-7a", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(page.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });

  it("does not execute an unclassified click after submission authorization is revoked", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"click","selector":"#custom-control","reasoning":"Continue the application"}'
    );
    const beforeSubmit = vi.fn().mockResolvedValue(false);
    const page = mockPage(undefined, false);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-7b", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(page.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });

  it("does not report a success URL as submitted after authorization is revoked", async () => {
    const beforeSubmit = vi.fn().mockResolvedValue(false);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(
      mockPage("https://jobs.example.com/application/confirmation"),
      {
        jobId: "job-8", applyUrl: "https://jobs.example.com/apply", persona: {},
        jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", beforeSubmit,
      },
    );

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "manual" });
    expect(result.error).toContain("could not be confirmed");
  });

  it("does not execute submit-like clicks during a fill-only pass", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText).mockResolvedValueOnce(
      '{"type":"click","selector":"#continue","reasoning":"Advance the form"}',
    );
    const page = mockPage(undefined, true);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-8a", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", allowSubmit: false,
    });

    expect(page.click).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });

  it("keeps non-submit custom controls usable during a fill-only pass", async () => {
    const { callLlmText } = await import("@jobcopilot/shared/llm");
    vi.mocked(callLlmText)
      .mockResolvedValueOnce('{"type":"click","selector":"#country-combobox","reasoning":"Open the country picker"}')
      .mockResolvedValueOnce('{"type":"done","reasoning":"Ready for review"}');
    const page = mockPage(undefined, false);

    const result = await new AgentHarness({ userId: "user-1", maxTurns: 2, dryRun: false, mode: "dom" }).run(page, {
      jobId: "job-8b", applyUrl: "https://jobs.example.com/apply", persona: {},
      jobTitle: "Dev", jobCompany: "Inc", resumePath: "/r.pdf", allowSubmit: false,
    });

    expect(page.click).toHaveBeenCalledWith("#country-combobox");
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });
});
