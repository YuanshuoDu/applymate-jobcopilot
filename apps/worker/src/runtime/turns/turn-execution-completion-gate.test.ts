import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertCompletionAllowed } from "./turn-execution-completion-gate.js"

type GateOptions = Pick<TurnExecutionOptions, "identity" | "scope" | "completionGate">
type GateWriter = Pick<TurnExecutionEventWriter, "append">

const identity: TurnExecutionOptions["identity"] = {
  kind: "turn",
  taskId: "task-1",
  rootTaskId: "root-1",
  userId: "user-1",
  sessionId: "session-1",
  turnId: "turn-1",
  ownerId: "owner-1",
  leaseExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
  leaseVersion: 1,
}
const step: TurnEngineStep = { id: "step-1", ordinal: 0 }
const nowValue = new Date("2026-09-24T12:00:00.000Z")

function gateOptions(completionGate: NonNullable<TurnExecutionOptions["completionGate"]>): GateOptions {
  return { identity, scope: { userId: identity.userId }, completionGate }
}

function gateWriter(): GateWriter {
  return { append: vi.fn(async (..._args: Parameters<GateWriter["append"]>) => "event-1") }
}

describe("assertCompletionAllowed", () => {
  it("allows a successful decision without writing a rejection event", async () => {
    const completionGate = vi.fn(async () => ({ ok: true as const }))
    const writer = gateWriter()
    const signal = new AbortController().signal

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, signal, () => nowValue)).resolves.toBeUndefined()

    expect(completionGate).toHaveBeenCalledWith({ identity, scope: { userId: identity.userId }, rootTaskId: identity.rootTaskId, stepId: step.id, signal, now: nowValue })
    expect(writer.append).not.toHaveBeenCalled()
  })

  it("writes the blocker event and rejects a denied decision", async () => {
    const completionGate = vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child work is still running" }))
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ code: "business_precondition_failed", message: "child_tasks_pending" })

    expect(writer.append).toHaveBeenCalledWith(
      "final.rejected", step.id, null,
      { code: "business_precondition_failed", blocker: "child_tasks_pending", feedback: "Child work is still running", taskId: identity.taskId },
      `final-rejected:${step.id}`,
    )
  })

  it("fails closed on a malformed decision", async () => {
    const completionGate = vi.fn(async () => ({ ok: "yes" } as unknown as Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>))
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ code: "invalid_output", message: "Completion gate returned an invalid decision" })
    expect(writer.append).not.toHaveBeenCalled()
  })

  it("fails closed when the gate throws", async () => {
    const completionGate = vi.fn(async () => { throw new Error("store unavailable") })
    const writer = gateWriter()

    await expect(assertCompletionAllowed(gateOptions(completionGate), writer, step, new AbortController().signal, () => nowValue))
      .rejects.toMatchObject({ name: "TurnEngineError", code: "invalid_output", message: "Completion gate failed closed" })
    expect(writer.append).not.toHaveBeenCalled()
  })
})
