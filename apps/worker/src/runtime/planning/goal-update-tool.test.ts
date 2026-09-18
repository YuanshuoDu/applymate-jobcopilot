import { describe, expect, it } from "vitest"

import { createGoalUpdateTool } from "./goal-update-tool.js"
import { MAX_GOAL_REVISIONS, type GoalContract } from "./goal-plan-contract.js"

const goal: GoalContract = { revision: 1, objective: "Find jobs", constraints: ["EU"], successCriteria: ["review"], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
const context = { scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", signal: new AbortController().signal, capabilities: ["canPlan"], reportProgress: async () => undefined }

describe("goal update tool", () => {
  it("merges semantic changes and increments the server revision", async () => {
    const tool = createGoalUpdateTool({ goal })
    await expect(tool.execute(context, { changes: { objective: "Find senior jobs", knownFacts: ["Dublin"] } })).resolves.toMatchObject({ status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract: { objective: "Find senior jobs", constraints: ["EU"], knownFacts: ["Dublin"], budgetRef: "runtime:turn" } })
  })

  it("updates the server-owned goal reference used by sibling planning tools", async () => {
    const current = { value: goal }
    const goalRef = { get: () => current.value, update: (next: GoalContract) => { current.value = next } }
    const tool = createGoalUpdateTool({ goal, goalRef })
    const result = await tool.execute(context, { changes: { objective: "Find senior jobs" } })
    expect(result.goalRevision).toBe(2)
    expect(current.value).toMatchObject({ revision: 2, objective: "Find senior jobs" })
  })

  it("rejects empty, forbidden and malformed patches without advancing", async () => {
    const tool = createGoalUpdateTool({ goal })
    await expect(tool.execute(context, { changes: {} })).rejects.toMatchObject({ code: "goal_update_invalid" })
    await expect(tool.execute(context, { changes: { budgetRef: "budget:user" } } as never)).rejects.toMatchObject({ code: "goal_update_invalid" })
    await expect(tool.execute(context, { changes: { revision: 9 } } as never)).rejects.toMatchObject({ code: "goal_update_invalid" })
    await expect(tool.execute(context, { changes: { objective: "Updated" }, limits: {} } as never)).rejects.toMatchObject({ code: "goal_update_invalid" })
    await expect(tool.execute(context, { changes: { constraints: [" "] } })).rejects.toMatchObject({ code: "goal_update_invalid" })
    await expect(tool.execute(context, { changes: { objective: "Updated" } })).resolves.toMatchObject({ goalRevision: 2 })
  })

  it("keeps later CAS based on the updated server contract", async () => {
    const tool = createGoalUpdateTool({ goal })
    await expect(tool.execute(context, { changes: { objective: "First" } })).resolves.toMatchObject({ goalRevision: 2 })
    await expect(tool.execute(context, { changes: { successCriteria: ["Second"] } })).resolves.toMatchObject({ goalRevision: 3, basedOnGoalRevision: 2 })
  })

  it("allows clearing a list and rejects the next revision at the server bound", async () => {
    const clearTool = createGoalUpdateTool({ goal })
    await expect(clearTool.execute(context, { changes: { constraints: [] } })).resolves.toMatchObject({ goalRevision: 2, goalContract: { constraints: [] } })
    const tool = createGoalUpdateTool({ goal: { ...goal, revision: MAX_GOAL_REVISIONS } })
    await expect(tool.execute(context, { changes: { constraints: [] } })).rejects.toMatchObject({ code: "goal_revision_limit", safeOutput: { maxGoalRevisions: MAX_GOAL_REVISIONS } })
  })
})
