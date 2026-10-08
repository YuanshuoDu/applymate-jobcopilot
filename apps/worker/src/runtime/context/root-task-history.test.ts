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
