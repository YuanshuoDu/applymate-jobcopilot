import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runTurnJob: vi.fn().mockResolvedValue({ status: "completed", summary: "pipeline complete" }),
  createStore: vi.fn().mockReturnValue({}),
}))

vi.mock("../runtime/turns/turn-queue.js", () => ({ runTurnJob: mocks.runTurnJob }))
vi.mock("../runtime/turns/turn-engine-store.js", () => ({ createPgTurnEngineStore: mocks.createStore }))

import { runCanonicalAgentTurn } from "./agent-run-turn-executor.js"

describe("runCanonicalAgentTurn", () => {
  it("derives the legacy lease owner from turnId instead of executionId", async () => {
    await runCanonicalAgentTurn({
      data: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", executionId: "attacker-chosen" },
      attemptsMade: 3,
    }, {} as never)

    expect(mocks.runTurnJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { turnId: "turn-1", sessionId: "session-1", ownerId: "agent-run:turn-1" },
        attemptsMade: 3,
      }),
      expect.any(Object),
    )
  })
})
