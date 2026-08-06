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
      .mockResolvedValueOnce({ rows: [{ enabled: true, configured: true, configured_limit: 100 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 3, limit: 100 }] });

    const result = await checkBudget("user-1");

    expect(result).toEqual({ allowed: true, used: 3, limit: 100 });
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(String(mocks.query.mock.calls[0][0])).toContain("PlanEntitlement");
    expect(String(mocks.query.mock.calls[1][0])).toContain("INSERT INTO ai_budgets");
    expect(String(mocks.query.mock.calls[3][0])).toContain("SELECT used");
  });

  it("blocks AI usage when used has reached the monthly limit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ enabled: true, configured: true, configured_limit: 25 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 25, limit: 25 }] });

    const result = await checkBudget("user-1");

    expect(result).toEqual({ allowed: false, used: 25, limit: 25 });
  });

  it("fails open to the legacy row limit while plan tables are unavailable", async () => {
    mocks.query
      .mockRejectedValueOnce(new Error('relation "PlanEntitlement" does not exist'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 3, limit: 30 }] });

    await expect(checkBudget("user-1")).resolves.toEqual({ allowed: true, used: 3, limit: 30 });
  });

  it("blocks a disabled AI entitlement before invoking the model", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ enabled: false, configured: true, configured_limit: 100 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 0, limit: 100 }] });

    await expect(checkBudget("user-1")).resolves.toEqual({ allowed: false, used: 0, limit: 100 });
  });

  it("increments the monthly budget usage for the current user", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await incrementBudget("user-1");

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("UPDATE ai_budgets");
    expect(mocks.query.mock.calls[0][1]).toEqual(["user-1", expect.stringMatching(/^\d{4}-\d{2}$/)]);
  });
});
