import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("./apply-results.js", () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { checkBudget, incrementBudget } from "./budget.js";

describe("budget", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("allows AI usage when used is below the monthly limit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 3, limit: 30 }] });

    const result = await checkBudget("user-1");

    expect(result).toEqual({ allowed: true, used: 3, limit: 30 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[0][0])).toContain("INSERT INTO ai_budgets");
    expect(String(mocks.query.mock.calls[1][0])).toContain("SELECT used");
  });

  it("blocks AI usage when used has reached the monthly limit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 30, limit: 30 }] });

    const result = await checkBudget("user-1");

    expect(result).toEqual({ allowed: false, used: 30, limit: 30 });
  });

  it("increments the monthly budget usage for the current user", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await incrementBudget("user-1");

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("UPDATE ai_budgets");
    expect(mocks.query.mock.calls[0][1]).toEqual(["user-1", expect.stringMatching(/^\d{4}-\d{2}$/)]);
  });
});
