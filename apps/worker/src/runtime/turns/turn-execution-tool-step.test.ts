import { describe, expect, it, vi } from "vitest"
import { createTurnBudgetLedger } from "../budget.js"
import type { TurnExecutionOptions } from "./turn-execution-options.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnEngineToolResult } from "./turn-engine-types.js"
import { executeTurnExecutionToolStep } from "./turn-execution-tool-step.js"

describe("turn execution tool step closure", () => {
  it("uses the ordinary wait tool result, accounts its budget, and closes the waiting step once", async () => {
    const identity = { kind: "task" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "parent-1",
      rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 1, leaseExpiresAt: new Date("2026-11-13T12:00:00Z") }
    const childId = "subagent-00000000-0000-4000-8000-000000000001"
    const waitOutput = {
      waitId: "00000000-0000-4000-8000-000000000002", status: "waiting", taskIds: [childId],
      deadlineAt: "2026-11-13T12:00:30.000Z", matchedTaskIds: [],
      tasks: [{ taskId: childId, status: "running", role: "scout", result: null, failureReason: null }],
    }
    const events: string[] = [], stepUpdates: unknown[] = [], createdItems: string[] = []
    const options = {
      identity, scope: { userId: identity.userId }, goal: "inspect the child result",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      contextBuilder: { build: vi.fn() }, model: {}, tools: [{ name: "wait_subagents", version: "1" }],
      executeTool: vi.fn(async ({ call }: { call: { id: string; toolName: string } }): Promise<TurnEngineToolResult> => ({
        id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: waitOutput, errorCode: null,
      })),
      store: {
        appendEvent: vi.fn(async ({ id, type }: { id: string; type: string }) => { events.push(type); return { id } }),
        createItem: vi.fn(async ({ itemId }: { itemId: string }) => { createdItems.push(itemId); return { id: itemId, revision: 0 } }),
        updateItem: vi.fn(async ({ itemId, expectedRevision }: { itemId: string; expectedRevision: number }) => ({ id: itemId, revision: expectedRevision + 1 })),
        updateStep: vi.fn(async input => { stepUpdates.push(input) }),
      },
      idFactory: (prefix: string) => prefix,
    } as unknown as TurnExecutionOptions
    const output = {
      text: "", reasoningSummary: "", toolCalls: [{ id: "runtime-wait", name: "wait_subagents", arguments: {
        idempotencyKey: "runtime-wait-key", taskIds: [childId], mode: "all", timeoutMs: 30_000,
      } }], provider: "runtime", model: "runtime", finishReason: "stop" as const, usage: null, continuation: null,
    }
    const budget = createTurnBudgetLedger({ maxToolCalls: 1 })
    const closed = vi.fn(), accounted = vi.fn()
    const result = await executeTurnExecutionToolStep({
      options, executionOptions: options, writer: new TurnExecutionEventWriter(options), step: { id: "step-1", ordinal: 1 }, output,
      snapshot: options.snapshot, seenCallIds: new Set(), signal: new AbortController().signal,
      now: () => new Date("2026-11-13T12:00:00Z"), steeringMarkerState: undefined, budget,
      questionIntent: false, commentaryText: null, onToolCallsAccounted: accounted, onStepClosed: closed,
    })

    expect(result.wait).toMatchObject({ status: "waiting_for_dependency" })
    expect(options.executeTool).toHaveBeenCalledTimes(1)
    expect(options.executeTool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ toolName: "wait_subagents" }) }))
    expect(stepUpdates).toHaveLength(1)
    expect(stepUpdates[0]).toMatchObject({ status: "waiting_for_tool", finishReason: "stop" })
    expect(events.filter(type => type === "step.completed")).toHaveLength(1)
    expect(createdItems).toHaveLength(2)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(accounted).toHaveBeenCalledWith(1)
    expect(budget.snapshot().used.toolCalls).toBe(1)
  })
})
