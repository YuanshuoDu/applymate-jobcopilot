import { describe, expect, it } from "vitest"
import { projectScheduledPipelineGraph, projectScheduledPipelineGraphAtCurrentStage, scheduledPipelineV2ScoutMembershipMatches, type ScheduledPipelineGraphNode,
  type ScheduledPipelineGraphStage } from "./scheduled-pipeline-graph-shape.js"

function graph(count: number, stage: ScheduledPipelineGraphStage): ScheduledPipelineGraphNode[] {
  const scouts = Array.from({ length: count }, (_, index) => node(`scout-${String.fromCharCode(122 - index)}`, "scout", 1, []))
  const nodes = [...scouts, node("analyst", "analyst", 2, scouts.map(item => item.key).reverse())]
  if (stage === "prepare" || stage === "gate" || stage === "audit") nodes.push(node("prepare", "prepare", 3, ["analyst"]))
  if (stage === "gate" || stage === "audit") nodes.push(node("gate", "gate", 4, ["prepare"]))
  if (stage === "audit") nodes.push(node("scheduled_audit", "scheduled_audit", 5, ["gate"]))
  return nodes
}
function graphWithExecutes(count: number, executeCount: number): ScheduledPipelineGraphNode[] {
  const prefix = graph(count, "gate")
  const executes = Array.from({ length: executeCount }, (_, index) => ({
    ...node(`execute-${index + 1}`, "scheduled.application.execute", 5, ["gate"]), packageRefs: [`job-${index + 1}`],
  }))
  return [...prefix, ...executes, node("scheduled.post_gate_audit", "scheduled.post_gate_audit", 6, executes.map(item => item.key))]
}
function node(key: string, templateId: string, depth: number, dependsOn: string[]): ScheduledPipelineGraphNode {
  return { key, templateId, depth, dependsOn }
}

