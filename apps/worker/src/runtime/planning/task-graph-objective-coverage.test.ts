import { describe, expect, it } from "vitest"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "./task-graph-verification.js"
import type { TaskGraphNodeProposal } from "./task-graph.js"
import type { TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"
import { evaluateTaskGraphObjectiveCoverage } from "./task-graph-objective-coverage.js"

const templates = {
  scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
  analyst: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] },
} as const satisfies Readonly<Record<string, TaskGraphTaskTemplate>>
const scoutVerification = (minimum = 3): TaskGraphVerificationContract => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "roles", check: { kind: "candidate_count_gte", minimum } }],
})
const candidateRequirement = { id: "roles", check: { kind: "candidate_count_gte", minimum: 2 } }
const turnInput = (requirements: unknown) => ({ input: { verificationRequirements: {
  schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements,
} } })
const resolution = resolveRootTaskVerificationRequirements(turnInput([candidateRequirement]))
const scoutNode = (key: string, taskId: string, verification = scoutVerification(), repairOf?: TaskGraphNodeProposal["repairOf"]) => ({
  key, templateId: "scout", goal: "Find roles", successCriteria: ["Return roles"], dependsOn: [],
  verification, taskId, depth: 1, status: "failed" as const, verificationDisposition: "typed" as const,
  ...(repairOf ? { repairOf } : {}),
})
const relation = (nodeKey: string, taskId: string) => ({ graphRootTaskId: "root-task", nodeKey, taskId, criterionIds: ["roles"] })

describe("TaskGraph objective coverage", () => {
  it("accepts exact or stronger coverage and keeps absent distinct from invalid", () => {
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [scoutNode("research", "task-1")], templates, "root-task"))
      .toEqual({ status: "covered" })
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [scoutNode("research", "task-1", scoutVerification(4))], templates, "root-task"))
      .toEqual({ status: "covered" })

    const findingResolution = resolveRootTaskVerificationRequirements(turnInput([
      { id: "findings", check: { kind: "finding_count_gte", minimum: 4 } },
    ]))
    const analyst: TaskGraphNodeProposal = { key: "analysis", templateId: "analyst", goal: "Analyze roles",
      successCriteria: ["Return findings"], dependsOn: [], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "findings", check: { kind: "finding_count_gte", minimum: 4 } }],
      } }
    expect(evaluateTaskGraphObjectiveCoverage(findingResolution, [analyst], templates, "root-task"))
      .toEqual({ status: "covered" })
    expect(evaluateTaskGraphObjectiveCoverage({ status: "absent" }, [], templates, "root-task"))
      .toEqual({ status: "absent" })
    expect(evaluateTaskGraphObjectiveCoverage({ status: "invalid" }, [], templates, "root-task"))
      .toEqual({ status: "invalid" })
  })

  it("rejects missing, weak, duplicate, wrong-role, and wrong-kind requirements", () => {
    if (resolution.status !== "valid") throw new Error("fixture_requirements_invalid")
    const expected = { status: "incomplete", requirements: [{ id: "roles", kind: "candidate_count_gte", role: "scout", minimum: 2 }] }
    const weak = scoutNode("research", "task-1", scoutVerification(1))
    const missing = { ...scoutNode("research", "task-1"), verification: { ...scoutVerification(), criteria: [] } }
    const wrongRole = { ...scoutNode("research", "task-1"), templateId: "analyst", verification: {
      ...scoutVerification(), role: "analyst" as const,
    } }
    const wrongKind = { ...scoutNode("research", "task-1"), verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
      criteria: [{ id: "roles", check: { kind: "finding_count_gte" as const, minimum: 3 } }],
    } }
    for (const nodes of [[weak], [missing], [scoutNode("research", "task-1"), scoutNode("duplicate", "task-2")], [wrongRole], [wrongKind]]) {
      expect(evaluateTaskGraphObjectiveCoverage(resolution, nodes, templates, "root-task")).toEqual(expected)
    }
  })

  it("collapses valid chained repairs and latest repeated-target retries into one effective lineage", () => {
    const target = scoutNode("target", "task-target")
    const first = scoutNode("repair-first", "task-first", scoutVerification(), relation("target", "task-target"))
    const chained = scoutNode("repair-chain", "task-chain", scoutVerification(), relation("repair-first", "task-first"))
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [target, first, chained], templates, "root-task"))
      .toEqual({ status: "covered" })

    const retry = scoutNode("repair-retry", "task-retry", scoutVerification(), relation("target", "task-target"))
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [target, first, retry], templates, "root-task"))
      .toEqual({ status: "covered" })
  })

  it("keeps an untouched canonical criterion on the original node when a repair replaces another criterion", () => {
    const targetVerification: TaskGraphVerificationContract = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [
        { id: "roles", check: { kind: "candidate_count_gte", minimum: 3 } },
        { id: "evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
      ],
    }
    const target = scoutNode("target", "task-target", targetVerification)
    const repairVerification: TaskGraphVerificationContract = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } }],
    }
    const repair = scoutNode("repair-evidence", "task-repair", repairVerification, {
      graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["evidence"],
    })
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [target, repair], templates, "root-task"))
      .toEqual({ status: "covered" })
  })

  it.each([
    ["missing", { ...scoutVerification(), criteria: [] }],
    ["wrong kind", { ...scoutVerification(), criteria: [{ id: "roles", check: { kind: "finding_count_gte" as const, minimum: 3 } }] }],
    ["weaker", scoutVerification(1)],
  ] as const)("does not let the old target hide a %s repair criterion", (_label, replacement) => {
    const target = scoutNode("target", "task-target")
    const repair = scoutNode("repair", "task-repair", replacement as TaskGraphVerificationContract | undefined, relation("target", "task-target"))
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [target, repair], templates, "root-task")).toMatchObject({ status: "incomplete" })
  })

  it("rejects an independent duplicate even when one copy is on a valid repair lineage", () => {
    const target = scoutNode("target", "task-target")
    const repair = scoutNode("repair", "task-repair", scoutVerification(), relation("target", "task-target"))
    const unrelated = scoutNode("unrelated", "task-unrelated")
    expect(evaluateTaskGraphObjectiveCoverage(resolution, [target, repair, unrelated], templates, "root-task"))
      .toMatchObject({ status: "incomplete" })
  })
})
