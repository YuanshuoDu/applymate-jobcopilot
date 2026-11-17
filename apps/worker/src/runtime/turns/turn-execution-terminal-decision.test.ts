import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { SCHEDULED_PIPELINE_COMPLETION, SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME, type TurnEngineCompletionGate } from "./turn-execution-types.js"
import { assertCompletionAllowed, TASK_GRAPH_VERIFICATION_BLOCKER } from "./turn-execution-terminal-decision.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK } from "../subagents/scheduled-post-gate-contract.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY } from "./completion-recovery-context.js"

const identity: TurnExecutionOptions["identity"] = { kind: "turn", taskId: "root-1", rootTaskId: "root-1",
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "lease-1",
  leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"), leaseVersion: 1 }
const step = { id: "step-1", ordinal: 1 }
const now = () => new Date("2026-01-01T00:00:00.000Z")
const scope = { userId: "user-1" }

function eventWriter() {
  const append = vi.fn(async (..._args: Parameters<TurnExecutionEventWriter["append"]>) => "event-1")
  return { append, writer: { append } }
}

describe("terminal decision routing", () => {
  it("keeps a post-Gate plan request in the active Root feedback path", async () => {
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "replan", candidateText: input.candidateText,
      feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK })
    const { append, writer } = eventWriter()
    const result = await assertCompletionAllowed({ identity, scope, completionGate }, writer, step,
      new AbortController().signal, now, "candidate")

    expect(result).toEqual({ feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK,
      [SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY]: SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY })
    expect(append).toHaveBeenCalledWith("final.rejected", "step-1", null, expect.objectContaining({
      code: "scheduled_post_gate_plan_required", taskId: "root-1", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK,
    }), "final-rejected:step-1:scheduled-post-gate-plan-required")
  })

  it("marks only the validated existing-Audit resume replan path", async () => {
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: false, blocker: "child_tasks_pending", feedback: "Audit is still running" })
    completionGate[SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME] = async () => ({ status: "replan", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK })
    const { append, writer } = eventWriter()

    const result = await assertCompletionAllowed({ identity, scope, completionGate }, writer, step,
      new AbortController().signal, now, "candidate")

    expect(result).toEqual({ feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK,
      [SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY]: SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY })
    expect(append).toHaveBeenCalledWith("final.rejected", "step-1", null, expect.objectContaining({
      code: "scheduled_post_gate_plan_required", taskId: "root-1", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK,
    }), "final-rejected:step-1:scheduled-post-gate-plan-required")
  })

  it("does not add the marker to ordinary denials or normal scheduled completion", async () => {
    const ordinaryGate: TurnEngineCompletionGate = async () => ({
      ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: "ordinary TaskGraph verification feedback",
    })
    const ordinary = await assertCompletionAllowed({ identity, scope, completionGate: ordinaryGate }, eventWriter().writer, step,
      new AbortController().signal, now, "candidate")
    expect(ordinary).toMatchObject({ feedback: expect.not.stringContaining(SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK) })
    expect(ordinary && Reflect.get(ordinary, SCHEDULED_POST_GATE_PLAN_REQUIRED_RECOVERY)).toBeUndefined()

    const completedGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completedGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "completed", candidateText: input.candidateText })
    expect(await assertCompletionAllowed({ identity, scope, completionGate: completedGate }, eventWriter().writer, step,
      new AbortController().signal, now, "candidate")).toBeUndefined()
  })

  it("fails closed without a marker for malformed and throwing scheduled outcomes", async () => {
    const malformedGate: TurnEngineCompletionGate = async () => ({ ok: true })
    malformedGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "replan", candidateText: input.candidateText,
      feedback: "lookalike Post-Gate feedback" as never })
    const malformedWriter = eventWriter()
    await expect(assertCompletionAllowed({ identity, scope, completionGate: malformedGate }, malformedWriter.writer, step,
      new AbortController().signal, now, "candidate")).rejects.toMatchObject({ code: "invalid_output", message: "Scheduled pipeline completion returned an invalid disposition" })
    expect(malformedWriter.append).not.toHaveBeenCalled()

    const throwingGate: TurnEngineCompletionGate = async () => ({ ok: true })
    throwingGate[SCHEDULED_PIPELINE_COMPLETION] = async () => { throw new Error("scheduled completion failed") }
    const throwingWriter = eventWriter()
    await expect(assertCompletionAllowed({ identity, scope, completionGate: throwingGate }, throwingWriter.writer, step,
      new AbortController().signal, now, "candidate")).rejects.toMatchObject({ code: "invalid_output" })
    expect(throwingWriter.append).not.toHaveBeenCalled()
  })
})
