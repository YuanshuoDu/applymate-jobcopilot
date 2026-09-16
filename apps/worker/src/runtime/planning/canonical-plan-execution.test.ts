import { describe, expect, it, vi } from "vitest"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PLAN_PROPOSAL_SCHEMA_VERSION, type GoalContract, type GoalContractRef, type PlanActionKind, type PlanProposal } from "./goal-plan-contract.js"
import { fingerprintPlanProposal } from "./plan-fingerprint.js"
import { createCanonicalPlanExecutionFactory, type CanonicalPlanExecutionOptions } from "./canonical-plan-execution.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import type { PlanCommandReceipt } from "./plan-command-receipt.js"
import { createPlanRevisionRecoveryDispatcher, PlanRevisionRecoveryError, type PlanRevisionRecoveryDispatcher } from "./plan-revision-receipt.js"

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

function join(localId = "join", overrides: Record<string, unknown> = {}) {
  return { ...baseNode, localId, kind: "join" as const, objective: "Join children", inputRefs: ["child"], dependsOn: ["child"], joinMode: "all" as const, timeoutMs: 5_000, ...overrides }
}

function proposal(nodes: PlanProposal["nodes"]): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes, completionCriteria: ["finish"], briefRationale: "bounded" }
}

function output(value: PlanProposal, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: value, intents: [], proposalHash: fingerprintPlanProposal(value), ...overrides }
}

function validScoutStructuredResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" as const, status: "completed" as const,
    candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/jobs/job-1", evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }], summary: "One matching job",
  }
}

function validAnalystStructuredResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" as const, status: "completed" as const,
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }], summary: "Strong match",
  }
}

function replayWait(role: "scout" | "analyst", task: Record<string, unknown>, toolName: "agent.wait" | "wait_subagents" = "agent.wait") {
  const plan = proposal([delegate("child", { role }), join(), use("after", { dependsOn: ["join"] })])
  const delegateObservation = { id: "plan-result:proposal-1:child", content: { kind: "plan_command", localId: "child", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } } }
  const joinObservation = { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } } }
  const waitObservation = { id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName, input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { waitId: "wait-1", status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed", result: null, failureReason: null, ...task }] }, errorCode: null } }
  return { plan, observations: [delegateObservation, joinObservation, waitObservation] as StepContextSnapshot["toolObservations"] }
}

type FixtureOverrides = {
  readonly allowedTools?: readonly string[]
  readonly allowedRoles?: readonly string[]
  readonly waitDefinitions?: readonly Record<string, unknown>[]
}

function readDefinition(name: string, domain: "jobs" | "persona" | "resume" | "application") {
  return { name, version: "1", risk: "read", capabilities: ["read"], domain, requiredCapabilities: [] }
}

function fixture(router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> } = { execute: async (_context, request) => ({ ...request, status: "completed", output: { ok: true }, errorCode: null }) }, initialPlanRevision?: number, persistOutcome?: (receipt: PlanCommandReceipt) => Promise<void> | void, maxPlanRevisions?: number, initialPlanHashes?: readonly string[], goalRef?: GoalContractRef, allowedPlanActions?: readonly PlanActionKind[], recoveryDispatcher?: PlanRevisionRecoveryDispatcher, overrides: FixtureOverrides = {}) {
  const allowedTools = overrides.allowedTools ?? ["jobs.search"]
  const allowedRoles = overrides.allowedRoles ?? ["scout"]
  const options: CanonicalPlanExecutionOptions = {
    goal, allowedTools, allowedTemplates: [], allowedRoles, maxNodes: 8,
    capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease,
    rootTaskId: "root-1", taskId: "root-1", initialPlanRevision, router,
    registry: { list: () => [
      readDefinition("jobs.search", "jobs"), readDefinition("jobs.get", "jobs"), readDefinition("persona.retrieve", "persona"),
      readDefinition("resume.get_base", "resume"), readDefinition("application.get_state", "application"),
      { name: "tool_results.read", version: "1", risk: "read", capabilities: ["read"], domain: "coordination", requiredCapabilities: [] },
      ...(overrides.waitDefinitions ?? [{ name: "agent.wait", version: "1", risk: "internal_write", capabilities: ["coordination"], domain: "coordination", requiredCapabilities: [] }]),
    ] },
    policy: {} as PolicyEngine, ...(persistOutcome ? { persistOutcome } : {}), ...(maxPlanRevisions === undefined ? {} : { maxPlanRevisions }), ...(initialPlanHashes ? { initialPlanHashes } : {}), ...(goalRef ? { goalRef } : {}), ...(allowedPlanActions === undefined ? {} : { allowedPlanActions }), ...(recoveryDispatcher ? { recoveryDispatcher } : {}),
  }
  return createCanonicalPlanExecutionFactory(options)
}

