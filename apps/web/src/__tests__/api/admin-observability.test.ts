import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

function request() {
  return new Request("http://localhost/api/admin/observability");
}

describe("GET /api/admin/observability", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryRaw.mockReset();
  });

  it("returns overall auto-apply health metrics and ATS breakdown", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          total: 100,
          successRate: 72.5,
          programmatic: 40,
          patternCache: 25,
          llm: 20,
          avgDurationMs: 38_000,
          captchaErrors: 5,
          last24h: 12,
          last24hSuccessRate: 75,
        },
      ])
      .mockResolvedValueOnce([
        { atsType: "greenhouse", count: 50, successRate: 80 },
        { atsType: "lever", count: 20, successRate: 65 },
      ]);

    const { GET } = await import("@/app/api/admin/observability/route");
    const res = await GET(request() as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      overall: {
        total: 100,
        successRate: 72.5,
        byFlowUsed: {
          programmatic: 40,
          patternCache: 25,
          llm: 20,
          unknown: 15,
        },
        avgDurationMs: 38_000,
        captchaRate: 5,
        captchaErrors: 5,
        last24h: {
          count: 12,
          successRate: 75,
        },
      },
      byAts: [
        { atsType: "greenhouse", count: 50, successRate: 80 },
        { atsType: "lever", count: 20, successRate: 65 },
      ],
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns zero-safe metrics when there are no apply results", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        {
          total: 0,
          successRate: null,
          programmatic: 0,
          patternCache: 0,
          llm: 0,
          avgDurationMs: null,
          captchaErrors: 0,
          last24h: 0,
          last24hSuccessRate: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const { GET } = await import("@/app/api/admin/observability/route");
    const res = await GET(request() as never);

    await expect(res.json()).resolves.toEqual({
      overall: {
        total: 0,
        successRate: 0,
        byFlowUsed: {
          programmatic: 0,
          patternCache: 0,
          llm: 0,
          unknown: 0,
        },
        avgDurationMs: 0,
        captchaRate: 0,
        captchaErrors: 0,
        last24h: {
          count: 0,
          successRate: 0,
        },
      },
      byAts: [],
    });
  });
});
