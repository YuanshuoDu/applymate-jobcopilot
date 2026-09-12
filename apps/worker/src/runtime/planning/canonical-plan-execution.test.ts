import { describe, expect, it, vi } from "vitest"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PLAN_PROPOSAL_SCHEMA_VERSION, type GoalContract, type GoalContractRef, type PlanActionKind, type PlanProposal } from "./goal-plan-contract.js"
import { fingerprintPlanProposal } from "./plan-fingerprint.js"
import { createCanonicalPlanExecutionFactory, type CanonicalPlanExecutionOptions } from "./canonical-plan-execution.js"
import type { PlanCommandReceipt } from "./plan-command-receipt.js"
import { createPlanRevisionRecoveryDispatcher, type PlanRevisionRecoveryDispatcher } from "./plan-revision-receipt.js"

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
  return { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: value, intents: [], proposalHash: fingerprintPlanProposal(value), ...overrides }
}

function fixture(router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> } = { execute: async (_context, request) => ({ ...request, status: "completed", output: { ok: true }, errorCode: null }) }, initialPlanRevision?: number, persistOutcome?: (receipt: PlanCommandReceipt) => Promise<void> | void, maxPlanRevisions?: number, initialPlanHashes?: readonly string[], goalRef?: GoalContractRef, allowedPlanActions?: readonly PlanActionKind[], recoveryDispatcher?: PlanRevisionRecoveryDispatcher) {
  const options: CanonicalPlanExecutionOptions = {
    goal, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8,
    capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease,
    rootTaskId: "root-1", taskId: "root-1", initialPlanRevision, router,
    registry: { list: () => [{ name: "jobs.search", version: "1", risk: "read", capabilities: ["read"] }] },
    policy: {} as PolicyEngine, ...(persistOutcome ? { persistOutcome } : {}), ...(maxPlanRevisions === undefined ? {} : { maxPlanRevisions }), ...(initialPlanHashes ? { initialPlanHashes } : {}), ...(goalRef ? { goalRef } : {}), ...(allowedPlanActions === undefined ? {} : { allowedPlanActions }), ...(recoveryDispatcher ? { recoveryDispatcher } : {}),
  }
  return createCanonicalPlanExecutionFactory(options)
}

