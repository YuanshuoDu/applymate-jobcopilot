import { describe, expect, it } from "vitest"
import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./task-graph-verification.js"
import type { TaskGraphNodeProposal } from "./task-graph.js"
import { selectTaskGraphObjectiveRequirementLineage } from "./task-graph-objective-lineage.js"

const requirement: RootTaskVerificationRequirement = { id: "roles", kind: "candidate_count_gte", minimum: 2 }
const verification = () => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "roles", check: { kind: "candidate_count_gte" as const, minimum: 3 } }] })
const node = (key: string, taskId: string, repairOf?: TaskGraphNodeProposal["repairOf"]) => ({
  key, taskId, templateId: "scout", goal: "Find roles", successCriteria: ["Return roles"], dependsOn: [],
  verification: verification(), verificationDisposition: "typed" as const, status: "failed" as const,
  ...(repairOf ? { repairOf } : {}),
})
const repair = (nodeKey: string, taskId: string, graphRootTaskId = "root") => ({
  graphRootTaskId, nodeKey, taskId, criterionIds: ["roles"],
})

describe("TaskGraph objective requirement lineage selector", () => {
  it("selects the latest graph-order member across chained repairs and repeated-target retries", () => {
    const original = node("original", "task-original")
    const first = node("first", "task-first", repair("original", "task-original"))
    const latest = node("latest", "task-latest", repair("first", "task-first"))
    const selected = selectTaskGraphObjectiveRequirementLineage(requirement, [original, first, latest], "root")
    expect(selected).toEqual({ status: "selected", node: latest, criterion: latest.verification.criteria[0] })

    const retry = node("retry", "task-retry", repair("original", "task-original"))
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [original, first, retry], "root"))
      .toMatchObject({ status: "selected", node: retry })
  })

  it("accepts minimal current-observation nodes and preserves caller state", () => {
    const target = { key: "target", taskId: "task-target", templateId: "scout", dependsOn: [], verification: verification(),
      verificationDisposition: "typed" as const, status: "failed" as const, verificationReport: { status: "unverified" } }
    const current = { key: "current", taskId: "task-current", templateId: "scout", dependsOn: [], verification: verification(),
      verificationDisposition: "typed" as const, repairOf: repair("target", "task-target"), status: "running" as const,
      verificationReport: { status: "passed" } }
    const selected = selectTaskGraphObjectiveRequirementLineage(requirement, [target, current], "root")
    expect(selected).toMatchObject({ status: "selected", node: current, criterion: current.verification.criteria[0] })
    if (selected.status !== "selected") throw new Error("objective_lineage_selection_missing")
    expect(selected.node.status).toBe("running")
    expect(Object.hasOwn(selected.node, "goal")).toBe(false)
    expect(Object.hasOwn(selected.node, "successCriteria")).toBe(false)
  })

  it("distinguishes an absent criterion from malformed or ambiguous lineage", () => {
    const absent = { ...node("other", "task-other"), verification: { ...verification(), criteria: [] } }
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [absent], "root")).toEqual({ status: "missing" })

    const duplicate = { ...node("duplicate", "task-duplicate"), verification: { ...verification(), criteria: [
      ...verification().criteria, ...verification().criteria,
    ] } }
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [duplicate], "root")).toEqual({ status: "invalid" })
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [node("one", "task-one"), node("two", "task-two")], "root"))
      .toEqual({ status: "invalid" })
  })

  it("rejects cyclic, missing-target, and wrong-root-scope repair links", () => {
    const cycleFirst = node("cycle-first", "task-cycle-first", repair("cycle-second", "task-cycle-second"))
    const cycleSecond = node("cycle-second", "task-cycle-second", repair("cycle-first", "task-cycle-first"))
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [cycleFirst, cycleSecond], "root"))
      .toEqual({ status: "invalid" })

    const missingTarget = node("orphan", "task-orphan", repair("missing", "task-missing"))
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [missingTarget], "root")).toEqual({ status: "invalid" })

    const target = node("target", "task-target")
    const wrongScope = node("repair", "task-repair", repair("target", "task-target", "different-root"))
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [target, wrongScope], "root"))
      .toEqual({ status: "invalid" })

    const validRepair = node("scoped-repair", "task-scoped-repair", repair("target", "task-target"))
    expect(selectTaskGraphObjectiveRequirementLineage(requirement, [target, validRepair], ""))
      .toEqual({ status: "invalid" })
  })
})
