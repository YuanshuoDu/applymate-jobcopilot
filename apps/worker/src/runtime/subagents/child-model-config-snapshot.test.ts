import { describe, expect, it } from "vitest"
import type { AiConfig } from "@jobcopilot/shared/llm"
import { applyChildModelProfileSnapshot } from "./child-model-config-snapshot.js"

const base: AiConfig = { provider: "openai", model: "base-model", apiKey: "fixture-key" }

describe("child model profile snapshot", () => {
  it("applies string provider and non-empty model values without normalizing the model", () => {
    const result = applyChildModelProfileSnapshot(base, { provider: "minimax", model: " snapshot-model " })

    expect(result).toEqual({ ...base, provider: "minimax", model: " snapshot-model " })
    expect(base).toEqual({ provider: "openai", model: "base-model", apiKey: "fixture-key" })
  })

  it.each([null, [], "invalid", { provider: 4, model: "   " }])("preserves config values for unusable snapshot %j", snapshot => {
    expect(applyChildModelProfileSnapshot(base, snapshot)).toEqual(base)
  })
})