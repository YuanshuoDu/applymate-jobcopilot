import { describe, expect, it } from "vitest"
import {
  normalizeTaskGraphPlanningNodes,
  parseTaskGraphPlanningReplacementModes,
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
