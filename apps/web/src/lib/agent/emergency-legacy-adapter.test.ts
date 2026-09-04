import { describe, expect, it, vi } from "vitest"
import type { LegacyModelFacade, ModelAdapter, ModelCapabilityProfile } from "@jobcopilot/agent-model"
import {
  EMERGENCY_LEGACY_MODE,
  createEmergencyLegacyAdapter,
  isEmergencyLegacyModeEnabled,
  readEmergencyLegacyMode,
} from "./emergency-legacy-adapter"

const profile: ModelCapabilityProfile = {
  provider: "legacy-provider",
  model: "legacy-model",
  nativeTools: false,
  structuredOutput: false,
  streaming: true,
  continuationCursor: false,
  supportsParallelTools: false,
  supportsStreamingToolArgs: false,
  supportsReasoningSummary: false,
  supportsResponseContinuation: false,
  supportsProviderConversation: false,
  supportsBackgroundResponse: false,
  maxContextTokens: null,
  maxOutputTokens: null,
  costClass: "unknown",
}

function facade(adapter: ModelAdapter): LegacyModelFacade<unknown> {
  return {
    chat: vi.fn(),
    createAdapter: vi.fn().mockReturnValue(adapter),
  }
}

describe("emergency legacy adapter", () => {
  it("fails closed when the emergency flag is unset", () => {
    const createAdapter = vi.fn()

    expect(() => createEmergencyLegacyAdapter({
      facade: { chat: vi.fn(), createAdapter },
      config: {},
      profile,
      env: {},
    })).toThrow("is unset")
    expect(createAdapter).not.toHaveBeenCalled()
  })

  it("accepts only the exact true enablement value", () => {
    expect(readEmergencyLegacyMode({})).toEqual({ enabled: false, reason: "unset" })
    expect(readEmergencyLegacyMode({ [EMERGENCY_LEGACY_MODE]: "true" })).toEqual({ enabled: true, reason: "enabled", value: "true" })
    expect(readEmergencyLegacyMode({ [EMERGENCY_LEGACY_MODE]: "TRUE" })).toEqual({ enabled: false, reason: "invalid", value: "TRUE" })
    expect(isEmergencyLegacyModeEnabled({ [EMERGENCY_LEGACY_MODE]: "1" })).toBe(false)
  })

  it("returns the existing typed ModelAdapter contract when enabled", () => {
    const adapter = { id: "legacy", profile, stream: vi.fn() } as unknown as ModelAdapter
    const createAdapter = vi.fn().mockReturnValue(adapter)
    const result = createEmergencyLegacyAdapter({
      facade: { chat: vi.fn(), createAdapter },
      config: { apiKey: "test-only" },
      profile,
      env: { [EMERGENCY_LEGACY_MODE]: "true" },
    })

    expect(result).toBe(adapter)
    expect(createAdapter).toHaveBeenCalledWith({ apiKey: "test-only" }, profile, "emergency-legacy:legacy-provider:legacy-model")
  })

  it("rejects malformed enablement before touching the legacy facade", () => {
    const legacy = facade({ id: "unused", profile, stream: vi.fn() } as unknown as ModelAdapter)
    let error: unknown

    try {
      createEmergencyLegacyAdapter({
        facade: legacy,
        config: {},
        profile,
        env: { [EMERGENCY_LEGACY_MODE]: "yes" },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: "configuration_error", recoverable: false })
    expect(legacy.createAdapter).not.toHaveBeenCalled()
  })
})
