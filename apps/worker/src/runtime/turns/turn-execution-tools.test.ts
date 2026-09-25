import { describe, expect, it, vi } from "vitest"

import { executeTools, recoverPersistedToolCalls } from "./turn-execution-tools.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { ToolCallRecovery } from "./turn-engine-types.js"

function execution(recovery: ToolCallRecovery, executeTool: TurnExecutionOptions["executeTool"]) {
  const updates: Array<{ itemId: string; status: string; content: unknown }> = []
  const events: Array<{ type: string; payload: unknown }> = []
  const options = {
    identity: { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-2", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-10T00:00:00.000Z") },
    scope: { userId: "user-1" }, goal: "Find jobs", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    toolCallRecovery: [recovery], executeTool, signal: new AbortController().signal,
    store: {
      updateItem: async (input: { itemId: string; expectedRevision: number; status: string; content: unknown }) => { updates.push(input); return { id: input.itemId, revision: input.expectedRevision + 1 } },
      createItem: async (input: { itemId: string }) => ({ id: input.itemId, revision: 0 }),
      appendEvent: async (input: { type: string; payload: unknown }) => { events.push(input); return { id: `event-${events.length}` } },
    },
  } as unknown as TurnExecutionOptions
  return { options, updates, events, writer: new TurnExecutionEventWriter(options) }
}

const pending: ToolCallRecovery = {
  action: "replay", call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "call-item", revision: 0 },
}

describe("recoverPersistedToolCalls", () => {
  it("replays a safe pending call with its original id and step before returning model context", async () => {
    const execute = vi.fn(async ({ call }: { call: { id: string; toolName: string; input: unknown } }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: { jobs: ["one"] }, errorCode: null }))
    const fixture = execution(pending, execute as never)
    const observations = await recoverPersistedToolCalls(fixture.options, fixture.writer, () => new Date("2026-09-09T00:00:00.000Z"))

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ stepId: "step-0", call: { id: "call-1", toolName: "jobs.search", toolVersion: "1", input: { location: "Dublin" } } }))
    expect(observations).toEqual([{ id: "tool-result:call-1", content: expect.objectContaining({ status: "completed", output: { jobs: ["one"] } }) }])
    expect(fixture.updates.map(item => [item.itemId, item.status])).toEqual([["call-item", "completed"], [expect.any(String), "completed"]])
  })

  it("persists an uncertain failure and never invokes the external tool", async () => {
    const execute = vi.fn()
    const fixture = execution({ ...pending, action: "fail" }, execute)

    await expect(recoverPersistedToolCalls(fixture.options, fixture.writer, () => new Date("2026-09-09T00:00:00.000Z"))).rejects.toMatchObject({ code: "tool_result_replay_uncertain" })
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.updates.map(item => item.status)).toEqual(["completed", "completed"])
    expect(JSON.stringify(fixture.updates)).toContain("tool_result_replay_uncertain")
    expect(fixture.events.some(event => event.type === "tool_call.failed" && JSON.stringify(event.payload).includes("tool_result_replay_uncertain"))).toBe(true)
  })
})

describe("executeTools persisted replay", () => {
  const call = { id: "wait-call", name: "agent.wait", arguments: { idempotencyKey: "wait-1", taskIds: ["child-1"], mode: "all", timeoutMs: 30_000 } }
  const waitReceipt = { waitId: "wait-1", status: "waiting", deadlineAt: "2026-09-10T00:00:00.000Z", matchedTaskIds: ["child-1"] }

  function replayFixture(output: unknown, persistedCall = call, additionalToolObservations: readonly { id: string; content: unknown }[] = []) {
    const executeTool = vi.fn()
    const options = {
      identity: { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-2", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-10T00:00:00.000Z") },
      scope: { userId: "user-1" },
      snapshot: {
        system: [], profile: [], steerHistory: [], businessRefs: [],
        toolObservations: [
          { id: "tool-result:wait-call", content: { toolCallId: persistedCall.id, toolName: persistedCall.name, input: persistedCall.arguments, status: "completed", output } },
          ...additionalToolObservations,
        ],
      },
      executeTool,
      signal: new AbortController().signal,
      store: {},
    } as unknown as TurnExecutionOptions
    return { options, executeTool, writer: new TurnExecutionEventWriter(options) }
  }

  async function replay(fixture: ReturnType<typeof replayFixture>) {
    return executeTools(
      fixture.options,
      fixture.writer,
      { id: "step-1", ordinal: 1 },
      { text: "", reasoningSummary: "", toolCalls: [call], provider: "fixture", model: "fixture-model", finishReason: "tool_calls", usage: null, continuation: null },
      fixture.options.snapshot,
      new Set(),
      fixture.options.signal!,
      () => new Date("2026-09-09T00:00:00.000Z"),
      undefined,
      vi.fn(),
    )
  }

  it("returns a persisted active wait receipt without re-executing the tool", async () => {
    const fixture = replayFixture(waitReceipt)

    const result = await replay(fixture)

    expect(result.wait).toEqual({ status: "waiting_for_dependency", waitId: "wait-1", stepCount: 0, toolCallCount: 0 })
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("does not re-handoff a stale wait receipt when its resolved outcome is in the snapshot", async () => {
    const fixture = replayFixture(waitReceipt, call, [{
      id: "wait-result:wait-1",
      content: {
        toolCallId: "wait:wait-1", toolName: "agent.wait", input: { taskIds: ["child-1"], mode: "all" }, status: "completed",
        output: { waitId: "wait-1", status: "ready", matchedTaskIds: ["child-1"], targetTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed" }] },
      },
    }])

    const result = await replay(fixture)

    expect(result.wait).toBeNull()
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("continues unchanged for an ordinary completed tool replay", async () => {
    const fixture = replayFixture({ jobs: ["one"] })

    const result = await replay(fixture)

    expect(result.wait).toBeNull()
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("rejects a persisted replay whose input differs from the model call", async () => {
    const fixture = replayFixture(waitReceipt, { ...call, arguments: { ...call.arguments, mode: "any" } })

    await expect(replay(fixture)).rejects.toMatchObject({ code: "invalid_output" })
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })
})
