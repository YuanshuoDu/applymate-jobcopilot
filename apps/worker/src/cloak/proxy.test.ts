import { afterEach, describe, expect, it, vi } from "vitest";

async function loadProxyModule() {
  vi.resetModules();
  return import("./proxy.js");
}

describe("getProxy", () => {
  afterEach(() => {
    delete process.env.CLOAK_PROXY_LIST;
    delete process.env.CLOAK_PROXY_URL;
  });

  it("returns null when no proxy env is configured", async () => {
    const { getProxy } = await loadProxyModule();

    expect(getProxy("user-1")).toBeNull();
  });

  it("returns CLOAK_PROXY_URL when a single proxy is configured", async () => {
    process.env.CLOAK_PROXY_URL = "http://proxy.example:8080";
    const { getProxy } = await loadProxyModule();

    expect(getProxy("user-1")).toBe("http://proxy.example:8080");
  });

  it("assigns users deterministically across CLOAK_PROXY_LIST", async () => {
    process.env.CLOAK_PROXY_LIST = "http://proxy-a:8080, http://proxy-b:8080";
    const { getProxy } = await loadProxyModule();

    const first = getProxy("user-1");
    expect(first).toBe(getProxy("user-1"));
    expect(["http://proxy-a:8080", "http://proxy-b:8080"]).toContain(first);
  });
});
