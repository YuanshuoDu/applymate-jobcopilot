import { describe, expect, it, vi } from "vitest"
import type { PlanCommandExecutionRecord, PlanControlRecord } from "./plan-command-executor.js"
import type { PlanDispatchCommand, PlanDispatchResult } from "./plan-intent-dispatcher.js"
import {
  PlanTaskGraphAdapterError,
  createPlanTaskGraphAdapter,
  hydratePlanTaskGraph,
  type PlanTaskGraphAdapterOptions,
  type PersistedTaskGraphEvent,
} from "./plan-task-graph-adapter.js"
import type { TaskGraphEvent } from "./task-graph-reducer.js"

const command = (localId: string, dependsOn: readonly string[] = []): PlanDispatchCommand => ({
  localId, objective: localId, inputRefs: [], dependsOn: [...dependsOn], successCriteria: [], outputSchemaRef: null,
  kind: "tool_call", call: { id: `call-${localId}`, toolName: "jobs.search", toolVersion: "1", input: {} },
})
const plan = (...commands: PlanDispatchCommand[]): PlanDispatchResult => ({ proposal: {} as PlanDispatchResult["proposal"], commands })
const record = (localId: string, status: "completed" | "failed" | "cancelled", output?: unknown): PlanCommandExecutionRecord => ({
  localId, kind: "tool_call", dependsOn: [], result: { id: `call-${localId}`, toolName: "jobs.search", toolVersion: "1", status, errorCode: status === "completed" ? null : "failed", ...(output === undefined ? {} : { output }) },
})
const control = (kind: "request_input" | "propose_completion", localId: string): PlanControlRecord => kind === "request_input"
  ? { kind, localId, dependsOn: [], question: "Where?" }
  : { kind, localId, dependsOn: [], completionCriteria: ["done"] }
const adapter = (commands: readonly PlanDispatchCommand[], overrides: Partial<PlanTaskGraphAdapterOptions> = {}) => {
  const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockResolvedValue(undefined)
  const value = createPlanTaskGraphAdapter(plan(...commands), { runKey: "run-1", persist, ...overrides })
  return { value, persist }
}
const eventId = (runKey: string, nodeId: string, type: TaskGraphEvent["type"], attempt = 1): string => attempt === 1
  ? `${runKey}:${nodeId}:${type}`
  : `${runKey}:${nodeId}:attempt:${attempt}:${type}`
const persisted = (runKey: string, type: TaskGraphEvent["type"], nodeId: string, state?: unknown, attempt?: number): PersistedTaskGraphEvent => ({
  runKey, event: { type, nodeId, eventId: eventId(runKey, nodeId, type, attempt ?? 1), ...(attempt === undefined ? {} : { attempt }) }, ...(state === undefined ? {} : { state }),
})
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

