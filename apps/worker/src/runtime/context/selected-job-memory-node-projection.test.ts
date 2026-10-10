import { describe, expect, it } from "vitest"
import { parseSelectedJobMemoryNodes, projectSelectedJobMemoryNodes } from "./selected-job-memory-node-projection.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"

const resultProjection = {
  schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
  role: "analyst", status: "completed", findingCount: 2, evidenceCount: 3,
  findings: [
    { jobId: "job-a", score: 8.5, evidenceKinds: ["job", "resume"] },
    { jobId: "job-b", score: 3, evidenceKinds: ["job"] },
  ],
}
const graph = {
  revision: 4,
  nodes: [{
    key: "private-node-key", templateId: "analyst", taskId: "private-task-id", goal: "private narrative",
    successCriteria: ["private criteria"], resultSummary: "private summary", failureReason: "private failure",
    status: "completed", readiness: "terminal", resultProjection,
  }],
}

describe("selected-job node projection", () => {
  it("reuses the compacted record projection exactly without adding record metadata", () => {
    const nodes = projectSelectedJobMemoryNodes({ jobId: "job-a", graph })
    const record = projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19", graph })
    expect(nodes).toEqual(record?.nodes)
    expect(nodes?.[0]).toMatchObject({ role: "analyst", status: "completed", readiness: "terminal", repairState: "none",
      result: { availability: "available", role: "analyst", score: 8.5, evidenceKinds: ["job", "resume"] } })
    const serialized = JSON.stringify(nodes)
    for (const privateValue of ["job-a", "job-b", "private-node-key", "private-task-id", "private narrative", "private criteria", "private summary", "private failure", "throughSequence", "graphDigest"]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(JSON.stringify(record)).toContain("throughSequence")
    expect(JSON.stringify(record)).toContain("graphDigest")
  })

  it("preserves selected-job filtering for scout and analyst projections", () => {
    const noMatch = projectSelectedJobMemoryNodes({ jobId: "job-a", graph: { revision: 1, nodes: [{
      templateId: "analyst", status: "completed", readiness: "terminal", resultProjection: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId: "job-b", score: 9, evidenceKinds: ["job"] }],
      },
    }] } })
    expect(noMatch?.[0]?.result).toEqual({ availability: "available", role: "analyst", status: "completed", selectedJobFound: false })
  })

  it("strictly parses bounded canonical nodes into independent typed copies", () => {
    const nodes = projectSelectedJobMemoryNodes({ jobId: "job-a", graph })
    const parsed = parseSelectedJobMemoryNodes(nodes)
    expect(parsed).toEqual(nodes)
    expect(parsed).not.toBe(nodes)
    expect(parseSelectedJobMemoryNodes([{ ...nodes![0]!, privateField: "raw" }])).toBeNull()
    expect(parseSelectedJobMemoryNodes([{ ...nodes![0]!, result: { availability: "available", role: "analyst", status: "completed", score: 11, evidenceKinds: ["job"] } }])).toBeNull()
    expect(parseSelectedJobMemoryNodes([nodes![0], nodes![0]])).toBeNull()
    expect(parseSelectedJobMemoryNodes(new Array(1))).toBeNull()
    const oversized = new Proxy(new Array(9), {
      getOwnPropertyDescriptor(target, property) {
        if (property !== "length") throw new Error("oversized sparse nodes must be rejected before traversal")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(parseSelectedJobMemoryNodes(oversized)).toBeNull()
  })

  it("rejects invalid graph bounds before walking nodes", () => {
    const sparse = new Array(1)
    expect(projectSelectedJobMemoryNodes({ jobId: "job-a", graph: { revision: 1, nodes: sparse } })).toBeNull()
    const oversized = new Proxy(new Array(9), {
      getOwnPropertyDescriptor(target, property) {
        if (property !== "length") throw new Error("oversized sparse graph must be rejected before traversal")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(projectSelectedJobMemoryNodes({ jobId: "job-a", graph: { revision: 1, nodes: oversized } })).toBeNull()
    expect(projectSelectedJobMemoryNodes({ jobId: " job-a", graph })).toBeNull()
    expect(projectSelectedJobMemoryNodes({ jobId: "job-a", graph: { ...graph, revision: 0 } })).toBeNull()
  })
})
