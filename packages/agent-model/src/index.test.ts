import { describe, expect, it } from "vitest"

import {
  AgentModelError,
  MODEL_SCHEMA_VERSION,
  ModelAdapterRegistry,
  createLegacyModelFacade,
} from "./index.js"

describe("agent-model public entrypoint", () => {
  it("exports the provider-neutral kernel surface", () => {
    expect(MODEL_SCHEMA_VERSION).toBe("agent-harness.v2")
    expect(ModelAdapterRegistry).toBeDefined()
    expect(createLegacyModelFacade).toBeDefined()
    expect(AgentModelError).toBeDefined()
  })
})
