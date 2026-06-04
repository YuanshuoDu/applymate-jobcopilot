import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("./apply-results.js", () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { findFormPattern, upsertFormPattern } from "./form-patterns.js";

describe("form-patterns", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("upserts a form pattern with serialized field mapping", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await upsertFormPattern({
      atsHost: "jobs.example.com",
      urlPattern: "/apply",
      fieldMapping: { "#name": "fullName", "#email": "email" },
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("INSERT INTO form_patterns");
    expect(mocks.query.mock.calls[0][1]).toEqual([
      expect.any(String),
      "jobs.example.com",
      "/apply",
      JSON.stringify({ "#name": "fullName", "#email": "email" }),
    ]);
  });

  it("finds and normalizes an existing form pattern", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "pattern-1",
          ats_host: "jobs.example.com",
          url_pattern: "/apply",
          field_mapping: '{"#name":"fullName"}',
          success_count: 4,
          failure_count: 1,
          last_success_at: "2026-06-04T00:00:00.000Z",
        },
      ],
    });

    const result = await findFormPattern("jobs.example.com", "/apply");

    expect(result).toEqual({
      id: "pattern-1",
      atsHost: "jobs.example.com",
      urlPattern: "/apply",
      fieldMapping: { "#name": "fullName" },
      successCount: 4,
      failureCount: 1,
      lastSuccessAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("returns null when no form pattern exists", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(findFormPattern("jobs.example.com", "/missing")).resolves.toBeNull();
  });
});
