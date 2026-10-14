import { describe, expect, it } from "vitest"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "./task-graph-verification.js"
import type { TaskGraphProposal } from "./task-graph.js"
import { evaluateTaskGraphObjectiveCoverage } from "./task-graph-objective-coverage.js"

const templates = {
  scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
  analyst: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] },
} as const
const scoutVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "roles", check: { kind: "candidate_count_gte", minimum: 3 } }],
}
const proposal: TaskGraphProposal = {
  expectedRevision: 0,
  nodes: [{ key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return roles"], dependsOn: [],
    verification: scoutVerification }],
} as const
const turnInput = (requirements: unknown) => ({ input: { verificationRequirements: {
  schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements,
} } })
const candidateRequirement = { id: "roles", check: { kind: "candidate_count_gte", minimum: 2 } }

describe("TaskGraph objective coverage", () => {
  it("accepts exact or stronger coverage and keeps absent distinct from invalid", () => {
    const valid = resolveRootTaskVerificationRequirements(turnInput([candidateRequirement]))
    expect(evaluateTaskGraphObjectiveCoverage(valid, proposal, templates)).toEqual({ status: "covered" })
    expect(evaluateTaskGraphObjectiveCoverage(resolveRootTaskVerificationRequirements(turnInput([
      { ...candidateRequirement, check: { ...candidateRequirement.check, minimum: 3 } },
    ])), proposal, templates)).toEqual({ status: "covered" })
    const findingResolution = resolveRootTaskVerificationRequirements(turnInput([
      { id: "findings", check: { kind: "finding_count_gte", minimum: 4 } },
    ]))
    const analystProposal: TaskGraphProposal = { expectedRevision: 0, nodes: [{ key: "analysis", templateId: "analyst", goal: "Analyze roles",
      successCriteria: ["Return findings"], dependsOn: [], verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "findings", check: { kind: "finding_count_gte", minimum: 4 } }] } }] }
    expect(evaluateTaskGraphObjectiveCoverage(findingResolution, analystProposal, templates)).toEqual({ status: "covered" })
    expect(evaluateTaskGraphObjectiveCoverage({ status: "absent" }, proposal, templates)).toEqual({ status: "absent" })
    expect(evaluateTaskGraphObjectiveCoverage({ status: "invalid" }, proposal, templates)).toEqual({ status: "invalid" })
  })

  it("reports only expected safe values for weak, missing, duplicate, wrong-role, or wrong-kind criteria", () => {
    const resolution = resolveRootTaskVerificationRequirements(turnInput([candidateRequirement]))
    if (resolution.status !== "valid") throw new Error("fixture_requirements_invalid")
    const expected = { status: "incomplete", requirements: [{ id: "roles", kind: "candidate_count_gte", role: "scout", minimum: 2 }] }
    const scoutNode = proposal.nodes[0]!
    const altered = (node: TaskGraphProposal["nodes"][number]) => ({ ...proposal, nodes: [node] })
    expect(evaluateTaskGraphObjectiveCoverage(resolution, altered({ ...scoutNode, verification: {
      ...scoutVerification, criteria: [{ id: "roles", check: { kind: "candidate_count_gte", minimum: 1 } }],
    } }), templates)).toEqual(expected)
    expect(evaluateTaskGraphObjectiveCoverage(resolution, altered({ ...scoutNode, verification: {
      ...scoutVerification, criteria: [],
    } }), templates)).toEqual(expected)
    expect(evaluateTaskGraphObjectiveCoverage(resolution, { ...proposal, nodes: [scoutNode, scoutNode] }, templates)).toEqual(expected)
    expect(evaluateTaskGraphObjectiveCoverage(resolution, altered({ ...scoutNode, templateId: "analyst", verification: {
      ...scoutVerification, role: "analyst",
    } }), templates)).toEqual(expected)
    const wrongKind = altered({ ...scoutNode, verification: {
      ...scoutVerification, criteria: [{ id: "roles", check: { kind: "finding_count_gte", minimum: 3 } }],
    } } as unknown as TaskGraphProposal["nodes"][number])
    expect(evaluateTaskGraphObjectiveCoverage(resolution, wrongKind, templates)).toEqual(expected)
  })
})
