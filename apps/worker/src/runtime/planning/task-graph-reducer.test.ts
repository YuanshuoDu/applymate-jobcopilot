import { describe, expect, it } from "vitest"
import {
  TaskGraphError,
  createTaskGraph,
  reduceTaskGraph,
  type TaskGraphEvent,
} from "./task-graph-reducer.js"

const event = (type: TaskGraphEvent["type"], nodeId: string, eventId: string): TaskGraphEvent => ({ type, nodeId, eventId })
const apply = (state: ReturnType<typeof createTaskGraph>, next: TaskGraphEvent) => {
  const result = reduceTaskGraph(state, next)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.state
}

describe("task graph reducer", () => {
  it("starts roots ready and reports dependency blockers", () => {
    const state = createTaskGraph([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }])
    expect(state.readyNodeIds).toEqual(["a"])
    expect(state.statuses).toMatchObject({ a: "ready", b: "pending" })
    expect(state.blockedReasons).toEqual({ b: "waiting_on_dependencies" })
  })

  it("promotes a dependent only after every dependency completes", () => {
    let state = createTaskGraph([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: [] }, { id: "join", dependsOn: ["a", "b"] }])
    state = apply(state, event("start", "a", "1"))
    state = apply(state, event("complete", "a", "2"))
    expect(state.statuses.join).toBe("pending")
    state = apply(state, event("start", "b", "3"))
    state = apply(state, event("complete", "b", "4"))
    expect(state.readyNodeIds).toEqual(["join"])
  })

  it("allows a waiting node to resume and complete", () => {
    let state = createTaskGraph([{ id: "a", dependsOn: [] }])
    state = apply(state, event("start", "a", "1"))
    state = apply(state, event("wait", "a", "2"))
    expect(state.statuses.a).toBe("waiting")
    state = apply(state, event("start", "a", "3"))
    state = apply(state, event("complete", "a", "4"))
    expect(state.statuses.a).toBe("completed")
  })

  it("keeps descendants blocked after failure", () => {
    let state = createTaskGraph([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }])
    state = apply(state, event("start", "a", "1"))
    state = apply(state, event("fail", "a", "2"))
    expect(state.readyNodeIds).toEqual([])
    expect(state.blockedReasons).toMatchObject({ b: "dependency_failed", c: "dependency_failed" })
  })

  it("keeps descendants blocked after cancellation", () => {
    let state = createTaskGraph([{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }])
    state = apply(state, event("cancel", "a", "1"))
    expect(state.statuses).toMatchObject({ a: "cancelled", b: "pending" })
    expect(state.readyNodeIds).toEqual([])
    expect(state.blockedReasons.b).toBe("dependency_failed")
  })

  it("fails closed for unknown nodes and illegal transitions without mutation", () => {
    const state = createTaskGraph([{ id: "a", dependsOn: [] }])
    const unknown = reduceTaskGraph(state, event("start", "missing", "1"))
    expect(unknown).toMatchObject({ ok: false, errorCode: "unknown_node" })
    expect(state.statuses.a).toBe("ready")
    const illegal = reduceTaskGraph(state, event("complete", "a", "2"))
    expect(illegal).toMatchObject({ ok: false, errorCode: "illegal_transition" })
  })

  it("makes an identical duplicate event idempotent", () => {
    const state = apply(createTaskGraph([{ id: "a", dependsOn: [] }]), event("start", "a", "1"))
    const duplicate = reduceTaskGraph(state, event("start", "a", "1"))
    expect(duplicate).toEqual({ ok: true, state })
  })

  it("rejects a conflicting duplicate event id", () => {
    const state = apply(createTaskGraph([{ id: "a", dependsOn: [] }]), event("start", "a", "1"))
    const duplicate = reduceTaskGraph(state, event("cancel", "a", "1"))
    expect(duplicate).toMatchObject({ ok: false, errorCode: "duplicate_event" })
    expect(state.statuses.a).toBe("running")
  })

  it("rejects missing dependencies and cycles at construction", () => {
    expect(() => createTaskGraph([{ id: "a", dependsOn: ["missing"] }])).toThrowError(TaskGraphError)
    expect(() => createTaskGraph([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }])).toThrowError(/cycle/)
  })

  it("fails closed for malformed events", () => {
    const state = createTaskGraph([{ id: "a", dependsOn: [] }])
    const result = reduceTaskGraph(state, { type: "start", nodeId: "a", eventId: "" })
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_event" })
    expect(result.state).toEqual(state)
  })
})
