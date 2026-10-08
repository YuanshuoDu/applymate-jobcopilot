import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { projectSelectedJobMemory, type SelectedJobMemoryNode, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { projectSelectedJobHistory, projectSelectedJobHistoryOutcomes, type ValidatedSelectedJobHistory, type ValidatedSelectedJobHistoryOutcome } from "./selected-job-history.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"

const jobId = "job-current"
const artifact = { artifactId: "private-artifact", version: 1, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
type VerificationFixture = Readonly<{
  status: "passed" | "failed" | "unverified"
  reasonCode: string
  evidenceDigest: string | null
  resultDigest: string | null
  criteria: readonly Readonly<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: string }>[]
}>
const passedVerification: VerificationFixture = {
  status: "passed", reasonCode: "criteria_met", evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
  criteria: [{ criterionId: "coverage", status: "passed", reasonCode: "criteria_met" }],
}
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
function makeRecord(turn: string, root: string, score: number, throughSequence = "11", selectedJobId = jobId,
  verification: VerificationFixture = passedVerification): SelectedJobMemoryRecord {
  const verificationReport = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, ...verification }
  const graphNodes = [
    { ...node("scout", 0, projection("scout", { candidateCount: 1, evidenceCount: 1, candidates: [{ jobId: selectedJobId, source: "greenhouse", evidenceKinds: ["job"] }] })) },
    { ...node("analyst", 1, projection("analyst", { findingCount: 1, evidenceCount: 2, findings: [{ jobId: selectedJobId, score, evidenceKinds: ["job", "resume"] }] })),
      status: verification.status === "passed" ? "completed" : "failed",
      verificationCriterionIds: verification.criteria.map(criterion => criterion.criterionId), verificationReport },
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
function outcome(record: SelectedJobMemoryRecord, terminalSequence: bigint): ValidatedSelectedJobHistoryOutcome {
  return { jobId: record.jobId, sourceTurnId: record.sourceTurnId, sourceRootTaskId: record.sourceRootTaskId, terminalSequence, nodes: record.nodes }
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

  it("adds sorted deduplicated negative reason hints to retained and direct histories only", () => {
    const failed = makeRecord("private-failed-turn", "private-failed-root", 2, "12", jobId, {
      status: "failed", reasonCode: "reported_score_below_minimum", evidenceDigest: "f".repeat(64), resultDigest: "e".repeat(64),
      criteria: [
        { criterionId: "private-score-check", status: "failed", reasonCode: "reported_score_below_minimum" },
        { criterionId: "private-count-check", status: "failed", reasonCode: "criterion_not_met" },
        { criterionId: "private-second-count-check", status: "failed", reasonCode: "criterion_not_met" },
        { criterionId: "private-passed-check", status: "passed", reasonCode: "criteria_met" },
      ],
    })
    const retained = projectSelectedJobHistory([history(failed, 41n)])
    const direct = projectSelectedJobHistoryOutcomes([outcome(failed, 41n)])
    expect(direct).toEqual(retained)
    const turns = (direct?.content as { turns: Array<{ nodes: Array<{ role: string; reasonHints?: string[] }> }> }).turns
    expect(turns[0]?.nodes.find(value => value.role === "analyst")?.reasonHints)
      .toEqual(["criterion_not_met", "reported_score_below_minimum"])
    expect(turns[0]?.nodes.find(value => value.role === "scout")).not.toHaveProperty("reasonHints")
    const serialized = json(direct)
    for (const secret of ["private-failed-turn", "private-failed-root", "private-score-check", "private-count-check", "evidenceDigest", "resultDigest", "sha256:", "criteria_met", "verification", "criteria", "PASS"]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("adds the unverified evidence-gap reason but keeps passed and missing reports byte-compatible", () => {
    const unverified = makeRecord("private-gap-turn", "private-gap-root", 3, "13", jobId, {
      status: "unverified", reasonCode: "canonical_evidence_missing", evidenceDigest: null, resultDigest: null,
      criteria: [
        { criterionId: "private-evidence-check", status: "unverified", reasonCode: "canonical_evidence_missing" },
        { criterionId: "private-second-evidence-check", status: "unverified", reasonCode: "canonical_evidence_missing" },
      ],
    })
    const historyBlock = projectSelectedJobHistory([history(unverified, 43n)])
    expect(projectSelectedJobHistoryOutcomes([outcome(unverified, 43n)])).toEqual(historyBlock)
    const turns = (historyBlock?.content as { turns: Array<{ nodes: Array<{ role: string; reasonHints?: string[] }> }> }).turns
    expect(turns[0]?.nodes.find(value => value.role === "analyst")?.reasonHints).toEqual(["canonical_evidence_missing"])

    const passed = projectSelectedJobHistory([history(makeRecord("private-pass-turn", "private-pass-root", 8), 45n)])
    const passedNodes = (passed?.content as { turns: Array<{ nodes: Array<{ role: string; status: string; result: unknown; reasonHints?: string[] }> }> }).turns[0]?.nodes
    const analyst = passedNodes?.find(value => value.role === "analyst")
    expect(analyst).toBeDefined()
    expect(Object.keys(analyst!)).toEqual(["role", "status", "result"])
    expect(JSON.stringify(analyst)).toBe(JSON.stringify({
      role: "analyst", status: "completed", result: { availability: "available", score: 8, evidenceKinds: ["job", "resume"] },
    }))
    const scout = passedNodes?.find(value => value.role === "scout")
    expect(scout).toBeDefined()
    expect(JSON.stringify(scout)).toBe(JSON.stringify({
      role: "scout", status: "completed",
      result: { availability: "available", source: "greenhouse", evidenceKinds: ["job"] },
    }))
  })

  it("accepts eight distinct negative hints and sorts them lexically", () => {
    const source = outcome(makeRecord("private-eight-hints-turn", "private-eight-hints-root", 4), 47n)
    const reasonCodes: Array<NonNullable<SelectedJobMemoryNode["verification"]>["criteria"][number]["reasonCode"]> = [
      "result_invalid", "result_evidence_unbound", "canonical_evidence_missing", "contract_invalid",
      "result_ambiguous", "canonical_evidence_ambiguous", "projection_invalid", "canonical_evidence_invalid",
    ]
    const nodes: SelectedJobMemoryNode[] = source.nodes.map(value => value.role === "analyst" ? {
      ...value, status: "failed", verification: { status: "unverified",
        criteria: reasonCodes.map(reasonCode => ({ status: "unverified" as const, reasonCode })) },
    } : value)
    const projected = projectSelectedJobHistoryOutcomes([{ ...source, nodes }])
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ role: string; reasonHints?: string[] }> }> }).turns
    const hints = turns[0]?.nodes.find(value => value.role === "analyst")?.reasonHints
    expect(hints).toHaveLength(8)
    expect(hints).toEqual([
      "canonical_evidence_ambiguous", "canonical_evidence_invalid", "canonical_evidence_missing", "contract_invalid",
      "projection_invalid", "result_ambiguous", "result_evidence_unbound", "result_invalid",
    ])
  })

  it("rejects unknown or success reason codes smuggled into a direct typed node", () => {
    const record = makeRecord("turn-invalid-hint", "root-invalid-hint", 4)
    const valid = outcome(record, 47n)
    const node = record.nodes.find(value => value.role === "analyst")
    if (!node) throw new Error("expected analyst node")
    for (const reasonCode of ["private_reason", "criteria_met"]) {
      const malformed = { ...node, verification: { status: "failed", criteria: [{ status: "failed", reasonCode }] } }
      const value = { ...valid, nodes: [malformed] as unknown as SelectedJobMemoryNode[] }
      expect(projectSelectedJobHistoryOutcomes([value])).toBeUndefined()
    }
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

  it("projects direct graph outcomes into the byte-compatible historical block without compaction metadata", () => {
    const records = [history(makeRecord("turn-old", "root-old", 5), 11n), history(makeRecord("turn-new", "root-new", 8), 31n)]
    const compacted = projectSelectedJobHistory(records)
    const direct = projectSelectedJobHistoryOutcomes(records.map(value => outcome(value.record, value.terminalSequence)))
    expect(direct).toEqual(compacted)
    const serialized = json(direct)
    for (const privateValue of ["turn-old", "root-new", "job-current", "terminalSequence", "throughSequence", "graphDigest", "verification", "criteria", "repairState", "readiness", "PASS"]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it("keeps full record digest and cursor conflicts in the legacy wrapper", () => {
    const first = makeRecord("turn-same", "root-same", 7, "11")
    const cursorChanged = makeRecord("turn-same", "root-same", 7, "12")
    const separate = history(makeRecord("turn-separate", "root-separate", 4), 19n)
    expect(cursorChanged.nodes).toEqual(first.nodes)
    expect(cursorChanged.graphDigest).not.toBe(first.graphDigest)
    const conflictProjection = projectSelectedJobHistory([history(first, 17n), history(cursorChanged, 17n), separate])
    expect(conflictProjection).toEqual(projectSelectedJobHistory([separate]))
  })

  it("fails closed when distinct sources have equal terminal sequences", () => {
    const candidates = [
      history(makeRecord("turn-z", "root-z", 9), 25n),
      history(makeRecord("turn-a", "root-a", 2), 25n),
    ]
    expect(projectSelectedJobHistory(candidates)).toBeUndefined()
    expect(projectSelectedJobHistory([...candidates].reverse())).toBeUndefined()

    const outcomes = candidates.map(value => outcome(value.record, value.terminalSequence))
    expect(projectSelectedJobHistoryOutcomes(outcomes)).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([...outcomes].reverse())).toBeUndefined()
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

  it("fails closed on malformed direct identity, sequence, job, and node envelopes", () => {
    const record = makeRecord("turn-safe", "root-safe", 8)
    const valid = outcome(record, 33n)
    expect(projectSelectedJobHistoryOutcomes([valid])).toEqual(projectSelectedJobHistory([history(record, 33n)]))
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, extra: "must not pass" } as ValidatedSelectedJobHistoryOutcome])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, jobId: " job-current" }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, sourceTurnId: "x".repeat(257) }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, terminalSequence: 33 as unknown as bigint }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, terminalSequence: 0n }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, nodes: [{ ...valid.nodes[0]!, privateText: "must not pass" }] as unknown as SelectedJobMemoryNode[] }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, nodes: new Array(1) as SelectedJobMemoryNode[] }])).toBeUndefined()
    const oversizedNodes = new Proxy(new Array(9), {
      getOwnPropertyDescriptor(target, property) {
        if (property !== "length") throw new Error("oversized sparse outcome nodes must be rejected before traversal")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(projectSelectedJobHistoryOutcomes([{ ...valid, nodes: oversizedNodes as SelectedJobMemoryNode[] }])).toBeUndefined()
    expect(projectSelectedJobHistoryOutcomes([valid, outcome(makeRecord("turn-other-job", "root-other-job", 1, "11", "another-job"), 32n)])).toBeUndefined()
    const sparse = new Array<ValidatedSelectedJobHistoryOutcome>(1)
    expect(projectSelectedJobHistoryOutcomes(sparse)).toBeUndefined()
    const oversized = new Proxy(new Array<ValidatedSelectedJobHistoryOutcome>(9), {
      getOwnPropertyDescriptor(target, property) {
        if (property !== "length") throw new Error("oversized sparse outcomes must be rejected before traversal")
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(projectSelectedJobHistoryOutcomes(oversized)).toBeUndefined()
  })
})
