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

    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: {} }] });
    await createNotification("user-1", {
      type: "apply_submitted",
      title: "Example submitted",
      body: "Software Engineer",
      jobId: "job-1",
    });

    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO notifications"),
      ["user-1", "apply_submitted", "Example submitted", "Software Engineer", "job-1"]
    );
  });

  it("does not insert an apply notification when the user disabled it", async () => {
    const { createNotification } = await import("./create-notification.js");
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: { notificationPreferences: { apply: false } } }] });

    await createNotification("user-1", {
      type: "apply_submitted",
      title: "Example submitted",
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).not.toContain("INSERT INTO notifications");
  });

  it("uses the apply preference for failed application attempts", async () => {
    const { createNotification } = await import("./create-notification.js");
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: { notificationPreferences: { apply: false, reject: true } } }] });

    await createNotification("user-1", {
      type: "apply_failed",
      title: "Example failed",
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).not.toContain("INSERT INTO notifications");
  });

  it("inserts a distinct blocked notification row", async () => {
    const { createNotification } = await import("./create-notification.js");

    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: {} }] });
    await createNotification("user-1", {
      type: "apply_blocked",
      title: "Example submission blocked",
      body: "Engineer",
      jobId: "job-1",
    });

    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO notifications"),
      ["user-1", "apply_blocked", "Example submission blocked", "Engineer", "job-1"],
    );
  });
});
