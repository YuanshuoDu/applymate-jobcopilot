import { describe, expect, it } from "vitest"

import { agentForkTurnSelect, agentTurnProjectionSelect } from "./turn-select"

describe("AgentTurn persistence projections", () => {
  it("selects only the public projection fields needed by mapTurn", () => {
    expect(Object.keys(agentTurnProjectionSelect).sort()).toEqual([
      "createdAt", "id", "revision", "sessionId", "source", "status", "updatedAt", "userId",
    ])
    expect(agentTurnProjectionSelect).not.toHaveProperty("nativeSemanticProgressMode")
  })

  it("selects only fields the fork copier uses", () => {
    expect(Object.keys(agentForkTurnSelect).sort()).toEqual([
      "completedAt", "durationMs", "error", "finalResponse", "id", "input", "inputTokens",
      "modelProfileSnapshot", "outputTokens", "source", "startedAt", "status", "estimatedCostUsd",
    ].sort())
    expect(agentForkTurnSelect).not.toHaveProperty("nativeSemanticProgressMode")
  })
})
