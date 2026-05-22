import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";

// Mock auth helpers
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((v: unknown) => v instanceof Response),
  ok: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  err: (message: string, status = 400) => new Response(JSON.stringify({ error: message }), { status }),
}));

// Mock DB
vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock apply queue client
vi.mock("@/lib/apply-queue-client", () => ({
  enqueueApplyTask: vi.fn(),
}));

// Mock rate limiter
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

function mockReq(body?: unknown): NextRequest {
  return new NextRequest("https://applymate.app/api/jobs/abc/auto-apply", {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function jsonBody(res: Response) {
  return res.json();
}

describe("POST /api/jobs/[id]/auto-apply", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: rate limit passes
    const { checkRateLimit } = vi.mocked(await import("@/lib/rate-limit"));
    checkRateLimit.mockReturnValue({ ok: true });
  });

  it("happy path: returns 200 + queued:true", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      url: "https://jobs.example.com/apply",
      status: "saved",
    } as never);

    const { enqueueApplyTask } = await import("@/lib/apply-queue-client");
    vi.mocked(enqueueApplyTask).mockResolvedValue("bull-task-123");

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    const body = await jsonBody(res);
    expect(body.queued).toBe(true);
    expect(body.taskId).toBe("bull-task-123");
  });

  it("rate limit exceeded returns 429", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { checkRateLimit } = await import("@/lib/rate-limit");
    vi.mocked(checkRateLimit).mockReturnValue({ ok: false, retryAfter: 3600 });

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(429);

    const body = await jsonBody(res);
    expect(body.error).toContain("Rate limit exceeded");
  });

  it("rate limit key is per-user (different users tracked independently)", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-2" } as never);

    const { checkRateLimit } = await import("@/lib/rate-limit");
    // user-2 is NOT rate-limited
    vi.mocked(checkRateLimit).mockReturnValue({ ok: true });

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-2",
      url: "https://jobs.example.com/apply",
      status: "saved",
    } as never);

    const { enqueueApplyTask } = await import("@/lib/apply-queue-client");
    vi.mocked(enqueueApplyTask).mockResolvedValue("bull-task-456");

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    // Verify rate limit was checked with user-2's key
    expect(checkRateLimit).toHaveBeenCalledWith("auto-apply:user-2", 10, 3_600_000);
  });

  it("job without URL returns 400", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      url: null,
      status: "saved",
    } as never);

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(400);
  });

  it("job owned by different user returns 404", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-2",
      url: "https://jobs.example.com/apply",
      status: "saved",
    } as never);

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(404);
  });

  it("dryRun flag passed through", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      url: "https://jobs.example.com/apply",
      status: "saved",
    } as never);

    const { enqueueApplyTask } = await import("@/lib/apply-queue-client");
    vi.mocked(enqueueApplyTask).mockResolvedValue("bull-task-dry");

    const res = await POST(mockReq({ dryRun: true }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    expect(enqueueApplyTask).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });

  it("returns 409 when job is already applied", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      url: "https://jobs.example.com/apply",
      status: "applied",
    } as never);

    const res = await POST(mockReq(), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(409);
  });
});