function input(value: unknown, stepId = "step-1", toolObservations: StepContextSnapshot["toolObservations"] = []) {
  return {
    identity: executionOwnerFence({ kind: "turn", taskId: "root-1", lease }), scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId,
    signal: new AbortController().signal, call: { id: "proposal-1", name: "agent.plan.propose", arguments: {} },
    result: { id: "proposal-1", toolName: "agent.plan.propose", toolVersion: "1", status: "completed" as const, output: value, errorCode: null },
    completedToolResults: [], snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations },
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
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate"])
    const result = await hook(input(output(proposal([use("read"), delegate("child", { dependsOn: ["read"] })]))))
    expect(result.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(2)
    expect(requests.map(request => request.toolName)).toEqual(["jobs.search", "spawn_subagent"])
    expect(contexts).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { userId: "user-1" }, taskId: "root-1", rootTaskId: "root-1", stepId: "step-1:plan:read" })]))
    expect(requests[1]?.input).toMatchObject({ role: "scout", taskType: "research" })
    expect(JSON.stringify(requests[1]?.input)).not.toMatch(/userId|taskId|parentTaskId|rootTaskId|lease|budgetLimit|maxBudget/)
    expect(result.observations).toHaveLength(2)
  })

  it("revalidates accepted output against the server action capability gate", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool"])
    const result = await hook(input(output(proposal([delegate("child")]))))
    expect(observationCode(result)).toBe("invalid_plan")
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("persists each command outcome before the next command and includes failures/controls", async () => {
    const order: string[] = []
    const receipts: PlanCommandReceipt[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => { order.push(`router:${request.toolName}`); return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null } }) }
    const hook = fixture(router, undefined, receipt => { order.push(`receipt:${receipt.observationId}`); receipts.push(receipt) })
    await hook(input(output(proposal([use("read"), delegate("child", { dependsOn: ["read"] })]))))
    expect(order).toEqual(["router:jobs.search", "receipt:plan-result:proposal-1:read", "router:spawn_subagent", "receipt:plan-result:proposal-1:child"])
    const failed = fixture({ execute: async (_context, request) => ({ ...request, status: "failed" as const, output: { safe: true }, errorCode: "denied" }) }, undefined, receipt => { receipts.push(receipt) })
    await failed(input(output(proposal([use("failed")]))))
    expect(receipts.map(receipt => receipt.content)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed" })]))
    const control = fixture(undefined, undefined, receipt => { receipts.push(receipt) })
    await control(input(output(proposal([{ ...baseNode, localId: "ask", kind: "request_input", objective: "Need location", question: "Where?" } as PlanProposal["nodes"][number]]))))
    expect(receipts.map(receipt => receipt.content)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "waiting_for_user" })]))
  })

  it("returns a visible failure when the durable outcome sink fails", async () => {
    const hook = fixture(undefined, undefined, async () => { throw new Error("outcome_persist_failed") })
    expect(observationCode(await hook(input(output(proposal([use("read")])))))).toBe("observer_failed")
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

  it("continues the bridge CAS from a recovered revision", async () => {
    const hook = fixture(undefined, 2)
    const recoveredProposal = { ...proposal([]), basedOnPlanRevision: 2 }
    const accepted = await hook(input(output(recoveredProposal, { planRevision: 3, basedOnPlanRevision: 2 })))
    expect(accepted.observations).toEqual([])
    const stale = await hook(input(output(recoveredProposal, { planRevision: 3, basedOnPlanRevision: 2 })))
    expect(observationCode(stale)).toBe("revision_conflict")
  })

  it("repairs bridge revision and hash state through the replay dispatcher without rollback", async () => {
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const hook = fixture(undefined, 1, undefined, undefined, undefined, undefined, undefined, dispatcher)
    const recovered = proposal([])
    dispatcher.recover({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: fingerprintPlanProposal(recovered) })
    dispatcher.recover({ goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: fingerprintPlanProposal(proposal([use("older")])) })
    const nextProposal = { ...proposal([use("next")]), basedOnPlanRevision: 2 }
    const next = await hook(input(output(nextProposal, { planRevision: 3, basedOnPlanRevision: 2 })))
    expect(next.observations).toHaveLength(1)
  })

  it("reads a revised goal and resets old plan state through the bridge", async () => {
    const current: { value: GoalContract } = { value: goal }
    const goalRef: GoalContractRef = { get: () => current.value, update: next => { current.value = next } }
    const hook = fixture(undefined, undefined, undefined, undefined, undefined, goalRef)
    await expect(hook(input(output(proposal([]))))).resolves.toEqual({ observations: [] })
    current.value = { ...goal, revision: 2, objective: "Find senior jobs" }
    const nextProposal = { ...proposal([]), basedOnGoalRevision: 2 }
    const accepted = await hook(input(output(nextProposal, { goalRevision: 2, planRevision: 1, basedOnPlanRevision: null })))
    expect(accepted.observations).toEqual([])
  })

  it("rejects accepted output beyond the server revision bound", async () => {
    const hook = fixture(undefined, undefined, undefined, 1)
    await expect(hook(input(output(proposal([]))))).resolves.toEqual({ observations: [] })
    const next = await hook(input(output(proposal([]), { planRevision: 2, basedOnPlanRevision: 1 })))
    expect(observationCode(next)).toBe("plan_revision_limit")
  })

  it("constructs from a recovered bound and returns a bounded limit observation", async () => {
    const hook = fixture(undefined, 8)
    const next = await hook(input(output(proposal([]), { planRevision: 9, basedOnPlanRevision: 8 })))
    expect(observationCode(next)).toBe("plan_revision_limit")
  })

  it("rejects a forged hash and a previously accepted semantic hash before routing", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const forged = await fixture(router)(input(output(proposal([]), { proposalHash: `sha256:${"b".repeat(64)}` })))
    expect(observationCode(forged)).toBe("invalid_plan_output")
    expect(router.execute).not.toHaveBeenCalled()
    const hash = fingerprintPlanProposal(proposal([]))
    const duplicateRouter = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const duplicate = await fixture(duplicateRouter, undefined, undefined, undefined, [hash])(input(output(proposal([]))))
    expect(observationCode(duplicate)).toBe("plan_no_progress")
    expect(duplicateRouter.execute).not.toHaveBeenCalled()
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

  it("hydrates only exact plain object snapshot references", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => { requests.push(request); return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null } }) }
    const observations = [
      { id: "prior-a", content: { output: { alpha: 1 } } },
      { id: "prior-b", content: { beta: "two" } },
    ]
    const hook = fixture(router)
    const hydrated = await hook(input(output(proposal([use("read", { inputRefs: ["prior-b", "prior-a"] })])), "step-1", observations))
    expect(hydrated.wait).toBeUndefined()
    expect(requests[0]?.input).toEqual({ alpha: 1, beta: "two" })
    expect(observationCode(await fixture()(input(output(proposal([use("missing", { inputRefs: ["same-plan-node"] })])))))).toBe("input_reference_unavailable")
    const badInput = input(output(proposal([use("bad", { inputRefs: ["bad"] })])), "step-1", [{ id: "bad", content: { output: "raw" } }])
    expect(observationCode(await fixture()(badInput))).toBe("input_reference_unavailable")
    const conflictInput = input(output(proposal([use("conflict", { inputRefs: ["left", "right"] })])), "step-1", [
      { id: "left", content: { output: { key: "one" } } }, { id: "right", content: { output: { key: "two" } } },
    ])
    const conflict = await fixture()(conflictInput)
    expect(observationCode(conflict)).toBe("input_reference_unavailable")
  })

  it("maps an explicit dependency wait without guessing malformed waits", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { status: "waiting", waitId: "wait-1" }, errorCode: null })) }
    const result = await fixture(router)(input(output(proposal([use("read")]))))
    expect(result.wait).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
  })
})
