import { describe, expect, it } from "vitest"

import { aggregateTokenAccounting } from "./context-snapshot-token-accounting.js"

describe("context snapshot token accounting", () => {
  it("aggregates and orders usage by stable profile key", () => {
    const result = aggregateTokenAccounting([
      { provider: "anthropic", model: "claude", profileId: "p-2", inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.2 },
      { provider: "minimax", model: "M3", profileId: "p-1", inputTokens: 5, outputTokens: 6, estimatedCostUsd: 0.123456789 },
      { provider: "anthropic", model: "claude", profileId: "p-2", inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.1 },
    ])
    expect(result.profiles.map((profile) => profile.profileKey)).toEqual(["p-1", "p-2"])
    expect(result.totalInputTokens).toBe(9)
    expect(result.totalOutputTokens).toBe(12)
    expect(result.totalCostUsd).toBe(0.42345679)
  })

  it("rejects conflicting provider or model metadata for one profile id", () => {
    expect(() => aggregateTokenAccounting([
      { provider: "minimax", model: "M3", profileId: "shared", inputTokens: 1, outputTokens: 0, estimatedCostUsd: 0 },
      { provider: "anthropic", model: "claude", profileId: "shared", inputTokens: 1, outputTokens: 0, estimatedCostUsd: 0 },
    ])).toThrow("conflicting provider/model")
  })

  it("rejects invalid token and cost values", () => {
    expect(() => aggregateTokenAccounting([{ provider: "minimax", model: "M3", inputTokens: -1, outputTokens: 0, estimatedCostUsd: 0 }])).toThrow("non-negative")
    expect(() => aggregateTokenAccounting([{ provider: "minimax", model: "M3", inputTokens: 0, outputTokens: 0, estimatedCostUsd: Number.POSITIVE_INFINITY }])).toThrow("finite")
  })
})