describe("plan task graph adapter", () => {
  it("maps dispatch commands to graph nodes and initial readiness", () => {
    const { value } = adapter([command("first"), command("next", ["first"])])
    expect(value.state.nodes).toEqual([{ id: "first", dependsOn: [] }, { id: "next", dependsOn: ["first"] }])
    expect(value.state.readyNodeIds).toEqual(["first"])
  })

  it("persists a standalone start once and rejects unknown or non-ready nodes", async () => {
    const { value, persist } = adapter([command("first"), command("next", ["first"])])
    await value.start!("first")
    await value.start!("first")
    await expect(value.start!("next")).rejects.toMatchObject({ code: "illegal_transition" })
    await expect(value.start!("missing")).rejects.toMatchObject({ code: "unknown_node" })
    await value.observe(record("first", "completed"))
    expect(persist.mock.calls.map(([entry]) => entry.event.eventId)).toEqual(["run-1:first:start", "run-1:first:complete"])
    expect(value.state.statuses.first).toBe("completed")
  })

  it("persists stable start and complete events for a completed record", async () => {
    const { value, persist } = adapter([command("first")])
    await value.observe(record("first", "completed"))
    expect(persist.mock.calls.map(([entry]) => [entry.runKey, entry.event.eventId, entry.event.type])).toEqual([
      ["run-1", "run-1:first:start", "start"], ["run-1", "run-1:first:complete", "complete"],
    ])
    expect(value.state.statuses.first).toBe("completed")
  })

  it("linearizes concurrent starts and matches sequential replay", async () => {
    const gate = deferred()
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>(async input => {
      if (input.event.nodeId === "first") await gate.promise
    })
    const concurrent = createPlanTaskGraphAdapter(plan(command("first"), command("second")), { runKey: "run-1", persist })
    const first = concurrent.start!("first")
    const second = concurrent.start!("second")
    await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([first, second])

    const sequential = adapter([command("first"), command("second")])
    await sequential.value.start!("first")
    await sequential.value.start!("second")
    expect(concurrent.state).toEqual(sequential.value.state)
    expect(persist.mock.calls.map(([entry]) => entry.event.eventId)).toEqual([
      "run-1:first:start", "run-1:second:start",
    ])
  })

  it("linearizes a queued retry after its durable start", async () => {
    const gate = deferred()
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>(async input => {
      if (input.event.type === "start") await gate.promise
    })
    const { value } = adapter([command("first")], { persist })
    const start = value.start!("first")
    const retry = value.retry!("first")
    await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(1)
    gate.resolve()
    await expect(start).resolves.toMatchObject({ statuses: { first: "running" } })
    await expect(retry).resolves.toMatchObject({ statuses: { first: "ready" } })
    expect(value.state.appliedEvents.map(event => event.eventId)).toEqual([
      "run-1:first:start", "run-1:first:attempt:2:retry",
    ])
  })

  it("serializes concurrent terminal observations and replays the durable result", async () => {
    const { value } = adapter([command("first")])
    await value.start!("first")
    const gate = deferred()
    const terminalPersist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>(async () => gate.promise)
    const first = value.observe(record("first", "completed"), terminalPersist)
    await vi.waitFor(() => expect(terminalPersist).toHaveBeenCalledTimes(1))
    const second = value.observe(record("first", "completed"), terminalPersist)
    await Promise.resolve()
    expect(terminalPersist).toHaveBeenCalledTimes(1)
    gate.resolve()
    await Promise.all([first, second])
    expect(value.state.statuses.first).toBe("completed")
    expect(value.state.appliedEvents.map(event => event.eventId)).toEqual(["run-1:first:start", "run-1:first:complete"])
  })

  it("uses a terminal persistence override after the durable start", async () => {
    const trace: string[] = []
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>(async input => { trace.push(`base:${input.event.type}`) })
    const value = createPlanTaskGraphAdapter(plan(command("first")), { runKey: "run-1", persist })
    const override = vi.fn<PlanTaskGraphAdapterOptions["persist"]>(async input => { trace.push(`override:${input.event.type}`) })
    await value.observe(record("first", "completed"), override)
    expect(trace).toEqual(["base:start", "override:complete"])
    expect(value.state.statuses.first).toBe("completed")
  })

  it("does not advance the terminal state when the override fails", async () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockResolvedValue(undefined)
    const value = createPlanTaskGraphAdapter(plan(command("first")), { runKey: "run-1", persist })
    const override = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockRejectedValue(new Error("atomic batch failed"))
    await expect(value.observe(record("first", "completed"), override)).rejects.toBeInstanceOf(PlanTaskGraphAdapterError)
    expect(value.state.statuses.first).toBe("running")
    expect(value.state.appliedEvents.map(event => event.eventId)).toEqual(["run-1:first:start"])
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it("maps failed and cancelled execution records to terminal events", async () => {
    const failed = adapter([command("failed")])
    await failed.value.observe(record("failed", "failed"))
    expect(failed.value.state.statuses.failed).toBe("failed")
    const cancelled = adapter([command("cancelled")])
    await cancelled.value.observe(record("cancelled", "cancelled"))
    expect(cancelled.value.state.statuses.cancelled).toBe("cancelled")
  })

  it("maps waiting execution output to wait", async () => {
    const { value, persist } = adapter([command("join")])
    await value.observe(record("join", "completed", { status: "waiting", waitId: "wait-1" }))
    expect(value.state.statuses.join).toBe("waiting")
    expect(persist.mock.calls[1]?.[0].event).toMatchObject({ type: "wait", eventId: "run-1:join:wait" })
  })

  it("maps both control records to wait after starting the node", async () => {
    const request = adapter([command("ask")])
    await request.value.observe(control("request_input", "ask"))
    expect(request.value.state.statuses.ask).toBe("waiting")
    const completion = adapter([command("finish")])
    await completion.value.observe(control("propose_completion", "finish"))
    expect(completion.value.state.statuses.finish).toBe("waiting")
  })

  it("does not forge an event for replan control", async () => {
    const { value, persist } = adapter([command("join")])
    await value.observe({ kind: "replan_required", localId: "join:replan", dependsOn: ["join"], reason: "child_failure", failedTaskIds: ["child"] })
    expect(value.state.appliedEvents).toEqual([])
    expect(persist).not.toHaveBeenCalled()
  })

  it("requires dependency order and fails closed before persistence", async () => {
    const { value, persist } = adapter([command("first"), command("next", ["first"])])
    await expect(value.observe(record("next", "completed"))).rejects.toMatchObject({ code: "illegal_transition" })
    expect(value.state.statuses).toMatchObject({ first: "ready", next: "pending" })
    expect(persist).not.toHaveBeenCalled()
  })

  it("replays the same run key and record idempotently", async () => {
    const { value, persist } = adapter([command("first")])
    const first = record("first", "completed")
    await value.observe(first)
    await value.observe(first)
    expect(value.state.statuses.first).toBe("completed")
    expect(value.state.appliedEvents).toHaveLength(2)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it("does not advance state when persistence fails", async () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockRejectedValue(new Error("db down"))
    const { value } = adapter([command("first")], { persist })
    await expect(value.observe(record("first", "completed"))).rejects.toBeInstanceOf(PlanTaskGraphAdapterError)
    expect(value.state.statuses.first).toBe("ready")
    expect(value.state.appliedEvents).toEqual([])
  })

  it("keeps queued routing on the prior state after a failed durable start", async () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockRejectedValue(new Error("db down"))
    const { value } = adapter([command("first"), command("next", ["first"])], { persist })
    const failedStart = value.start!("first")
    const queuedSuccessor = value.start!("next")
    await expect(failedStart).rejects.toMatchObject({ code: "persistence_failed" })
    await expect(queuedSuccessor).rejects.toMatchObject({ code: "illegal_transition" })
    expect(value.state.statuses).toMatchObject({ first: "ready", next: "pending" })
    expect(value.state.appliedEvents).toEqual([])
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed observations without creating a start event", async () => {
    const { value, persist } = adapter([command("first")])
    await expect(value.observe({ kind: "tool_call", localId: "first", dependsOn: [], result: { status: "unknown" } } as unknown as PlanCommandExecutionRecord)).rejects.toMatchObject({ code: "invalid_record" })
    expect(value.state.statuses.first).toBe("ready")
    expect(persist).not.toHaveBeenCalled()
  })

  it("fails closed for unknown observed nodes", async () => {
    const { value, persist } = adapter([command("first")])
    await expect(value.observe(record("missing", "completed"))).rejects.toMatchObject({ code: "unknown_node" })
    expect(persist).not.toHaveBeenCalled()
    expect(value.state.appliedEvents).toEqual([])
  })

  it("rejects null and primitive observations with a typed error", async () => {
    const { value } = adapter([command("first")])
    for (const malformed of [null, "record", 7]) {
      await expect(value.observe(malformed as unknown as PlanCommandExecutionRecord)).rejects.toMatchObject({ code: "invalid_record" })
    }
  })

  it("fails closed before persistence when the serialized graph state exceeds 8 KiB", async () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockResolvedValue(undefined)
    const longCommands = Array.from({ length: 8 }, (_, index) => command(`${"node".repeat(700)}-${index}`))
    const value = createPlanTaskGraphAdapter(plan(...longCommands), { runKey: "run-1", persist })
    await expect(value.observe(record(longCommands[0]!.localId, "completed"))).rejects.toMatchObject({ code: "persistence_failed" })
    expect(persist).not.toHaveBeenCalled()
    expect(value.state.appliedEvents).toEqual([])
  })

  it("retains blocked successors after an observed failure", async () => {
    const { value } = adapter([command("first"), command("next", ["first"])])
    await value.observe(record("first", "failed"))
    expect(value.state.readyNodeIds).toEqual([])
    expect(value.state.blockedReasons.next).toBe("dependency_failed")
  })

  it("hydrates completed graphs from ordered events and ignores the snapshot", () => {
    const value = hydratePlanTaskGraph(plan(command("first")), {
      runKey: "run-1",
      events: [
        persisted("run-1", "start", "first", { statuses: { first: "completed" } }),
        persisted("run-1", "complete", "first", { statuses: { first: "ready" } }),
      ],
    })
    expect(value.statuses.first).toBe("completed")
    expect(value.appliedEvents.map(event => event.eventId)).toEqual(["run-1:first:start", "run-1:first:complete"])
  })

  it("accepts reducer-derived initial state without trusting a persisted snapshot", () => {
    const dispatched = plan(command("first"))
    const initialState = hydratePlanTaskGraph(dispatched, { runKey: "run-1", events: [persisted("run-1", "start", "first")] })
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockResolvedValue(undefined)
    const value = createPlanTaskGraphAdapter(dispatched, { runKey: "run-1", persist, initialState })
    expect(value.state.statuses.first).toBe("running")
    expect(value.state.appliedEvents).toEqual([{ type: "start", nodeId: "first", eventId: "run-1:first:start" }])
  })

  it("rejects malformed initial state with a typed adapter error", () => {
    const dispatched = plan(command("first"))
    const initialState = hydratePlanTaskGraph(dispatched, { runKey: "run-1", events: [] })
    for (const malformed of [
      { ...initialState, appliedEvents: undefined },
      { ...initialState, nodes: null },
      { ...initialState, statuses: { first: "forged" } },
    ]) {
      expect(() => createPlanTaskGraphAdapter(dispatched, { runKey: "run-1", persist: vi.fn(), initialState: malformed as never })).toThrowError(PlanTaskGraphAdapterError)
    }
  })

  it("hydrates waiting and failure graphs while preserving dependent blocking", () => {
    const waiting = hydratePlanTaskGraph(plan(command("wait")), { runKey: "run-1", events: [persisted("run-1", "start", "wait"), persisted("run-1", "wait", "wait")] })
    expect(waiting.statuses.wait).toBe("waiting")
    const failed = hydratePlanTaskGraph(plan(command("first"), command("next", ["first"])), { runKey: "run-1", events: [persisted("run-1", "start", "first"), persisted("run-1", "fail", "first")] })
    expect(failed.statuses.first).toBe("failed")
    expect(failed.blockedReasons.next).toBe("dependency_failed")
  })

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["overlong", "r".repeat(257)],
  ])("rejects %s hydration run keys", (_label, runKey) => {
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey, events: [] })).toThrowError(PlanTaskGraphAdapterError)
  })

  it("rejects an overlong fresh adapter run key", () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>()
    expect(() => createPlanTaskGraphAdapter(plan(command("first")), { runKey: "r".repeat(257), persist })).toThrowError(PlanTaskGraphAdapterError)
    expect(persist).not.toHaveBeenCalled()
  })

  it.each([
    ["wrong runKey", [{ ...persisted("other", "start", "first"), runKey: "other" }]],
    ["wrong eventId", [{ ...persisted("run-1", "start", "first"), event: { type: "start" as const, nodeId: "first", eventId: "run-1:first:other" } }]],
    ["unknown node", [persisted("run-1", "start", "missing")]],
    ["duplicate event", [persisted("run-1", "start", "first"), persisted("run-1", "start", "first")]],
    ["illegal transition", [persisted("run-1", "complete", "first")]],
  ])("fails closed for %s", (_label, events) => {
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events })).toThrow(PlanTaskGraphAdapterError)
  })

  it("rejects malformed event fields and oversized history", () => {
    const malformed = { runKey: "run-1", event: { type: "start", nodeId: "first", eventId: "run-1:first:start", extra: true } } as unknown as PersistedTaskGraphEvent
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [malformed] })).toThrowError(/malformed/)
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [persisted("run-1", "start", "first", "x".repeat(9000))] })).toThrowError(PlanTaskGraphAdapterError)
    const extraEntry = { ...persisted("run-1", "start", "first"), source: "untrusted" } as unknown as PersistedTaskGraphEvent
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [extraEntry] })).toThrowError(/entry is malformed/)
  })

  it("replays legacy attempt one history and persists a distinct attempt two recovery", async () => {
    const { value, persist } = adapter([command("first")])
    await value.start!("first")
    await value.retry!("first")
    await value.start!("first")
    await value.observe(record("first", "completed"))
    expect(persist.mock.calls.map(([entry]) => entry.event.eventId)).toEqual([
      "run-1:first:start", "run-1:first:attempt:2:retry", "run-1:first:attempt:2:start", "run-1:first:attempt:2:complete",
    ])
    expect(persist.mock.calls.slice(1).every(([entry]) => entry.event.attempt === 2)).toBe(true)
    expect(value.state.statuses.first).toBe("completed")
  })

  it("hydrates attempt two recovery history and rejects a second recovery", async () => {
    const history = [persisted("run-1", "start", "first"), persisted("run-1", "retry", "first", undefined, 2)]
    const initialState = hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: history })
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>().mockResolvedValue(undefined)
    const value = createPlanTaskGraphAdapter(plan(command("first")), { runKey: "run-1", persist, initialState })
    expect(value.state.statuses.first).toBe("ready")
    await expect(value.retry!("first")).rejects.toMatchObject({ code: "illegal_transition" })
    await value.start!("first")
    await value.observe(record("first", "completed"))
    expect(value.state.statuses.first).toBe("completed")
  })

  it("does not advance adapter state when recovery persistence fails", async () => {
    const persist = vi.fn<PlanTaskGraphAdapterOptions["persist"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db down"))
    const value = createPlanTaskGraphAdapter(plan(command("first")), { runKey: "run-1", persist })
    await value.start!("first")
    await expect(value.retry!("first")).rejects.toMatchObject({ code: "persistence_failed" })
    expect(value.state.statuses.first).toBe("running")
    expect(value.state.appliedEvents.map(event => event.eventId)).toEqual(["run-1:first:start"])
  })

  it("fails closed for malformed or mismatched recovery identity", () => {
    const missingAttempt = { ...persisted("run-1", "retry", "first"), event: { type: "retry", nodeId: "first", eventId: "run-1:first:attempt:2:retry" } } as unknown as PersistedTaskGraphEvent
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [missingAttempt] })).toThrowError(PlanTaskGraphAdapterError)
    const mismatch = { ...persisted("run-1", "retry", "first", undefined, 2), event: { type: "retry", nodeId: "first", eventId: "run-1:first:attempt:2:wrong", attempt: 2 } } as PersistedTaskGraphEvent
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [mismatch] })).toThrowError(/runKey, attempt, and phase/)
    expect(() => hydratePlanTaskGraph(plan(command("first")), { runKey: "run-1", events: [persisted("run-1", "retry", "first", undefined, 3)] })).toThrowError(PlanTaskGraphAdapterError)
  })
})
