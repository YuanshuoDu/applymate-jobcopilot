import { describe, expect, it } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanNode, type PlanProposal } from "./goal-plan-contract.js"
import { PlanValidationError, findPlanValidationIssues, validatePlanProposal } from "./goal-plan-validator.js"

function node(overrides: Partial<PlanNode> = {}): PlanNode {
  return { localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["results"], outputSchemaRef: null, toolName: "jobs.search", ...overrides }
}

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 2, basedOnPlanRevision: null, nodes: [node()], completionCriteria: ["results reviewed"], briefRationale: "A bounded read", ...overrides }
}

const context = { goalRevision: 2, planRevision: null, allowedActions: ["use_tool", "delegate", "request_input", "propose_completion"] as const, allowedTools: ["jobs.search"], allowedTemplates: ["jobs.read"] }

describe("goal plan validator", () => {
  it("accepts a bounded proposal with a matching revision CAS", () => {
    expect(validatePlanProposal(proposal(), context)).toEqual(proposal())
    expect(findPlanValidationIssues(proposal(), context)).toEqual([])
  })

  it("returns normalized proposal data after validating it", () => {
    const spaced = proposal({ briefRationale: "  A bounded read  ", completionCriteria: [" results reviewed "], nodes: [node({ objective: " Read jobs ", inputRefs: [" input-1 "], toolName: " jobs.search " })] })
    const normalized = validatePlanProposal(spaced, context)
    expect(normalized).toMatchObject({ briefRationale: "A bounded read", completionCriteria: ["results reviewed"], nodes: [{ objective: "Read jobs", inputRefs: ["input-1"], toolName: "jobs.search" }] })
    expect(normalized).not.toBe(spaced)
    expect(() => validatePlanProposal({ ...spaced, userId: "forged" }, context)).toThrowError(PlanValidationError)
  })

  it("rejects stale goal or plan revisions", () => {
    expect(() => validatePlanProposal(proposal({ basedOnGoalRevision: 1 }), context)).toThrowError(PlanValidationError)
    expect(findPlanValidationIssues(proposal({ basedOnPlanRevision: 1 }), context)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "plan_revision_conflict" })]))
  })

  it("rejects missing, duplicate, self, and cyclic dependencies", () => {
    const invalid = proposal({ nodes: [node({ localId: "a", dependsOn: ["missing"] }), node({ localId: "a", dependsOn: ["a"] }), node({ localId: "b", dependsOn: ["c"] }), node({ localId: "c", dependsOn: ["b"] })] })
    const codes = findPlanValidationIssues(invalid, context).map(issue => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["missing_dependency", "duplicate_local_id", "self_dependency", "dependency_cycle"]))
  })

  it("rejects unknown actions/tools/templates and external writes", () => {
    const invalid = proposal({ nodes: [node({ kind: "use_tool", toolName: "application.submit" }), node({ localId: "unknown", toolName: "jobs.get", template: "application.submit" })] })
    const issues = findPlanValidationIssues(invalid, { ...context, allowedActions: ["delegate"] })
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["action_not_allowed", "external_write_forbidden", "unknown_tool"]))
    expect(findPlanValidationIssues(proposal({ nodes: [node({ template: "unknown" })] }), context).map(issue => issue.code)).toContain("unknown_template")
  })

  it("rejects semantically duplicated delegates while allowing distinct objectives", () => {
    const first = node({ kind: "delegate", role: "analyst", taskType: "research", objective: "Review jobs", toolName: undefined })
    const duplicate = { ...first, localId: "second" }
    expect(findPlanValidationIssues(proposal({ nodes: [first, duplicate] }), { ...context, allowedActions: ["delegate"] }).map(issue => issue.code)).toContain("duplicate_spawn")
    expect(findPlanValidationIssues(proposal({ nodes: [first, { ...duplicate, objective: "Review resume" }] }), { ...context, allowedActions: ["delegate"] })).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "duplicate_spawn" })]))
  })

  it("rejects class instances at the plan boundary", () => {
    class PlanCarrier {
      constructor(readonly value: PlanProposal) { Object.assign(this, value) }
    }
    expect(() => validatePlanProposal(new PlanCarrier(proposal()), context)).toThrowError(PlanValidationError)
    expect(() => validatePlanProposal(new Date(), context)).toThrowError(PlanValidationError)
  })

  it("rejects identity or permission expansion fields and oversized plans", () => {
    const invalid = { ...proposal({ nodes: Array.from({ length: 9 }, (_, index) => node({ localId: `node-${index}` })) }), userId: "user-1" }
    const issues = findPlanValidationIssues(invalid, context)
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["forbidden_field", "too_many_nodes"]))
  })

  it("requires delegate and request_input semantics", () => {
    const invalid = proposal({ nodes: [node({ kind: "delegate", role: "analyst", taskType: "research", toolName: undefined }), node({ localId: "ask", kind: "request_input", question: undefined })] })
    const codes = findPlanValidationIssues(invalid, context).map(issue => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["question_required"]))
    expect(codes).not.toContain("role_required")
  })
})
