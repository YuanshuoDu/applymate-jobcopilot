import { afterEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  getProxy: vi.fn(),
}));

vi.mock("cloakbrowser", () => ({
  launchPersistentContext: mocks.launchPersistentContext,
}));

vi.mock("./proxy.js", () => ({
  getProxy: mocks.getProxy,
}));

describe("pool (unit — mock cloakbrowser)", () => {
  afterEach(async () => {
    const mod = await import("./pool.js");
    await mod.closeAllSlots();
    vi.clearAllMocks();
  });

  it("pool module exports expected symbols", async () => {
    const mod = await import("./pool.js");
    expect(typeof mod.withCloakContext).toBe("function");
    expect(typeof mod.closeAllSlots).toBe("function");
  });

  it("withCloakContext propagates launch errors", async () => {
    mocks.launchPersistentContext.mockRejectedValueOnce(new Error("Mock cloakbrowser — unit test"));
    const { withCloakContext } = await import("./pool.js");
    await expect(
      withCloakContext("test-user", async () => {})
    ).rejects.toThrow(/Mock cloakbrowser|CloakBrowser pool exhausted/);
  });

  it("passes a configured proxy to launchPersistentContext", async () => {
    mocks.getProxy.mockReturnValueOnce("http://proxy.example:8080");
    const fakePage = { close: vi.fn().mockResolvedValue(undefined) };
    const fakeContext = {
      browser: () => ({ isConnected: () => true }),
      newPage: vi.fn().mockResolvedValue(fakePage),
      storageState: vi.fn().mockResolvedValue({ cookies: [] }),
      close: vi.fn().mockResolvedValue(undefined),
      addCookies: vi.fn().mockResolvedValue(undefined),
    };
    mocks.launchPersistentContext.mockResolvedValueOnce(fakeContext);

    const { withCloakContext } = await import("./pool.js");
    await withCloakContext("proxy-user", async () => {});

    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { server: "http://proxy.example:8080" },
      })
    );
  });
});
