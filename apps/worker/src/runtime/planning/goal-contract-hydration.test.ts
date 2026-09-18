import { describe, expect, it } from "vitest"

import { hydrateGoalContract } from "./goal-contract-hydration.js"

describe("hydrateGoalContract", () => {
  it("keeps the legacy nested goal input compatible", () => {
    expect(hydrateGoalContract({ input: { goal: "  Find jobs  " } })).toEqual({
      goal: "Find jobs",
      goalContract: { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" },
    })
  })

  it("retains bounded structured goal semantics", () => {
    const value = hydrateGoalContract({ input: { goal: "Find jobs", goalContract: { revision: 1, objective: "Find jobs", constraints: ["EU only"], successCriteria: ["ranked"], knownFacts: ["Dublin"], unresolvedQuestions: ["salary"], approvalBoundaries: ["submit only after approval"], budgetRef: "runtime:turn" } } })
    expect(value.goalContract).toMatchObject({ constraints: ["EU only"], successCriteria: ["ranked"], knownFacts: ["Dublin"], unresolvedQuestions: ["salary"], approvalBoundaries: ["submit only after approval"] })
  })

  it.each([
    ["objective mismatch", { revision: 1, objective: "Other", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }],
    ["future revision", { revision: 2, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }],
    ["input budget", { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "user-budget" }],
    ["identity field", { revision: 1, objective: "Find jobs", userId: "attacker", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }],
  ])("fails closed for %s", (_name, goalContract) => {
    expect(() => hydrateGoalContract({ goal: "Find jobs", goalContract })).toThrow()
  })
})
