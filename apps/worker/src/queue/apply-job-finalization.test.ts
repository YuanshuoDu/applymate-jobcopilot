import { describe, expect, it, vi } from "vitest";
import type { ApplyJobRunContext } from "./apply-job-runner.js";
import { createApplyJobFinalization } from "./apply-job-finalization.js";

describe("apply job finalization", () => {
  it("releases a held submission fence exactly once", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const context = {
      state: {
        activePageCloseRef: { current: null },
        activeSubmissionContextClose: null,
        activeSubmissionContextClosePromise: null,
        pendingSubmissionFence: { release },
        submissionFenceRelease: null,
        submissionFenceTimer: null,
        turnStopped: false,
        stopController: new AbortController(),
      },
    } as unknown as ApplyJobRunContext;
    const lifecycle = createApplyJobFinalization(context);

    await lifecycle.releaseSubmissionFence(true);
    await lifecycle.releaseSubmissionFence(false);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
    expect(context.state.pendingSubmissionFence).toBeNull();
  });
});
