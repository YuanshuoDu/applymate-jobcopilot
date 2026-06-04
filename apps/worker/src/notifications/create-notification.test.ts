import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../db/apply-results.js", () => ({
  getPool: vi.fn(() => ({ query: mocks.query })),
}));

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rowCount: 1 });
  });

  it("inserts an apply result notification row", async () => {
    const { createNotification } = await import("./create-notification.js");

    await createNotification("user-1", {
      type: "apply_submitted",
      title: "Example submitted",
      body: "Software Engineer",
      jobId: "job-1",
    });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notifications"),
      ["user-1", "apply_submitted", "Example submitted", "Software Engineer", "job-1"]
    );
  });
});
