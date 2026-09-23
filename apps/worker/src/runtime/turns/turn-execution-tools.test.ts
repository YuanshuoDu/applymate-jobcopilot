import { describe, expect, it, vi } from "vitest"

import { recoverPersistedToolCalls } from "./turn-execution-tools.js"
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
