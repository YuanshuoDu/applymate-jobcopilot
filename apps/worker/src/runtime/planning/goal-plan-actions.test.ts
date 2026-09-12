import { describe, expect, it } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { toRuntimeActionIntents } from "./goal-plan-actions.js"

const proposal: PlanProposal = {
  schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 3, basedOnPlanRevision: null,
  completionCriteria: ["all evidence reviewed"], briefRationale: "Read, delegate, then complete",
  nodes: [
    { localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["results"], outputSchemaRef: null, toolName: "jobs.search", budgetRequest: { ref: "budget:root", units: 8 } },
    { localId: "child", kind: "delegate", objective: "Review results", inputRefs: ["read"], dependsOn: ["read"], successCriteria: ["reviewed"], outputSchemaRef: "review.v1", role: "analyst", taskType: "research", constraints: ["read only"] },
    { localId: "ask", kind: "request_input", objective: "Confirm location", inputRefs: ["child"], dependsOn: ["child"], successCriteria: ["answer"], outputSchemaRef: null, question: "Which location?", approvalBoundary: "before submission" },
    { localId: "done", kind: "propose_completion", objective: "Finish", inputRefs: ["child"], dependsOn: ["child"], successCriteria: ["complete"], outputSchemaRef: null },
  ],
}

describe("goal plan action intents", () => {
  it("maps validated nodes to runtime-owned typed intents", () => {
    const intents = toRuntimeActionIntents(proposal)
    expect(intents).toMatchObject([
      { kind: "use_tool", localId: "read", toolName: "jobs.search" },
      { kind: "delegate", localId: "child", role: "analyst", taskType: "research", goal: "Review results" },
      { kind: "request_input", question: "Which location?" },
      { kind: "propose_completion", localId: "done" },
    ])
    expect(intents[1]).not.toHaveProperty("budgetRequest")
    expect(intents[1]).not.toHaveProperty("taskId")
    expect(intents[1]).not.toHaveProperty("parentTaskId")
    expect(intents[1]?.dependsOn).toEqual(["read"])
  })

  it("produces plain JSON data without assigning identity or idempotency", () => {
    const value = toRuntimeActionIntents(proposal)
    expect(() => JSON.stringify(value)).not.toThrow()
    expect(JSON.stringify(value)).not.toContain("idempotencyKey")
    expect(JSON.stringify(value)).not.toContain("userId")
    expect(JSON.stringify(value)).not.toContain("lease")
  })
})
