import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
  err: (message: string, status = 400) => new Response(JSON.stringify({ error: message }), { status }),
}));

vi.mock("@/lib/db", () => ({
  db: { job: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auto-apply", () => ({
  AutoApplyError: class AutoApplyError extends Error {},
  queueAutonomousApplication: vi.fn(),
}));

const request = () => new NextRequest("https://applymate.app/api/jobs/job-1/auto-apply", { method: "POST" });
const ctx = { params: Promise.resolve({ id: "job-1" }) };

describe("POST /api/jobs/[id]/auto-apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues an owned job for unattended submission", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);
    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({ id: "job-1", userId: "user-1", url: "https://jobs.example.com/apply" } as never);
    const { queueAutonomousApplication } = await import("@/lib/auto-apply");
    vi.mocked(queueAutonomousApplication).mockResolvedValue({ taskId: "task-1" });

    const response = await POST(request(), ctx);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ queued: true, taskId: "task-1" });
    expect(queueAutonomousApplication).toHaveBeenCalledWith({
      userId: "user-1",
      jobId: "job-1",
      applyUrl: "https://jobs.example.com/apply",
    });
  });

  it("keeps ownership checks", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);
    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({ id: "job-1", userId: "other-user" } as never);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(404);
  });
});
