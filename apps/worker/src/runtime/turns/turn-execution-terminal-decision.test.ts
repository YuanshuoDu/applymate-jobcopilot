import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { SCHEDULED_PIPELINE_COMPLETION, type TurnEngineCompletionGate } from "./turn-execution-types.js"
import { assertCompletionAllowed } from "./turn-execution-terminal-decision.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK } from "../subagents/scheduled-post-gate-contract.js"

describe("terminal decision routing", () => {
  it("keeps a post-Gate plan request in the active Root feedback path", async () => {
    const identity: TurnExecutionOptions["identity"] = { kind: "turn", taskId: "root-1", rootTaskId: "root-1",
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "lease-1",
      leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"), leaseVersion: 1 }
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "replan", candidateText: input.candidateText,
      feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK })
    const append = vi.fn(async (..._args: Parameters<TurnExecutionEventWriter["append"]>) => "event-1")
    const result = await assertCompletionAllowed({ identity, scope: { userId: "user-1" }, completionGate }, { append }, { id: "step-1", ordinal: 1 },
      new AbortController().signal, () => new Date("2026-01-01T00:00:00.000Z"), "candidate")

    expect(result).toEqual({ feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK })
    expect(append).toHaveBeenCalledWith("final.rejected", "step-1", null, expect.objectContaining({
      code: "scheduled_post_gate_plan_required", taskId: "root-1", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK,
    }), "final-rejected:step-1:scheduled-post-gate-plan-required")
  })
})
