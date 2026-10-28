import { describe, expect, it } from "vitest"
import { injectSelectedJobMemory, mergeSelectedJobMemories, parseSelectedJobMemories, projectSelectedJobMemory } from "./selected-job-memory.js"
import { projectSelectedJobHistory } from "./selected-job-history.js"
import { projectSelectedJobMemoryNodes } from "./selected-job-memory-node-projection.js"
import { sha256Hex } from "./context-compaction-canonical.js"
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
const unresolvedGraph = { revision: 5, nodes: [{ ...graph.nodes[0], status: "failed", verificationCriterionIds: ["salary-floor"],
  verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "repair_target_unresolved",
    evidenceDigest: null, resultDigest: "c".repeat(64), criteria: [{ criterionId: "salary-floor", status: "passed", reasonCode: "criteria_met" }] } }] }

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
    const legacyNodes = projectSelectedJobMemoryNodes({ jobId: "job-a", graph })
    if (!legacyNodes) throw new Error("expected the original unmarked node projection")
    const oldIdentity = { schemaVersion: memory.schemaVersion, jobId: memory.jobId, sourceTurnId: memory.sourceTurnId,
      sourceRootTaskId: memory.sourceRootTaskId, graphRevision: memory.graphRevision, throughSequence: memory.throughSequence, nodes: legacyNodes }
    expect(memory).toEqual({ ...oldIdentity, graphDigest: sha256Hex(oldIdentity) })
  })

  it("retains only the exact unresolved-repair marker and binds it into the digest", () => {
    const repair = projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-repair", sourceRootTaskId: "root-repair",
      throughSequence: "20", graph: unresolvedGraph })
    expect(repair?.nodes[0]).toMatchObject({ status: "failed", historicalRepairReasonHint: "repair_target_unresolved" })
    expect(repair?.nodes[0]).not.toHaveProperty("verification")
    expect(parseSelectedJobMemories(repair ? [repair] : [])).toEqual(repair ? [repair] : [])
    if (!repair) throw new Error("expected canonical unresolved-repair memory")

    const withoutMarker = repair.nodes.map(({ historicalRepairReasonHint: _hint, ...node }) => node)
    expect(parseSelectedJobMemories([{ ...repair, nodes: withoutMarker }])).toBeUndefined()
    expect(parseSelectedJobMemories([{ ...repair, nodes: repair.nodes.map(node => ({ ...node, historicalRepairReasonHint: "private_reason" })) }])).toBeUndefined()
    const wrongMarkerNodes = repair.nodes.map(node => ({ ...node, historicalRepairReasonHint: "private_reason" }))
    const wrongMarkerIdentity = { schemaVersion: repair.schemaVersion, jobId: repair.jobId, sourceTurnId: repair.sourceTurnId,
      sourceRootTaskId: repair.sourceRootTaskId, graphRevision: repair.graphRevision, throughSequence: repair.throughSequence, nodes: wrongMarkerNodes }
    expect(parseSelectedJobMemories([{ ...wrongMarkerIdentity, graphDigest: sha256Hex(wrongMarkerIdentity) }])).toBeUndefined()
    const forbiddenNodeVariants = [
      repair.nodes.map(node => ({ ...node, verification: { status: "unverified", criteria: [{ status: "passed", reasonCode: "criteria_met" }] } })),
      repair.nodes.map(node => ({ ...node, privateField: "must fail the exact node key set" })),
    ]
    for (const nodes of forbiddenNodeVariants) {
      const identity = { schemaVersion: repair.schemaVersion, jobId: repair.jobId, sourceTurnId: repair.sourceTurnId,
        sourceRootTaskId: repair.sourceRootTaskId, graphRevision: repair.graphRevision, throughSequence: repair.throughSequence, nodes }
      expect(parseSelectedJobMemories([{ ...identity, graphDigest: sha256Hex(identity) }])).toBeUndefined()
    }
    const unmarkedIdentity = { schemaVersion: repair.schemaVersion, jobId: repair.jobId, sourceTurnId: repair.sourceTurnId,
      sourceRootTaskId: repair.sourceRootTaskId, graphRevision: repair.graphRevision, throughSequence: repair.throughSequence, nodes: withoutMarker }
    const unmarked = parseSelectedJobMemories([{ ...unmarkedIdentity, graphDigest: sha256Hex(unmarkedIdentity) }])
    expect(unmarked?.[0]?.nodes[0]?.historicalRepairReasonHint).toBeUndefined()
    const unmarkedHistory = unmarked?.[0] ? projectSelectedJobHistory([{ record: unmarked[0], terminalSequence: 21n }]) : undefined
    expect(unmarkedHistory).toMatchObject({ content: { turns: [{ nodes: [{ role: "analyst", status: "failed" }] }] } })
    expect(JSON.stringify(unmarkedHistory?.content)).not.toContain("repair_target_unresolved")

    const ambiguousNodes = projectSelectedJobMemoryNodes({ jobId: "job-a", graph: unresolvedGraph })
    if (!ambiguousNodes) throw new Error("expected the unmarked ambiguous legacy projection")
    const ambiguousIdentity = { schemaVersion: repair.schemaVersion, jobId: repair.jobId, sourceTurnId: repair.sourceTurnId,
      sourceRootTaskId: repair.sourceRootTaskId, graphRevision: repair.graphRevision, throughSequence: repair.throughSequence, nodes: ambiguousNodes }
    expect(parseSelectedJobMemories([{ ...ambiguousIdentity, graphDigest: sha256Hex(ambiguousIdentity) }])).toBeUndefined()
  })

  it("strips the historical marker from the same-Turn model observation after freshness validation", () => {
    const repair = projectSelectedJobMemory({ jobId: "job-a", sourceTurnId: "turn-repair", sourceRootTaskId: "root-repair",
      throughSequence: "20", graph: unresolvedGraph })
    if (!repair) throw new Error("expected canonical unresolved-repair memory")
    const repairSnapshot: StepContextSnapshot = { ...snapshot, toolObservations: [{ id: "task-graph-current",
      content: { kind: "task_graph_current", revision: unresolvedGraph.revision, nodes: unresolvedGraph.nodes } }] }
    const injected = injectSelectedJobMemory({ snapshot: repairSnapshot, records: [repair], jobId: "job-a", turnId: "turn-repair", rootTaskId: "root-repair" })
    const observation = injected.toolObservations.find(item => item.id === "selected-job-memory")?.content
    expect(observation).toMatchObject({ kind: "selected_job_memory", nodes: [{ role: "analyst", status: "failed" }] })
    expect(observation).not.toHaveProperty("nodes.0.historicalRepairReasonHint")
    expect(JSON.stringify(observation)).not.toContain("repair_target_unresolved")
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

  it("deep-copies parsed result objects and arrays", () => {
    const input = structuredClone(memory)
    const parsed = parseSelectedJobMemories([input])
    if (!parsed) throw new Error("Expected selected-job memory to parse")
    const parsedResult = parsed[0]?.nodes[0]?.result
    if (!parsedResult || parsedResult.availability !== "available" || parsedResult.role !== "analyst") {
      throw new Error("Expected an available analyst result")
    }

    const mutable = parsedResult as unknown as { score: number; evidenceKinds: string[] }
    mutable.score = 1
    mutable.evidenceKinds.push("source")

    expect(input).toEqual(memory)
    const reparsed = parseSelectedJobMemories([input])
    expect(reparsed).toEqual([memory])
    expect(reparsed?.[0]?.nodes[0]?.result).not.toBe(parsedResult)
    const reparsedResult = reparsed?.[0]?.nodes[0]?.result
    if (reparsedResult?.availability === "available" && reparsedResult.role === "analyst" && "evidenceKinds" in reparsedResult) {
      expect(reparsedResult.evidenceKinds).not.toBe(mutable.evidenceKinds)
    }
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

    const input = structuredClone(valid!)
    const parsed = parseSelectedJobMemories([input])
    const parsedVerification = parsed?.[0]?.nodes[0]?.verification
    if (!parsedVerification?.criteria[0]) throw new Error("Expected a parsed verification criterion")
    const mutableCriterion = parsedVerification.criteria[0] as unknown as { status: string; reasonCode: string }
    mutableCriterion.status = "failed"
    mutableCriterion.reasonCode = "criterion_not_met"

    expect(input).toEqual(valid)
    expect(parseSelectedJobMemories([input])).toEqual([valid])
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
