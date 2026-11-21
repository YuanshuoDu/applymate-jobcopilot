import { describe, expect, it, vi } from "vitest";
import { createNotification } from "../notifications/create-notification.js";
import { createApplyResultNotification } from "./apply-job-outcomes.js";

vi.mock("../notifications/create-notification.js", () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));

describe("application outcome notifications", () => {
  it("keeps status-specific notification type and title", async () => {
    await createApplyResultNotification({
      userId: "user",
      jobId: "job",
      jobTitle: "Engineer",
      jobCompany: "Acme",
      status: "failed",
    });

    expect(createNotification).toHaveBeenCalledWith("user", {
      type: "apply_failed",
      title: "Acme ❌",
      body: "Engineer",
      jobId: "job",
    });
  });
});
