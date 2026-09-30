import { describe, expect, it } from "vitest"

import {
  appendTaskGraphProposal,
  createInitialTaskGraphState,
  deriveReadyTaskGraphNodes,
  deriveTaskGraphReadModel,
  reduceTaskGraphEvent,
  validateTaskGraphProposal,
  type TaskGraphNodeProposal,
  type TaskGraphNodeStatus,
  type TaskGraphState,
  type TaskGraphValidationOptions,
} from "./task-graph.js"

const options: TaskGraphValidationOptions = {
  registeredTemplateIds: new Set(["scout", "analyst", "writer"]), maxNodes: 8, maxDepth: 4,
}
function node(key: string, overrides: Partial<TaskGraphNodeProposal> = {}): TaskGraphNodeProposal {
  return { key, templateId: "scout", goal: `Research ${key}`, successCriteria: [`Evidence for ${key}`], dependsOn: [], ...overrides }
}
function append(state: TaskGraphState, nodes: readonly TaskGraphNodeProposal[], limits = options): TaskGraphState {
  const result = appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes }, limits)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.state
}
function event(state: TaskGraphState, type: string, nodeKey: string, idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return reduceTaskGraphEvent(state, { type, nodeKey, idempotencyKey, expectedRevision: state.revision, ...extra })
}
function transition(state: TaskGraphState, type: string, nodeKey: string, idempotencyKey: string, extra: Record<string, unknown> = {}): TaskGraphState {
  const result = event(state, type, nodeKey, idempotencyKey, extra)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.state
}
function withNodeStatus(state: TaskGraphState, key: string, status: TaskGraphNodeStatus): TaskGraphState {
  return { ...state, nodes: state.nodes.map(item => item.key === key ? { ...item, status } : item) }
}
function stateAtStatus(status: TaskGraphNodeStatus): TaskGraphState {
  let state = append(createInitialTaskGraphState(), [node("a")])
  if (status === "queued") return state
  if (status === "interrupted" || status === "cancelled") return transition(state, `task.${status}`, "a", `set-${status}`)
  if (status === "closed") return transition(state, "task.closed", "a", "set-closed")
  if (status === "retrying") return withNodeStatus(state, "a", "retrying")
  state = transition(state, "task.started", "a", "set-running")
  if (status === "running") return state
  if (status === "waiting") return transition(state, "task.waiting", "a", "set-waiting")
  if (status === "waiting_for_user") return transition(state, "task.waiting_for_user", "a", "set-waiting-for-user")
  if (status === "completed") return transition(state, "task.completed", "a", "set-completed")
  if (status === "failed") return transition(state, "task.failed", "a", "set-failed", { failureReason: "failed" })
  throw new Error(`Unsupported test status: ${status}`)
}

