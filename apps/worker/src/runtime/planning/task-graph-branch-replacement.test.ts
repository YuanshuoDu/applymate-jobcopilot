import { describe, expect, it } from "vitest"
import type { TaskGraphProposal } from "./task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./task-graph-verification.js"
import type { StoredTaskGraphNode, TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import {
  parseTaskGraphBranchReplacement,
  validateTaskGraphBranchReplacement,
  type TaskGraphBranchReplacement,
} from "./task-graph-branch-replacement.js"

const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }],
}
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst" as const,
  criteria: [
    { id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-old" } },
    { id: "coverage", check: { kind: "findings_cover_scout_candidates_gte" as const, dependencyNodeKey: "scout-old", minimumPercent: 75 } },
    { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
  ],
}

function node(input: Readonly<{
  key: string; taskId?: string; templateId?: string; dependsOn?: readonly string[]
  verification?: StoredTaskGraphNode["verification"]; verificationDisposition?: "typed" | "legacy_unverified"
  repairOf?: StoredTaskGraphNode["repairOf"]
}>): StoredTaskGraphNode {
  const templateId = input.templateId ?? "scout"
  const role = templateId === "analyst" ? "analyst" : "scout"
  return {
    key: input.key, taskId: input.taskId ?? `${input.key}-task`, templateId,
    goal: `Old plan for ${input.key}`, successCriteria: ["Old explanatory criterion"],
    dependsOn: [...(input.dependsOn ?? [])], depth: input.dependsOn?.length ? 2 : 1,
    verificationDisposition: input.verificationDisposition ?? "typed",
    ...(input.verificationDisposition === "legacy_unverified" ? {} : { verification: input.verification ?? (role === "analyst" ? analystVerification : scoutVerification) }),
    ...(input.repairOf ? { repairOf: input.repairOf } : {}),
  }
}

function baseSnapshot(legacyFoundation = false): TaskGraphSnapshot {
  return {
    schemaVersion: "agent-harness.v2.task-graph",
    rootSuccessCriteria: ["Keep the original Root objective"],
    nodes: [
      node({ key: "foundation", verificationDisposition: legacyFoundation ? "legacy_unverified" : "typed" }),
      node({ key: "scout-old", dependsOn: ["foundation"] }),
      node({ key: "analyst-old", templateId: "analyst", dependsOn: ["scout-old", "foundation"] }),
      node({ key: "unrelated" }),
    ],
  }
}

function branch(): TaskGraphBranchReplacement {
  return {
    root: { nodeKey: "scout-old", taskId: "scout-old-task" },
    sources: [
      { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
    ],
  }
}

function proposal(overrides: Readonly<{ nodes?: TaskGraphProposal["nodes"]; rootSuccessCriteria?: readonly string[] }> = {}): TaskGraphProposal {
  return {
    expectedRevision: 4,
    nodes: overrides.nodes ?? [
      { key: "scout-new", templateId: "scout", goal: "Try a new search approach", successCriteria: ["Look for updated roles"],
        dependsOn: ["foundation"], verification: scoutVerification },
      { key: "analyst-new", templateId: "analyst", goal: "Reassess the refreshed evidence", successCriteria: ["Explain the strongest matches"],
        dependsOn: ["scout-new", "foundation"], verification: {
          ...analystVerification,
          criteria: analystVerification.criteria.map(criterion => (criterion.check.kind === "findings_from_scout_dependency"
            || criterion.check.kind === "findings_cover_scout_candidates_gte")
            ? { ...criterion, check: { ...criterion.check, dependencyNodeKey: "scout-new" } } : criterion),
        } },
    ],
    ...(overrides.rootSuccessCriteria ? { rootSuccessCriteria: overrides.rootSuccessCriteria } : {}),
  }
}

describe("TaskGraph branch replacement contract", () => {
  it("derives the full descendant closure and remaps only structured references", () => {
    const current = baseSnapshot()
    const candidate = proposal()
    const result = validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: branch(), proposal: candidate })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.sourceNodes.map(item => item.key)).toEqual(["scout-old", "analyst-old"])
    expect([...result.value.sourceToReplacementKey]).toEqual([[
      "scout-old", "scout-new",
    ], ["analyst-old", "analyst-new"]])
    expect(result.value.replacementNodes).toEqual(candidate.nodes)
    expect(result.value.replacementNodes[1]?.goal).toBe("Reassess the refreshed evidence")
    expect(result.value.replacementNodes[1]?.successCriteria).toEqual(["Explain the strongest matches"])
    expect(current.rootSuccessCriteria).toEqual(["Keep the original Root objective"])
  })

  it("requires exact source identity coverage, a fresh key set, and the original root criteria", () => {
    const current = baseSnapshot(), candidate = proposal()
    const missing = { ...branch(), sources: branch().sources.slice(0, 1) }
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: missing, proposal: candidate })).toMatchObject({ ok: false })
    expect(validateTaskGraphBranchReplacement({ snapshot: current,
      replaceBranch: { ...branch(), root: { nodeKey: "missing-root", taskId: "missing-task" },
        sources: [{ nodeKey: "missing-root", taskId: "missing-task", replacementKey: "scout-new" }, branch().sources[1]!] }, proposal: candidate }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_root_mismatch" })
    const collision = proposal({ nodes: [{ ...candidate.nodes[0]!, key: "foundation" }, candidate.nodes[1]!] })
    const collidingBranch = { ...branch(), sources: [
      { ...branch().sources[0]!, replacementKey: "foundation" }, branch().sources[1]!,
    ] }
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: collidingBranch, proposal: collision }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_key_collision" })
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: branch(), proposal: candidate,
      proposedRootSuccessCriteria: ["Changed canonical Root criterion"] })).toEqual({
      ok: false, code: "task_graph_branch_replacement_contract_mismatch",
    })
  })

  it("preserves every branch edge and typed check except mapped dependency keys", () => {
    const current = baseSnapshot(), candidate = proposal()
    const oldSelector = proposal({ nodes: [candidate.nodes[0]!, {
      ...candidate.nodes[1]!, verification: analystVerification,
    }] })
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: branch(), proposal: oldSelector }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_contract_mismatch" })
    const changedThreshold = proposal({ nodes: [candidate.nodes[0]!, {
      ...candidate.nodes[1]!, verification: { ...candidate.nodes[1]!.verification!, criteria: [
        { id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-new" } },
        { id: "coverage", check: { kind: "findings_cover_scout_candidates_gte" as const, dependencyNodeKey: "scout-new", minimumPercent: 90 } },
        { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
      ] },
    }] })
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: branch(), proposal: changedThreshold }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_contract_mismatch" })
    const changedEdge = proposal({ nodes: [candidate.nodes[0]!, { ...candidate.nodes[1]!, dependsOn: ["scout-new"] }] })
    expect(validateTaskGraphBranchReplacement({ snapshot: current, replaceBranch: branch(), proposal: changedEdge }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_contract_mismatch" })
  })

  it("rejects all repair lineage touching the replaced closure", () => {
    const base = baseSnapshot()
    const target = base.nodes[0]!
    const repairNode = node({ key: "scout-old", dependsOn: [], repairOf: {
      graphRootTaskId: "root-task", nodeKey: target.key, taskId: target.taskId, criterionIds: ["candidate-count"],
    } })
    const sourceRepair = { ...base, nodes: [target, repairNode, base.nodes[2]!, base.nodes[3]!] }
    expect(validateTaskGraphBranchReplacement({ snapshot: sourceRepair, replaceBranch: branch(), proposal: proposal() }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_repair_reference" })

    const outsideRepair = node({ key: "outside-repair", repairOf: {
      graphRootTaskId: "root-task", nodeKey: "scout-old", taskId: "scout-old-task", criterionIds: ["candidate-count"],
    } })
    const outsideRef = { ...base, nodes: [...base.nodes.slice(0, 3), outsideRepair] }
    expect(validateTaskGraphBranchReplacement({ snapshot: outsideRef, replaceBranch: branch(), proposal: proposal() }))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_repair_reference" })
  })

  it("rejects a legacy-unverified dependency ancestor regardless of readiness", () => {
    expect(validateTaskGraphBranchReplacement({ snapshot: baseSnapshot(true), replaceBranch: branch(), proposal: proposal() }))
      .toEqual({ ok: false, code: "task_graph_dependency_unverified" })
  })

  it("parses strict request and proposal mappings before persistence", () => {
    expect(parseTaskGraphBranchReplacement({ ...branch(), extra: true }, proposal().nodes))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_invalid" })
    expect(parseTaskGraphBranchReplacement({ ...branch(), sources: [branch().sources[0], branch().sources[0]] }, proposal().nodes))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_invalid" })
    expect(parseTaskGraphBranchReplacement(branch(), [{ ...proposal().nodes[0]!, key: "foreign-key" }, proposal().nodes[1]!]))
      .toEqual({ ok: false, code: "task_graph_branch_replacement_invalid" })
  })
})
