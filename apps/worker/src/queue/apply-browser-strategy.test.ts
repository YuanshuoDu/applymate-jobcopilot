import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runApplyBrowserStrategy } from "./apply-browser-strategy.js";

vi.mock("../flows/greenhouse-flow.js", () => ({ runGreenhouseFlow: vi.fn() }));

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
});
