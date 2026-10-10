import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
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
function lesson(nodeOrdinal: number, criterionOrdinals: readonly number[] = []): NonNullable<ValidatedRootTaskHistoryOutcome["nodeLessons"]>[number] {
  if (!criterionOrdinals.length) return undefined
  return {
    ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal,
    criterionFailures: criterionOrdinals.map(criterionOrdinal => ({ criterionOrdinal, status: "failed", reasonCode: "criterion_not_met" })),
  }
}

describe("root task history projection", () => {
  it("emits only typed advisory outcomes and negative reason codes", () => {
    const projected = projectRootTaskHistory([outcome("private-source", 12n)])
    expect(projected).toEqual({
      id: "root-task-history",
      content: {
        kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true,
        label: "Earlier outcomes for the same verifier objective; advisory context only.",
        turns: [{ label: "earlier terminal attempt", nodes: [{ taskKind: "scout", status: "failed", negativeReasonHints: ["criterion_not_met"] }] }],
      },
    })
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

  it("sorts shuffled cross-session outcomes by DB time instead of comparing session sequences", () => {
    const latest = { ...outcome("latest", 1n, [node({ status: "interrupted" })]), terminalAt: new Date("2026-10-07T11:00:00.000Z") }
    const older = { ...outcome("older", 900n, [node({ status: "failed" })]), terminalAt: new Date("2026-10-07T10:00:00.000Z") }
    const projected = projectRootTaskHistory([older, latest], true)?.content as { turns?: Array<{ nodes: Array<{ status: string }> }> }
    expect(projected.turns?.map(turn => turn.nodes[0]?.status)).toEqual(["interrupted", "failed"])
  })

  it("breaks equal cross-session DB times by descending stable source Turn ID", () => {
    const time = new Date("2026-10-07T11:00:00.000Z")
    const olderId = { ...outcome("a", 900n, [node({ status: "failed" })]), terminalAt: time }
    const newerId = { ...outcome("z", 1n, [node({ status: "interrupted" })]), terminalAt: time }
    const projected = projectRootTaskHistory([olderId, newerId], true)?.content as { turns?: Array<{ nodes: Array<{ status: string }> }> }
    expect(projected.turns?.map(turn => turn.nodes[0]?.status)).toEqual(["interrupted", "failed"])
  })

  it("keeps criterion ordinals source-local through the legacy task-kind sort and preserves repair links", () => {
    const scout = node({ templateId: "scout", status: "failed" })
    const analyst = node({ templateId: "analyst", status: "completed" })
    const targetLesson = lesson(1, [1, 2])
    const repairLesson = { ordinalScope: "source_graph_local" as const, advisoryOnly: true as const, notCurrentEvidence: true as const,
      nodeOrdinal: 2, criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" as const }] }
    const source = { ...outcome("lesson-source", 12n, [scout, analyst]), nodeLessons: [targetLesson, repairLesson] }

    const projected = projectRootTaskHistory([source])
    const turns = (projected?.content as { turns: Array<{ nodes: Array<Record<string, unknown>> }> }).turns

    expect(turns[0]?.nodes.map(value => value.taskKind)).toEqual(["analyst", "scout"])
    expect(turns[0]?.nodes[0]?.lesson).toEqual({
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 2,
      criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1, 2], status: "passed" }],
    })
    expect(turns[0]?.nodes[1]?.lesson).toEqual({
      ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: 1,
      criterionFailures: [
        { criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" },
        { criterionOrdinal: 2, status: "failed", reasonCode: "criterion_not_met" },
      ],
    })
    const serialized = JSON.stringify(projected)
    for (const forbidden of ["lesson-source", "PRIVATE_", "criterion-a", "verificationReport", "evidenceDigest", "resultDigest"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it("ignores malformed optional lesson facts while preserving the exact legacy projection", () => {
    const source = outcome("malformed-lessons", 3n)
    const baseline = projectRootTaskHistory([source])
    const malformed = { ...source, nodeLessons: [{ nodeOrdinal: 1, criterionFailures: [{ criterionId: "raw-id" }] }] }

    expect(projectRootTaskHistory([malformed as unknown as ValidatedRootTaskHistoryOutcome])).toEqual(baseline)
  })

  it("drops a repair link when node capping omits its failed target without renumbering source ordinals", () => {
    const newest = outcome("newest-cap", 20n, Array.from({ length: 5 }, (_, index) => node({ key: `new-${index}`, status: "completed" })))
    const olderNodes = [
      node({ key: "target", templateId: "scout", status: "failed" }),
      node({ key: "other-a", templateId: "misc-a", status: "completed" }),
      node({ key: "other-b", templateId: "misc-b", status: "completed" }),
      node({ key: "other-c", templateId: "misc-c", status: "completed" }),
      node({ key: "repair", templateId: "analyst", status: "completed" }),
    ]
    const oldLessons = [lesson(1, [1]), undefined, undefined, undefined, {
      ordinalScope: "source_graph_local" as const, advisoryOnly: true as const, notCurrentEvidence: true as const,
      nodeOrdinal: 5, criterionFailures: [], successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: [1], status: "passed" as const }],
    }]
    const older = { ...outcome("older-cap", 10n, olderNodes), nodeLessons: oldLessons }

    const projected = projectRootTaskHistory([newest, older])?.content as { turns: Array<{ nodes: Array<Record<string, unknown>> }> }
    const oldTurnNodes = projected.turns[1]?.nodes ?? []

    expect(projected.turns.flatMap(turn => turn.nodes)).toHaveLength(8)
    expect(oldTurnNodes.some(value => value.taskKind === "scout")).toBe(false)
    expect(oldTurnNodes.find(value => value.taskKind === "analyst")).not.toHaveProperty("lesson")
    expect(oldTurnNodes.some(value => (value.lesson as { nodeOrdinal?: number } | undefined)?.nodeOrdinal === 1)).toBe(false)
  })

  it("drops links to target criteria trimmed by the UTF-8 byte cap", () => {
    const ordinals = Array.from({ length: 8 }, (_, index) => index + 1)
    const failedCriteria = ordinals.map(criterionOrdinal => ({ criterionOrdinal, status: "failed" as const, reasonCode: "canonical_evidence_ambiguous" as const }))
    const nodes = [node({ templateId: "scout", status: "failed" }), ...Array.from({ length: 7 }, (_, index) =>
      node({ key: `repair-${index + 1}`, templateId: "analyst", status: "failed" }))]
    const nodeLessons = nodes.map((_, index) => ({
      ordinalScope: "source_graph_local" as const, advisoryOnly: true as const, notCurrentEvidence: true as const,
      nodeOrdinal: index + 1, criterionFailures: failedCriteria,
      ...(index > 0 ? { successfulRepairs: [{ targetNodeOrdinal: 1, targetCriterionOrdinals: ordinals, status: "passed" as const }] } : {}),
    }))

    const projected = projectRootTaskHistory([{ ...outcome("byte-cap", 15n, nodes), nodeLessons }])
    const emitted = (projected?.content as { turns: Array<{ nodes: Array<Record<string, unknown>> }> }).turns[0]?.nodes ?? []
    const target = emitted.find(value => value.taskKind === "scout")
    const repairs = emitted.filter(value => value.taskKind === "analyst")

    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(8 * 1024)
    expect(target).not.toHaveProperty("lesson")
    expect(repairs).toHaveLength(7)
    expect(repairs.every(value => {
      const fact = value.lesson as { successfulRepairs?: unknown[] } | undefined
      return !!fact && !Object.hasOwn(fact, "successfulRepairs")
    })).toBe(true)
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
  })
})
