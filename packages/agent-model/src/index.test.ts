import { describe, expect, it } from "vitest"

import {
  AgentModelError,
  MAX_MODEL_REROUTES,
  MAX_REPAIR_ATTEMPTS,
  MODEL_SCHEMA_VERSION,
  ModelAdapterRegistry,
  NextStepSchema,
  createLegacyModelFacade,
} from "./index.js"

describe("agent-model public entrypoint", () => {
  it("exports the provider-neutral kernel surface", () => {
    expect(MODEL_SCHEMA_VERSION).toBe("agent-harness.v2")
    expect(ModelAdapterRegistry).toBeDefined()
    expect(createLegacyModelFacade).toBeDefined()
    expect(AgentModelError).toBeDefined()
    expect(MAX_REPAIR_ATTEMPTS).toBe(1)
    expect(MAX_MODEL_REROUTES).toBe(2)
    expect(NextStepSchema.$id).toBe("agent.model.next-step")
  })
})
