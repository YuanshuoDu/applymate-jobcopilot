import { describe, expect, it } from "vitest"
import type { TaskGraphProposal } from "./task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./task-graph-verification.js"
import type { StoredTaskGraphNode, TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import {
  parseTaskGraphOperationalFailureReplacement,
  validateTaskGraphOperationalFailureReplacement,
  type TaskGraphOperationalFailureReplacement,
} from "./task-graph-operational-failure-replacement.js"

const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 2 } }],
}
const analystVerification = (dependencyNodeKey: string) => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst" as const,
  criteria: [
    { id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey } },
    { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
  ],
})
const analystUnionVerification = (dependencyNodeKeys: readonly string[]) => ({
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst" as const,
  criteria: [
    { id: "from-scout-union", check: { kind: "findings_from_scout_union" as const, dependencyNodeKeys: [...dependencyNodeKeys] } },
    { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
  ],
})

function node(input: Readonly<{
  key: string; taskId?: string; templateId?: "scout" | "analyst" | "writer"; dependsOn?: readonly string[]
  disposition?: "typed" | "legacy_unverified"; repairOf?: StoredTaskGraphNode["repairOf"]
}>): StoredTaskGraphNode {
  const templateId = input.templateId ?? "scout"
  const role = templateId === "analyst" ? "analyst" : "scout"
  const dependencies = [...(input.dependsOn ?? [])]
  return {
    key: input.key, taskId: input.taskId ?? `${input.key}-task`, templateId,
    goal: `Work on ${input.key}`, successCriteria: ["Produce useful evidence"], dependsOn: dependencies,
    depth: dependencies.length === 0 ? 1 : Math.max(2, dependencies.length + 1),
    verificationDisposition: input.disposition ?? "typed",
    ...(input.disposition === "legacy_unverified" ? {} : {
      verification: templateId === "analyst" ? analystVerification(dependencies[0] ?? "foundation") : scoutVerification,
    }),
    ...(input.repairOf ? { repairOf: input.repairOf } : {}),
  }
}

function baseSnapshot(): TaskGraphSnapshot {
  return {
    schemaVersion: "agent-harness.v2.task-graph",
    rootSuccessCriteria: ["Keep the original Root objective"],
    nodes: [
      node({ key: "foundation" }),
      node({ key: "scout-old", dependsOn: ["foundation"] }),
      node({ key: "analyst-old", templateId: "analyst", dependsOn: ["scout-old", "foundation"] }),
      node({ key: "unrelated" }),
    ],
  }
}

function replacement(): TaskGraphOperationalFailureReplacement {
  return {
    root: { nodeKey: "scout-old", taskId: "scout-old-task" },
    sources: [
      { nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" },
    ],
  }
}

function proposal(nodes?: TaskGraphProposal["nodes"]): TaskGraphProposal {
  return {
    expectedRevision: 8,
    nodes: nodes ?? [
      { key: "scout-new", templateId: "scout", goal: "Try another source", successCriteria: ["Produce useful evidence"],
        dependsOn: ["foundation"], verification: scoutVerification },
      { key: "analyst-new", templateId: "analyst", goal: "Reassess fresh evidence", successCriteria: ["Produce useful evidence"],
        dependsOn: ["scout-new", "foundation"], verification: analystVerification("scout-new") },
    ],
  }
}

describe("operational failure replacement input", () => {
  it("accepts a singleton leaf and rejects incomplete, duplicate, extra, or model-authored failure fields", () => {
    const leaf = { root: { nodeKey: "analyst-old", taskId: "analyst-old-task" },
      sources: [{ nodeKey: "analyst-old", taskId: "analyst-old-task", replacementKey: "analyst-new" }] }
    expect(parseTaskGraphOperationalFailureReplacement(leaf, [{ key: "analyst-new" }])).toEqual({ ok: true, value: leaf })
    for (const input of [
      { ...leaf, sources: [] },
      { ...leaf, sources: [leaf.sources[0], leaf.sources[0]] },
      { ...leaf, failureReason: "child_resume_unavailable" },
      { ...leaf, sources: [{ ...leaf.sources[0], status: "failed" }] },
    ]) expect(parseTaskGraphOperationalFailureReplacement(input, [{ key: "analyst-new" }])).toEqual({
      ok: false, code: "task_graph_operational_failure_replacement_invalid",
    })
    expect(parseTaskGraphOperationalFailureReplacement(leaf, [{ key: "analyst-new" }, { key: "unmapped" }])).toMatchObject({ ok: false })
  })

  it("rejects accessors and sparse source arrays without invoking getters", () => {
    let invoked = false
    const source = Object.defineProperty({}, "nodeKey", { enumerable: true, get: () => { invoked = true; return "x" } })
    expect(parseTaskGraphOperationalFailureReplacement({ root: { nodeKey: "x", taskId: "t" }, sources: [source] }))
      .toMatchObject({ ok: false })
    const sources: unknown[] = []
    sources.length = 1
    expect(parseTaskGraphOperationalFailureReplacement({ root: { nodeKey: "x", taskId: "t" }, sources })).toMatchObject({ ok: false })
    expect(invoked).toBe(false)
  })
})

describe("operational failure replacement graph validation", () => {
  it("maps a complete typed descendant closure and only remaps structured dependency selectors", () => {
    const current = baseSnapshot(), candidate = proposal()
    const result = validateTaskGraphOperationalFailureReplacement({
      snapshot: current, replaceOperationalFailure: replacement(), proposal: candidate,
      proposedRootSuccessCriteria: ["Keep the original Root objective"],
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.sourceNodes.map(source => source.key)).toEqual(["scout-old", "analyst-old"])
    expect([...result.value.sourceToReplacementKey]).toEqual([["scout-old", "scout-new"], ["analyst-old", "analyst-new"]])
    expect(result.value.replacementNodes).toEqual(candidate.nodes)
    expect(result.value.replacementNodes[1]?.verification).toEqual(analystVerification("scout-new"))
    expect(current.rootSuccessCriteria).toEqual(["Keep the original Root objective"])
  })

  it("remaps the selected subset of union selectors without moving external keys or reordering them", () => {
    const original = baseSnapshot()
    const snapshot = { ...original, nodes: original.nodes.map(node => node.key === "analyst-old"
      ? { ...node, verification: analystUnionVerification(["foundation", "scout-old"]) } : node) }
    const base = proposal()
    const candidate = proposal([base.nodes[0]!, { ...base.nodes[1]!,
      verification: analystUnionVerification(["foundation", "scout-new"]) }])
    const result = validateTaskGraphOperationalFailureReplacement({ snapshot,
      replaceOperationalFailure: replacement(), proposal: candidate })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.replacementNodes[1]?.verification?.criteria[0]?.check).toEqual({
      kind: "findings_from_scout_union", dependencyNodeKeys: ["foundation", "scout-new"],
    })
  })

  it("accepts a failed-analyst leaf only when it is the actual complete closure", () => {
    const snapshot = { ...baseSnapshot(), nodes: [baseSnapshot().nodes[0]!, baseSnapshot().nodes[3]!,
      node({ key: "analyst-leaf", templateId: "analyst", dependsOn: ["foundation"] })] }
    const mode: TaskGraphOperationalFailureReplacement = {
      root: { nodeKey: "analyst-leaf", taskId: "analyst-leaf-task" },
      sources: [{ nodeKey: "analyst-leaf", taskId: "analyst-leaf-task", replacementKey: "analyst-retry" }],
    }
    const candidate = proposal([{ key: "analyst-retry", templateId: "analyst", goal: "Reassess", successCriteria: ["Produce useful evidence"],
      dependsOn: ["foundation"], verification: analystVerification("foundation") }])
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot, replaceOperationalFailure: mode, proposal: candidate })).toMatchObject({ ok: true })
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot, replaceOperationalFailure: mode,
      proposal: proposal([candidate.nodes[0]!, { ...candidate.nodes[0]!, key: "extra" }]) })).toMatchObject({ ok: false })
  })

  it("rejects partial mappings, changed contracts or edges, unsupported roles, and changed Root criteria", () => {
    const current = baseSnapshot(), candidate = proposal()
    const cases: ReadonlyArray<Readonly<{ mode?: TaskGraphOperationalFailureReplacement; nodes?: TaskGraphProposal["nodes"]; criteria?: readonly string[] }>> = [
      { mode: { ...replacement(), sources: replacement().sources.slice(0, 1) } },
      { nodes: [candidate.nodes[0]!, { ...candidate.nodes[1]!, dependsOn: ["scout-new"] }] },
      { nodes: [candidate.nodes[0]!, { ...candidate.nodes[1]!, verification: analystVerification("foundation") }] },
      { nodes: [{ ...candidate.nodes[0]!, successCriteria: ["Changed canonical criterion"] }, candidate.nodes[1]!] },
      { nodes: [{ ...candidate.nodes[0]!, templateId: "writer" }, candidate.nodes[1]!] },
      { criteria: ["Changed Root objective"] },
    ]
    for (const item of cases) expect(validateTaskGraphOperationalFailureReplacement({ snapshot: current,
      replaceOperationalFailure: item.mode ?? replacement(), proposal: proposal(item.nodes),
      ...(item.criteria ? { proposedRootSuccessCriteria: item.criteria } : {}),
    })).toMatchObject({ ok: false })
  })

  it("rejects missing roots, colliding fresh keys, legacy proof ancestry, and repair lineage", () => {
    const current = baseSnapshot(), candidate = proposal()
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot: current,
      replaceOperationalFailure: { root: { nodeKey: "scout-old", taskId: "wrong-task" }, sources: [
        { nodeKey: "scout-old", taskId: "wrong-task", replacementKey: "scout-new" },
        replacement().sources[1]!,
      ] }, proposal: candidate,
    })).toMatchObject({ ok: false, code: "task_graph_operational_failure_replacement_root_mismatch" })
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot: current,
      replaceOperationalFailure: { ...replacement(), sources: replacement().sources.map(source => ({ ...source,
        replacementKey: source.nodeKey === "scout-old" ? "foundation" : source.replacementKey })) }, proposal: proposal([
        { ...candidate.nodes[0]!, key: "foundation" }, candidate.nodes[1]!,
      ]),
    })).toMatchObject({ ok: false, code: "task_graph_operational_failure_replacement_key_collision" })
    const legacy = { ...current, nodes: [node({ key: "foundation", disposition: "legacy_unverified" }), ...current.nodes.slice(1)] }
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot: legacy, replaceOperationalFailure: replacement(), proposal: candidate }))
      .toMatchObject({ ok: false, code: "task_graph_dependency_unverified" })
    const repairTarget = node({ key: "repair-target" })
    const repaired = { ...current, nodes: [current.nodes[0]!, repairTarget,
      { ...current.nodes[1]!, repairOf: { graphRootTaskId: "root", nodeKey: "repair-target", taskId: "repair-target-task", criterionIds: ["candidate-count"] } },
      ...current.nodes.slice(2)] }
    expect(validateTaskGraphOperationalFailureReplacement({ snapshot: repaired, replaceOperationalFailure: replacement(), proposal: candidate }))
      .toMatchObject({ ok: false, code: "task_graph_operational_failure_replacement_repair_reference" })
  })
})
