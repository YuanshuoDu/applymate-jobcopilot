import { describe, expect, it, vi } from "vitest"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { createCanonicalPlanExecutionFactory, type CanonicalPlanExecutionOptions } from "./canonical-plan-execution.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-09T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T00:10:00.000Z"),
}
const baseNode = { inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null }
const goal = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }

function use(localId: string, overrides: Record<string, unknown> = {}) {
  return { ...baseNode, localId, kind: "use_tool" as const, objective: `Read ${localId}`, toolName: "jobs.search", ...overrides }
}

function delegate(localId: string, overrides: Record<string, unknown> = {}) {
  return { ...baseNode, localId, kind: "delegate" as const, objective: `Delegate ${localId}`, role: "scout", taskType: "research", ...overrides }
}

function proposal(nodes: PlanProposal["nodes"]): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes, completionCriteria: ["finish"], briefRationale: "bounded" }
}

function output(value: PlanProposal, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: value, intents: [], ...overrides }
}

function fixture(router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> } = { execute: async (_context, request) => ({ ...request, status: "completed", output: { ok: true }, errorCode: null }) }) {
  const options: CanonicalPlanExecutionOptions = {
    goal, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8,
    capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease,
    rootTaskId: "root-1", taskId: "root-1", router,
    registry: { list: () => [{ name: "jobs.search", version: "1", risk: "read", capabilities: ["read"] }] },
    policy: {} as PolicyEngine,
  }
  return createCanonicalPlanExecutionFactory(options)
}

function input(value: unknown, stepId = "step-1") {
  return {
    identity: executionOwnerFence({ kind: "turn", taskId: "root-1", lease }), scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId,
    signal: new AbortController().signal, call: { id: "proposal-1", name: "agent.plan.propose", arguments: {} },
    result: { id: "proposal-1", toolName: "agent.plan.propose", toolVersion: "1", status: "completed" as const, output: value, errorCode: null },
    completedToolResults: [], snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
  }
}

function observationCode(result: Awaited<ReturnType<ReturnType<typeof fixture>>>) {
  const value = result.observations[0]?.content
  return value && typeof value === "object" && "errorCode" in value && typeof value.errorCode === "string" ? value.errorCode : undefined
}

describe("createCanonicalPlanExecutionFactory", () => {
  it("executes read and delegate commands with runtime-owned context and IDs", async () => {
    const requests: ToolCallRequest[] = []
    const contexts: ToolRouterContext[] = []
    const router = { execute: vi.fn(async (context: ToolRouterContext, request: ToolCallRequest) => { contexts.push(context); requests.push(request); return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null } }) }
    const hook = fixture(router)
    const result = await hook(input(output(proposal([use("read"), delegate("child", { dependsOn: ["read"] })]))))
    expect(result.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(2)
    expect(requests.map(request => request.toolName)).toEqual(["jobs.search", "spawn_subagent"])
    expect(contexts).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { userId: "user-1" }, taskId: "root-1", rootTaskId: "root-1", stepId: "step-1:plan:read" })]))
    expect(requests[1]?.input).toMatchObject({ role: "scout", taskType: "research" })
    expect(JSON.stringify(requests[1]?.input)).not.toMatch(/userId|taskId|parentTaskId|rootTaskId|lease|budgetLimit|maxBudget/)
    expect(result.observations).toHaveLength(2)
  })

  it("returns bounded failures for malformed, conflicting, unknown, and unresolved plans", async () => {
    const hook = fixture()
    const valid = output(proposal([]))
    expect(observationCode(await hook(input({ ...valid, taskId: "model-owned" })))).toBe("invalid_plan_output")
    expect(observationCode(await hook(input(valid)))).toBeUndefined()
    expect(observationCode(await hook(input(valid)))).toBe("revision_conflict")
    expect(observationCode(await fixture()(input(output(proposal([use("unknown", { toolName: "jobs.unknown" })])))))).toBe("invalid_plan")
    expect(observationCode(await fixture()(input(output(proposal([use("ref", { inputRefs: ["prior"] })])))))).toBe("input_reference_unavailable")
  })

  it("feeds command failure back and maps request input to a wait", async () => {
    const failedRouter = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "failed" as const, output: { safe: true }, errorCode: "policy_denied" })) }
    const failedHook = fixture(failedRouter)
    const failed = await failedHook(input(output(proposal([use("read")]))))
    expect(failed.observations[0]?.content).toMatchObject({ status: "failed", errorCode: "policy_denied" })
    const waiting = await fixture()(input(output(proposal([{ ...baseNode, localId: "ask", kind: "request_input", objective: "Need location", question: "Where?", approvalBoundary: "before submission" } as PlanProposal["nodes"][number]]))))
    expect(waiting.wait).toMatchObject({ status: "waiting_for_user", errorCode: "plan_request_input" })
    expect(waiting.observations[0]?.content).toMatchObject({ status: "waiting_for_user", approvalBoundary: "before submission" })
    expect(waiting.observations).toHaveLength(1)
  })

  it("maps an explicit dependency wait without guessing malformed waits", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { status: "waiting", waitId: "wait-1" }, errorCode: null })) }
    const result = await fixture(router)(input(output(proposal([use("read")]))))
    expect(result.wait).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
  })
})
