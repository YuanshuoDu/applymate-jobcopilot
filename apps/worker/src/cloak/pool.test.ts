import { describe, it, expect, vi } from "vitest";

vi.mock("cloakbrowser", () => ({
  launchPersistentContext: vi.fn().mockRejectedValue(new Error("Mock cloakbrowser — unit test")),
}));

describe("pool (unit — mock cloakbrowser)", () => {
  it("pool module exports expected symbols", async () => {
    const mod = await import("./pool.js");
    expect(typeof mod.withCloakContext).toBe("function");
    expect(typeof mod.closeAllSlots).toBe("function");
  });

  it("withCloakContext propagates launch errors", async () => {
    const { withCloakContext } = await import("./pool.js");
    await expect(
      withCloakContext("test-user", async () => {})
    ).rejects.toThrow(/Mock cloakbrowser|CloakBrowser pool exhausted/);
  });
});
