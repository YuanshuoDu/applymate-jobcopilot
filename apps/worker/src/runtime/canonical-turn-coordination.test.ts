import { describe, expect, it, vi } from "vitest"

import type { TaskGraphCommandPort, TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import { createCanonicalTurnCoordination } from "./canonical-turn-coordination.js"
import { SessionPauseRequestedError } from "./session-gate.js"
import { NATIVE_COORDINATION_RECEIPT_SCHEMA } from "./tools/task-graph-coordination-bridge.js"

const lease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 4 } as TurnLease
const digest = "b".repeat(64)
const receipt = {
  schemaVersion: NATIVE_COORDINATION_RECEIPT_SCHEMA, operationKind: "spawn", status: "accepted", replay: false,
  operationId: "operation-1", requestFingerprint: digest, graphRevision: 2, nodeKey: "node-1",
  dispatchDisposition: "pending", rootTaskId: "root-1",
  child: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "queued" },
}
const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [
  { id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "agent.spawn", status: "completed", output: { nativeCoordination: receipt } } },
] }

function graph(nodes: TaskGraphCurrentState["nodes"] = [{
  key: "node-1", templateId: "native:scout", goal: "Inspect", successCriteria: [], dependsOn: [], taskId: "child-1",
  status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
  native: { operationKind: "spawn", operationId: "operation-1", requestFingerprint: digest, callerTaskId: "root-1", role: "scout", taskType: "research", contextDigest: digest },
}]): TaskGraphCurrentState { return { revision: 3, nodes } }

function makeCoordination(
  readCurrent = vi.fn(async () => graph()),
  readCurrentForPlanning = readCurrent,
) {
  const commandPort = { appendAndSchedule: vi.fn(), appendNativeCoordination: vi.fn(), readCurrent, readCurrentForPlanning } as unknown as TaskGraphCommandPort
  const coordination = createCanonicalTurnCoordination({ enabled: true, commandPort, lease })
  coordination.bindRoot({ id: "root-1", attemptCount: 2 } as never)
  return { coordination, readCurrent, readCurrentForPlanning }
}

describe("canonical Turn native coordination", () => {
  it("immediately refreshes the graph and uses the canonical root lease fence", async () => {
    const current = makeCoordination(vi.fn(async () => graph()), vi.fn(async () => graph()))
    const refreshed = await current.coordination.refresh(snapshot as never)

    expect(current.readCurrentForPlanning).toHaveBeenCalledWith({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "worker-1", turnLeaseVersion: 4, parentLeaseOwner: "worker-1", parentAttemptCount: 2,
    })
    expect(refreshed.toolObservations.find(item => item.id === "task-graph-current")?.content).toMatchObject({ kind: "task_graph_current", revision: 3 })
    await expect(current.coordination.checkNativeGraphCompletion()).resolves.toBeNull()
    expect(current.readCurrent).toHaveBeenCalledOnce()
    expect(current.readCurrentForPlanning).toHaveBeenCalledOnce()
    expect(current.coordination.executionScope("step-3")).toEqual({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step-3",
      turnLeaseOwner: "worker-1", turnLeaseVersion: 4, parentLeaseOwner: "worker-1", parentAttemptCount: 2,
    })
    await expect(current.coordination.hasNativeTasks()).resolves.toBe(true)
    expect(current.readCurrent).toHaveBeenCalledOnce()
  })

  it("uses advisory planner context for refresh while completion reads the provenance-free graph", async () => {
    const plannerState = graph([{ ...graph().nodes[0]!, inputRelation: "predates_current_inputs" }])
    const completionState = graph()
    const current = makeCoordination(vi.fn(async () => completionState), vi.fn(async () => plannerState))

    const refreshed = await current.coordination.refresh(snapshot as never)
    const observation = refreshed.toolObservations.find(item => item.id === "task-graph-current")?.content as Record<string, unknown>
    const nodes = observation.nodes as Array<Record<string, unknown>>
    expect(nodes[0]?.inputRelation).toBe("predates_current_inputs")
    expect(completionState.nodes[0]).not.toHaveProperty("inputRelation")
    await expect(current.coordination.checkNativeGraphCompletion()).resolves.toBeNull()
    expect(current.readCurrentForPlanning).toHaveBeenCalledOnce()
    expect(current.readCurrent).toHaveBeenCalledOnce()
  })

  it("reuses the planner refresh for the internal native-task check without another graph read", async () => {
    const plannerState = graph([{ ...graph().nodes[0]!, inputRelation: "covers_current_inputs" }])
    const current = makeCoordination(vi.fn(async () => graph()), vi.fn(async () => plannerState))

    await current.coordination.refresh(snapshot as never)

    await expect(current.coordination.hasNativeTasks()).resolves.toBe(true)
    expect(current.readCurrentForPlanning).toHaveBeenCalledOnce()
    expect(current.readCurrent).not.toHaveBeenCalled()
  })

  it("keeps a recovered native receipt as a completion requirement when the graph is absent", async () => {
    const current = makeCoordination(vi.fn(async () => graph([])))
    await expect(current.coordination.refresh(snapshot as never)).rejects.toThrow("task_graph_native_coordination_missing")
    await expect(current.coordination.checkNativeGraphCompletion()).resolves.toMatchObject({
      ok: false, blocker: "task_graph_verification_unverified", feedback: expect.stringContaining("Native coordination"),
    })
  })

  it("rethrows typed session pauses instead of converting them into native feedback", async () => {
    const pause = new SessionPauseRequestedError()
    const current = makeCoordination(vi.fn(async () => { throw pause }))
    await expect(current.coordination.refresh(snapshot as never)).rejects.toBe(pause)
    await expect(current.coordination.checkNativeGraphCompletion()).rejects.toBe(pause)
  })

  it("rethrows PostgreSQL TaskGraph ownership fences instead of ordinary completion feedback", async () => {
    const fence = new Error("task_graph_turn_fenced")
    const current = makeCoordination(vi.fn(async () => { throw fence }))
    await expect(current.coordination.refresh(snapshot as never)).rejects.toBe(fence)
    await expect(current.coordination.checkNativeGraphCompletion()).rejects.toBe(fence)
  })

  it("fails immediate refresh closed when the native receipt has no graph witness", async () => {
    const current = makeCoordination(vi.fn(async () => graph([])))
    await expect(current.coordination.refresh(snapshot as never)).rejects.toThrow("task_graph_native_coordination_missing")
  })

  it("does not add a native completion gate to no-delegation roots", async () => {
    const current = makeCoordination()
    await expect(current.coordination.checkNativeGraphCompletion()).resolves.toBeNull()
    expect(current.readCurrent).not.toHaveBeenCalled()
  })
})
