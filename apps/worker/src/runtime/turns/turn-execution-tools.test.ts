import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { executeTools, recoverPersistedToolCalls } from "./turn-execution-tools.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { ToolCallRecovery } from "./turn-engine-types.js"

function execution(recovery: ToolCallRecovery, executeTool: TurnExecutionOptions["executeTool"], validateToolArguments?: TurnExecutionOptions["validateToolArguments"]) {
  const updates: Array<{ itemId: string; status: string; content: unknown }> = []
  const events: Array<{ type: string; payload: unknown }> = []
  const options = {
    identity: { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-2", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-10T00:00:00.000Z") },
    scope: { userId: "user-1" }, goal: "Find jobs", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    toolCallRecovery: [recovery], executeTool, validateToolArguments, signal: new AbortController().signal,
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
  const durableWaitId = "wait-12345678-1234-4234-9234-123456789012"
  const call = { id: "wait-call", name: "agent.wait", arguments: { idempotencyKey: "wait-1", taskIds: ["child-1"], mode: "all", timeoutMs: 30_000 } }
  const waitReceipt = { waitId: durableWaitId, status: "waiting", deadlineAt: "2026-09-10T00:00:00.000Z", matchedTaskIds: ["child-1"] }
  const resolvedInput = { taskIds: ["child-1"], mode: "all" }
  const resolvedOutput = { waitId: durableWaitId, status: "ready", matchedTaskIds: ["child-1"], targetTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed" }] }
  const nativeOutput = {
    taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, status: "queued", replay: false,
    nativeCoordination: { schemaVersion: "agent-harness.v2.native-coordination-receipt.v1", operationKind: "spawn", status: "accepted", replay: false,
      operationId: "operation-1", requestFingerprint: "a".repeat(64), graphRevision: 1, nodeKey: "node-1", dispatchDisposition: "pending", rootTaskId: "root-1",
      child: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "queued" } },
  }

  function projection(output: unknown, input: unknown = resolvedInput, includeInput = true) {
    return { id: `wait-result:${durableWaitId}`, content: { toolCallId: `wait:${durableWaitId}`, toolName: "agent.wait", ...(includeInput ? { input } : {}), status: "completed", output } }
  }

  function replayFixture(output: unknown, persistedCall: { id: string; name: string; arguments: Record<string, unknown> } = call, additionalToolObservations: readonly { id: string; content: unknown }[] = []) {
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

  const resumedCall = { id: "model-call-9", name: "jobs.search", arguments: { query: "Dublin" } }
  const resumedOutput = { jobs: [{ id: "job-1" }] }

  function childResumeReplayFixture(overrides: { id?: string; content?: Record<string, unknown>; attemptCount?: number } = {}) {
    const executeTool = vi.fn()
    const createdItems: Array<Record<string, unknown>> = []
    const updates: Array<Record<string, unknown>> = []
    const events: Array<{ type: string; payload: unknown }> = []
    const options = {
      identity: { kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-2", attemptCount: overrides.attemptCount ?? 3, leaseExpiresAt: new Date("2026-09-10T00:00:00.000Z") },
      scope: { userId: "user-1" },
      snapshot: {
        system: [], profile: [], steerHistory: [], businessRefs: [],
        toolObservations: [{ id: overrides.id ?? "child-resume:source-result-1", content: {
          toolCallId: resumedCall.id, toolName: resumedCall.name, input: resumedCall.arguments, status: "completed", output: resumedOutput, errorCode: null,
          ...overrides.content,
        } }],
      },
      executeTool,
      idFactory: (prefix: string) => `${prefix}:attempt:${overrides.attemptCount ?? 3}`,
      signal: new AbortController().signal,
      store: {
        createItem: async (input: Record<string, unknown>) => { createdItems.push(input); return { id: String(input.itemId), revision: 0 } },
        updateItem: async (input: Record<string, unknown>) => { updates.push(input); return { id: String(input.itemId), revision: Number(input.expectedRevision) + 1 } },
        appendEvent: async (input: { type: string; payload: unknown }) => { events.push(input); return { id: `event-${events.length}` } },
      },
    } as unknown as TurnExecutionOptions
    return { options, executeTool, createdItems, updates, events, writer: new TurnExecutionEventWriter(options) }
  }

  async function replayChildResume(fixture: ReturnType<typeof childResumeReplayFixture>, modelCall = resumedCall, stepId = "step-attempt-3", onCallPersisted = vi.fn()) {
    return executeTools(
      fixture.options, fixture.writer, { id: stepId, ordinal: 0 },
      { text: "", reasoningSummary: "", toolCalls: [modelCall], provider: "fixture", model: "fixture-model", finishReason: "tool_calls", usage: null, continuation: null },
      fixture.options.snapshot, new Set(), fixture.options.signal!,
      () => new Date("2026-09-09T00:00:00.000Z"), undefined, onCallPersisted,
    )
  }

  async function replay(fixture: ReturnType<typeof replayFixture>, modelCall: { id: string; name: string; arguments: Record<string, unknown> } = call) {
    return executeTools(
      fixture.options,
      fixture.writer,
      { id: "step-1", ordinal: 1 },
      { text: "", reasoningSummary: "", toolCalls: [modelCall], provider: "fixture", model: "fixture-model", finishReason: "tool_calls", usage: null, continuation: null },
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

    expect(result.wait).toEqual({ status: "waiting_for_dependency", waitId: durableWaitId, stepCount: 0, toolCallCount: 0 })
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it.each([
    ["redaction marker", { ...waitReceipt, waitId: "[REDACTED]" }],
    ["missing", { status: "waiting", deadlineAt: "2026-09-10T00:00:00.000Z", matchedTaskIds: [] }],
  ] as const)("fails persisted waiting receipts with a %s ID instead of handing them off", async (_label, output) => {
    const fixture = replayFixture(output)

    await expect(replay(fixture)).rejects.toMatchObject({ code: "invalid_output" })
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it.each(["durable_wait_receipt_invalid", "schema_error"] as const)("surfaces failed agent.wait receipt validation as terminal for %s", async errorCode => {
    const executeTool = vi.fn(async () => ({
      id: call.id, toolName: call.name, toolVersion: "1", status: "failed" as const, errorCode,
    }))
    const fixture = execution(pending, executeTool as never, () => true)

    await expect(executeTools(
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
    )).rejects.toMatchObject({ code: "invalid_output" })
    expect(executeTool).toHaveBeenCalledTimes(1)
  })

  it("keeps an invalid wait input schema error recoverable", async () => {
    const executeTool = vi.fn(async () => ({
      id: call.id, toolName: call.name, toolVersion: "1", status: "failed" as const, errorCode: "schema_error",
    }))
    const fixture = execution(pending, executeTool as never, () => "invalid wait arguments")

    const result = await executeTools(
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

    expect(result.wait).toBeNull()
    expect(executeTool).toHaveBeenCalledTimes(1)
  })

  it("does not re-handoff a stale wait receipt when its resolved outcome is in the snapshot", async () => {
    const fixture = replayFixture(waitReceipt, call, [projection(resolvedOutput)])

    const result = await replay(fixture)

    expect(result.wait).toBeNull()
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "ready any with one matched target",
      modelCall: { ...call, arguments: { ...call.arguments, taskIds: ["child-b", "child-a"], mode: "any" } },
      input: { taskIds: ["child-a", "child-b"], mode: "any" },
      output: { waitId: durableWaitId, status: "ready", matchedTaskIds: ["child-b"], targetTaskIds: ["child-a", "child-b"], tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-b", status: "failed" }] },
    },
    {
      label: "ready all with every target matched",
      modelCall: { ...call, arguments: { ...call.arguments, taskIds: ["child-b", "child-a"] } },
      input: { taskIds: ["child-a", "child-b"], mode: "all" },
      output: { waitId: durableWaitId, status: "ready", matchedTaskIds: ["child-a", "child-b"], targetTaskIds: ["child-a", "child-b"], tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-b", status: "completed" }] },
    },
    {
      label: "timed out with no matched targets",
      modelCall: { ...call, arguments: { ...call.arguments, taskIds: ["child-b", "child-a"] } },
      input: { taskIds: ["child-a", "child-b"], mode: "all" },
      output: { waitId: durableWaitId, status: "timed_out", matchedTaskIds: [], targetTaskIds: ["child-a", "child-b"], tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-b", status: "running" }] },
    },
  ])("accepts a valid $label projection", async ({ modelCall, input, output }) => {
    const fixture = replayFixture({ ...waitReceipt, matchedTaskIds: output.matchedTaskIds }, modelCall, [projection(output, input)])

    const result = await replay(fixture, modelCall)

    expect(result.wait).toBeNull()
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  const multiResolvedOutput = {
    waitId: durableWaitId, status: "ready", matchedTaskIds: ["child-a", "child-b"], targetTaskIds: ["child-a", "child-b"],
    tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-b", status: "completed" }],
  }

  it.each([
    { label: "wrong projection input", mode: "all" as const, input: { taskIds: ["child-a"], mode: "all" }, output: multiResolvedOutput },
    { label: "wrong projection mode", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "any" }, output: multiResolvedOutput },
    { label: "missing projection input", mode: "all" as const, input: undefined, includeInput: false, output: multiResolvedOutput },
    { label: "wrong task rows", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-c", status: "completed" }] } },
    { label: "missing task rows", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, tasks: [{ taskId: "child-a", status: "completed" }] } },
    { label: "duplicate task rows", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-a", status: "completed" }] } },
    { label: "duplicate targets", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, targetTaskIds: ["child-a", "child-a"], matchedTaskIds: ["child-a"], tasks: [{ taskId: "child-a", status: "completed" }, { taskId: "child-a", status: "completed" }] } },
    { label: "empty targets", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, targetTaskIds: [], matchedTaskIds: [], tasks: [] } },
    { label: "duplicate matches", mode: "any" as const, input: { taskIds: ["child-a", "child-b"], mode: "any" }, output: { ...multiResolvedOutput, matchedTaskIds: ["child-a", "child-a"] } },
    { label: "ready with empty matches", mode: "any" as const, input: { taskIds: ["child-a", "child-b"], mode: "any" }, output: { ...multiResolvedOutput, matchedTaskIds: [] } },
    { label: "ready all partial match", mode: "all" as const, input: { taskIds: ["child-a", "child-b"], mode: "all" }, output: { ...multiResolvedOutput, matchedTaskIds: ["child-a"] } },
  ])("keeps the durable handoff for a $label projection", async ({ mode, input, includeInput, output }) => {
    const modelCall = { ...call, arguments: { ...call.arguments, taskIds: ["child-b", "child-a"], mode } }
    const fixture = replayFixture(waitReceipt, modelCall, [projection(output, input, includeInput)])

    const result = await replay(fixture, modelCall)

    expect(result.wait).toEqual({ status: "waiting_for_dependency", waitId: durableWaitId, stepCount: 0, toolCallCount: 0 })
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("continues unchanged for an ordinary completed tool replay", async () => {
    const fixture = replayFixture({ jobs: ["one"] })

    const result = await replay(fixture)

    expect(result.wait).toBeNull()
    expect(result.snapshot).toBe(fixture.options.snapshot)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("refreshes graph state after a persisted native alias replay", async () => {
    const spawnCall = { id: "spawn-call", name: "spawn_subagent", arguments: { role: "scout", taskType: "research", goal: "Inspect" } }
    const fixture = replayFixture(nativeOutput, spawnCall)
    const refreshed = { ...fixture.options.snapshot, toolObservations: [...fixture.options.snapshot.toolObservations, { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1, nodes: [] } }] }
    const refresh = vi.fn(async () => refreshed)
    Object.assign(fixture.options, { refreshTaskGraphAfterPlan: refresh })

    const result = await replay(fixture, spawnCall)

    expect(refresh).toHaveBeenCalledOnce()
    expect(result.snapshot).toBe(refreshed)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("refreshes graph state immediately after a newly accepted native followup", async () => {
    const followupCall = { id: "followup-call", name: "agent.followup", arguments: { taskId: "source-1", goal: "Continue" } }
    const executeTool = vi.fn(async () => ({ id: followupCall.id, toolName: followupCall.name, toolVersion: "1", status: "completed" as const, output: { ...nativeOutput, sourceTaskId: "source-1", nativeCoordination: { ...nativeOutput.nativeCoordination, operationKind: "followup" } }, errorCode: null }))
    const fixture = execution(pending, executeTool as never)
    const refreshed = { ...fixture.options.snapshot, toolObservations: [{ id: "task-graph-current", content: { kind: "task_graph_current", revision: 1, nodes: [] } }] }
    const refresh = vi.fn(async () => refreshed)
    Object.assign(fixture.options, { refreshTaskGraphAfterPlan: refresh })

    const result = await executeTools(fixture.options, fixture.writer, { id: "step-1", ordinal: 1 },
      { text: "", reasoningSummary: "", toolCalls: [followupCall], provider: "fixture", model: "fixture", finishReason: "tool_calls", usage: null, continuation: null },
      fixture.options.snapshot, new Set(), fixture.options.signal!, () => new Date("2026-09-09T00:00:00.000Z"), undefined, vi.fn())

    expect(refresh).toHaveBeenCalledOnce()
    expect(result.snapshot).toBe(refreshed)
  })

  it("persists an attempt-scoped receipt and exact resume link without re-executing the tool", async () => {
    const fixture = childResumeReplayFixture()
    const onCallPersisted = vi.fn()

    const result = await replayChildResume(fixture, resumedCall, "step-attempt-3", onCallPersisted)

    const replayToolCallId = String((fixture.createdItems[0]?.content as Record<string, unknown>).toolCallId)
    const expectedId = `task-graph-replay-v1:${createHash("sha256").update(JSON.stringify(["step-attempt-3", resumedCall.id])).digest("hex")}`
    expect(replayToolCallId).toBe(expectedId)
    expect(replayToolCallId).not.toBe(resumedCall.id)
    expect(fixture.createdItems.map(item => [item.type, item.stepId])).toEqual([["tool_call", "step-attempt-3"], ["tool_result", "step-attempt-3"]])
    expect(fixture.createdItems.map(item => (item.content as Record<string, unknown>).toolCallId)).toEqual([expectedId, expectedId])
    expect(fixture.updates.map(item => [item.status, item.content])).toEqual([
      ["completed", { toolCallId: expectedId, toolName: resumedCall.name, toolVersion: "1", status: "completed", errorCode: null, input: resumedCall.arguments }],
      ["completed", { toolCallId: expectedId, output: resumedOutput, errorCode: null }],
    ])
    const started = fixture.events.find(event => event.type === "tool_call.started")
    const terminal = fixture.events.find(event => event.type === "tool_call.completed")
    const expectedSource = { toolCallId: resumedCall.id, resultItemId: "source-result-1" }
    expect((started?.payload as Record<string, unknown>).replaySource).toEqual(expectedSource)
    expect((terminal?.payload as Record<string, unknown>).replaySource).toEqual(expectedSource)
    expect(fixture.executeTool).not.toHaveBeenCalled()
    expect(onCallPersisted).toHaveBeenCalledTimes(1)
    expect(result.wait).toBeNull()
  })

  it("persists the exact failed result code without exception prose", async () => {
    const fixture = childResumeReplayFixture({ content: { status: "failed", errorCode: "tool_execution_failed" } })

    await replayChildResume(fixture)

    expect(fixture.events.find(event => event.type === "tool_call.failed")?.payload).toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
    expect(fixture.updates[0]?.content).toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
    expect(JSON.stringify(fixture.createdItems.concat(fixture.updates))).not.toContain("Error:")
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("rejects exception prose instead of persisting it as a result error", async () => {
    const fixture = childResumeReplayFixture({ content: { status: "failed", errorCode: "Error: refresh token expired" } })

    await expect(replayChildResume(fixture)).rejects.toMatchObject({ code: "invalid_output" })

    expect(fixture.createdItems).toHaveLength(0)
    expect(fixture.events).toHaveLength(0)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("rejects a mismatched resumed input without persisting or executing it", async () => {
    const fixture = childResumeReplayFixture()
    const mismatchedCall = { ...resumedCall, arguments: { query: "Amsterdam" } }

    await expect(replayChildResume(fixture, mismatchedCall)).rejects.toMatchObject({ code: "invalid_output" })

    expect(fixture.createdItems).toHaveLength(0)
    expect(fixture.events).toHaveLength(0)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it.each(["child-resume:", "child-resume", "child-resume: "])("rejects malformed child-resume ID %s", async id => {
    const fixture = childResumeReplayFixture({ id })

    await expect(replayChildResume(fixture)).rejects.toMatchObject({ code: "invalid_output" })

    expect(fixture.createdItems).toHaveLength(0)
    expect(fixture.events).toHaveLength(0)
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it("rejects a persisted replay whose input differs from the model call", async () => {
    const fixture = replayFixture(waitReceipt, { ...call, arguments: { ...call.arguments, mode: "any" } })

    await expect(replay(fixture)).rejects.toMatchObject({ code: "invalid_output" })
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })
})
