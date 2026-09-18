import { describe, expect, it, vi } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { dispatchPlanProposal, type PlanDispatchRuntime, type PlanDispatchResult } from "./plan-intent-dispatcher.js"
import { executePlanCommands, type CommandContextRequest, type PlanCommandExecutionRuntime } from "./plan-command-executor.js"
import type { PlanValidationContext } from "./goal-plan-validator.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"

const validation: PlanValidationContext = {
  goalRevision: 1, planRevision: null, maxNodes: 8,
  allowedActions: ["use_tool", "delegate", "join", "request_input", "propose_completion"],
  allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"],
}
const base = { inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null }
function proposal(nodes: PlanProposal["nodes"]): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes, completionCriteria: ["finish"], briefRationale: "bounded" }
}
function use(localId: string, overrides: Partial<PlanProposal["nodes"][number]> = {}) {
  return { ...base, localId, kind: "use_tool" as const, objective: `Read ${localId}`, toolName: "jobs.search", ...overrides }
}
function delegate(localId: string, overrides: Partial<PlanProposal["nodes"][number]> = {}) {
  return { ...base, localId, kind: "delegate" as const, objective: `Delegate ${localId}`, role: "scout", taskType: "research", ...overrides }
}
function dispatch(nodes: PlanProposal["nodes"]): PlanDispatchResult {
  const runtime: PlanDispatchRuntime = {
    resolveToolVersion: () => "1", createToolCallId: id => `call:${id}`, createIdempotencyKey: id => `idem:${id}`,
    resolveInputRefs: request => ({ from: request.inputRefs[0] }), resolveDelegateActions: () => ["jobs.search"],
  }
  return dispatchPlanProposal(proposal(nodes), validation, runtime)
}
function context(request: CommandContextRequest): ToolRouterContext {
  return { scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: `step:${request.localId}`, actorRole: "orchestrator", capabilities: ["read"], signal: new AbortController().signal }
}
function runtime(router: PlanCommandExecutionRuntime["router"], createContext = context): PlanCommandExecutionRuntime {
  return { router, createContext }
}
function completed(request: ToolCallRequest): ToolExecutionResult {
  return { ...request, status: "completed", output: { observed: request.id }, errorCode: null }
}
function legacyCoordinationNames(plan: PlanDispatchResult): PlanDispatchResult {
  return {
    ...plan,
    commands: plan.commands.map(command => command.kind === "delegate"
      ? { ...command, call: { ...command.call, toolName: "spawn_subagent" as const } }
      : command.kind === "join"
        ? { ...command, call: { ...command.call, toolName: "wait_subagents" as const } }
        : command),
  }
}