describe("TaskGraph planning kernel", () => {
  it("rejects malformed exact-shape proposals and unregistered templates", () => {
    const state = createInitialTaskGraphState()
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a")], extra: true }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [{ ...node("a"), extra: true }] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { successCriteria: [] })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { templateId: "unregistered" })] }, state, options)).toMatchObject({ ok: false, error: { code: "unknown_template" } })
    expect(event(state, "toString", "a", "prototype-event")).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })

  it("rejects duplicate keys, missing dependencies, cycles, and caller bounds", () => {
    const state = createInitialTaskGraphState()
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("a")] }, state, options)).toMatchObject({ ok: false, error: { code: "duplicate_key" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { dependsOn: ["missing"] })] }, state, options)).toMatchObject({ ok: false, error: { code: "missing_dependency" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("sparse-criteria", { successCriteria: new Array<string>(1) })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape", path: "nodes[0].successCriteria" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("sparse-dependencies", { dependsOn: new Array<string>(1) })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape", path: "nodes[0].dependsOn" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })] }, state, options)).toMatchObject({ ok: false, error: { code: "dependency_cycle" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("b"), node("c")] }, state, { ...options, maxNodes: 2 })).toMatchObject({ ok: false, error: { code: "node_limit" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("b", { dependsOn: ["a"] })] }, state, { ...options, maxDepth: 1 })).toMatchObject({ ok: false, error: { code: "depth_limit" } })
    const forward = append(state, [node("child", { dependsOn: ["parent"] }), node("parent")])
    expect(forward.nodes.map(item => [item.key, item.depth])).toEqual([["child", 2], ["parent", 1]])
    expect(deriveReadyTaskGraphNodes(forward).map(item => item.key)).toEqual(["parent"])
  })

  it("enforces canonical persisted field and graph limits even when caller bounds are looser", () => {
    const state = createInitialTaskGraphState()
    const oversizedTemplateId = "t".repeat(129)
    const looseOptions: TaskGraphValidationOptions = {
      registeredTemplateIds: new Set([...options.registeredTemplateIds, oversizedTemplateId]),
      maxNodes: 16,
      maxDepth: 16,
    }
    const invalidNodes = [
      node("long-goal", { goal: "g".repeat(1201) }),
      node("long-criterion", { successCriteria: ["c".repeat(321)] }),
      node("too-many-criteria", { successCriteria: Array.from({ length: 9 }, (_, index) => `criterion ${index}`) }),
      node("long-key", { key: "k".repeat(129) }),
      node("long-template", { templateId: oversizedTemplateId }),
    ]
    for (const invalid of invalidNodes) {
      expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [invalid] }, state, looseOptions)).toMatchObject({
        ok: false, error: { code: "invalid_shape" },
      })
    }
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: Array.from({ length: 9 }, (_, index) => node(`node-${index}`)) }, state, looseOptions))
      .toMatchObject({ ok: false, error: { code: "node_limit" } })
  })

  it("derives parallel ready nodes in stable proposal order", () => {
    let state = append(createInitialTaskGraphState(), [node("z"), node("a"), node("after-z", { dependsOn: ["z"] })])
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["z", "a"])
    state = transition(state, "task.started", "z", "start-z")
    state = transition(state, "task.completed", "z", "complete-z")
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["a", "after-z"])
  })

  it("fences revisions, replays exact events idempotently, and rejects idempotency-key reuse", () => {
    let state = append(createInitialTaskGraphState(), [node("a")])
    expect(appendTaskGraphProposal(state, { expectedRevision: 0, nodes: [node("stale")] }, options)).toMatchObject({ ok: false, error: { code: "revision_mismatch" } })
    const start = { type: "task.started", nodeKey: "a", idempotencyKey: "event-1", expectedRevision: state.revision }
    const first = reduceTaskGraphEvent(state, start)
    expect(first).toMatchObject({ ok: true, duplicate: false })
    if (!first.ok) throw new Error(first.error.message)
    state = first.state
    const replay = reduceTaskGraphEvent(state, start)
    expect(replay).toMatchObject({ ok: true, duplicate: true })
    if (replay.ok) expect(replay.state).toBe(state)
    expect(reduceTaskGraphEvent(state, { ...start, type: "task.waiting" })).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(reduceTaskGraphEvent(state, { type: "task.completed", nodeKey: "a", idempotencyKey: "event-2", expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "revision_mismatch" } })
  })

  it("appends without rewriting active or completed nodes", () => {
    let state = append(createInitialTaskGraphState(), [node("active"), node("done")])
    state = transition(state, "task.started", "active", "start-active")
    state = transition(state, "task.started", "done", "start-done")
    state = transition(state, "task.completed", "done", "complete-done")
    const prior = state
    expect(appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes: [node("done", { goal: "rewrite" })] }, options)).toMatchObject({ ok: false, error: { code: "duplicate_key" } })
    const result = appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes: [node("follow-up", { dependsOn: ["done"] })] }, options)
    expect(result).toMatchObject({ ok: true, state: { revision: state.revision + 1 } })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.state.nodes[0]).toBe(prior.nodes[0])
    expect(result.state.nodes[1]).toBe(prior.nodes[1])
    expect(result.state.nodes.slice(0, 2).map(item => [item.goal, item.status])).toEqual([["Research active", "running"], ["Research done", "completed"]])
    expect(prior.nodes).toHaveLength(2)
  })

  it("maps waiting and cancellation to Worker statuses and exposes blocked dependencies", () => {
    let state = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] }), node("leaf", { dependsOn: ["child"] })])
    state = transition(state, "task.started", "root", "start-root")
    state = transition(state, "task.waiting", "root", "wait-root")
    expect(deriveTaskGraphReadModel(state).map(item => [item.key, item.status, item.readiness])).toEqual([
      ["root", "waiting", "ready"], ["child", "queued", "waiting_for_dependencies"], ["leaf", "queued", "waiting_for_dependencies"],
    ])
    state = transition(state, "task.cancelled", "root", "cancel-root")
    expect(deriveTaskGraphReadModel(state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency", "blocked_dependency"])
    expect(deriveReadyTaskGraphNodes(state)).toEqual([])
  })

  it("propagates final failure through descendants and rejects starting blocked work", () => {
    let state = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] }), node("leaf", { dependsOn: ["child"] })])
    state = transition(state, "task.started", "root", "start-root")
    const failed = event(state, "task.failed", "root", "fail-root", { failureReason: "No evidence" })
    expect(failed).toMatchObject({ ok: true })
    if (!failed.ok) throw new Error(failed.error.message)
    state = failed.state
    expect(state.nodes[0]).toMatchObject({ status: "failed", failureReason: "No evidence" })
    expect(deriveTaskGraphReadModel(state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency", "blocked_dependency"])
    expect(event(state, "task.started", "leaf", "start-leaf")).toMatchObject({ ok: false, error: { code: "blocked_dependency" } })
  })

  it("derives waiting-node readiness from dependencies without dispatching waiting tasks", () => {
    const graph = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] })])
    const waiting = withNodeStatus(graph, "child", "waiting")
    expect(deriveTaskGraphReadModel(waiting).map(item => [item.key, item.readiness])).toEqual([
      ["root", "ready"], ["child", "waiting_for_dependencies"],
    ])
    expect(deriveReadyTaskGraphNodes(waiting).map(item => item.key)).toEqual(["root"])
    expect(event(waiting, "task.queued", "child", "queue-too-early")).toMatchObject({ ok: false, error: { code: "dependencies_incomplete" } })

    const completedDependency = withNodeStatus(waiting, "root", "completed")
    expect(deriveTaskGraphReadModel(completedDependency).find(item => item.key === "child")?.readiness).toBe("ready")
    expect(deriveReadyTaskGraphNodes(completedDependency)).toEqual([])
    const queued = event(completedDependency, "task.queued", "child", "queue-after-dependency")
    expect(queued).toMatchObject({ ok: true, duplicate: false })
    if (!queued.ok) throw new Error(queued.error.message)
    expect(queued.state.nodes.find(item => item.key === "child")?.status).toBe("queued")
    expect(deriveReadyTaskGraphNodes(queued.state).map(item => item.key)).toEqual(["child"])

    const failedDependency = withNodeStatus(waiting, "root", "failed")
    expect(deriveTaskGraphReadModel(failedDependency).find(item => item.key === "child")?.readiness).toBe("blocked_dependency")
    expect(event(failedDependency, "task.queued", "child", "queue-after-failure")).toMatchObject({ ok: false, error: { code: "blocked_dependency" } })
  })

  it("records retrying tasks as queued, matching the durable Worker status", () => {
    let state = append(createInitialTaskGraphState(), [node("retry")])
    state = transition(state, "task.started", "retry", "start-retry")
    state = transition(state, "task.retrying", "retry", "retry-again")
    expect(state.nodes[0]?.status).toBe("queued")
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["retry"])
  })

  it.each(["queued", "running", "retrying", "waiting", "waiting_for_user"] as const)("closes a %s task and blocks its dependents", status => {
    const initial = stateAtStatus(status)
    const withChild = append(initial, [node("child", { dependsOn: ["a"] })])
    const result = event(withChild, "task.closed", "a", `close-${status}`)
    expect(result).toMatchObject({ ok: true, duplicate: false })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.state.nodes[0]?.status).toBe("closed")
    expect(deriveTaskGraphReadModel(result.state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency"])
  })

  it.each(["completed", "failed", "interrupted", "cancelled", "closed"] as const)("rejects closing a %s terminal task", status => {
    const state = stateAtStatus(status)
    expect(event(state, "task.closed", "a", `close-terminal-${status}`)).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })
})
