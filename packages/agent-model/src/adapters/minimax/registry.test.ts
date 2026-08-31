import { afterEach, describe, expect, it, vi } from "vitest"

import { createMiniMaxModelRegistry } from "./registry.js"

afterEach(() => vi.unstubAllEnvs())

describe("MiniMax model registry", () => {
  it("registers MiniMax-M3 as the platform default and resolves the platform key", () => {
    vi.stubEnv("MINIMAX_API_KEY", "platform-key")
    const registry = createMiniMaxModelRegistry()
    const adapter = registry.resolve({ provider: "minimax", model: "MiniMax-M3" })
    expect(registry.list()).toHaveLength(1)
    expect(adapter.profile).toMatchObject({ provider: "minimax", model: "MiniMax-M3" })
    expect(adapter).toMatchObject({ credentialSource: "platform" })
  })

  it("keeps BYOK resolution local to the MiniMax profile", () => {
    vi.stubEnv("MINIMAX_API_KEY", "platform-key")
    const registry = createMiniMaxModelRegistry({ apiKey: "user-key" })
    expect(registry.resolve({ provider: "minimax", model: "MiniMax-M3" })).toMatchObject({ credentialSource: "user" })
  })
})
