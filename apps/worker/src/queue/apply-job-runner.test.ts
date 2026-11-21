import { describe, expect, it, vi } from "vitest";
import { createApplyJobProcessor } from "./apply-job-runner.js";

vi.mock("../rate-limit.js", () => ({ checkRateLimit: vi.fn() }));

describe("apply job runner", () => {
  it("keeps a stale fill payload as a no-op before queue or browser work", async () => {
    const isQueuePaused = vi.fn().mockResolvedValue(false);
    const processJob = createApplyJobProcessor({ isQueuePaused });
    const job = {
      id: "worker-stale",
      data: {
        applicationTaskId: "",
        operation: "fill",
        userId: "user",
        jobId: "job",
        applyUrl: "https://jobs.example/apply",
        personaId: "persona",
        resumePath: "/resume.pdf",
      },
    } as never;

    await expect(processJob(job)).resolves.toBeUndefined();
    expect(isQueuePaused).not.toHaveBeenCalled();
  });
});
