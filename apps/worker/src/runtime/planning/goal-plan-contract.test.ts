import { describe, expect, it } from "vitest"

import { GOAL_CONTRACT_SCHEMA_VERSION, PLAN_MAX_NODES, PLAN_MAX_REVISIONS, PLAN_PROPOSAL_SCHEMA_VERSION, isPlanProposal, normalizeGoalContract, type GoalContract, type PlanProposal } from "./goal-plan-contract.js"

describe("goal and plan contracts", () => {
  it("keeps stable schema identifiers and the existing fan-out bound", () => {
    expect(GOAL_CONTRACT_SCHEMA_VERSION).toBe("agent-harness.goal-contract.v1")
    expect(PLAN_PROPOSAL_SCHEMA_VERSION).toBe("agent-harness.plan.v1")
    expect(PLAN_MAX_NODES).toBe(8)
    expect(PLAN_MAX_REVISIONS).toBe(8)
  })

  it("keeps identity and lease fields out of the model contract types", () => {
    const goal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: ["rank jobs"], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "budget:root" }
    const plan: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: goal.revision, basedOnPlanRevision: null, nodes: [], completionCriteria: ["rank jobs"], briefRationale: "Read and rank" }
    expect(isPlanProposal(plan)).toBe(true)
    expect(isPlanProposal({ ...plan, schemaVersion: "other" })).toBe(false)
  })

  it("normalizes bounded goal fields and rejects model-owned identity", () => {
    expect(() => normalizeGoalContract({ revision: 2, objective: "  Find jobs ", constraints: ["Remote"], successCriteria: ["Rank"], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "budget:root", taskId: "forged" })).toThrowError()
    expect(normalizeGoalContract({ revision: 2, objective: "  Find jobs ", constraints: [" Remote "], successCriteria: ["Rank"], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "budget:root" })).toEqual(expect.objectContaining({ revision: 2, objective: "Find jobs", constraints: ["Remote"] }))
  })

  it("accepts only plain JSON objects at the goal boundary", () => {
    class GoalCarrier {
      revision = 1
      objective = "Find jobs"
      constraints: string[] = []
      successCriteria = ["rank"]
      knownFacts: string[] = []
      unresolvedQuestions: string[] = []
      approvalBoundaries: string[] = []
      budgetRef = "budget:root"
    }
    expect(() => normalizeGoalContract(new GoalCarrier())).toThrowError()
    expect(() => normalizeGoalContract(new Date())).toThrowError()
  })
})
