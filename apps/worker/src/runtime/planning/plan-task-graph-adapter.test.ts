import { describe, expect, it, vi } from "vitest"
import type { PlanCommandExecutionRecord, PlanControlRecord } from "./plan-command-executor.js"
import type { PlanDispatchCommand, PlanDispatchResult } from "./plan-intent-dispatcher.js"
import {
  PlanTaskGraphAdapterError,
  createPlanTaskGraphAdapter,
  type PlanTaskGraphAdapterOptions,
} from "./plan-task-graph-adapter.js"

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

describe("plan task graph adapter", () => {
  it("maps dispatch commands to graph nodes and initial readiness", () => {
    const { value } = adapter([command("first"), command("next", ["first"])])
    expect(value.state.nodes).toEqual([{ id: "first", dependsOn: [] }, { id: "next", dependsOn: ["first"] }])
    expect(value.state.readyNodeIds).toEqual(["first"])
  })

  it("persists stable start and complete events for a completed record", async () => {
    const { value, persist } = adapter([command("first")])
    await value.observe(record("first", "completed"))
    expect(persist.mock.calls.map(([entry]) => [entry.runKey, entry.event.eventId, entry.event.type])).toEqual([
      ["run-1", "run-1:first:start", "start"], ["run-1", "run-1:first:complete", "complete"],
    ])
    expect(value.state.statuses.first).toBe("completed")
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

  it("retains blocked successors after an observed failure", async () => {
    const { value } = adapter([command("first"), command("next", ["first"])])
    await value.observe(record("first", "failed"))
    expect(value.state.readyNodeIds).toEqual([])
    expect(value.state.blockedReasons.next).toBe("dependency_failed")
  })
})
