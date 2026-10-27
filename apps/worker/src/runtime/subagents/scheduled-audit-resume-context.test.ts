import { describe, expect, it } from "vitest"
import { projectScheduledAuditResumeGraph } from "./scheduled-audit-resume-context.js"
import type { ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"

function graph(scoutCount: number, stage: "analyze" | "prepare" | "gate" | "audit"): ScheduledPipelineGraphNode[] {
  const scouts = Array.from({ length: scoutCount }, (_, index) => ({ key: `source-${index}`, templateId: "scout", depth: 1, dependsOn: [] }))
  const nodes = [...scouts, { key: "analyst", templateId: "analyst", depth: 2, dependsOn: scouts.map(node => node.key).reverse() }]
  if (stage !== "analyze") nodes.push({ key: "prepare", templateId: "prepare", depth: 3, dependsOn: ["analyst"] })
  if (stage === "gate" || stage === "audit") nodes.push({ key: "gate", templateId: "gate", depth: 4, dependsOn: ["prepare"] })
  if (stage === "audit") nodes.push({ key: "scheduled_audit", templateId: "scheduled_audit", depth: 5, dependsOn: ["gate"] })
  return nodes
}

describe("scheduled Audit resume graph context", () => {
  it.each([1, 2, 4])("recognizes valid v1/v2 stages for %i sources", count => {
    for (const stage of ["analyze", "prepare", "gate", "audit"] as const) {
      expect(projectScheduledAuditResumeGraph(graph(count, stage))?.projection.stage).toBe(stage)
    }
  })
  it("rejects malformed or unsupported source prefixes", () => {
    const malformed = graph(2, "audit")
    malformed[2] = { ...malformed[2]!, dependsOn: ["missing"] }
    expect(projectScheduledAuditResumeGraph(malformed)).toBeNull()
    expect(projectScheduledAuditResumeGraph(graph(5, "gate"))).toBeNull()
  })
})