describe("executePlanCommands", () => {
  it("executes tool and delegate commands in order through the router", async () => {
    const requests: ToolCallRequest[] = []
    const contexts: CommandContextRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => { requests.push(request); return completed(request) }) }
    const plan = dispatch([use("search", { inputRefs: ["goal"] }), delegate("child", { dependsOn: ["search"] })])
    const result = await executePlanCommands(plan, { router, createContext: request => { contexts.push(request); return context(request) } })
    expect(result.status).toBe("completed")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ id: "call:child", toolName: "agent.spawn", toolVersion: "1", input: { idempotencyKey: "idem:child", role: "scout" } })
    expect(contexts).toEqual([{ localId: "search", kind: "tool_call" }, { localId: "child", kind: "delegate" }])
    expect(result.completed[0]).toMatchObject({ localId: "search", dependsOn: [], result: { status: "completed", id: "call:search" } })
  })

  it("accepts legacy coordination names and preserves them in router requests", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      if (request.toolName === "spawn_subagent") return { ...request, status: "completed" as const, output: { taskId: "task-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "ready", taskIds: ["task-1"], matchedTaskIds: ["task-1"], tasks: [{ taskId: "task-1", status: "completed", role: "scout", result: null, failureReason: null }] }, errorCode: null }
    }) }
    const join = { ...base, localId: "join", kind: "join" as const, objective: "Join child", inputRefs: ["child"], dependsOn: ["child"], joinMode: "all" as const, timeoutMs: 5_000 }
    const result = await executePlanCommands(legacyCoordinationNames(dispatch([delegate("child"), join])), { ...runtime(router), rootTaskId: "root-1" })
    expect(result.status).toBe("completed")
    expect(requests.map(request => `${request.toolName}@${request.toolVersion}`)).toEqual(["spawn_subagent@1", "wait_subagents@1"])
  })

  it("fails closed for malformed canonical delegate input before routing", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => completed(request)) }
    const plan = dispatch([delegate("child")])
    const forged: PlanDispatchResult = {
      ...plan,
      commands: plan.commands.map(command => command.kind === "delegate"
        ? { ...command, call: { ...command.call, input: { ...command.call.input, taskId: "foreign-task" } } }
        : command),
    }
    await expect(executePlanCommands(forged, runtime(router))).rejects.toMatchObject({ code: "invalid_plan" })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("keeps delegate execution serial unless the server-owned bound is set", async () => {
    let active = 0
    let peak = 0
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return completed(request)
    }) }
    const result = await executePlanCommands(dispatch([delegate("first"), delegate("second")]), runtime(router))
    expect(result.status).toBe("completed")
    expect(peak).toBe(1)
    expect(router.execute.mock.calls.map(call => call[1].id)).toEqual(["call:first", "call:second"])
  })

  it("starts independent delegates concurrently and observes them in plan order", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>(resolve => { resolveSecondStarted = resolve })
    const started: string[] = []
    const observed: string[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      started.push(request.id)
      if (started.length === 2) resolveSecondStarted()
      if (request.id === "call:first") await firstGate
      return completed(request)
    }) }
    const execution = executePlanCommands(dispatch([delegate("first"), delegate("second")]), {
      ...runtime(router), parallelDelegateLimit: 2,
      observe: record => { observed.push(record.localId) },
    })
    await secondStarted
    expect(started).toEqual(["call:first", "call:second"])
    releaseFirst()
    const result = await execution
    expect(result.status).toBe("completed")
    expect(observed).toEqual(["first", "second"])
    expect(result.completed.map(record => record.localId)).toEqual(["first", "second"])
  })

  it("never exceeds the server-owned delegate concurrency bound", async () => {
    let active = 0
    let peak = 0
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return completed(request)
    }) }
    const nodes = Array.from({ length: 8 }, (_, index) => delegate(`child-${index}`))
    const result = await executePlanCommands(dispatch(nodes), { ...runtime(router), parallelDelegateLimit: 2 })
    expect(result.status).toBe("completed")
    expect(router.execute).toHaveBeenCalledTimes(8)
    expect(peak).toBe(2)
  })

  it("waits for a dependency layer and keeps a control command as a barrier", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let resolveIndependentStarted!: () => void
    const independentStarted = new Promise<void>(resolve => { resolveIndependentStarted = resolve })
    const started: string[] = []
    const observed: string[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      started.push(request.id)
      if (request.id === "call:independent") resolveIndependentStarted()
      if (request.id === "call:first") await firstGate
      return completed(request)
    }) }
    const ask = { ...base, localId: "ask", kind: "request_input" as const, objective: "Need input", question: "Where?", dependsOn: ["first", "independent"] }
    const execution = executePlanCommands(dispatch([delegate("first"), delegate("independent"), delegate("dependent", { dependsOn: ["first"] }), ask]), {
      ...runtime(router), parallelDelegateLimit: 2,
      observe: record => { observed.push(record.localId) },
    })
    await independentStarted
    expect(started).toEqual(["call:first", "call:independent"])
    releaseFirst()
    const result = await execution
    expect(result.status).toBe("blocked")
    expect(started).toEqual(["call:first", "call:independent", "call:dependent"])
    expect(observed).toEqual(["first", "independent", "dependent", "ask"])
    expect(router.execute).toHaveBeenCalledTimes(3)
  })

  it("fails closed after a parallel sibling fails while preserving observation order", async () => {
    let releaseSecond!: () => void
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>(resolve => { resolveSecondStarted = resolve })
    const observed: string[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.id === "call:second") { resolveSecondStarted(); await secondGate; return completed(request) }
      return { ...request, status: "failed" as const, errorCode: "policy_denied" }
    }) }
    const execution = executePlanCommands(dispatch([delegate("first"), delegate("second")]), {
      ...runtime(router), parallelDelegateLimit: 2,
      observe: record => { observed.push(record.localId) },
    })
    await secondStarted
    releaseSecond()
    const result = await execution
    expect(result).toMatchObject({ status: "failed", completed: [], failure: { localId: "first", result: { errorCode: "policy_denied" } } })
    expect(observed).toEqual(["first", "second"])
  })

  it("surfaces observer failure after attempting sibling observations in order", async () => {
    const observed: string[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => completed(request)) }
    await expect(executePlanCommands(dispatch([delegate("first"), delegate("second")]), {
      ...runtime(router), parallelDelegateLimit: 2,
      observe: record => {
        observed.push(record.localId)
        if (record.localId === "first") throw new Error("observer unavailable")
      },
    })).rejects.toMatchObject({ code: "observer_failed" })
    expect(observed).toEqual(["first", "second"])
  })

  it("resolves completed local output before routing a dependent command", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      return { ...request, status: "completed" as const, output: request.toolName === "jobs.search" ? { jobId: "job-1" } : { ok: true }, errorCode: null }
    }) }
    const plan = dispatch([use("first"), use("second", { inputRefs: ["first"] })])
    const result = await executePlanCommands(plan, {
      ...runtime(router),
      resolveInputRefs: request => ({ observedJob: request.outputs.get("first") }),
    })
    expect(result.status).toBe("completed")
    expect(requests[1]?.input).toEqual({ observedJob: { jobId: "job-1" } })
  })

  it("passes dependent output to a delegate as server-owned context", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      return { ...request, status: "completed" as const, output: { childId: "child-1" }, errorCode: null }
    }) }
    const plan = dispatch([use("first"), delegate("child", { inputRefs: ["first"], dependsOn: ["first"] })])
    await expect(executePlanCommands(plan, {
      ...runtime(router),
      resolveInputRefs: request => ({ source: request.outputs.get("first") }),
    })).resolves.toMatchObject({ status: "completed" })
    expect(requests[1]?.input).toMatchObject({ role: "scout", context: { source: { childId: "child-1" } } })
  })

  it.each(["all", "any"] as const)("routes a %s join with server-produced delegate task IDs", async mode => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      if (request.toolName === "agent.spawn") {
        const taskId = request.id.endsWith(":first") ? "task-1" : "task-2"
        return { ...request, status: "completed" as const, output: { taskId, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      }
      return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "ready", taskIds: ["task-1", "task-2"], matchedTaskIds: ["task-1", "task-2"], tasks: [{ taskId: "task-1", status: "completed", role: "scout", result: null, failureReason: null }, { taskId: "task-2", status: "completed", role: "scout", result: null, failureReason: null }] }, errorCode: null }
    }) }
    const join = { ...base, localId: "join", kind: "join" as const, objective: "Join children", inputRefs: ["first", "second"], dependsOn: ["first", "second"], joinMode: mode, timeoutMs: 5_000 }
    const plan = dispatch([delegate("first"), delegate("second"), join])
    const result = await executePlanCommands(plan, { ...runtime(router), rootTaskId: "root-1" })
    expect(result.status).toBe("completed")
    expect(requests[2]?.input).toMatchObject({ taskIds: ["task-1", "task-2"], mode, timeoutMs: 5_000 })
  })

  it("accepts a waiting join without task evidence for adapter compatibility", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.toolName === "agent.spawn") return { ...request, status: "completed" as const, output: { taskId: "task-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "waiting", taskIds: ["task-1"], matchedTaskIds: [] }, errorCode: null }
    }) }
    const result = await executePlanCommands(dispatch([delegate("child"), { ...base, localId: "join", kind: "join" as const, objective: "Join child", inputRefs: ["child"], dependsOn: ["child"], joinMode: "all" as const, timeoutMs: 5_000 }]), { ...runtime(router), rootTaskId: "root-1" })
    expect(result.status).toBe("waiting")
    expect(result.waiting?.result.output).not.toHaveProperty("tasks")
  })

  it("rejects malformed ready join task evidence", async () => {
    const validTask = (taskId: string) => ({ taskId, status: "completed", role: "scout", result: null, failureReason: null })
    const invalidTasks: unknown[][] = [
      [validTask("task-1")],
      [validTask("task-1"), validTask("task-1")],
      [validTask("task-1"), { ...validTask("task-2"), taskId: "foreign-task" }],
      [validTask("task-1"), { ...validTask("task-2"), result: { sessionId: "foreign-session" } }],
      [validTask("task-1"), { ...validTask("task-2"), result: { nested: { taskId: "foreign-task" } } }],
      [validTask("task-1"), { ...validTask("task-2"), extra: true }],
    ]
    for (const tasks of invalidTasks) {
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
        if (request.toolName === "agent.spawn") {
          const taskId = request.id.endsWith(":first") ? "task-1" : "task-2"
          return { ...request, status: "completed" as const, output: { taskId, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
        }
        return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "ready", taskIds: ["task-1", "task-2"], matchedTaskIds: ["task-1"], tasks }, errorCode: null }
      }) }
      const join = { ...base, localId: "join", kind: "join" as const, objective: "Join children", inputRefs: ["first", "second"], dependsOn: ["first", "second"], joinMode: "all" as const, timeoutMs: 5_000 }
      await expect(executePlanCommands(dispatch([delegate("first"), delegate("second"), join]), { ...runtime(router), rootTaskId: "root-1" })).rejects.toMatchObject({ code: "router_result_mismatch" })
      expect(router.execute).toHaveBeenCalledTimes(3)
    }
  })

  it("rejects foreign or duplicate target and matched IDs", async () => {
    const validTasks = [
      { taskId: "task-1", status: "completed", role: "scout", result: null, failureReason: null },
      { taskId: "task-2", status: "completed", role: "scout", result: null, failureReason: null },
    ]
    const invalidIds = [
      { taskIds: ["task-1", "foreign"], matchedTaskIds: ["task-1"] },
      { taskIds: ["task-1", "task-1"], matchedTaskIds: ["task-1"] },
      { taskIds: ["task-1", "task-2"], matchedTaskIds: ["foreign"] },
      { taskIds: ["task-1", "task-2"], matchedTaskIds: ["task-1", "task-1"] },
    ]
    for (const ids of invalidIds) {
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
        if (request.toolName === "agent.spawn") {
          const taskId = request.id.endsWith(":first") ? "task-1" : "task-2"
          return { ...request, status: "completed" as const, output: { taskId, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
        }
        return { ...request, status: "completed" as const, output: { waitId: "wait-ids", status: "ready", ...ids, tasks: validTasks }, errorCode: null }
      }) }
      const join = { ...base, localId: "join", kind: "join" as const, objective: "Join children", inputRefs: ["first", "second"], dependsOn: ["first", "second"], joinMode: "all" as const, timeoutMs: 5_000 }
      await expect(executePlanCommands(dispatch([delegate("first"), delegate("second"), join]), { ...runtime(router), rootTaskId: "root-1" })).rejects.toMatchObject({ code: "router_result_mismatch" })
      expect(router.execute).toHaveBeenCalledTimes(3)
    }
  })

  it.each([
    ["ready", ["task-1"]],
    ["timed_out", []],
  ] as const)("accepts valid %s join target and matched IDs", async (status, matchedTaskIds) => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.toolName === "agent.spawn") {
        const taskId = request.id.endsWith(":first") ? "task-1" : "task-2"
        return { ...request, status: "completed" as const, output: { taskId, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      }
      return { ...request, status: "completed" as const, output: {
        waitId: `wait-${status}`, status, taskIds: ["task-1", "task-2"], matchedTaskIds,
        tasks: [
          { taskId: "task-1", status: "completed", role: "scout", result: null, failureReason: null },
          { taskId: "task-2", status: "completed", role: "scout", result: null, failureReason: null },
        ],
      }, errorCode: null }
    }) }
    const join = { ...base, localId: "join", kind: "join" as const, objective: "Join children", inputRefs: ["first", "second"], dependsOn: ["first", "second"], joinMode: "all" as const, timeoutMs: 5_000 }
    await expect(executePlanCommands(dispatch([delegate("first"), delegate("second"), join]), { ...runtime(router), rootTaskId: "root-1" })).resolves.toMatchObject({ status: "completed" })
    expect(router.execute).toHaveBeenCalledTimes(3)
  })

  it("fails a join before routing when delegate output is missing or duplicated", async () => {
    for (const outputs of [[{ ok: true }, { taskId: "task-2", rootTaskId: "root-1", parentTaskId: "root-1" }], [{ taskId: "task-1", rootTaskId: "root-1", parentTaskId: "root-1" }, { taskId: "task-1", rootTaskId: "root-1", parentTaskId: "root-1" }], [{ taskId: "task-1" }, { taskId: "task-2", rootTaskId: "root-1", parentTaskId: "root-1" }]]) {
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: request.id.endsWith(":first") ? outputs[0] : outputs[1], errorCode: null })) }
      const join = { ...base, localId: "join", kind: "join" as const, objective: "Join children", inputRefs: ["first", "second"], dependsOn: ["first", "second"], joinMode: "all" as const, timeoutMs: 5_000 }
      const plan = dispatch([delegate("first"), delegate("second"), join])
      await expect(executePlanCommands(plan, { ...runtime(router), rootTaskId: "root-1" })).rejects.toMatchObject({ code: "input_reference_unavailable" })
      expect(router.execute).toHaveBeenCalledTimes(2)
    }
  })

  it("rejects a join command with prefilled task IDs before routing", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { taskId: "task-1", rootTaskId: "root-1", parentTaskId: "root-1" }, errorCode: null })) }
    const plan = dispatch([delegate("child"), { ...({ ...base, localId: "join", kind: "join" as const, objective: "Join child", inputRefs: ["child"], dependsOn: ["child"], joinMode: "all" as const, timeoutMs: 5_000 }) }])
    const join = plan.commands.find(command => command.kind === "join")
    if (!join || join.kind !== "join") throw new Error("join command missing")
    const forged: PlanDispatchResult = { ...plan, commands: plan.commands.map(command => command.kind === "join" && command.localId === join.localId ? { ...command, call: { ...command.call, input: { ...command.call.input, taskIds: ["forged-task"] } } } : command) }
    await expect(executePlanCommands(forged, { ...runtime(router), rootTaskId: "root-1" })).rejects.toMatchObject({ code: "invalid_plan" })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("fails before the router when a referenced output cannot be resolved", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const plan = dispatch([use("first"), use("second", { inputRefs: ["first"] })])
    await expect(executePlanCommands(plan, { ...runtime(router), resolveInputRefs: () => undefined })).rejects.toMatchObject({ code: "input_reference_unavailable" })
    expect(router.execute).toHaveBeenCalledTimes(1)
  })

  it("fails closed for deferred references when no resolver is provided", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const deferred = dispatchPlanProposal(proposal([use("read", { inputRefs: ["prior"] })]), validation, { resolveToolVersion: () => "1", createToolCallId: id => `call:${id}`, resolveDelegateActions: () => ["jobs.search"], deferInputRefs: true })
    await expect(executePlanCommands(deferred, runtime(router))).rejects.toMatchObject({ code: "input_reference_unavailable" })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("returns a failed status and stops after a failed or cancelled router result", async () => {
    const execute = vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "failed" as const, output: { safe: true }, errorCode: "policy_denied" }))
    const result = await executePlanCommands(dispatch([use("first"), use("second")]), runtime({ execute }))
    expect(result).toMatchObject({ status: "failed", completed: [], failure: { localId: "first", result: { errorCode: "policy_denied" } } })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("fails closed for router identity mismatches and malformed results", async () => {
    const mismatch = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...completed(request), id: "wrong-call" })) }
    await expect(executePlanCommands(dispatch([use("read")]), runtime(mismatch))).rejects.toMatchObject({ code: "router_result_mismatch" })
    const malformed = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "unexpected", errorCode: null } as unknown as ToolExecutionResult)) }
    await expect(executePlanCommands(dispatch([use("read")]), runtime(malformed))).rejects.toMatchObject({ code: "router_result_mismatch" })
    const oversized = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: "x".repeat(8 * 1024 + 1), errorCode: null })) }
    await expect(executePlanCommands(dispatch([use("read")]), runtime(oversized))).rejects.toMatchObject({ code: "router_result_mismatch" })
  })

  it("returns explicit control barriers without invoking the router", async () => {
    const router = { execute: vi.fn() }
    const createContext = vi.fn(context)
    const waiting = await executePlanCommands(dispatch([{ ...base, localId: "ask", kind: "request_input", objective: "Need a location", question: "Where?" }, use("later", { dependsOn: ["ask"] })]), runtime(router, createContext))
    expect(waiting).toMatchObject({ status: "blocked", blocked: { localId: "ask", question: "Where?" } })
    const complete = await executePlanCommands(dispatch([{ ...base, localId: "finish", kind: "propose_completion", objective: "Finish", successCriteria: ["verified"] }, use("later", { dependsOn: ["finish"] })]), runtime(router, createContext))
    expect(complete).toMatchObject({ status: "blocked", blocked: { localId: "finish", completionCriteria: ["finish", "verified"] } })
    expect(router.execute).not.toHaveBeenCalled()
    expect(createContext).not.toHaveBeenCalled()
  })

  it("fails clearly when router/context is absent or commands exceed the bound", async () => {
    const plan = dispatch([use("read")])
    await expect(executePlanCommands(plan, { createContext: context })).rejects.toMatchObject({ code: "runtime_unavailable" })
    await expect(executePlanCommands(plan, { router: { execute: vi.fn() } })).rejects.toMatchObject({ code: "runtime_unavailable" })
    const tooMany: PlanDispatchResult = { ...plan, commands: Array.from({ length: 9 }, () => plan.commands[0]!) }
    await expect(executePlanCommands(tooMany, runtime({ execute: vi.fn() }))).rejects.toMatchObject({ code: "invalid_plan" })
  })
})
