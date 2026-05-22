import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
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
    },
    $queryRaw: vi.fn(),
  },
}));

async function jsonBody(res: Response) {
  return res.json();
}

describe("GET /api/jobs/[id]/apply-results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns results array for valid job", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      userId: "user-1",
    } as never);

    vi.mocked(db.$queryRaw).mockResolvedValue([
      { id: 1, status: "submitted", mode: "unattended", atsType: "greenhouse", flowUsed: "programmatic", error: null, durationMs: 5000, createdAt: "2026-05-22T00:00:00Z" },
    ]);

    const res = await GET(new NextRequest("https://applymate.app/api/jobs/job-1/apply-results"), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    const body = await jsonBody(res);
    expect(body.results).toBeDefined();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe("submitted");
  });

  it("returns empty results array when no results exist", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      userId: "user-1",
    } as never);

    vi.mocked(db.$queryRaw).mockResolvedValue([]);

    const res = await GET(new NextRequest("https://applymate.app/api/jobs/job-1/apply-results"), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    const body = await jsonBody(res);
    expect(body.results).toEqual([]);
  });

  it("returns 404 for wrong user", async () => {
    const { requireAuth } = await import("@/lib/api-helpers");
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user-1" } as never);

    const { db } = await import("@/lib/db");
    vi.mocked(db.job.findUnique).mockResolvedValue({
      userId: "user-2",
    } as never);

    const res = await GET(new NextRequest("https://applymate.app/api/jobs/job-1/apply-results"), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(404);
  });
});
