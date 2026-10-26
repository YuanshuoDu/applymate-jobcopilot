import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentNode, TaskGraphCurrentState, TaskGraphResultProjection } from "../subagents/task-graph-command-port.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { projectRootTaskHistory } from "./root-task-history.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"

function node(overrides: Partial<TaskGraphCurrentNode> = {}): TaskGraphCurrentNode {
  return {
    key: "node-private-key", templateId: "scout", goal: "PRIVATE_GOAL", successCriteria: ["PRIVATE_CRITERIA"],
    dependsOn: [], taskId: "PRIVATE_TASK_ID", status: "failed", readiness: "terminal",
    resultSummary: "PRIVATE_RESULT", failureReason: "PRIVATE_FAILURE", verificationCriterionIds: ["criterion-a"],
    verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "criterion-a", status: "failed", reasonCode: "criterion_not_met" }],
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
    },
    ...overrides,
  }
}
function graph(nodes: readonly TaskGraphCurrentNode[]): TaskGraphCurrentState {
  return { revision: 9, nodes }
}
function outcome(id: string, sequence: bigint, nodes: readonly TaskGraphCurrentNode[] = [node()]): ValidatedRootTaskHistoryOutcome {
  return { sourceTurnId: "turn-" + id, sourceRootTaskId: "root-" + id, terminalSequence: sequence, taskGraph: graph(nodes) }
}

