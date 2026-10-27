import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification-contract.js"
import {
  buildTaskGraphProposalInputSchema,
  normalizeTaskGraphPlanningNodes,
  parseTaskGraphPlanningReplacementModes,
  TaskGraphProposalInputSchema,
  type TaskGraphModelNodeProposal,
  type TaskGraphProposalInput,
} from "./task-graph-planning-input.js"

const oneNode = [{ key: "analyst-new", templateId: "analyst", goal: "Fresh analysis", successCriteria: ["Report findings"],
  dependsOn: ["scout-source"] }] as const
const singleton = {
  root: { nodeKey: "analyst-old", taskId: "task-analyst-old" },
  sources: [{ nodeKey: "analyst-old", taskId: "task-analyst-old", replacementKey: "analyst-new" }],
} as const

function input(overrides: Partial<TaskGraphProposalInput> = {}): TaskGraphProposalInput {
  return { expectedRevision: 3, nodes: oneNode, ...overrides }
}

describe("agent.plan proposal schema construction", () => {
  it("preserves the generic proposal schema and builds strict role-specific registered templates", () => {
    expect(Value.Check(TaskGraphProposalInputSchema, input())).toBe(true)
    const templates = [
      ["scout", { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] }],
      ["analyst", { role: "analyst", taskType: "job_analysis", allowedActions: ["persona.retrieve"] }],
    ] as const
    const schema = buildTaskGraphProposalInputSchema(Type.Union([Type.Literal("scout"), Type.Literal("analyst")]), templates)
    const scout = { key: "scout-new", templateId: "scout", goal: "Find candidates", successCriteria: ["Find one candidate"],
      dependsOn: [], verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
        criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } }
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [scout] })).toBe(true)
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [{ ...scout, verification: {
      ...scout.verification, role: "analyst",
    } }] })).toBe(false)
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [{ ...scout, taskId: "server-owned" }] })).toBe(false)
    expect(() => buildTaskGraphProposalInputSchema(Type.String(), [
      ["scout", { role: "analyst", taskType: "job_analysis", allowedActions: [] }],
    ])).toThrow("task_graph_verification_template_role_mismatch")
  })

  it("accepts only bounded unique Analyst union selectors in the native planning schema", () => {
    const templates = [
      ["scout", { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] }],
      ["analyst", { role: "analyst", taskType: "job_analysis", allowedActions: ["persona.retrieve"] }],
    ] as const
    const schema = buildTaskGraphProposalInputSchema(Type.Union([Type.Literal("scout"), Type.Literal("analyst")]), templates)
    const analyst = {
      key: "analyst-union", templateId: "analyst", goal: "Synthesize both source sets", successCriteria: ["Report verified findings"],
      dependsOn: ["scout-a", "scout-b"], verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [
          { id: "union-membership", check: { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-b", "scout-a"] } },
          { id: "union-coverage", check: { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 75 } },
        ],
      },
    }
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [analyst] })).toBe(true)
    for (const dependencyNodeKeys of [[], ["scout-a"], ["scout-a", " "], ["scout-a", "scout-a"],
      ["scout-a", "scout-b\n"], ["scout-a", "scout-b\r"], ["scout-a", "scout-b\u2028"], ["scout-a", "scout-b\u2029"],
      ["scout-a", "scout-b", "scout-c", "scout-d", "scout-e", "scout-f", "scout-g", "scout-h", "scout-i"]]) {
      const invalid = { ...analyst, verification: { ...analyst.verification, criteria: [
        { id: "union-membership", check: { kind: "findings_from_scout_union", dependencyNodeKeys } },
      ] } }
      expect(Value.Check(schema, { expectedRevision: 0, nodes: [invalid] })).toBe(false)
    }
    for (const dependencyNodeKeys of [["scout-a", "scout-b\n"], ["scout-a", "scout-b\r"],
      ["scout-a", "scout-b\u2028"], ["scout-a", "scout-b\u2029"]]) {
      const invalid = { ...analyst, verification: { ...analyst.verification, criteria: [
        { id: "union-coverage", check: { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys, minimumPercent: 75 } },
      ] } }
      expect(Value.Check(schema, { expectedRevision: 0, nodes: [invalid] })).toBe(false)
    }
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [{ ...analyst, verification: {
      ...analyst.verification, criteria: [{ id: "union-membership", check: {
        kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"], extra: true,
      } }],
    } }] })).toBe(false)
    const scout = { ...analyst, key: "scout-union", templateId: "scout", dependsOn: [], verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "union-membership", check: { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"] } }],
    } }
    expect(Value.Check(schema, { expectedRevision: 0, nodes: [scout] })).toBe(false)
  })
})