describe("projectScheduledPipelineGraph", () => {
  it.each(["analyze", "prepare", "gate", "audit"] as const)("projects the v1 singleton at %s", stage => {
    const projection = projectScheduledPipelineGraph(graph(1, stage), "v1", stage)
    expect(projection).toMatchObject({ version: "v1", stage, scouts: [{ key: "scout-z" }], analyst: { key: "analyst" } })
  })
  it.each([2, 4])("projects the v2 %i-source topology through every suffix stage", count => {
    for (const stage of ["analyze", "prepare", "gate", "audit"] as const) {
      const projection = projectScheduledPipelineGraph(graph(count, stage), "v2", stage)
      expect(projection).not.toBeNull()
      expect(projection?.scouts.map(item => item.key)).toEqual(graph(count, stage).slice(0, count).map(item => item.key))
      expect(projection?.analyst.dependsOn).toEqual(projection?.scouts.map(item => item.key).reverse())
    }
  })
  it("matches the complete Scout membership as a set without changing authored order", () => {
    const nodes = graph(2, "analyze"), projection = projectScheduledPipelineGraph(nodes, "v2", "analyze")
    expect(projection?.scouts.map(item => item.key)).toEqual(["scout-z", "scout-y"])
    expect(scheduledPipelineV2ScoutMembershipMatches(["scout-y", "scout-z"], projection!.scouts)).toBe(true)
    expect(scheduledPipelineV2ScoutMembershipMatches(["scout-z"], projection!.scouts)).toBe(false)
    expect(scheduledPipelineV2ScoutMembershipMatches(["scout-z", "scout-y", "scout-extra"], projection!.scouts)).toBe(false)
    expect(scheduledPipelineV2ScoutMembershipMatches(["scout-z", "scout-z"], projection!.scouts)).toBe(false)
    expect(scheduledPipelineV2ScoutMembershipMatches([], [])).toBe(false)
    expect(scheduledPipelineV2ScoutMembershipMatches(["scout-z"], projection!.scouts.slice(0, 1))).toBe(false)
  })
  it("projects one to three post-Gate Execute nodes and an Audit bound to every Execute", () => {
    for (const executeCount of [1, 2, 3]) {
      const nodes = graphWithExecutes(4, executeCount)
      const projection = projectScheduledPipelineGraph(nodes, "v2", "audit")
      expect(projection?.stage).toBe("audit")
      expect(projection?.executes).toHaveLength(executeCount)
      expect(projectScheduledPipelineGraphAtCurrentStage(nodes)).toMatchObject({ version: "v2", projection: { stage: "audit" } })
      expect(nodes).toHaveLength(7 + executeCount + 1)
    }
  })
  it.each([
    [1, "v2"], [5, "v2"], [2, "v1"], [4, "v1"],
  ] as const)("rejects Scout count %i in %s", (count, version) => {
    expect(projectScheduledPipelineGraph(graph(count, "analyze"), version, "analyze")).toBeNull()
  })
  it("rejects gaps, extra nodes, wrong suffix depths, and non-Scout prefixes", () => {
    const prefix = graph(2, "analyze")
    expect(projectScheduledPipelineGraph([...prefix, node("gate", "gate", 4, ["prepare"])], "v2", "gate")).toBeNull()
    expect(projectScheduledPipelineGraph([...graph(2, "audit"), node("extra", "scout", 1, [])], "v2", "audit")).toBeNull()
    const wrongDepth = graph(2, "prepare"); wrongDepth[3] = node("prepare", "prepare", 4, ["analyst"])
    expect(projectScheduledPipelineGraph(wrongDepth, "v2", "prepare")).toBeNull()
    const wrongPrefix = graph(2, "analyze"); wrongPrefix[0] = node("other", "analyst", 1, [])
    expect(projectScheduledPipelineGraph(wrongPrefix, "v2", "analyze")).toBeNull()
  })
  it("rejects malformed post-Gate Execute dependencies and an unbounded suffix", () => {
    expect(projectScheduledPipelineGraph(graphWithExecutes(1, 1), "v1", "audit")).toBeNull()
    const wrongAudit = graphWithExecutes(2, 2)
    wrongAudit[wrongAudit.length - 1] = node("scheduled.post_gate_audit", "scheduled.post_gate_audit", 6, ["execute-1"])
    expect(projectScheduledPipelineGraph(wrongAudit, "v2", "audit")).toBeNull()
    const wrongExecute = graphWithExecutes(2, 1)
    wrongExecute[wrongExecute.length - 2] = node("execute-1", "execute", 5, ["analyst"])
    expect(projectScheduledPipelineGraph(wrongExecute, "v2", "audit")).toBeNull()
    expect(projectScheduledPipelineGraph(graphWithExecutes(2, 4), "v2", "audit")).toBeNull()
    const missingPackageRefs = graphWithExecutes(2, 1)
    missingPackageRefs[missingPackageRefs.length - 2] = node("execute-1", "scheduled.application.execute", 5, ["gate"])
    expect(projectScheduledPipelineGraph(missingPackageRefs, "v2", "audit")).toBeNull()
    const duplicatePackageRefs = graphWithExecutes(2, 2)
    duplicatePackageRefs[duplicatePackageRefs.length - 2] = {
      ...duplicatePackageRefs[duplicatePackageRefs.length - 2]!, packageRefs: ["job-1"],
    }
    expect(projectScheduledPipelineGraph(duplicatePackageRefs, "v2", "audit")).toBeNull()
  })
  it.each([[1, "v1"], [2, "v2"], [4, "v2"]] as const)("infers every complete %s pipeline stage", (count, version) => {
    for (const stage of ["analyze", "prepare", "gate", "audit"] as const) {
      expect(projectScheduledPipelineGraphAtCurrentStage(graph(count, stage))).toMatchObject({ version, projection: { stage } })
    }
  })
  it("does not infer a stage from a malformed or overlong graph", () => {
    const malformed = graph(2, "gate")
    malformed[3] = node("prepare", "prepare", 3, ["missing-analyst"])
    expect(projectScheduledPipelineGraphAtCurrentStage(malformed)).toBeNull()
    expect(projectScheduledPipelineGraphAtCurrentStage([...graph(4, "audit"), node("extra", "scout", 1, [])])).toBeNull()
  })
})
