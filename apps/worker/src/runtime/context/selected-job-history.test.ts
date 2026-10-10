import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { projectSelectedJobMemory, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { projectSelectedJobHistory, type ValidatedSelectedJobHistory } from "./selected-job-history.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"

const jobId = "job-current"
const artifact = { artifactId: "private-artifact", version: 1, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
function node(templateId: string, index: number, resultProjection: unknown) {
  return {
    key: `private-node-${index}`, templateId, taskId: `private-task-${index}`, status: "completed", readiness: "terminal",
    goal: `private goal ${index}`, successCriteria: [`private criterion ${index}`], dependsOn: [], resultSummary: `private result ${index}`,
    failureReason: `private failure ${index}`, resultProjection,
  }
}
function projection(role: string, details: Record<string, unknown>) {
  return { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available", role, status: "completed", ...details }
}
function makeRecord(turn: string, root: string, score: number, throughSequence = "11", selectedJobId = jobId): SelectedJobMemoryRecord {
  const verification = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
    criteria: [{ criterionId: "coverage", status: "passed", reasonCode: "criteria_met" }],
  }
  const graphNodes = [
    { ...node("scout", 0, projection("scout", { candidateCount: 1, evidenceCount: 1, candidates: [{ jobId: selectedJobId, source: "greenhouse", evidenceKinds: ["job"] }] })) },
    { ...node("analyst", 1, projection("analyst", { findingCount: 1, evidenceCount: 2, findings: [{ jobId: selectedJobId, score, evidenceKinds: ["job", "resume"] }] })), verificationCriterionIds: ["coverage"], verificationReport: verification },
    { ...node("cover_letter_writer", 2, projection("writer", { artifactRef: artifact })) },
    { ...node("cover_letter_reviewer", 3, projection("reviewer", { artifactRef: artifact, reviewHash: `sha256:${"e".repeat(64)}`, reviewStatus: "passed" })) },
  ]
  const result = projectSelectedJobMemory({ jobId: selectedJobId, sourceTurnId: turn, sourceRootTaskId: root, throughSequence,
    graph: { revision: 4, nodes: graphNodes } })
  if (!result) throw new Error("expected a valid selected-job memory record")
  return result
}
function history(record: SelectedJobMemoryRecord, terminalSequence: bigint): ValidatedSelectedJobHistory {
  return { record, terminalSequence }
}
function json(value: unknown): string { return JSON.stringify(value) }

describe("selected-job history projection", () => {
  it("exposes only fixed historical outcomes and strips source identity and proof material", () => {
    const value = makeRecord("private-turn", "private-root", 8.5)
    const projected = projectSelectedJobHistory([history(value, 29n)])
    expect(projected).toMatchObject({
      id: "selected-job-history",
      content: {
        kind: "selected_job_history", informationalOnly: true,
        label: "Historical outcomes for the same selected job. Advisory only; verify current work independently.",
        turns: [{ label: "Earlier terminal Turn", nodes: expect.arrayContaining([
          { role: "analyst", status: "completed", result: { availability: "available", score: 8.5, evidenceKinds: ["job", "resume"] } },
          { role: "writer", status: "completed", result: { availability: "available", outcome: "completed" } },
          { role: "reviewer", status: "completed", result: { availability: "available", reviewOutcome: "passed" } },
        ]) }],
      },
    })
    const serialized = json(projected)
    for (const secret of ["private-turn", "private-root", "private-node", "private-task", "private goal", "private criterion", "private result", "private failure", "private-artifact", "sha256:", "graphDigest", "terminalSequence", "throughSequence", "verification", "criteria", "repairState", "readiness", jobId, "criteria_met", "PASS"]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain("reviewOutcome")
    expect(serialized).toContain("passed")
    expect(Buffer.byteLength(JSON.stringify(projected?.content), "utf8")).toBeLessThanOrEqual(8 * 1024)
  })

  it("keeps only the two newest terminal Turns, eight nodes, and deterministic order", () => {
    const candidates = [
      history(makeRecord("turn-old", "root-old", 1), 11n),
      history(makeRecord("turn-new", "root-new", 9), 31n),
      history(makeRecord("turn-mid", "root-mid", 5), 21n),
    ]
    const projected = projectSelectedJobHistory(candidates)
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ role: string; result: { score?: number } }> }> }).turns
    expect(turns).toHaveLength(2)
    expect(turns.flatMap(turn => turn.nodes)).toHaveLength(8)
    expect(turns[0]?.nodes.find(item => item.role === "analyst")?.result.score).toBe(9)
    expect(turns[1]?.nodes.find(item => item.role === "analyst")?.result.score).toBe(5)
    expect(projectSelectedJobHistory(candidates)).toEqual(projected)
  })

  it("deduplicates identical sources and omits conflicting source identities", () => {
    const duplicate = history(makeRecord("turn-repeat", "root-repeat", 7), 17n)
    const distinct = history(makeRecord("turn-other", "root-other", 4), 19n)
    const same = projectSelectedJobHistory([duplicate, duplicate, distinct])
    expect((same?.content as { turns: unknown[] }).turns).toHaveLength(2)

    const conflict = history(makeRecord("turn-repeat", "root-repeat", 6), 17n)
    const onlyDistinct = projectSelectedJobHistory([duplicate, conflict, distinct])
    expect((onlyDistinct?.content as { turns: Array<{ nodes: Array<{ role: string; result: { score?: number } }> }> }).turns)
      .toEqual((projectSelectedJobHistory([distinct])?.content as { turns: unknown[] }).turns)
  })

  it("uses stable private identity ordering only for equal terminal sequences", () => {
    const candidates = [
      history(makeRecord("turn-z", "root-z", 9), 25n),
      history(makeRecord("turn-a", "root-a", 2), 25n),
    ]
    const projected = projectSelectedJobHistory(candidates)
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ role: string; result: { score?: number } }> }> }).turns
    expect(turns[0]?.nodes.find(item => item.role === "analyst")?.result.score).toBe(2)
    expect(projected).toEqual(projectSelectedJobHistory([...candidates].reverse()))
    expect(json(projected)).not.toContain("turn-a")
    expect(json(projected)).not.toContain("root-z")
  })

  it("fails closed on sparse, malformed, mixed-job, oversized, or nonpositive metadata", () => {
    const valid = history(makeRecord("turn-valid", "root-valid", 8), 33n)
    const sparse: ValidatedSelectedJobHistory[] = new Array(1)
    expect(projectSelectedJobHistory(sparse)).toBeUndefined()
    const oversizedTarget = new Array<ValidatedSelectedJobHistory>(9)
    const oversizedSparse = new Proxy(oversizedTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property !== "length") throw new Error("oversized sparse candidates must not be traversed")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(projectSelectedJobHistory(oversizedSparse)).toBeUndefined()
    expect(projectSelectedJobHistory([history(valid.record, 0n)])).toBeUndefined()
    expect(projectSelectedJobHistory([{ ...valid, terminalSequence: 33 as unknown as bigint }])).toBeUndefined()
    expect(projectSelectedJobHistory([valid, { ...valid, record: { ...valid.record, graphDigest: "0".repeat(64) } }])).toBeUndefined()
    expect(projectSelectedJobHistory([valid, history(makeRecord("other-job-turn", "other-job-root", 3, "11", "different-job"), 30n)])).toBeUndefined()
    expect(projectSelectedJobHistory(Array.from({ length: 9 }, (_, index) => history(makeRecord(`turn-${index}`, `root-${index}`, index), BigInt(index + 1))))).toBeUndefined()

    const sparseNodes = { ...valid.record, nodes: new Array(valid.record.nodes.length) }
    expect(projectSelectedJobHistory([history(sparseNodes as SelectedJobMemoryRecord, 34n)])).toBeUndefined()
  })
})
