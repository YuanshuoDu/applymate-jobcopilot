import { describe, it, expect, vi } from "vitest";
import { AgentHarness } from "./agent-harness.js";
import type { Page } from "playwright-core";

// ── Helpers ──

/** Mock perceived fields */
const mockFields = (): Array<{
  selector: string;
  type: string;
  label: string;
  required: boolean;
  currentValue: string;
  options?: string[];
}> => [
  { selector: "#name", type: "text", label: "Full Name", required: true, currentValue: "" },
  { selector: "#email", type: "email", label: "Email", required: true, currentValue: "" },
  { selector: "#resume", type: "file", label: "Upload Resume", required: true, currentValue: "" },
];

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

/** Mock LLM that returns a sequence of actions */
function mockCallLLM(responses: string[]) {
  let idx = 0;
  return vi.fn<() => Promise<string>>().mockImplementation(async () => {
    const r = responses[idx] ?? '{"type": "done"}';
    idx++;
    return r;
  });
}

// ── Tests ──

describe("AgentHarness", () => {
  it("happy path: 3 turns → done", async () => {
    const callLLM = mockCallLLM([
      '{"type": "fill", "selector": "#name", "value": "John Doe", "reasoning": "Fill name"}',
      '{"type": "click", "selector": "#next", "reasoning": "Click next"}',
      '{"type": "done", "reasoning": "Form submitted"}',
    ]);

    const harness = new AgentHarness(
      { userId: "user-1", maxTurns: 30, dryRun: false, mode: "dom" },
      callLLM
    );

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
  });

  it("maxTurns exceeded → failed result", async () => {
    const callLLM = mockCallLLM(
      Array(10).fill('{"type": "fill", "selector": "#field", "value": "data", "reasoning": "filling"}')
    );

    const harness = new AgentHarness(
      { userId: "user-1", maxTurns: 3, dryRun: false, mode: "dom" },
      callLLM
    );

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
    const callLLM = mockCallLLM([
      '{"type": "fill", "selector": "#name", "value": "Test", "reasoning": "Fill name"}',
      '{"type": "done", "reasoning": "Done"}',
    ]);

    const harness = new AgentHarness(
      { userId: "user-1", maxTurns: 10, dryRun: true, mode: "dom" },
      callLLM
    );

    const page = mockPage();
    await harness.run(page, {
      jobId: "job-3",
      applyUrl: "https://jobs.example.com/apply",
      persona: {},
      jobTitle: "Dev",
      jobCompany: "Inc",
      resumePath: "/r.pdf",
    });

    // fill should NOT be called in dry-run
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
  });

  it("manual escalation: LLM returns 'manual' → correct result type", async () => {
    const callLLM = mockCallLLM([
      '{"type": "manual", "reasoning": "CAPTCHA detected, cannot proceed"}',
    ]);

    const harness = new AgentHarness(
      { userId: "user-1", maxTurns: 30, dryRun: false, mode: "dom" },
      callLLM
    );

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
