import { describe, expect, it, vi } from "vitest"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { DirectRootTaskHistoryLoadInput } from "./context/root-task-history-direct-store.js"
import { appendCanonicalRootTaskHistory, type DirectRootTaskHistoryReader } from "./canonical-turn-root-task-history.js"
import type { ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"

const snapshot: StepContextSnapshot = {
  system: [], profile: [], steerHistory: [], businessRefs: [],
  toolObservations: [
    { id: "keep", content: { safe: true } },
    { id: "root-task-history", content: { kind: "forged", proof: "must be replaced" } },
  ],
}
const request = {
  lease: {
    userId: "user-a", sessionId: "session-a", turnId: "turn-current", ownerId: "worker-a", leaseVersion: 2,
    leaseStartedAt: new Date("2026-10-08T00:00:00Z"), leaseExpiresAt: new Date("2026-10-08T00:01:00Z"),
  },
  rootTaskId: "root-current", rootAttemptCount: 3, stepId: "step-current", now: new Date("2026-10-08T00:00:10Z"),
} as DirectRootTaskHistoryLoadInput
const outcomes: readonly ValidatedRootTaskHistoryOutcome[] = [{
  sourceTurnId: "private-source-turn", sourceRootTaskId: "private-source-root", terminalSequence: 9n,
  taskGraph: { revision: 1, nodes: [{
    key: "private-node", templateId: "scout", goal: "private goal", successCriteria: [], dependsOn: [],
    taskId: "private-child", status: "failed", readiness: "terminal", resultSummary: "private result", failureReason: "private failure",
  }] },
}]

describe("canonical Root task history context", () => {
  it("uses the server-owned request fence and replaces any reserved caller block", async () => {
    const load = vi.fn(async (_input: DirectRootTaskHistoryLoadInput) => outcomes)
    const reader: DirectRootTaskHistoryReader = { load }
    const built = await appendCanonicalRootTaskHistory({ snapshot, reader, request })

    expect(load).toHaveBeenCalledWith(request)
    expect(built.toolObservations).toHaveLength(2)
    expect(built.toolObservations[0]).toEqual({ id: "keep", content: { safe: true } })
    expect(built.toolObservations[1]).toMatchObject({
      id: "root-task-history", content: { kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true },
    })
    expect(JSON.stringify(built.toolObservations)).not.toContain("forged")
    expect(JSON.stringify(built.toolObservations)).not.toContain("private-source-root")
  })

  it("removes a stale reserved block when no validated history exists", async () => {
    const reader: DirectRootTaskHistoryReader = { load: async () => [] }
    const built = await appendCanonicalRootTaskHistory({ snapshot, reader, request })
    expect(built.toolObservations).toEqual([{ id: "keep", content: { safe: true } }])
  })

  it("passes the opt-in projection mode so equal-time outcomes use descending Turn ID order", async () => {
    const terminalAt = new Date("2026-10-08T00:00:00Z")
    const base = outcomes[0]!
    const before = { ...base, sourceTurnId: "turn-a", terminalAt,
      taskGraph: { revision: 1, nodes: [{ ...base.taskGraph.nodes[0]!, status: "queued" as const }] } }
    const after = { ...base, sourceTurnId: "turn-z", terminalAt,
      taskGraph: { revision: 1, nodes: [{ ...base.taskGraph.nodes[0]!, status: "running" as const }] } }
    const reader: DirectRootTaskHistoryReader = { load: async () => [before, after] }
    const built = await appendCanonicalRootTaskHistory({ snapshot, reader,
      request: { ...request, crossSessionRootTaskHistoryEnabled: true } })
    const history = built.toolObservations.find(item => item.id === "root-task-history")?.content as {
      turns: Array<{ nodes: Array<{ status: string }> }>
    }

    expect(history.turns.map(turn => turn.nodes[0]?.status)).toEqual(["running", "queued"])
  })

  it("propagates owner/database read failures instead of turning them into accepted history", async () => {
    const reader: DirectRootTaskHistoryReader = { load: async () => { throw new Error("root_task_history_scope_invalid") } }
    await expect(appendCanonicalRootTaskHistory({ snapshot, reader, request })).rejects.toThrow("root_task_history_scope_invalid")
  })
})
