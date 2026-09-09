import { describe, expect, it, vi } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { dispatchPlanProposal, type PlanDispatchRuntime, type PlanDispatchResult } from "./plan-intent-dispatcher.js"
import { executePlanCommands, type PlanCommandExecutionRuntime } from "./plan-command-executor.js"
import type { PlanValidationContext } from "./goal-plan-validator.js"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"

const validation: PlanValidationContext = {
  goalRevision: 1, planRevision: null, maxNodes: 8,
  allowedActions: ["use_tool", "delegate", "request_input", "propose_completion"],
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
function context(request: { localId: string; kind: "tool_call" | "delegate" }): ToolRouterContext {
  return { scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: `step:${request.localId}`, actorRole: "orchestrator", capabilities: ["read"], signal: new AbortController().signal }
}
function runtime(router: PlanCommandExecutionRuntime["router"], createContext = context): PlanCommandExecutionRuntime {
  return { router, createContext }
}
function completed(request: ToolCallRequest): ToolExecutionResult {
  return { ...request, status: "completed", output: { observed: request.id }, errorCode: null }
}

describe("executePlanCommands", () => {
  it("executes tool and delegate commands in order through the router", async () => {
    const requests: ToolCallRequest[] = []
    const contexts: Array<{ localId: string; kind: "tool_call" | "delegate" }> = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => { requests.push(request); return completed(request) }) }
    const plan = dispatch([use("search", { inputRefs: ["goal"] }), delegate("child", { dependsOn: ["search"] })])
    const result = await executePlanCommands(plan, { router, createContext: request => { contexts.push(request); return context(request) } })
    expect(result.status).toBe("completed")
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ id: "call:child", toolName: "spawn_subagent", toolVersion: "1", input: { idempotencyKey: "idem:child", role: "scout" } })
    expect(contexts).toEqual([{ localId: "search", kind: "tool_call" }, { localId: "child", kind: "delegate" }])
    expect(result.completed[0]).toMatchObject({ localId: "search", dependsOn: [], result: { status: "completed", id: "call:search" } })
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