describe("agent.plan replacement mode parsing", () => {
  it("parses the singleton operational mode without changing expectedRevision placement", () => {
    const parsed = parseTaskGraphPlanningReplacementModes(input({ replaceOperationalFailure: singleton }))
    expect(parsed).toEqual({ ok: true, value: { replaceOperationalFailure: singleton } })
  })

  it("rejects every mixed replacement mode before returning a scheduler input", () => {
    const cases = [
      { replaceOperationalFailure: singleton, replaceUnstarted: { nodeKey: "analyst-old" } },
      { replaceOperationalFailure: singleton, replaceBranch: { root: singleton.root, sources: [
        ...singleton.sources, { nodeKey: "other", taskId: "task-other", replacementKey: "other-new" },
      ] } },
    ]
    for (const value of cases) expect(parseTaskGraphPlanningReplacementModes(input(value))).toEqual({
      ok: false, code: "task_graph_replacement_modes_conflict",
    })
  })

  it("keeps legacy branch minimum-two and unstarted single-node rules unchanged", () => {
    expect(parseTaskGraphPlanningReplacementModes(input({ replaceBranch: { ...singleton, sources: singleton.sources } })))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_invalid" })
    expect(parseTaskGraphPlanningReplacementModes(input({ replaceUnstarted: { nodeKey: "analyst-old" }, nodes: [oneNode[0], oneNode[0]] })))
      .toEqual({ ok: false, code: "task_graph_supersession_requires_one_replacement" })
  })

  it("rejects incomplete operational mappings and model-provided failure metadata", () => {
    const malformedInput: unknown = {
      ...input(),
      replaceOperationalFailure: {
        ...singleton, sources: [{ ...singleton.sources[0], cause: "child_resume_unavailable" }],
      },
    }
    expect(parseTaskGraphPlanningReplacementModes(malformedInput as TaskGraphProposalInput)).toEqual({
      ok: false, code: "task_graph_operational_failure_replacement_invalid",
    })
    expect(parseTaskGraphPlanningReplacementModes(input({ replaceOperationalFailure: {
      ...singleton, sources: [{ ...singleton.sources[0], replacementKey: "unmapped" }],
    } }))).toEqual({ ok: false, code: "task_graph_operational_failure_replacement_invalid" })
  })

  it("rejects top-level mode accessors without invoking them", () => {
    let invoked = false
    const value = Object.defineProperty({ expectedRevision: 1, nodes: oneNode }, "replaceOperationalFailure", {
      enumerable: true, get: () => { invoked = true; return singleton },
    }) as unknown as TaskGraphProposalInput
    expect(parseTaskGraphPlanningReplacementModes(value)).toEqual({ ok: false, code: "task_graph_replacement_mode_invalid" })
    expect(invoked).toBe(false)
  })

  it("shares planner node normalization for persisted-call fingerprinting", () => {
    const modelNodes: readonly TaskGraphModelNodeProposal[] = [{ ...oneNode[0], repairOf: {
      nodeKey: "analyst-target", taskId: "task-target", criterionIds: ["finding-count"],
    } }]
    const normalized = normalizeTaskGraphPlanningNodes(modelNodes, "root-current")
    expect(normalized).toEqual({ ok: true, nodes: [{ ...modelNodes[0], repairOf: {
      graphRootTaskId: "root-current", nodeKey: "analyst-target", taskId: "task-target", criterionIds: ["finding-count"],
    } }] })
    expect(normalizeTaskGraphPlanningNodes(modelNodes.map(node => ({ ...node, repairOf: {
      ...node.repairOf!, graphRootTaskId: "foreign-root",
    } })), "root-current")).toEqual({ ok: false })
  })
})
