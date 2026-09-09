import { describe, expect, it } from "vitest"

import { createPlanProposalTool } from "./plan-proposal-tool.js"
import { PLAN_MAX_NODES, PLAN_PROPOSAL_SCHEMA_VERSION, type GoalContract, type PlanProposal } from "./goal-plan-contract.js"

const goal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: ["review results"], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
const baseNode = { localId: "read", kind: "use_tool" as const, objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["results"], outputSchemaRef: null, toolName: "jobs.search" }
function plan(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [baseNode], completionCriteria: ["review results"], briefRationale: "Bounded read", ...overrides }
}
function context() { return { scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", signal: new AbortController().signal, capabilities: ["canPlan"], reportProgress: async () => undefined } }
function toolOptions() { return { goal, allowedTools: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state", "tool_results.read"], allowedTemplates: [], allowedRoles: ["scout", "analyst"], maxNodes: 8 } }
function tool() { return createPlanProposalTool(toolOptions()) }

describe("plan proposal tool", () => {
  it("rejects invalid server-owned bounds at factory construction", () => {
    expect(() => createPlanProposalTool({ ...toolOptions(), maxNodes: 0 })).toThrow("maxNodes")
    expect(() => createPlanProposalTool({ ...toolOptions(), maxNodes: PLAN_MAX_NODES + 1 })).toThrow("maxNodes")
    expect(() => createPlanProposalTool({ ...toolOptions(), goal: { ...goal, revision: 0 } })).toThrow("goal revision")
  })

  it("snapshots server allowlists so later caller mutation cannot widen planning", async () => {
    const allowedTools = ["jobs.search"]
    const definition = createPlanProposalTool({ ...toolOptions(), allowedTools })
    allowedTools.push("jobs.get")
    await expect(definition.execute(context(), { proposal: plan({ nodes: [{ ...baseNode, toolName: "jobs.get" }] }) })).rejects.toMatchObject({ code: "plan_invalid" })
  })

  it("accepts the first proposal, increments the private plan revision, and returns intents only", async () => {
    const definition = tool()
    const first = await definition.execute(context(), { proposal: plan() })
    expect(first).toMatchObject({ status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, intents: [{ kind: "use_tool", toolName: "jobs.search" }] })
    expect(first.intents[0]).not.toHaveProperty("taskId")
    const second = await definition.execute(context(), { proposal: plan({ basedOnPlanRevision: 1, nodes: [{ ...baseNode, localId: "read-again", objective: "Read more jobs" }] }) })
    expect(second).toMatchObject({ planRevision: 2, basedOnPlanRevision: 1 })
  })

  it("rejects stale CAS and does not advance the private revision", async () => {
    const definition = tool()
    await definition.execute(context(), { proposal: plan() })
    await expect(definition.execute(context(), { proposal: plan() })).rejects.toMatchObject({ code: "plan_invalid", safeOutput: { issues: expect.arrayContaining([expect.objectContaining({ code: "plan_revision_conflict" })]) } })
    const accepted = await definition.execute(context(), { proposal: plan({ basedOnPlanRevision: 1, nodes: [{ ...baseNode, localId: "next", objective: "Read next" }] }) })
    expect(accepted).toMatchObject({ planRevision: 2, basedOnPlanRevision: 1 })
  })

  it("rejects forged identity, external tools, and unknown delegate roles without dispatching", async () => {
    const definition = tool()
    await expect(definition.execute(context(), { proposal: { ...plan(), taskId: "forged" } })).rejects.toMatchObject({ code: "plan_invalid" })
    await expect(definition.execute(context(), { proposal: plan({ nodes: [{ ...baseNode, toolName: "application.submit" }] }) })).rejects.toMatchObject({ code: "plan_invalid", safeOutput: { issues: expect.arrayContaining([expect.objectContaining({ code: "external_write_forbidden" })]) } })
    await expect(definition.execute(context(), { proposal: plan({ nodes: [{ ...baseNode, kind: "delegate", toolName: undefined, role: "executor", taskType: "apply" }] }) })).rejects.toMatchObject({ code: "plan_invalid", safeOutput: { issues: expect.arrayContaining([expect.objectContaining({ code: "unknown_role" })]) } })
  })
})
