import { describe, expect, it } from "vitest"
import { scheduledPrepareGateVerifierStage } from "./canonical-turn-scheduled-pipeline-context.js"
import type { ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"

function graph(scoutCount: number, stage: "analyze" | "prepare" | "gate" | "audit"): ScheduledPipelineGraphNode[] {
  const scouts = Array.from({ length: scoutCount }, (_, index) => ({ key: `scout-${index}`, templateId: "scout", depth: 1, dependsOn: [] }))
  const nodes = [...scouts, { key: "analyst", templateId: "analyst", depth: 2, dependsOn: scouts.map(node => node.key) }]
  if (stage !== "analyze") nodes.push({ key: "prepare", templateId: "prepare", depth: 3, dependsOn: ["analyst"] })
  if (stage === "gate" || stage === "audit") nodes.push({ key: "gate", templateId: "gate", depth: 4, dependsOn: ["prepare"] })
  if (stage === "audit") nodes.push({ key: "scheduled_audit", templateId: "scheduled_audit", depth: 5, dependsOn: ["gate"] })
  return nodes
}

describe("scheduled Prepare verifier routing", () => {
  it("routes only current Gate/Audit stages, not a four-node two-Scout Prepare graph", () => {
    expect(graph(2, "prepare")).toHaveLength(4)
    expect(scheduledPrepareGateVerifierStage(graph(2, "prepare"))).toBeNull()
    expect(scheduledPrepareGateVerifierStage(graph(1, "gate"))).toBe("gate")
    expect(scheduledPrepareGateVerifierStage(graph(2, "gate"))).toBe("gate")
    expect(scheduledPrepareGateVerifierStage(graph(4, "audit"))).toBe("audit")
  })
  it("fails closed for incomplete or malformed prefixes", () => {
    expect(scheduledPrepareGateVerifierStage(graph(2, "analyze"))).toBeNull()
    const malformed = graph(2, "gate")
    malformed[3] = { ...malformed[3]!, dependsOn: ["missing"] }
    expect(scheduledPrepareGateVerifierStage(malformed)).toBeNull()
  })
})
