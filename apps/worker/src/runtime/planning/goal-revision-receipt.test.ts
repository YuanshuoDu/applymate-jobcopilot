import { describe, expect, it } from "vitest"

import { parseGoalRevisionEvent, parseGoalRevisionOutput, restoreGoalRevisions } from "./goal-revision-receipt.js"
import type { GoalContract } from "./goal-plan-contract.js"

const initial: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
const next: GoalContract = { ...initial, revision: 2, objective: "Find EU jobs" }
const output = { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract: next }

describe("goal revision receipt", () => {
  it("accepts bounded output and event metadata", () => {
    expect(parseGoalRevisionOutput(output)).toMatchObject({ goalRevision: 2, basedOnGoalRevision: 1, goalContract: next })
    expect(parseGoalRevisionEvent({ goalRevision: 2, basedOnGoalRevision: 1, goalContract: next })).toMatchObject({ goalRevision: 2 })
  })

  it("rejects unknown keys, gaps, wrong budget and malformed contracts", () => {
    expect(parseGoalRevisionOutput({ ...output, extra: "identity" })).toBeNull()
    expect(parseGoalRevisionEvent({ ...output, status: undefined })).toBeNull()
    expect(parseGoalRevisionEvent({ goalRevision: 3, basedOnGoalRevision: 2, goalContract: { ...next, revision: 3 } })).toMatchObject({ goalRevision: 3 })
    expect(parseGoalRevisionEvent({ goalRevision: 2, basedOnGoalRevision: 1, goalContract: { ...next, budgetRef: "budget:user" } })).toBeNull()
  })

  it("restores only a continuous scoped sequence", () => {
    const third = { ...next, revision: 3, objective: "Find senior EU jobs" }
    const restored = restoreGoalRevisions(initial, [
      { type: "goal.revision", payload: { goalRevision: 3, basedOnGoalRevision: 2, goalContract: third } },
      { type: "goal.revision", payload: { goalRevision: output.goalRevision, basedOnGoalRevision: output.basedOnGoalRevision, goalContract: output.goalContract } },
      { type: "goal.revision", payload: { goalRevision: 3, basedOnGoalRevision: 2, goalContract: third } },
    ])
    expect(restored.goalContract).toEqual(third)
    expect(restored.receipt?.goalRevision).toBe(3)
  })
})
