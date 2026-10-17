import { describe, expect, it } from "vitest"
import {
  parseSelectedJobHistoryMemoryNodes, parseSelectedJobMemoryNodes, projectSelectedJobHistoryMemoryNodes, projectSelectedJobMemoryNodes,
} from "./selected-job-memory-node-projection.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"

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

  it("keeps the canonical unresolved repair report as a fixed direct-history hint only", () => {
    const unresolved = {
      templateId: "analyst", key: "private-repair-node", taskId: "private-repair-task", status: "failed", readiness: "terminal",
      verificationCriterionIds: ["salary-floor"], verificationReport: {
        verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "repair_target_unresolved",
        evidenceDigest: null, resultDigest: "c".repeat(64),
        criteria: [{ criterionId: "salary-floor", status: "passed", reasonCode: "criteria_met" }],
      },
      resultProjection: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId: "job-a", score: 6, evidenceKinds: ["job"] }],
      },
    }
    const graph = { revision: 1, nodes: [unresolved] }
    const ordinary = projectSelectedJobMemoryNodes({ jobId: "job-a", graph })
    expect(ordinary?.[0]?.verification).toMatchObject({ status: "unverified", criteria: [{ status: "passed", reasonCode: "criteria_met" }] })
    expect(parseSelectedJobMemoryNodes(ordinary)).toBeNull()

    const historical = projectSelectedJobHistoryMemoryNodes({ jobId: "job-a", graph })
    expect(historical?.[0]).toMatchObject({
      role: "analyst", status: "failed", historicalRepairReasonHint: "repair_target_unresolved",
      result: { availability: "available", score: 6, evidenceKinds: ["job"] },
    })
    expect(historical?.[0]).not.toHaveProperty("verification")
    expect(parseSelectedJobHistoryMemoryNodes(historical)).toEqual(historical)
    const serialized = JSON.stringify(historical)
    for (const privateValue of ["private-repair-node", "private-repair-task", "salary-floor", "evidenceDigest", "resultDigest", "criteria_met"]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(serialized).toContain("repair_target_unresolved")

    const wrongDigest = { ...unresolved, verificationReport: { ...unresolved.verificationReport, resultDigest: null } }
    expect(projectSelectedJobHistoryMemoryNodes({ jobId: "job-a", graph: { revision: 1, nodes: [wrongDigest] } })).toBeNull()
    const nonNullEvidence = { ...unresolved, verificationReport: { ...unresolved.verificationReport, evidenceDigest: "d".repeat(64) } }
    expect(projectSelectedJobHistoryMemoryNodes({ jobId: "job-a", graph: { revision: 1, nodes: [nonNullEvidence] } })).toBeNull()
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
