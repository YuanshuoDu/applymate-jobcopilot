import { describe, expect, it } from "vitest"
import { injectSelectedJobMemory, mergeSelectedJobMemories, parseSelectedJobMemories, projectSelectedJobMemory } from "./selected-job-memory.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"

const projection = {
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
    key: "private-node-key", templateId: "analyst", taskId: "private-task-id", goal: "private narrative must not persist",
    successCriteria: ["private criteria"], dependsOn: [], resultSummary: "private summary", failureReason: null,
    status: "completed", readiness: "terminal", resultProjection: projection,
  }],
}
const memory = projectSelectedJobMemory({
  jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19", graph,
})!
const snapshot: StepContextSnapshot = {
  system: [], profile: [], steerHistory: [], businessRefs: [],
  toolObservations: [{ id: "task-graph-current", content: { kind: "task_graph_current", revision: graph.revision, nodes: graph.nodes } }],
}

describe("selected-job memory", () => {
  it("projects only the selected job typed result and excludes graph narrative and internal IDs", () => {
    expect(memory.nodes[0]).toMatchObject({
      role: "analyst", status: "completed", readiness: "terminal",
      result: { availability: "available", role: "analyst", score: 8.5, evidenceKinds: ["job", "resume"] },
    })
    const serialized = JSON.stringify(memory)
    for (const secret of ["job-b", "private narrative", "private criteria", "private summary", "private-node-key", "private-task-id"]) {
      expect(serialized).not.toContain(secret)
    }
    expect(parseSelectedJobMemories([memory])).toEqual([memory])
  })

  it("injects only when selector, turn, root and current graph digest all match", () => {
    const injected = injectSelectedJobMemory({ snapshot, records: [memory], jobId: "job-a", turnId: "turn-a", rootTaskId: "root-a" })
    expect(injected.toolObservations.find(item => item.id === "selected-job-memory")?.content).toMatchObject({
      kind: "selected_job_memory", informationalOnly: true, nodes: memory.nodes,
    })
    expect(injectSelectedJobMemory({ snapshot, records: [memory], jobId: "job-b", turnId: "turn-a", rootTaskId: "root-a" })).toEqual(snapshot)
    expect(injectSelectedJobMemory({ snapshot, records: [memory], turnId: "turn-a", rootTaskId: "root-a" })).toEqual(snapshot)
    expect(injectSelectedJobMemory({ snapshot, records: [memory], jobId: "job-a", turnId: "turn-b", rootTaskId: "root-a" })).toEqual(snapshot)
    expect(injectSelectedJobMemory({ snapshot, records: [memory], jobId: "job-a", turnId: "turn-a", rootTaskId: "root-b" })).toEqual(snapshot)
    expect(injectSelectedJobMemory({ snapshot: { ...snapshot, toolObservations: [] }, records: [memory], jobId: "job-a", turnId: "turn-a", rootTaskId: "root-a" })).toEqual({ ...snapshot, toolObservations: [] })
    const changedGraph = { ...snapshot, toolObservations: [{ id: "task-graph-current", content: {
      kind: "task_graph_current", revision: graph.revision, nodes: [{ ...graph.nodes[0], resultProjection: { ...projection, findings: [{ jobId: "job-a", score: 2, evidenceKinds: ["job"] }] } }],
    } }] }
    expect(injectSelectedJobMemory({ snapshot: changedGraph, records: [memory], jobId: "job-a", turnId: "turn-a", rootTaskId: "root-a" })).toEqual(changedGraph)
    expect(injectSelectedJobMemory({ snapshot, records: [{ ...memory, narrative: "unsafe" } as never], jobId: "job-a", turnId: "turn-a", rootTaskId: "root-a" })).toEqual(snapshot)
    const observation = injected.toolObservations.find(item => item.id === "selected-job-memory")
    expect(JSON.stringify(observation)).not.toContain("job-a")
    expect(JSON.stringify(observation)).not.toContain("root-a")
    expect(JSON.stringify(observation)).not.toContain("turn-a")
  })

  it("rejects tampering, invalid verifier codes, and unbounded or unknown snapshot fields", () => {
    expect(parseSelectedJobMemories([{ ...memory, graphDigest: "0".repeat(64) }])).toBeUndefined()
    expect(parseSelectedJobMemories(undefined, true)).toEqual([])
    expect(parseSelectedJobMemories([memory, { ...memory, sourceTurnId: "other" }])).toBeUndefined()
    expect(parseSelectedJobMemories([{ ...memory, unapprovedNarrative: "do not keep" }])).toBeUndefined()
    const oversized = { ...memory, nodes: Array.from({ length: 9 }, () => memory.nodes[0]) }
    expect(parseSelectedJobMemories([oversized])).toBeUndefined()
  })

  it("drops another job's scout and analyst facts while preserving selected-job facts", () => {
    const selected = projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19", graph: {
      revision: 5, nodes: [{ ...graph.nodes[0], templateId: "scout", resultProjection: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
        candidates: [{ jobId: "job-b", source: "lever", evidenceKinds: ["job"] }],
      } }],
    } })
    expect(selected?.nodes[0]?.result).toMatchObject({ availability: "available", role: "scout", selectedJobFound: false })
  })

  it("keeps only parsed verifier reason codes and rejects malformed verifier or repair receipts", () => {
    const verification = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
      criteria: [{ criterionId: "coverage", status: "passed", reasonCode: "criteria_met" }],
    }
    const node = { ...graph.nodes[0], verificationCriterionIds: ["coverage"], verificationReport: verification }
    const valid = projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19",
      graph: { revision: 6, nodes: [node] } })
    expect(valid?.nodes[0]?.verification).toEqual({ status: "passed", criteria: [{ status: "passed", reasonCode: "criteria_met" }] })
    expect(projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19",
      graph: { revision: 6, nodes: [{ ...node, verificationReport: { ...verification, reasonCode: "free-form reason" } }] } })).toBeNull()
    expect(parseSelectedJobMemories([{ ...valid!, nodes: [{ ...valid!.nodes[0]!, verification: { status: "passed", criteria: [{ status: "failed", reasonCode: "criterion_not_met" }] } }] }])).toBeUndefined()
    expect(projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "19",
      graph: { revision: 6, nodes: [{ ...graph.nodes[0], repairOf: { graphRootTaskId: "root-a", nodeKey: "target", taskId: "task-a", criterionIds: ["coverage"] }, repairReceipt: { note: "invalid" } }] } })).toBeNull()
  })

  it("deduplicates repeat compaction and retains a deterministic bounded latest set", () => {
    const records = Array.from({ length: 10 }, (_, index) => projectSelectedJobMemory({
      jobId: `job-${index}`, sourceTurnId: `turn-${index}`, sourceRootTaskId: `root-${index}`,
      throughSequence: String(index + 1), graph: { revision: 1, nodes: graph.nodes },
    })!)
    const merged = mergeSelectedJobMemories(records.slice(0, 8), [records[7]!, records[8]!, records[9]!])
    expect(merged).toHaveLength(8)
    expect(merged).toEqual(mergeSelectedJobMemories(merged, [records[9]!]))
    expect(parseSelectedJobMemories(merged)).toEqual(merged)
    expect(merged.map(item => item.jobId)).not.toContain("job-0")
  })
})
