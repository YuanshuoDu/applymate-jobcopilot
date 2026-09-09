import { describe, expect, it } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { dispatchPlanProposal, type PlanDispatchRuntime } from "./plan-intent-dispatcher.js"
import type { PlanValidationContext } from "./goal-plan-validator.js"

const validation: PlanValidationContext = {
  goalRevision: 1, planRevision: null, maxNodes: 8,
  allowedActions: ["use_tool", "delegate", "request_input", "propose_completion"],
  allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"],
}

const base = { inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null }
function proposal(nodes: PlanProposal["nodes"], overrides: Partial<PlanProposal> = {}): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes, completionCriteria: ["finish"], briefRationale: "bounded", ...overrides }
}
function use(localId: string, overrides: Partial<PlanProposal["nodes"][number]> = {}) {
  return { ...base, localId, kind: "use_tool" as const, objective: `Read ${localId}`, toolName: "jobs.search", ...overrides }
}
function delegate(localId: string, overrides: Partial<PlanProposal["nodes"][number]> = {}) {
  return { ...base, localId, kind: "delegate" as const, objective: `Delegate ${localId}`, role: "scout", taskType: "research", ...overrides }
}
function runtime(overrides: Partial<PlanDispatchRuntime> = {}): PlanDispatchRuntime {
  return {
    resolveToolVersion: toolName => toolName === "jobs.search" ? "1" : undefined,
    createToolCallId: localId => `call:${localId}`,
    createIdempotencyKey: localId => `idem:${localId}`,
    resolveInputRefs: request => ({ from: request.inputRefs[0] }),
    resolveDelegateActions: role => role === "scout" ? ["jobs.search"] : undefined,
    ...overrides,
  }
}

describe("dispatchPlanProposal", () => {
  it("materializes validated tool and delegate commands in deterministic dependency order", () => {
    const result = dispatchPlanProposal(proposal([delegate("delegate", { dependsOn: ["search"] }), use("search", { inputRefs: ["goal"] })]), validation, runtime())
    expect(result.commands.map(command => command.localId)).toEqual(["search", "delegate"])
    expect(result.commands[0]).toMatchObject({ kind: "tool_call", successCriteria: ["done"], outputSchemaRef: null, call: { id: "call:search", toolName: "jobs.search", toolVersion: "1", input: { from: "goal" } } })
    expect(result.commands[1]).toMatchObject({ kind: "delegate", call: { id: "call:delegate", input: { idempotencyKey: "idem:delegate", role: "scout", taskType: "research", goal: "Delegate delegate", allowedActions: ["jobs.search"] } } })
    expect(JSON.stringify(result.commands)).not.toMatch(/userId|taskId|parentTaskId|lease|budgetLimit|maxBudget/)
  })

  it("fails closed when runtime tool, input, or role callbacks are unavailable", () => {
    expect(() => dispatchPlanProposal(proposal([use("read")]), validation, runtime({ resolveToolVersion: undefined }))).toThrowError(expect.objectContaining({ code: "unknown_tool" }))
    expect(() => dispatchPlanProposal(proposal([use("read", { inputRefs: ["prior"] })]), validation, runtime({ resolveInputRefs: undefined }))).toThrowError(expect.objectContaining({ code: "input_reference_unavailable" }))
    expect(() => dispatchPlanProposal(proposal([delegate("child")]), validation, runtime({ resolveDelegateActions: undefined }))).toThrowError(expect.objectContaining({ code: "role_actions_unavailable" }))
    expect(() => dispatchPlanProposal(proposal([delegate("child")]), validation, runtime({ resolveDelegateActions: () => [] }))).toThrowError(expect.objectContaining({ code: "role_actions_unavailable" }))
    expect(() => dispatchPlanProposal(proposal([use("read", { inputRefs: ["prior"] })]), validation, runtime({ resolveInputRefs: () => ({ nested: new Date() }) }))).toThrowError(expect.objectContaining({ code: "input_reference_unavailable" }))
    expect(() => dispatchPlanProposal(proposal([use("read", { inputRefs: ["prior"] })]), validation, runtime({ resolveInputRefs: () => ({ value: Number.NaN }) }))).toThrowError(expect.objectContaining({ code: "input_reference_unavailable" }))
    const trimmed = dispatchPlanProposal(proposal([use("read")]), validation, runtime({ resolveToolVersion: () => " 1 ", createToolCallId: () => " call:read " }))
    expect(trimmed.commands[0]).toMatchObject({ kind: "tool_call", call: { id: "call:read", toolVersion: "1" } })
  })

  it("rejects forged identity, external writes, and invalid graphs through validation", () => {
    expect(() => dispatchPlanProposal({ ...proposal([use("read")]), taskId: "model-owned" }, validation, runtime())).toThrowError(expect.objectContaining({ code: "invalid_plan" }))
    expect(() => dispatchPlanProposal(proposal([use("read", { toolName: "application.submit" })]), { ...validation, allowedTools: ["application.submit"] }, runtime())).toThrowError(expect.objectContaining({ code: "invalid_plan" }))
    expect(() => dispatchPlanProposal(proposal([use("a", { dependsOn: ["b"] }), use("b", { dependsOn: ["a"] })]), validation, runtime())).toThrowError(expect.objectContaining({ code: "invalid_plan" }))
  })

  it("stops materialization after request input and completion barriers", () => {
    const waiting = dispatchPlanProposal(proposal([{ ...base, localId: "ask", kind: "request_input", objective: "Need a location", question: "Where?" }, use("later", { dependsOn: ["ask"] })]), validation, runtime())
    expect(waiting).toMatchObject({ blockedAfterLocalId: "ask", commands: [{ kind: "request_input", question: "Where?" }] })
    const complete = dispatchPlanProposal(proposal([{ ...base, localId: "finish", kind: "propose_completion", objective: "Finish", successCriteria: ["verified"] }, use("later", { dependsOn: ["finish"] })]), validation, runtime())
    expect(complete).toMatchObject({ blockedAfterLocalId: "finish", commands: [{ kind: "propose_completion", completionCriteria: ["finish", "verified"], successCriteria: ["verified"] }] })
  })
})