function input(value: unknown, stepId = "step-1", toolObservations: StepContextSnapshot["toolObservations"] = [], replayed = false, admitPlanCommands?: (count: number) => void) {
  return {
    identity: executionOwnerFence({ kind: "turn", taskId: "root-1", lease }), scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId,
    signal: new AbortController().signal, call: { id: "proposal-1", name: "agent.plan.propose", arguments: {} },
    result: { id: "proposal-1", toolName: "agent.plan.propose", toolVersion: "1", status: "completed" as const, output: value, errorCode: null },
    completedToolResults: [], replayed, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations },
    ...(admitPlanCommands ? { admitPlanCommands } : {}),
  }
}

function observationCode(result: Awaited<ReturnType<ReturnType<typeof fixture>>>) {
  const value = result.observations[0]?.content
  return value && typeof value === "object" && "errorCode" in value && typeof value.errorCode === "string" ? value.errorCode : undefined
}

function expectRecoveryError(action: () => void): void {
  let caught: unknown
  try { action() } catch (error: unknown) { caught = error }
  expect(caught).toBeInstanceOf(PlanRevisionRecoveryError)
  expect(caught).toMatchObject({ code: "invalid_output" })
}

describe("createCanonicalPlanExecutionFactory", () => {
  it("rejects a plan tool that is absent from the registered capability catalog", async () => {
    const hook = fixture(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      allowedTools: ["jobs.missing"],
    })
    const result = await hook(input(output(proposal([use("read", { toolName: "jobs.missing" })]))))

    expect(observationCode(result)).toBe("invalid_plan")
  })

  it("returns a stable plan budget error observation when admission fails", async () => {
    const hook = fixture()
    const result = await hook(input(output(proposal([use("read")])), "step-1", [], false, () => { throw new Error("budget exhausted") }))
    expect(observationCode(result)).toBe("plan_budget_exhausted")
  })

  it("admits only missing commands during replay", async () => {
    const plan = proposal([use("read"), use("next", { dependsOn: ["read"] })])
    const existing = { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { jobId: "job-1" } } }
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router)
    const admissions: number[] = []
    const result = await hook(input(output(plan), "step-1", [existing], true, count => admissions.push(count)))
    expect(result.observations).toHaveLength(1)
    expect(admissions).toEqual([1])
    expect(router.execute).toHaveBeenCalledTimes(1)
  })

  it("executes read and delegate commands with runtime-owned context and IDs", async () => {
    const requests: ToolCallRequest[] = []
    const contexts: ToolRouterContext[] = []
    const router = { execute: vi.fn(async (context: ToolRouterContext, request: ToolCallRequest) => { contexts.push(context); requests.push(request); return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null } }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate"])
    const result = await hook(input(output(proposal([use("read"), delegate("child", { dependsOn: ["read"] })]))))
    expect(result.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(2)
    expect(requests.map(request => request.toolName)).toEqual(["jobs.search", "agent.spawn"])
    expect(contexts).toEqual(expect.arrayContaining([expect.objectContaining({ scope: { userId: "user-1" }, taskId: "root-1", rootTaskId: "root-1", stepId: "step-1:plan:read" })]))
    expect(requests[1]?.input).toMatchObject({ role: "scout", taskType: "research", allowedActions: ["jobs.search"] })
    expect(JSON.stringify(requests[1]?.input)).not.toMatch(/userId|taskId|parentTaskId|rootTaskId|lease|budgetLimit|maxBudget/)
    expect(result.observations).toHaveLength(2)
  })

  it("enables bounded delegate fan-out for canonical execution", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>(resolve => { resolveSecondStarted = resolve })
    const started: string[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      started.push(request.id)
      if (started.length === 2) resolveSecondStarted()
      if (request.id.endsWith(":first")) await firstGate
      return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null }
    }) }
    const execution = fixture(router)(input(output(proposal([delegate("first"), delegate("second")]))))
    await secondStarted
    expect(started).toEqual(["plan-call:proposal-1:first", "plan-call:proposal-1:second"])
    releaseFirst()
    await expect(execution).resolves.toMatchObject({ observations: expect.any(Array) })
  })

  it("derives distinct read-only delegate actions from the requested role", async () => {
    const allowedTools = ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state", "tool_results.read"]
    const cases = [
      { role: "scout", expected: ["jobs.search", "jobs.get"] },
      { role: "analyst", expected: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"] },
    ] as const

    for (const testCase of cases) {
      const requests: ToolCallRequest[] = []
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
        requests.push(request)
        return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null }
      }) }
      const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["delegate"], undefined, { allowedTools, allowedRoles: ["scout", "analyst"] })
      const result = await hook(input(output(proposal([delegate(`${testCase.role}-child`, { role: testCase.role })]))))

      expect(result.observations).toHaveLength(1)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.input).toMatchObject({ role: testCase.role, allowedActions: testCase.expected })
    }
  })

  it.each([
    { name: "an unknown role", role: "future-role", allowedTools: ["jobs.search"], allowedRoles: ["future-role"] },
    { name: "a role with no compatible tools", role: "scout", allowedTools: ["tool_results.read"], allowedRoles: ["scout"] },
  ])("fails closed for $name delegate actions", async ({ role, allowedTools, allowedRoles }) => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["delegate"], undefined, { allowedTools, allowedRoles })
    const result = await hook(input(output(proposal([delegate("child", { role })]))))

    expect(observationCode(result)).toBe("role_actions_unavailable")
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("passes a prior local result into a dependent tool through the canonical resolver", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      return { ...request, status: "completed" as const, output: request.id.endsWith(":read") ? { jobId: "job-1" } : { ok: true }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool"])
    const result = await hook(input(output(proposal([use("read"), use("review", { inputRefs: ["read"] })]))))
    expect(result.observations).toHaveLength(2)
    expect(requests[1]?.input).toEqual({ jobId: "job-1" })
  })

  it.each(["waiting", "ready", "timed_out"] as const)("handles a join wait result with status %s", async status => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      if (request.toolName === "agent.spawn") return { ...request, status: "completed" as const, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      return { ...request, status: "completed" as const, output: { waitId: "wait-1", status, taskIds: ["child-1"], matchedTaskIds: status === "waiting" ? [] : ["child-1"] }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["delegate", "join"])
    const result = await hook(input(output(proposal([delegate("child"), join()]))))
    expect(requests).toHaveLength(2)
    if (status === "waiting") expect(result.wait).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
    else expect(result.wait).toBeUndefined()
  })

  it("blocks static downstream commands and emits a durable child failure replan control", async () => {
    const receipts: PlanCommandReceipt[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.toolName === "agent.spawn") {
        const taskId = request.id.endsWith(":first") ? "child-first" : "child-second"
        return { ...request, status: "completed" as const, output: { taskId, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      }
      if (request.toolName === "agent.wait") return {
        ...request, status: "completed" as const,
        output: { waitId: "wait-1", status: "ready", taskIds: ["child-first", "child-second"], matchedTaskIds: ["child-first", "child-second"], tasks: [
          { taskId: "child-second", status: "cancelled", result: null, failureReason: "worker stopped" },
          { taskId: "child-first", status: "failed", result: null, failureReason: "provider error" },
        ] }, errorCode: null,
      }
      return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, receipt => { receipts.push(receipt) }, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const plan = proposal([
      delegate("first"), delegate("second"),
      join("join", { inputRefs: ["first", "second"], dependsOn: ["first", "second"] }),
      use("after", { dependsOn: ["join"] }),
    ])
    const result = await hook(input(output(plan)))
    const control = result.observations.find(observation => {
      if (!observation.content || typeof observation.content !== "object") return false
      return "status" in observation.content && observation.content.status === "replan_required"
    })
    expect(result.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(3)
    expect(control?.content).toMatchObject({ kind: "plan_control", localId: "join:replan", status: "replan_required", reason: "child_failure", failedTaskIds: ["child-first", "child-second"] })
    expect(receipts.some(receipt => receipt.observationId === "plan-control:proposal-1:join:replan")).toBe(true)
  })

  it("keeps a ready join with only successful children flowing downstream", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.toolName === "agent.spawn") return { ...request, status: "completed" as const, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      if (request.toolName === "agent.wait") return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "ready", taskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed", result: null, failureReason: null }] }, errorCode: null }
      return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const result = await hook(input(output(proposal([delegate("child"), join(), use("after", { dependsOn: ["join"] })]))))
    expect(result.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(3)
    expect(result.observations.some(observation => JSON.stringify(observation.content).includes("replan_required"))).toBe(false)
  })

  it("replays a legacy wait_subagents child failure replan signal without a second plan execution", async () => {
    const plan = proposal([delegate("child"), join(), use("after", { dependsOn: ["join"] })])
    const delegateObservation = { id: "plan-result:proposal-1:child", content: { kind: "plan_command", localId: "child", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } } }
    const joinObservation = { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } } }
    const waitOutcome = { id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName: "wait_subagents", input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { waitId: "wait-1", status: "timed_out", targetTaskIds: ["child-1"], matchedTaskIds: [], tasks: [{ taskId: "child-1", status: "interrupted", result: null, failureReason: "lease expired" }] }, errorCode: null } }
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const first = await hook(input(output(plan), "step-1", [delegateObservation, joinObservation, waitOutcome], true))
    expect(first.wait).toBeUndefined()
    expect(first.observations).toHaveLength(1)
    expect(first.observations[0]?.content).toMatchObject({ localId: "join:replan", status: "replan_required", failedTaskIds: ["child-1"] })
    expect(router.execute).not.toHaveBeenCalled()

    const persisted = [...first.observations]
    const second = await hook(input(output(plan), "step-1", [delegateObservation, joinObservation, waitOutcome, ...persisted], true))
    expect(second).toEqual({ observations: [] })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("replays a direct ready child failure replan signal without rejecting its control", async () => {
    const plan = proposal([delegate("first"), delegate("second"), join("join", { inputRefs: ["first", "second"], dependsOn: ["first", "second"] }), use("after", { dependsOn: ["join"] })])
    const delegateObservations = ["first", "second"].map((localId, index) => ({
      id: `plan-result:proposal-1:${localId}`,
      content: { kind: "plan_command", localId, commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: `child-${index === 0 ? "first" : "second"}`, rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } },
    }))
    const joinObservation = { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["first", "second"], status: "completed", errorCode: null, output: {
      waitId: "wait-1", status: "ready", taskIds: ["child-first", "child-second"], matchedTaskIds: ["child-first", "child-second"], tasks: [
        { taskId: "child-first", status: "failed", result: null, failureReason: "provider error" },
        { taskId: "child-second", status: "cancelled", result: null, failureReason: "worker stopped" },
      ],
    } } }
    const replanObservation = { id: "plan-control:proposal-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", dependsOn: ["first", "second"], reason: "child_failure", failedTaskIds: ["child-first", "child-second"] } }
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { unexpected: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const result = await hook(input(output(plan), "step-1", [...delegateObservations, joinObservation, replanObservation], true))
    expect(result).toEqual({ observations: [] })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("rejects a replayed replan observation when failure evidence is clean", async () => {
    const replay = replayWait("scout", {})
    const clean = replay.observations.find(observation => observation.id === "wait-result:wait-1")
    const forged = { id: "plan-control:proposal-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", dependsOn: ["child"], reason: "child_failure", failedTaskIds: ["child-1"] } }
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const result = await hook(input(output(replay.plan), "step-1", [replay.observations[0]!, replay.observations[1]!, clean!, forged], true))
    expect(observationCode(result)).toBe("invalid_plan_output")
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("replays a waiting join without rerouting and resumes only from a strict consumed outcome", async () => {
    const proposalValue = proposal([delegate("child"), join(), use("after", { dependsOn: ["join"] })])
    const delegateObservation = { id: "plan-result:proposal-1:child", content: { kind: "plan_command", localId: "child", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } } }
    const joinObservation = { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } } }
    const waitOutcome = { id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName: "agent.wait", input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { waitId: "wait-1", status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed", result: null, failureReason: null }] }, errorCode: null } }
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])
    const waiting = await hook(input(output(proposalValue), "step-1", [delegateObservation, joinObservation], true))
    expect(waiting.wait).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(router.execute).not.toHaveBeenCalled()

    const resumed = await hook(input(output(proposalValue), "step-1", [delegateObservation, joinObservation, waitOutcome], true))
    expect(resumed.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(1)
    expect(router.execute.mock.calls[0]?.[1].toolName).toBe("jobs.search")

    const timedOutOutcome = { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, status: "timed_out", matchedTaskIds: [] } } }
    const timedOut = await hook(input(output(proposalValue), "step-1", [delegateObservation, joinObservation, timedOutOutcome], true))
    expect(timedOut.wait).toBeUndefined()
    expect(router.execute).toHaveBeenCalledTimes(2)

    for (const structuredResult of [validScoutStructuredResult(), validAnalystStructuredResult()]) {
      const structuredWaitOutcome = {
        ...waitOutcome,
        content: {
          ...waitOutcome.content,
          output: {
            ...waitOutcome.content.output,
            tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult } }],
          },
        },
      }
      const structured = await hook(input(proposalValue, "step-1", [delegateObservation, joinObservation, structuredWaitOutcome], true))
      expect(structured.wait).toBeUndefined()
    }

    const invalidWaitOutcomes = [
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: undefined } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0] }, { ...waitOutcome.content.output.tasks[0] }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], taskId: "foreign-task" }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ taskId: "child-1", status: "", result: null, failureReason: null }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { taskId: "forged" } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, input: { taskIds: ["child-1", "child-1"], mode: "all" } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, targetTaskIds: ["child-1", "child-1"] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, matchedTaskIds: ["foreign-task"] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ taskId: "child-1", userId: "forged" }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: "malformed" } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), userId: "forged" } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), candidates: [{ ...validScoutStructuredResult().candidates[0], evidenceIds: [] }] } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), role: "analyst" } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validAnalystStructuredResult(), findings: [{ ...validAnalystStructuredResult().findings[0], score: 11 }] } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], status: "waiting", result: { structuredResult: validScoutStructuredResult() } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), summary: "x".repeat(9_000) } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), candidates: [{ ...validScoutStructuredResult().candidates[0], evidenceIds: ["evidence-job-1"] }], evidence: [{ ...validScoutStructuredResult().evidence[0], id: "evidence-job-1" }] } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), evidence: [...validScoutStructuredResult().evidence, { id: "read:source:source-1", kind: "source", ref: "source-1", source: "model" }] } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), candidates: [{ ...validScoutStructuredResult().candidates[0], evidenceIds: ["read:job:other"] }], evidence: [{ ...validScoutStructuredResult().evidence[0], id: "read:job:other" }] } } }] } } },
      { ...waitOutcome, content: { ...waitOutcome.content, output: { ...waitOutcome.content.output, tasks: [{ ...waitOutcome.content.output.tasks[0], result: { structuredResult: { ...validScoutStructuredResult(), evidence: [validScoutStructuredResult().evidence[0], { ...validScoutStructuredResult().evidence[0] }] } } }] } } },
    ]
    for (const invalid of invalidWaitOutcomes) {
      const rejected = await hook(input(output(proposalValue), "step-1", [delegateObservation, joinObservation, invalid], true))
      expect(observationCode(rejected)).toBe("invalid_plan_output")
    }
    for (const lineage of [{ taskId: "child-1", rootTaskId: "root-1" }, { taskId: "child-1", parentTaskId: "root-1" }]) {
      const missingLineage = { ...delegateObservation, content: { ...delegateObservation.content, output: lineage } }
      const rejected = await hook(input(output(proposalValue), "step-1", [missingLineage, joinObservation, waitOutcome], true))
      expect(observationCode(rejected)).toBe("invalid_plan_output")
    }
    expect(router.execute).toHaveBeenCalledTimes(2)
  })

  it("replays canonical agent.wait outcomes while retaining the legacy join path", async () => {
    const replay = replayWait("scout", {}, "agent.wait")
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"])

    const result = await hook(input(output(replay.plan), "step-1", replay.observations, true))

    expect(result.wait).toBeUndefined()
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.content).toMatchObject({ localId: "after", status: "completed" })
    expect(router.execute).toHaveBeenCalledTimes(1)
  })

  it("prefers the canonical wait version before falling back to the legacy registry entry", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      if (request.toolName === "agent.spawn") return { ...request, status: "completed" as const, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" }, errorCode: null }
      return { ...request, status: "completed" as const, output: { waitId: "wait-1", status: "ready", taskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed", result: null, failureReason: null }] }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["delegate", "join"], undefined, {
      waitDefinitions: [
        { name: "agent.wait", version: "1", risk: "internal_write", capabilities: ["coordination"], domain: "coordination", requiredCapabilities: [] },
        { name: "wait_subagents", version: "2", risk: "internal_write", capabilities: ["coordination"], domain: "coordination", requiredCapabilities: [] },
      ],
    })

    const result = await hook(input(output(proposal([delegate("child"), join()]))))

    expect(result.observations).toHaveLength(2)
    expect(result.observations.some(observation => {
      const content = observation.content
      return content !== null && typeof content === "object" && !Array.isArray(content) && "kind" in content && content.kind === "plan_error"
    })).toBe(false)
  })

  it("binds structured replay evidence to the canonical delegate role", async () => {
    const run = async (role: "scout" | "analyst", task: Record<string, unknown>) => {
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
      const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "delegate", "join"], undefined, {
        allowedTools: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"], allowedRoles: ["scout", "analyst"],
      })
      const replay = replayWait(role, task)
      const result = await hook(input(output(replay.plan), "step-1", replay.observations, true))
      return { result, router }
    }

    const validScout = await run("scout", { role: "scout", result: { structuredResult: validScoutStructuredResult() } })
    expect(observationCode(validScout.result)).toBeUndefined()
    expect(validScout.router.execute).toHaveBeenCalledTimes(1)
    const validAnalyst = await run("analyst", { role: "analyst", result: { structuredResult: validAnalystStructuredResult() } })
    expect(observationCode(validAnalyst.result)).toBeUndefined()
    for (const task of [
      { result: { structuredResult: validScoutStructuredResult() } },
      { role: "analyst", result: { structuredResult: validScoutStructuredResult() } },
      { result: { legacy: true } },
      { role: "" }, { role: "x".repeat(257) }, { role: 42 },
    ]) {
      const { result, router } = await run("scout", task)
      if (task.result && typeof task.result === "object" && "structuredResult" in task.result || "role" in task && task.role !== undefined && task.role !== "scout") expect(observationCode(result)).toBe("invalid_plan_output")
      else expect(observationCode(result)).toBeUndefined()
      if (task.role !== undefined) expect(router.execute).not.toHaveBeenCalled()
    }
  })

  it("fails closed for missing or ambiguous delegate role mappings", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const options = { allowedTools: ["jobs.search", "jobs.get"], allowedRoles: ["scout", "analyst"] }
    const duplicatePlan = proposal([delegate("first"), delegate("second"), join("join", { inputRefs: ["first", "second"], dependsOn: ["first", "second"] })])
    const duplicateObservations = [
      { id: "plan-result:proposal-1:first", content: { kind: "plan_command", localId: "first", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } } },
      { id: "plan-result:proposal-1:second", content: { kind: "plan_command", localId: "second", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "queued" } } },
      { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["first", "second"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } } },
    ] as StepContextSnapshot["toolObservations"]
    const duplicate = await fixture(router, undefined, undefined, undefined, undefined, undefined, ["delegate", "join"], undefined, options)(input(output(duplicatePlan), "step-1", duplicateObservations, true))
    expect(observationCode(duplicate)).toBe("invalid_plan_output")
    expect(router.execute).not.toHaveBeenCalled()

    const missingPlan = proposal([use("read"), join("join", { inputRefs: ["read"], dependsOn: ["read"] })])
    const missingObservations = [
      { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { ok: true } } },
      { id: "plan-result:proposal-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["read"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["read"], matchedTaskIds: [] } } },
    ] as StepContextSnapshot["toolObservations"]
    const missing = await fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool", "join"], undefined, options)(input(output(missingPlan), "step-1", missingObservations, true))
    expect(observationCode(missing)).toBe("invalid_plan_output")
    expect(router.execute).not.toHaveBeenCalled()
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
    expect(order).toEqual(["router:jobs.search", "receipt:plan-result:proposal-1:read", "router:agent.spawn", "receipt:plan-result:proposal-1:child"])
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

  it("rejects bridge revision rollback through the replay dispatcher", async () => {
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const hook = fixture(undefined, 1, undefined, undefined, undefined, undefined, undefined, dispatcher)
    const recovered = proposal([])
    dispatcher.recover({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: fingerprintPlanProposal(recovered) })
    expectRecoveryError(() => dispatcher.recover({ goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: fingerprintPlanProposal(proposal([use("older")])) }))
    const nextProposal = { ...proposal([use("next")]), basedOnPlanRevision: 2 }
    const next = await hook(input(output(nextProposal, { planRevision: 3, basedOnPlanRevision: 2 })))
    expect(next.observations).toHaveLength(1)
  })

  it("rejects a same-revision recovery with a different proposal hash without polluting state", async () => {
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const hook = fixture(undefined, 1, undefined, undefined, undefined, undefined, undefined, dispatcher)
    const recovered = proposal([])
    dispatcher.recover({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: fingerprintPlanProposal(recovered) })
    const conflicting = proposal([use("conflicting")])
    expectRecoveryError(() => dispatcher.recover({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: fingerprintPlanProposal(conflicting) }))
    const next = await hook(input(output({ ...conflicting, basedOnPlanRevision: 2 }, { planRevision: 3, basedOnPlanRevision: 2 })))
    expect(next.observations).toHaveLength(1)
    expect(observationCode(next)).toBeUndefined()
  })

  it("replays all persisted plan commands without routing or emitting duplicates", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { unexpected: true }, errorCode: null })) }
    const command = { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { jobId: "job-1" } } }
    const hook = fixture(router)
    const result = await hook(input(output(proposal([use("read")])), "step-1", [command], true))
    expect(result).toEqual({ observations: [] })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("accepts a replayed receipt at the current revision bound", async () => {
    const hook = fixture(undefined, 8)
    const replayed = { ...proposal([]), basedOnPlanRevision: 7 }
    const result = await hook(input(output(replayed, { planRevision: 8, basedOnPlanRevision: 7 }), "step-1", [], true))
    expect(result).toEqual({ observations: [] })
  })

  it("replays completed outputs into dependent missing commands and persists only the missing observation", async () => {
    const requests: ToolCallRequest[] = []
    const receipts: PlanCommandReceipt[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => { requests.push(request); return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null } }) }
    const nodes = [use("read"), use("review", { inputRefs: ["read"], dependsOn: ["read"] })]
    const existing = { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { jobId: "job-1" } } }
    const hook = fixture(router, undefined, receipt => { receipts.push(receipt) })
    const result = await hook(input(output(proposal(nodes)), "step-1", [existing], true))
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.id).toBe("plan-result:proposal-1:review")
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ observationId: "plan-result:proposal-1:review", planRevision: 1 })
    expect(router.execute).toHaveBeenCalledTimes(1)
    expect(requests[0]?.input).toEqual({ jobId: "job-1" })
  })

  it.each(["failed", "cancelled"] as const)("reuses a persisted %s command without routing", async status => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { unexpected: true }, errorCode: null })) }
    const existing = { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status, errorCode: "denied", output: { safe: true } } }
    const result = await fixture(router)(input(output(proposal([use("read", { inputRefs: ["missing"] })])), "step-1", [existing], true))
    expect(result).toEqual({ observations: [] })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("reuses a persisted request input control and keeps the wait barrier", async () => {
    const router = { execute: vi.fn() }
    const ask = { ...baseNode, localId: "ask", kind: "request_input" as const, objective: "Need location", question: "Where?" }
    const existing = { id: "plan-control:proposal-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } }
    const result = await fixture(router)(input(output(proposal([ask])), "step-1", [existing], true))
    expect(result).toMatchObject({ observations: [], wait: { status: "waiting_for_user", errorCode: "plan_request_input" } })
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("records completion dependencies and rejects an old completion replay shape", async () => {
    const completionNode = { ...baseNode, localId: "finish", kind: "propose_completion" as const, objective: "Finish", dependsOn: ["read"], successCriteria: ["finish"] }
    const plan = proposal([use("read"), completionNode])
    const hook = fixture()
    const fresh = await hook(input(output(plan)))
    expect(fresh.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "plan-control:proposal-1:finish", content: expect.objectContaining({ status: "completion_proposed", dependsOn: ["read"] }) }),
    ]))

    const persisted = [
      { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { ok: true } } },
      { id: "plan-control:proposal-1:finish", content: { kind: "plan_control", localId: "finish", status: "completion_proposed", completionCriteria: ["finish"] } },
    ]
    const replayed = await hook(input(output(plan), "step-1", persisted, true))
    expect(observationCode(replayed)).toBe("invalid_plan_output")
  })

  it("fails closed when a matching persisted command receipt is corrupt", async () => {
    const router = { execute: vi.fn() }
    const existing = { id: "plan-result:proposal-1:read", content: { kind: "plan_command", localId: "read", commandKind: "delegate", dependsOn: [], status: "completed", errorCode: null, output: { jobId: "job-1" } } }
    const result = await fixture(router)(input(output(proposal([use("read")])), "step-1", [existing], true))
    expect(observationCode(result)).toBe("invalid_plan_output")
    expect(router.execute).not.toHaveBeenCalled()
  })

  it("rejects non-contiguous and over-bound replay recovery without advancing state", async () => {
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const hook = fixture(undefined, 1, undefined, undefined, undefined, undefined, undefined, dispatcher)
    expectRecoveryError(() => dispatcher.recover({ goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2 }))
    const nextProposal = { ...proposal([use("next")]), basedOnPlanRevision: 1 }
    expect(observationCode(await hook(input(output(nextProposal, { planRevision: 2, basedOnPlanRevision: 1 }))))).toBeUndefined()

    const boundedDispatcher = createPlanRevisionRecoveryDispatcher()
    const bounded = fixture(undefined, 2, undefined, 2, undefined, undefined, undefined, boundedDispatcher)
    expectRecoveryError(() => boundedDispatcher.recover({ goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2 }))
    expect(observationCode(await bounded(input(output({ ...proposal([use("bounded")]), basedOnPlanRevision: 2 }, { planRevision: 3, basedOnPlanRevision: 2 }))))).toBe("plan_revision_limit")
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
    expect(observationCode(conflict)).toBe("input_reference_conflict")
  })

  it.each([
    { name: "a nested object userId", output: { payload: { userId: "forged-user" } } },
    { name: "a taskId in an array element", output: { payload: [{ taskId: "forged-task" }] } },
    { name: "deep permissions", output: { payload: { metadata: { policy: { permissions: ["admin"] } } } } },
    { name: "deep allowedCapabilities", output: { payload: { metadata: { policy: { allowedCapabilities: ["write"] } } } } },
  ])("rejects $name from historical and local input references", async ({ output: forbiddenOutput }) => {
    const historicalRouter = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null })) }
    const historical = await fixture(historicalRouter)(input(
      output(proposal([use("historical", { inputRefs: ["prior"] })])),
      "step-1",
      [{ id: "prior", content: { output: forbiddenOutput } }],
    ))
    expect(observationCode(historical)).toBe("input_reference_unavailable")
    expect(historicalRouter.execute).not.toHaveBeenCalled()

    const localRouter = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({
      ...request,
      status: "completed" as const,
      output: request.id.endsWith(":first") ? forbiddenOutput : { ok: true },
      errorCode: null,
    })) }
    const local = await fixture(localRouter, undefined, undefined, undefined, undefined, undefined, ["use_tool"])(input(
      output(proposal([use("first"), use("second", { inputRefs: ["first"] })])),
    ))
    expect(observationCode(local)).toBe("input_reference_unavailable")
    expect(localRouter.execute).toHaveBeenCalledTimes(1)
  })

  it("allows nested business data in input references", async () => {
    const nestedBusinessData = {
      job: { title: "Senior Software Engineer", company: { name: "Example Labs" } },
      locations: [{ city: "Dublin", country: "Ireland" }],
      compensation: { currency: "EUR", range: { min: 70000, max: 90000 } },
    }
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      return { ...request, status: "completed" as const, output: { ok: true }, errorCode: null }
    }) }
    const result = await fixture(router)(input(
      output(proposal([use("nested", { inputRefs: ["prior"] })])),
      "step-1",
      [{ id: "prior", content: { output: nestedBusinessData } }],
    ))
    expect(observationCode(result)).toBeUndefined()
    expect(requests[0]?.input).toEqual(nestedBusinessData)
  })

  it("merges local output with snapshot input and rejects conflicts before routing", async () => {
    const requests: ToolCallRequest[] = []
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => {
      requests.push(request)
      return { ...request, status: "completed" as const, output: request.id.endsWith(":first") ? { alpha: 1 } : { ok: true }, errorCode: null }
    }) }
    const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool"])
    const mixed = await hook(input(output(proposal([use("first"), use("second", { inputRefs: ["first", "prior"] })])), "step-1", [{ id: "prior", content: { output: { beta: "two" } } }]))
    expect(mixed.observations).toHaveLength(2)
    expect(requests[1]?.input).toEqual({ alpha: 1, beta: "two" })

    const conflictRouter = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { key: "one" }, errorCode: null })) }
    const conflictProposal = proposal([use("first"), use("second", { inputRefs: ["first", "prior"] })])
    const conflict = await fixture(conflictRouter, undefined, undefined, undefined, undefined, undefined, ["use_tool"])(input(output(conflictProposal), "step-1", [{ id: "prior", content: { output: { key: "two" } } }]))
    expect(observationCode(conflict)).toBe("input_reference_conflict")
    expect(conflictRouter.execute).toHaveBeenCalledTimes(1)
  })

  it("rejects non-object, oversized, and identity-bearing local references before the next router call", async () => {
    const cases: Array<{ output: unknown; expected: string }> = [
      { output: ["array"], expected: "input_reference_unavailable" },
      { output: { payload: "x".repeat(8 * 1024) }, expected: "router_result_mismatch" },
      { output: { lease: { ownerId: "forged" } }, expected: "input_reference_unavailable" },
    ]
    for (const testCase of cases) {
      const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: request.id.endsWith(":first") ? testCase.output : { ok: true }, errorCode: null })) }
      const hook = fixture(router, undefined, undefined, undefined, undefined, undefined, ["use_tool"])
      const result = await hook(input(output(proposal([use("first"), use("second", { inputRefs: ["first"] })]))))
      expect(observationCode(result)).toBe(testCase.expected)
      expect(router.execute).toHaveBeenCalledTimes(1)
    }
  })

  it("maps an explicit dependency wait without guessing malformed waits", async () => {
    const router = { execute: vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { status: "waiting", waitId: "wait-1" }, errorCode: null })) }
    const result = await fixture(router)(input(output(proposal([use("read")]))))
    expect(result.wait).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
  })
})