describe("root task history projection", () => {
  it("emits only typed advisory outcomes and negative reason codes", () => {
    const projected = projectRootTaskHistory([outcome("private-source", 12n)])
    const legacyShape = {
      id: "root-task-history",
      content: {
        kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true,
        label: "Earlier outcomes for the same verifier objective; advisory context only.",
        turns: [{ label: "earlier terminal attempt", nodes: [{ taskKind: "scout", status: "failed", negativeReasonHints: ["criterion_not_met"] }] }],
      },
    }
    expect(projected).toEqual(legacyShape)
    expect(JSON.stringify(projected)).toBe(JSON.stringify(legacyShape))
    expect(Buffer.byteLength(JSON.stringify(projected) ?? "", "utf8"))
      .toBe(Buffer.byteLength(JSON.stringify(legacyShape), "utf8"))
    const serialized = JSON.stringify(projected)
    for (const forbidden of ["private-source", "turn-private", "root-private", "PRIVATE_", "criterion-a", "sourceTurnId", "verificationReport", "evidenceDigest"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it("omits success reason codes and does not expose verifier proof fields", () => {
    const passed = node({
      status: "completed",
      verificationReport: {
        verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
        criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
        evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
      },
    })
    const projected = projectRootTaskHistory([outcome("passed", 2n, [passed])])
    expect(projected?.content).toMatchObject({ informationalOnly: true, advisoryOnly: true })
    expect(JSON.stringify(projected)).not.toContain("criteria_met")
    expect(JSON.stringify(projected)).not.toContain("evidenceDigest")
  })

  it("preserves the allowlisted unresolved repair reason when all criteria passed", () => {
    const unresolved = node({
      verificationReport: {
        verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "repair_target_unresolved",
        criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
        evidenceDigest: null, resultDigest: "e".repeat(64),
      },
    })
    const projected = projectRootTaskHistory([outcome("unresolved-repair", 5n, [unresolved])])
    expect(projected?.content).toMatchObject({
      informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true,
      turns: [{ nodes: [{ status: "failed", negativeReasonHints: ["repair_target_unresolved"] }] }],
    })
    expect(JSON.stringify(projected)).not.toContain("resultDigest")
  })

  it("emits ordinal-bound lessons and matching sanitized output counts only", () => {
    const target = node(), repair = node({ status: "completed", verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
    } })
    const projection = {
      schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
      role: "scout", status: "partial", candidateCount: 4, evidenceCount: 4,
      candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] },
        { jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] },
        { jobId: "job-2", source: "greenhouse", evidenceKinds: ["job"] }],
    } satisfies TaskGraphResultProjection
    const targetLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "candidate_count_gte", minimum: 2 } }] } as const
    const repairLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] } as const
    const source = outcome("safe-facts", 16n, [repair, target])
    const facts = { ...source, sourceNodeOrdinals: [2, 1], nodeLessons: [repairLesson, targetLesson],
      reportedOutputs: [{ role: "scout", candidateCount: 4, resultStatus: "partial" }, undefined] as const,
      taskGraph: graph([node({ ...repair, resultProjection: projection }), target]) }

    const projected = projectRootTaskHistory([facts])
    expect(projected?.content).toMatchObject({ turns: [{ nodes: [
      { status: "completed", reportedOutput: { role: "scout", candidateCount: 4, resultStatus: "partial" },
        lesson: { nodeOrdinal: 2, successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] } },
      { status: "failed", lesson: { nodeOrdinal: 1, criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "candidate_count_gte", minimum: 2 } }] } },
    ] }] })
    const serialized = JSON.stringify(projected)
    for (const forbidden of ["safe-facts", "PRIVATE_", "job-1", "job-2", "greenhouse", "evidenceKinds", "evidenceDigest", "resultDigest", "criterion-a"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it("sanitizes only cross-session history and preserves the same-session typed facts", () => {
    const repair = node({ status: "completed", verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
    } })
    const target = node()
    const category = node({ templateId: "analyst" })
    const repairLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] } as const
    const targetLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "candidate_count_gte", minimum: 2 } }] } as const
    const categoryLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: 3, criterionFailures: [], executionFailureCategory: "execution_setup_unavailable" } as const
    const source = outcome("cross-session-private", 18n, [repair, target, category])
    const resultProjection = { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted",
      availability: "available", role: "scout", status: "partial", candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "safe-job", source: "other", evidenceKinds: ["job"] }] } satisfies TaskGraphResultProjection
    const facts = { ...source, sourceNodeOrdinals: [2, 1, 3], nodeLessons: [repairLesson, targetLesson, categoryLesson],
      reportedOutputs: [{ role: "scout", candidateCount: 1, resultStatus: "partial" }, undefined, undefined] as const,
      taskGraph: graph([node({ ...repair, resultProjection }), target, category]) }
    const currentTurn = projectRootTaskHistory([facts])
    expect(currentTurn?.content).not.toHaveProperty("historical")
    expect(currentTurn?.content).toMatchObject({ turns: [{ nodes: [
      { taskKind: "analyst", lesson: { executionFailureCategory: "execution_setup_unavailable" } },
      { taskKind: "scout", reportedOutput: { candidateCount: 1 }, lesson: { successfulRepairs: [{ targetNodeOrdinal: 1 }] } },
      { taskKind: "scout", lesson: { criterionFailures: [{ check: { kind: "candidate_count_gte", minimum: 2 } }] } },
    ] }] })

    const foreign = { ...facts, terminalAt: new Date("2026-10-07T11:00:00.000Z"), sourceSessionDiffers: true }
    const sameSession = { ...facts, sourceTurnId: "turn-same-session", sourceRootTaskId: "root-same-session",
      terminalAt: new Date("2026-10-07T11:01:00.000Z"), sourceSessionDiffers: false }
    const historical = projectRootTaskHistory([foreign, sameSession], true)
    expect(historical?.content).toMatchObject({ historical: true, advisoryOnly: true, notCurrentEvidence: true,
      turns: expect.any(Array) })
    const historicalTurns = (historical?.content as { turns?: Array<{ nodes: Array<Record<string, unknown>> }> } | undefined)?.turns
    expect(historicalTurns).toHaveLength(2)
    expect(historicalTurns?.[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKind: "analyst", lesson: expect.objectContaining({ executionFailureCategory: "execution_setup_unavailable" }) }),
      expect.objectContaining({ taskKind: "scout", status: "completed", reportedOutput: { role: "scout", candidateCount: 1, resultStatus: "partial" },
        lesson: expect.objectContaining({ successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] }) }),
    ]))
    expect(historicalTurns?.[1]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKind: "analyst", status: "failed" }),
      expect.objectContaining({ taskKind: "scout", status: "completed", lesson: expect.objectContaining({
        advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
        successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }],
      }) }),
      expect.objectContaining({ taskKind: "scout", status: "failed", lesson: expect.objectContaining({ advisoryOnly: true,
        notCurrentEvidence: true, nodeOrdinal: 1,
        criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] }) }),
    ]))
    const foreignAnalyst = historicalTurns?.[1]?.nodes.find(item => item.taskKind === "analyst")
    const foreignOutput = historicalTurns?.[1]?.nodes.find(item => item.taskKind === "scout" && item.status === "completed")
    const foreignFailure = historicalTurns?.[1]?.nodes.find(item => item.taskKind === "scout" && item.status === "failed")
    expect(foreignAnalyst?.lesson).toBeUndefined()
    expect(foreignOutput?.reportedOutput).toBeUndefined()
    expect(foreignOutput?.lesson).not.toHaveProperty("executionFailureCategory")
    expect(foreignOutput?.lesson).not.toHaveProperty("criterionFailures.0.check")
    expect(foreignFailure?.lesson).not.toHaveProperty("criterionFailures.0.check")
    const serialized = JSON.stringify(historical)
    expect(serialized).not.toContain("sourceSessionDiffers")
    const unknownLocality = { ...facts, sourceTurnId: "turn-unknown-session", sourceRootTaskId: "root-unknown-session",
      terminalAt: foreign.terminalAt }
    expect(projectRootTaskHistory([unknownLocality], true)?.content)
      .toEqual(projectRootTaskHistory([foreign], true)?.content)
  })

  it("rejects changing locality accessors before they can leak historical private fields", () => {
    const resultProjection = { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted",
      availability: "available", role: "scout", status: "partial", candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "private-job", source: "greenhouse", evidenceKinds: ["job"] }] } satisfies TaskGraphResultProjection
    const base = { ...outcome("accessor-locality", 31n, [
      node({ status: "completed", failureReason: null, resultProjection }), node(), node({ templateId: "analyst" }),
    ]), terminalAt: new Date("2026-10-07T11:00:00.000Z"), sourceNodeOrdinals: [1, 2, 3],
    nodeLessons: [undefined, { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "scout", kind: "candidate_count_gte", minimum: 2 } }] },
    { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 3,
      criterionFailures: [], executionFailureCategory: "execution_setup_unavailable" }] as const,
    reportedOutputs: [{ role: "scout", candidateCount: 1, resultStatus: "partial" }, undefined, undefined] as const }
    let localityReads = 0
    const changingLocality = { ...base, sourceTurnId: "turn-changing-locality", sourceRootTaskId: "root-changing-locality" }
    Object.defineProperty(changingLocality, "sourceSessionDiffers", { enumerable: true, get: () => ++localityReads === 1 })
    expect(projectRootTaskHistory([changingLocality], true)).toBeUndefined()
    expect(localityReads).toBe(0)

    const setterLocality = { ...base, sourceTurnId: "turn-setter-locality", sourceRootTaskId: "root-setter-locality" }
    Object.defineProperty(setterLocality, "sourceSessionDiffers", { enumerable: true, set: (_value: boolean) => undefined })
    expect(projectRootTaskHistory([setterLocality], true)).toBeUndefined()
  })

  it("emits a same-session plan skeleton using source ordinals, independent of public node sorting", () => {
    const analyst = node({ key: "private-analyst-key", taskId: "private-analyst-task", templateId: "analyst",
      dependsOn: ["private-scout-key"] })
    const scout = node({ key: "private-scout-key", taskId: "private-scout-task", templateId: "scout" })
    const local = { ...outcome("shape-local", 25n, [analyst, scout]), sourceNodeOrdinals: [2, 1] }
    const projected = projectRootTaskHistory([local])
    const turns = (projected?.content as { turns?: Array<{ nodes: unknown[]; planShape?: unknown }> } | undefined)?.turns

    expect(turns?.[0]?.nodes).toMatchObject([{ taskKind: "analyst" }, { taskKind: "scout" }])
    expect(turns?.[0]?.planShape).toEqual({
      schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1",
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodes: [
        { ordinal: 1, role: "scout", dependsOnOrdinals: [] },
        { ordinal: 2, role: "analyst", dependsOnOrdinals: [1] },
      ],
    })
    const serialized = JSON.stringify(projected)
    for (const privateValue of ["private-analyst-key", "private-scout-key", "private-analyst-task", "private-scout-task", "PRIVATE_GOAL"]) {
      expect(serialized).not.toContain(privateValue)
    }

    const terminalAt = new Date("2026-10-08T11:00:00.000Z")
    const explicitLocality = { ...local, terminalAt, sourceSessionDiffers: false }
    const foreign = { ...local, terminalAt, sourceSessionDiffers: true }
    const unknownLocality = { ...local, terminalAt }
    const localShape = (value: ValidatedRootTaskHistoryOutcome) => {
      const projected = projectRootTaskHistory([value], true)
      return (projected?.content as { turns?: Array<{ planShape?: unknown }> } | undefined)?.turns?.[0]?.planShape
    }
    expect(localShape(explicitLocality)).toBeDefined()
    expect(localShape(foreign)).toBeUndefined()
    expect(localShape(unknownLocality)).toBeUndefined()
  })

  it("omits an invalid or incomplete optional skeleton while retaining the history outcome", () => {
    const scout = node({ key: "scout-key", taskId: "scout-task", templateId: "scout" })
    const analyst = node({ key: "analyst-key", taskId: "analyst-task", templateId: "analyst", dependsOn: ["scout-key"] })
    const source = { ...outcome("shape-fail-closed", 26n, [scout, analyst]), sourceNodeOrdinals: [1, 2] }
    const dangling = { ...source, taskGraph: graph([scout, { ...analyst, dependsOn: ["missing-key"] }]) }
    const missingMapping = { ...source, sourceNodeOrdinals: undefined }
    for (const candidate of [dangling, missingMapping]) {
      const projected = projectRootTaskHistory([candidate])
      expect(projected?.content).toMatchObject({ turns: [{ nodes: [{ taskKind: "analyst" }, { taskKind: "scout" }] }] })
      expect((projected?.content as { turns: Array<{ planShape?: unknown }> }).turns[0]?.planShape).toBeUndefined()
    }
  })

  it("drops a whole skeleton when global node truncation makes its turn incomplete", () => {
    const newestNodes = Array.from({ length: 7 }, (_, index) => node({ key: `new-${index}`, taskId: `new-task-${index}`,
      templateId: "analyst" }))
    const oldScout = node({ key: "old-scout", taskId: "old-scout-task", templateId: "scout" })
    const oldAnalyst = node({ key: "old-analyst", taskId: "old-analyst-task", templateId: "analyst", dependsOn: ["old-scout"] })
    const newest = { ...outcome("shape-newest", 28n, newestNodes), sourceNodeOrdinals: [1, 2, 3, 4, 5, 6, 7] }
    const older = { ...outcome("shape-truncated", 27n, [oldScout, oldAnalyst]), sourceNodeOrdinals: [1, 2] }
    const turns = (projectRootTaskHistory([older, newest])?.content as {
      turns?: Array<{ nodes: unknown[]; planShape?: { nodes: unknown[] } }>
    } | undefined)?.turns

    expect(turns).toHaveLength(2)
    expect(turns?.[0]?.nodes).toHaveLength(7)
    expect(turns?.[0]?.planShape?.nodes).toHaveLength(7)
    expect(turns?.[1]?.nodes).toHaveLength(1)
    expect(turns?.[1]?.planShape).toBeUndefined()
  })

  it("drops whole plan shapes before changing otherwise fitting outcomes or lessons at the byte cap", () => {
    const maxBytes = 8 * 1024
    const criterionIds = Array.from({ length: 8 }, (_, index) => `criterion-${index + 1}`)
    const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed" as const, reasonCode: "criterion_not_met" as const,
      criteria: criterionIds.map(criterionId => ({ criterionId, status: "failed" as const, reasonCode: "criterion_not_met" as const })),
      evidenceDigest: null, resultDigest: null }
    let witness: { withShape: ReturnType<typeof projectRootTaskHistory>; withoutShape: ReturnType<typeof projectRootTaskHistory> } | undefined

    for (let count = 1; count <= 8 && !witness; count++) {
      const nodes = Array.from({ length: 8 }, (_, index) => node({ key: `budget-key-${index + 1}`,
        taskId: `budget-task-${index + 1}`, templateId: "analyst", status: "failed", verificationCriterionIds: criterionIds,
        verificationReport: report, dependsOn: index ? [`budget-key-${index}`] : [] }))
      const ordinals = nodes.map((_, index) => index + 1)
      const failures = Array.from({ length: count }, (_, index) => ({ criterionOrdinal: index + 1, status: "failed" as const,
        reasonCode: "criterion_not_met" as const,
        check: { role: "analyst" as const, kind: "reported_score_gte" as const, minimumScore: 10, minimumFindings: 8, aggregation: "all" as const } }))
      const lessons = nodes.map((_, index) => ({ ordinalScope: "source_graph_local" as const, advisoryOnly: true as const,
        notCurrentEvidence: true as const, nodeOrdinal: index + 1, criterionFailures: failures }))
      const valid = { ...outcome(`shape-byte-${count}`, 40n, nodes), sourceNodeOrdinals: ordinals, nodeLessons: lessons }
      const invalidGraph = nodes.map((item, index) => index === 7 ? { ...item, dependsOn: [...item.dependsOn, "missing-key"] } : item)
      const withoutShape = projectRootTaskHistory([{ ...valid, taskGraph: graph(invalidGraph) }])
      const baselineContent = withoutShape?.content as { turns?: Array<Record<string, unknown>> } | undefined
      const baselineTurn = baselineContent?.turns?.[0]
      if (!withoutShape || !baselineTurn || !Array.isArray(baselineTurn.nodes)) continue
      const hypothetical = { ...withoutShape, content: { ...baselineContent, turns: [
        { ...baselineTurn, planShape: {
          schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1", ordinalScope: "source_graph_local",
          advisoryOnly: true, notCurrentEvidence: true,
          nodes: nodes.map((item, index) => ({ ordinal: index + 1, role: "analyst", dependsOnOrdinals: index ? [index] : [] })),
        } },
      ] } }
      if (Buffer.byteLength(JSON.stringify(withoutShape), "utf8") <= maxBytes
        && Buffer.byteLength(JSON.stringify(hypothetical), "utf8") > maxBytes
        && (baselineTurn.nodes as Array<{ lesson?: { criterionFailures?: unknown[] } }>).length === 8
        && (baselineTurn.nodes as Array<{ lesson?: { criterionFailures?: unknown[] } }>).every(item => item.lesson?.criterionFailures?.length === count)) {
        witness = { withoutShape, withShape: projectRootTaskHistory([valid]) }
      }
    }

    expect(witness).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(witness?.withoutShape), "utf8")).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.byteLength(JSON.stringify(witness?.withShape), "utf8")).toBeLessThanOrEqual(maxBytes)
    expect(witness?.withShape).toEqual(witness?.withoutShape)
  })

  it("applies the byte cap to the final sanitized cross-session frame", () => {
    const criterionIds = Array.from({ length: 8 }, (_, index) => "criterion-" + (index + 1))
    const failedReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed" as const, reasonCode: "criterion_not_met" as const,
      criteria: criterionIds.map(criterionId => ({ criterionId, status: "failed" as const, reasonCode: "criterion_not_met" as const })),
      evidenceDigest: null, resultDigest: null,
    }
    const nodes = Array.from({ length: 8 }, (_, index) => node({ key: "bounded-" + index, taskId: "bounded-task-" + index,
      templateId: "analyst", status: "failed", verificationCriterionIds: criterionIds, verificationReport: failedReport }))
    const lessons = nodes.map((_, index) => ({ ordinalScope: "source_graph_local" as const, advisoryOnly: true as const,
      notCurrentEvidence: true as const, nodeOrdinal: index + 1, criterionFailures: criterionIds.map((__, criterionIndex) => ({
        criterionOrdinal: criterionIndex + 1, status: "failed" as const, reasonCode: "criterion_not_met" as const,
        check: { role: "analyst" as const, kind: "finding_count_gte" as const, minimum: 1 },
      })) }))
    const source = { ...outcome("large-cross-session", 19n, nodes), terminalAt: new Date("2026-10-07T11:00:00.000Z"), sourceSessionDiffers: true,
      sourceNodeOrdinals: nodes.map((_, index) => index + 1), nodeLessons: lessons }
    const projected = projectRootTaskHistory([source], true)
    const turns = (projected?.content as { turns?: Array<{ nodes: Array<{ lesson?: { criterionFailures: unknown[] } }> }> } | undefined)?.turns

    expect(turns?.[0]?.nodes).toHaveLength(8)
    expect(turns?.[0]?.nodes.every(item => item.lesson?.criterionFailures.length === 8)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(8 * 1024)
    expect(JSON.stringify(projected)).not.toContain("\"check\"")
  })

  it("keeps repair ordinals local to each emitted historical outcome", () => {
    const passed = (key: string) => node({ key, status: "completed", verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "e".repeat(64), resultDigest: "f".repeat(64),
    } })
    const targetA = node({ key: "target-a" })
    const repairA = passed("repair-a")
    const targetB = node({ key: "target-b", verificationCriterionIds: ["criterion-a", "criterion-b"], verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
      criteria: [
        { criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "criterion-b", status: "failed", reasonCode: "canonical_evidence_missing" },
      ],
      evidenceDigest: "g".repeat(64), resultDigest: "h".repeat(64),
    } })
    const repairB = passed("repair-b")
    const lesson = (nodeOrdinal: number, criterionOrdinal: number, reasonCode: "criterion_not_met" | "canonical_evidence_missing") => ({
      ordinalScope: "source_graph_local" as const, advisoryOnly: true as const, notCurrentEvidence: true as const, nodeOrdinal,
      criterionFailures: [{ criterionOrdinal, status: "failed" as const, reasonCode }],
    })
    const oldOutcome = { ...outcome("old-local-frame", 10n, [targetA, repairA]),
      terminalAt: new Date("2026-10-07T10:00:00.000Z"), sourceSessionDiffers: true, sourceNodeOrdinals: [1, 2],
      nodeLessons: [lesson(1, 1, "criterion_not_met"), { ...lesson(2, 1, "criterion_not_met"), criterionFailures: [],
        successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" as const }] }] }
    const newOutcome = { ...outcome("new-local-frame", 11n, [targetB, repairB]),
      terminalAt: new Date("2026-10-07T11:00:00.000Z"), sourceSessionDiffers: true, sourceNodeOrdinals: [1, 2],
      nodeLessons: [lesson(1, 2, "canonical_evidence_missing"), { ...lesson(2, 2, "canonical_evidence_missing"), criterionFailures: [],
        successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [2], status: "passed" as const }] }] }

    const projected = projectRootTaskHistory([oldOutcome, newOutcome], true)
    const turns = (projected?.content as { turns?: Array<{ nodes: Array<{ lesson?: {
      nodeOrdinal: number; criterionFailures: unknown[]; successfulRepairs?: unknown[]
    } }> }> } | undefined)?.turns

    expect(projected?.content).toMatchObject({ historical: true })
    expect(turns).toHaveLength(2)
    expect(turns?.map(turn => turn.nodes.find(item => item.lesson?.nodeOrdinal === 2)?.lesson?.successfulRepairs)).toEqual([
      [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [2], status: "passed" }],
      [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }],
    ])
    expect(turns?.map(turn => turn.nodes.find(item => item.lesson?.nodeOrdinal === 1)?.lesson?.criterionFailures)).toEqual([
      [{ criterionOrdinal: 2, status: "failed", reasonCode: "canonical_evidence_missing" }],
      [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }],
    ])
  })

  it("retains dependency meaning for an emitted Scout with no lesson and strips it if that Scout is pruned", () => {
    const scout = node({ key: "source-scout", taskId: "source-scout-task", status: "completed", failureReason: null,
      verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
        criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
        evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64) } })
    const analyst = node({ key: "dependent-analyst", taskId: "dependent-analyst-task", templateId: "analyst" })
    const dependentLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } }] } as const
    const prior = outcome("dependency-source", 20n, [scout, analyst])
    const aligned = { ...prior, sourceNodeOrdinals: [1, 2], nodeLessons: [undefined, dependentLesson] }
    const retained = projectRootTaskHistory([aligned])
    expect(retained?.content).toMatchObject({ turns: [{ nodes: [
      { taskKind: "analyst", lesson: { criterionFailures: [{ check: { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } }] } },
      { taskKind: "scout", status: "completed" },
    ] }] })

    const newerNodes = Array.from({ length: 7 }, (_, index) => node({ key: `newer-${index}`, taskId: `newer-task-${index}`, templateId: "analyst" }))
    const pruned = projectRootTaskHistory([aligned, outcome("newer-turn", 21n, newerNodes)])
    const prunedTurns = (pruned?.content as { turns?: { nodes?: { taskKind: string; lesson?: { criterionFailures?: unknown[] } }[] }[] } | undefined)?.turns
    expect(prunedTurns).toHaveLength(2)
    expect(prunedTurns?.[0]?.nodes).toHaveLength(7)
    expect(prunedTurns?.[1]?.nodes).toHaveLength(1)
    expect(prunedTurns?.[1]?.nodes?.[0]).toMatchObject({ taskKind: "analyst", lesson: { criterionFailures: [
      { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
    ] } })
    const oldLesson = prunedTurns?.[1]?.nodes?.[0]?.lesson
    expect(oldLesson?.criterionFailures?.[0]).not.toHaveProperty("check")
  })

  it("omits an aligned lesson whose typed-check role conflicts with the public node", () => {
    const source = outcome("role-mismatch", 22n, [node()])
    const invalidLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { role: "analyst", kind: "finding_count_gte", minimum: 2 } }] } as const
    const projected = projectRootTaskHistory([{ ...source, sourceNodeOrdinals: [1], nodeLessons: [invalidLesson] }])
    expect(projected?.content).toMatchObject({ turns: [{ nodes: [{ taskKind: "scout", status: "failed" }] }] })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain("finding_count_gte")
    expect(serialized).not.toContain("invalidLesson")
  })

  it("keeps valid history when optional lessons lack source ordinals and validates counts independently", () => {
    const resultProjection = {
      schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
      role: "scout", status: "partial", candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
    } satisfies TaskGraphResultProjection
    const source = outcome("no-ordinals", 18n, [node({ status: "completed", resultProjection })])
    const baseline = projectRootTaskHistory([source])
    const lesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] } as const

    expect(projectRootTaskHistory([{ ...source, nodeLessons: [lesson] }])).toEqual(baseline)
    expect(projectRootTaskHistory([{ ...source, nodeLessons: [lesson], reportedOutputs: [
      { role: "scout", candidateCount: 1, resultStatus: "partial" },
    ] }])?.content).toMatchObject({ turns: [{ nodes: [{ reportedOutput: { role: "scout", candidateCount: 1, resultStatus: "partial" } }] }] })
    expect(projectRootTaskHistory([{ ...source, reportedOutputs: [
      { role: "scout", candidateCount: 2, resultStatus: "partial" },
    ] }])).toEqual(baseline)
  })

  it("retains category-only lessons only for failed enclosing nodes", () => {
    const failed = {
      key: "ordinary-failed", templateId: "scout", goal: "PRIVATE_GOAL", successCriteria: [], dependsOn: [],
      taskId: "PRIVATE_TASK_ID", status: "failed", readiness: "terminal", resultSummary: null,
      failureReason: "PRIVATE_RAW_FAILURE_REASON",
    } satisfies TaskGraphCurrentNode
    const categoryLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: 1, criterionFailures: [], executionFailureCategory: "execution_setup_unavailable" } as const
    const accepted = projectRootTaskHistory([{ ...outcome("category-only", 23n, [failed]), sourceNodeOrdinals: [1], nodeLessons: [categoryLesson] }])
    expect(accepted?.content).toMatchObject({ turns: [{ nodes: [{ status: "failed", lesson: {
      nodeOrdinal: 1, criterionFailures: [], executionFailureCategory: "execution_setup_unavailable",
    } }] }] })
    expect(JSON.stringify(accepted)).not.toContain("PRIVATE_RAW_FAILURE_REASON")
    expect(JSON.stringify(accepted)).not.toContain("PRIVATE_TASK_ID")

    const completed = { ...failed, status: "completed" as const, failureReason: null }
    const rejected = projectRootTaskHistory([{ ...outcome("category-on-completed", 24n, [completed]),
      sourceNodeOrdinals: [1], nodeLessons: [categoryLesson] }])
    expect(rejected?.content).toMatchObject({ turns: [{ nodes: [{ status: "completed" }] }] })
    expect(JSON.stringify(rejected)).not.toContain("execution_setup_unavailable")
  })

  it("keeps bounded eight-node/eight-criterion facts under the content cap", () => {
    const criterionIds = Array.from({ length: 8 }, (_, index) => "criterion-" + (index + 1))
    const unverified = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified" as const, reasonCode: "canonical_evidence_ambiguous" as const,
      criteria: criterionIds.map(criterionId => ({ criterionId, status: "unverified" as const, reasonCode: "canonical_evidence_ambiguous" as const })),
      evidenceDigest: null, resultDigest: null,
    }
    const passed = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed" as const, reasonCode: "criteria_met" as const,
      criteria: criterionIds.map(criterionId => ({ criterionId, status: "passed" as const, reasonCode: "criteria_met" as const })),
      evidenceDigest: "b".repeat(64), resultDigest: "c".repeat(64),
    }
    const resultProjection = {
      schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
      role: "analyst", status: "partial", findingCount: Number.MAX_SAFE_INTEGER, evidenceCount: 3,
      findings: Array.from({ length: 3 }, (_, index) => ({ jobId: "job-" + (index + 1), score: 10,
        evidenceKinds: ["job", "persona", "resume", "source"] as const })),
    } satisfies TaskGraphResultProjection
    const failedNodes = Array.from({ length: 7 }, (_, index) => node({ key: "failed-" + (index + 1), taskId: "task-" + (index + 1), templateId: "analyst",
      status: "failed", verificationCriterionIds: criterionIds, verificationReport: unverified }))
    const completedNode = node({ key: "completed-analyst", taskId: "task-8", templateId: "analyst", status: "completed",
      verificationCriterionIds: criterionIds, verificationReport: passed, resultProjection })
    const source = outcome("bounded-facts", 19n, [...failedNodes, completedNode])
    const sourceNodeOrdinals = Array.from({ length: 8 }, (_, index) => index + 1)
    const repairLesson = { ordinalScope: "source_graph_local" as const, advisoryOnly: true as const, notCurrentEvidence: true as const,
      nodeOrdinal: 8, criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1,
        targetCriterionOrdinals: Array.from({ length: 8 }, (_, index) => index + 1), status: "passed" as const }] }
    const nodeLessons = [...failedNodes.map((_, index) => ({ ordinalScope: "source_graph_local" as const, advisoryOnly: true as const,
      notCurrentEvidence: true as const, nodeOrdinal: index + 1, criterionFailures: criterionIds.map((_, criterionIndex) => ({
        criterionOrdinal: criterionIndex + 1, status: "unverified" as const, reasonCode: "canonical_evidence_ambiguous" as const,
      })) })), repairLesson] as const
    const base = projectRootTaskHistory([{ ...source, sourceNodeOrdinals, nodeLessons }])
    const projected = projectRootTaskHistory([{ ...source, sourceNodeOrdinals, nodeLessons, reportedOutputs: [
      ...Array.from({ length: 7 }, () => undefined),
      { role: "analyst", findingCount: Number.MAX_SAFE_INTEGER, resultStatus: "partial" },
    ] }])
    const baseBytes = Buffer.byteLength(JSON.stringify(base) ?? "", "utf8")
    const factBytes = Buffer.byteLength(JSON.stringify(projected) ?? "", "utf8")
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ status: string; negativeReasonHints?: string[]; lesson?: { criterionFailures: unknown[]; successfulRepairs?: unknown[] }; reportedOutput?: unknown }> }> }).turns

    expect(turns[0]?.nodes).toHaveLength(8)
    expect(turns[0]?.nodes.find(item => item.status === "failed")?.negativeReasonHints).toEqual(["canonical_evidence_ambiguous"])
    expect(turns[0]?.nodes.filter(item => item.status === "failed").every(item => item.lesson?.criterionFailures.length === 8)).toBe(true)
    expect(turns[0]?.nodes.find(item => item.status === "completed")?.reportedOutput).toEqual({
      role: "analyst", findingCount: Number.MAX_SAFE_INTEGER, resultStatus: "partial",
    })
    expect(turns[0]?.nodes.find(item => item.status === "completed")?.lesson?.successfulRepairs).toHaveLength(1)
    expect(baseBytes).toBeLessThanOrEqual(8 * 1024)
    expect(factBytes).toBeGreaterThan(baseBytes)
    expect(factBytes).toBeLessThanOrEqual(8 * 1024)
  })

  it("drops a repair link when its target is outside the final emitted subset", () => {
    const completed = (key: string) => node({ key, status: "completed", verificationReport: {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "criterion-a", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
    } })
    const target = node({ key: "target" }), repair = completed("repair")
    const newest = outcome("newest", 20n, ["n1", "n2", "n3", "n4", "n5"].map(completed))
    const old = outcome("older", 10n, [target, repair, completed("filler-1"), completed("filler-2")])
    const targetLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] } as const
    const repairLesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" }] } as const
    const older = { ...old, sourceNodeOrdinals: [1, 2, 3, 4], nodeLessons: [targetLesson, repairLesson, undefined, undefined] as const }

    const projected = projectRootTaskHistory([newest, older])
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ status: string; lesson?: { successfulRepairs?: unknown[] } }> }> }).turns
    expect(turns[0]?.nodes).toHaveLength(5)
    expect(turns[1]?.nodes).toHaveLength(3)
    expect(turns[1]?.nodes[0]?.status).toBe("completed")
    expect(turns[1]?.nodes[0]?.lesson).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain("successfulRepairs")
  })

  it("omits arbitrary report-level reasons and mismatched report status", () => {
    const unresolvedReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified" as const, reasonCode: "repair_target_unresolved" as const,
      criteria: [{ criterionId: "criterion-a", status: "passed" as const, reasonCode: "criteria_met" as const }],
      evidenceDigest: null, resultDigest: "f".repeat(64),
    }
    const arbitrary = node({
      verificationReport: { ...unresolvedReport, reasonCode: "projection_invalid" },
    })
    const mismatched = node({ status: "completed", verificationReport: unresolvedReport })
    const projected = projectRootTaskHistory([outcome("arbitrary", 6n, [arbitrary]), outcome("mismatch", 7n, [mismatched])])
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain("repair_target_unresolved")
    expect(serialized).not.toContain("projection_invalid")
    expect(projected?.content).toMatchObject({
      turns: [
        { nodes: [{ status: "completed" }] },
        { nodes: [{ status: "failed" }] },
      ],
    })
  })

  it("uses deterministic newest-first history and enforces Turn and node caps", () => {
    const nodes = Array.from({ length: 4 }, (_, index) => node({ key: "n" + index, templateId: index === 0 ? "analyst" : "unknown-private-template" }))
    const projected = projectRootTaskHistory([
      outcome("oldest", 1n, nodes), outcome("newest", 3n, nodes), outcome("middle", 2n, nodes),
    ])
    const content = projected?.content as { turns?: Array<{ nodes: unknown[] }> }
    expect(content.turns).toHaveLength(2)
    expect(content.turns?.flatMap(turn => turn.nodes)).toHaveLength(8)
    expect(content.turns?.[0].nodes[0]).toMatchObject({ taskKind: "analyst" })
    expect(JSON.stringify(projected)).not.toContain("unknown-private-template")
  })

  it("orders cross-session outcomes by DB time and breaks equal-time ties by descending Turn ID", () => {
    const terminalAt = new Date("2026-10-07T11:00:00.000Z")
    const highTurnId = { ...outcome("z-source", 1n, [node({ status: "running" })]), terminalAt, sourceSessionDiffers: true }
    const lowTurnId = { ...outcome("a-source", 90n, [node({ status: "queued" })]), terminalAt, sourceSessionDiffers: true }
    const olderTime = { ...outcome("older-time", 100n, [node({ status: "interrupted" })]),
      terminalAt: new Date(terminalAt.getTime() - 1), sourceSessionDiffers: true }
    const projected = projectRootTaskHistory([lowTurnId, highTurnId], true)
    const turns = (projected?.content as { turns: Array<{ nodes: Array<{ status: string }> }> }).turns

    expect(turns.map(turn => turn.nodes[0]?.status)).toEqual(["running", "queued"])
    const byTime = projectRootTaskHistory([olderTime, highTurnId], true)?.content as { turns: Array<{ nodes: Array<{ status: string }> }> }
    expect(byTime.turns.map(turn => turn.nodes[0]?.status)).toEqual(["running", "interrupted"])
    expect(projectRootTaskHistory([{ ...outcome("missing-source-session-scope", 3n), terminalAt }], true)?.content)
      .toMatchObject({ historical: true, advisoryOnly: true })
    expect(projectRootTaskHistory([{ ...outcome("invalid-source-session-scope", 4n), terminalAt,
      sourceSessionDiffers: "foreign" as unknown as boolean }], true)).toBeUndefined()
    expect(projectRootTaskHistory([{ ...outcome("missing-terminal-time", 2n), sourceSessionDiffers: false }], true)).toBeUndefined()
  })

  it("strips large untrusted node strings before applying the byte bound", () => {
    const large = node({ goal: "g".repeat(1000), resultSummary: "r".repeat(4000), failureReason: "f".repeat(2000) })
    const projected = projectRootTaskHistory([outcome("large", 4n, [large])])
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(8 * 1024)
    expect(JSON.stringify(projected)).not.toContain("gggg")
    expect(JSON.stringify(projected)).not.toContain("rrrr")
    expect(JSON.stringify(projected)).not.toContain("ffff")
  })

  it("omits conflicting duplicate and malformed source identities", () => {
    const first = outcome("same", 2n, [node()])
    const changed = outcome("same", 2n, [node({ status: "completed" })])
    expect(projectRootTaskHistory([first, changed])).toBeUndefined()
    expect(projectRootTaskHistory([{ ...first, unexpected: "proof" } as unknown as ValidatedRootTaskHistoryOutcome])).toBeUndefined()
    const lesson = { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] } as const
    expect(projectRootTaskHistory([{ ...first, sourceNodeOrdinals: [2], nodeLessons: [lesson] }])).toEqual(projectRootTaskHistory([first]))
  })
})
