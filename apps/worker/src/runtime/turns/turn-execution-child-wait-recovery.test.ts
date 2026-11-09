import { describe, expect, it, vi } from "vitest"

import type { ChildWaitClaimRecovery, ChildWaitOrphanRecovery } from "../subagents/child-durable-wait-replay.js"
import { childWaitClaimEventKey } from "../subagents/child-durable-wait-replay.js"
import { recoverChildWaitClaim, recoverChildWaitOrphan } from "./turn-execution-child-wait-recovery.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-options.js"
import type { TurnExecutionIdentity, TurnExecutionStore } from "./turn-execution-types.js"

function fixture(status: "streaming" | "completed" = "streaming") {
  const owner: TurnExecutionIdentity = { kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1",
    rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2, leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") }
  const events: Array<{ id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; idempotencyKey: string }> = []
  const updateStep = vi.fn(async () => undefined)
  const store: TurnExecutionStore = {
    startStep: async input => ({ id: input.stepId, ordinal: input.ordinal }), updateStep,
    createItem: async input => ({ id: input.itemId, revision: 0 }),
    updateItem: async input => ({ id: input.itemId, revision: input.expectedRevision + 1 }),
    appendEvent: async input => { events.push({ id: input.id, type: input.type, itemId: input.itemId, correlationId: input.correlationId,
      causationId: input.causationId, idempotencyKey: input.idempotencyKey }); return { id: input.id } },
  }
  const options = { identity: owner, scope: { userId: owner.userId }, goal: "Resume wait", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    contextBuilder: { build: async () => { throw new Error("not used") } }, store, model: {} as never, tools: [], executeTool: async () => {
      throw new Error("dispatcher_must_not_run")
    }, signal: new AbortController().signal, idFactory: (prefix: string) => prefix } as unknown as TurnExecutionOptions
  const input = { idempotencyKey: "wait-key", taskIds: ["leaf-1"], mode: "all", timeoutMs: 5_000 }
  const stepId = "task:child-1:step:5:attempt:2", callId = "provider-call"
  const callItemId = `task:child-1:item:tool-call:${callId}:attempt:2`
  const resultItemId = `task:child-1:item:tool-result:${callId}:attempt:2`
  const recovery: ChildWaitOrphanRecovery = { owner: { id: "child-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, attemptCount: 2 }, stepId, stepOrdinal: 5, stepStatus: status,
    sourceWaitCallId: "old-wait-call", sourceInput: input, call: { id: callId, name: "wait_subagents", arguments: input },
    callItem: { id: callItemId, revision: status === "completed" ? 1 : 0, status: status === "completed" ? "completed" : "started" },
    callStartedEventId: "item-started-event", modelUsage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 },
    output: { waitId: "wait-1", status: "ready" } }
  const writer = new TurnExecutionEventWriter(options)
  return { options, events, updateStep, recovery, writer, input, callItemId, resultItemId }
}

describe("turn execution child wait recovery", () => {
  it("claims and completes the original orphan call, closes its step, and carries usage once", async () => {
    const state = fixture()
    const result = await recoverChildWaitOrphan(state.options, state.writer, state.recovery, () => new Date("2026-10-29T10:00:00.000Z"))

    expect(result.id).toBe("tool-result:provider-call")
    expect(result.content).toMatchObject({ toolCallId: "provider-call", input: state.input, status: "completed", output: state.recovery.output })
    expect(state.updateStep).toHaveBeenCalledWith(expect.objectContaining({ identity: state.options.identity, stepId: state.recovery.stepId,
      status: "completed", inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 }))
    expect(state.events.map(event => event.type)).toEqual([
      "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed", "step.completed",
    ])
    const claim = state.events[0]!
    expect(claim).toMatchObject({ itemId: state.callItemId, correlationId: "provider-call", causationId: "item-started-event",
      idempotencyKey: `task:child-1:event:${childWaitClaimEventKey(2, state.recovery.stepId)}` })
    expect(state.events.at(-1)).toMatchObject({ correlationId: state.recovery.stepId, causationId: state.events.at(-2)!.id,
      idempotencyKey: `task:child-1:event:step-completed:${state.recovery.stepId}` })
  })

  it("returns the completed claim observation without rewriting its durable lifecycle", async () => {
    const state = fixture("completed")
    const recovery: ChildWaitClaimRecovery = { ...state.recovery, claimEventId: "claim-event",
      resultItem: { id: state.resultItemId, revision: 1, status: "completed" } }
    const result = await recoverChildWaitClaim(state.options, state.writer, recovery, () => new Date("2026-10-29T10:00:00.000Z"))

    expect(result).toEqual({ id: "tool-result:provider-call", content: expect.objectContaining({ toolCallId: "provider-call",
      toolName: "wait_subagents", input: state.input, status: "completed", output: recovery.output, errorCode: null }) })
    expect(state.updateStep).not.toHaveBeenCalled()
    expect(state.events).toEqual([])
  })

  it.each([
    ["missing result item", undefined],
    ["started result item", { id: "result-item", revision: 0, status: "started" as const }],
    ["wrong result revision", { id: "result-item", revision: 2, status: "completed" as const }],
  ])("rejects completed recovery with %s without writing", async (_label, resultItem) => {
    const state = fixture("completed")
    const recovery: ChildWaitClaimRecovery = { ...state.recovery, claimEventId: "claim-event",
      ...(resultItem ? { resultItem } : {}) }

    await expect(recoverChildWaitClaim(state.options, state.writer, recovery, () => new Date()))
      .rejects.toThrow("child_resume_wait_tool_call_conflict")
    expect(state.events).toEqual([])
    expect(state.updateStep).not.toHaveBeenCalled()
  })

  it("keeps the streaming claim recovery lifecycle and closes its step", async () => {
    const state = fixture()
    const recovery: ChildWaitClaimRecovery = { ...state.recovery, claimEventId: "claim-event" }
    const result = await recoverChildWaitClaim(state.options, state.writer, recovery, () => new Date("2026-10-29T10:00:00.000Z"))

    expect(result.content).toMatchObject({ toolCallId: "provider-call", status: "completed", output: recovery.output })
    expect(state.updateStep).toHaveBeenCalledWith(expect.objectContaining({ stepId: recovery.stepId, status: "completed" }))
    expect(state.events.map(event => event.type)).toEqual(["item.completed", "tool_call.completed", "item.started", "item.completed", "step.completed"])
  })

  it("rejects a stale owner before claiming or updating any state", async () => {
    const state = fixture()
    const stale = { ...state.recovery, owner: { ...state.recovery.owner, ownerId: "old-worker" } }
    await expect(recoverChildWaitOrphan(state.options, state.writer, stale, () => new Date())).rejects.toThrow("child_wait_claim_recovery_owner_mismatch")
    expect(state.events).toEqual([])
    expect(state.updateStep).not.toHaveBeenCalled()
  })
})
