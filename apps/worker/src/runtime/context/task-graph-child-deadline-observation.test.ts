import { describe, expect, it } from "vitest"
import {
  replaceTaskGraphChildDeadlineObservation,
  TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID,
  type TaskGraphChildDeadlineNode,
} from "./task-graph-child-deadline-observation.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

const nodes: readonly TaskGraphChildDeadlineNode[] = [
  { key: "scout", status: "running" },
  { key: "auditor", status: "waiting_for_user" },
  { key: "finished", status: "completed" },
]
const observedAt = "2026-01-01T00:00:00.000Z"
const packet = {
  revision: 7,
  observedAt,
  entries: [{ nodeKey: "scout", deadlineAt: "2026-01-01T00:05:00.000Z" }],
}

function snapshot(toolObservations: StepContextSnapshot["toolObservations"] = []): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations }
}

describe("TaskGraph child deadline observation", () => {
  it("projects only ordered active-node timing into a separate advisory observation", () => {
    const result = replaceTaskGraphChildDeadlineObservation(snapshot(), { revision: 7, nodes, packet })
    const observation = result.toolObservations.find(item => item.id === TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID)

    expect(observation?.content).toEqual({
      schemaVersion: "agent-harness.v2.task-graph-child-deadlines.v1",
      kind: "task_graph_child_deadlines",
      revision: 7,
      observedAt,
      authorityNotice: "Current child task times are advisory only. The server task graph, scheduler, and existing planning, budget, approval, and action rules remain authoritative.",
      entries: [{ nodeKey: "scout", deadlineAt: "2026-01-01T00:05:00.000Z" }],
    })
    expect(JSON.stringify(observation)).not.toMatch(/taskId|private|result|approvalId/)
  })

  it("replaces stale timing and clears the reserved block when the new packet is absent or invalid", () => {
    const prior = snapshot([
      { id: "kept", content: { safe: true } },
      { id: TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID, content: { privateTaskId: "old-child" } },
    ])
    const fresh = replaceTaskGraphChildDeadlineObservation(prior, { revision: 7, nodes, packet })
    expect(fresh.toolObservations.some(item => JSON.stringify(item.content).includes("old-child"))).toBe(false)

    for (const invalidPacket of [undefined, { ...packet, privateField: "untrusted" },
      { ...packet, revision: 6 }, { ...packet, entries: [{ nodeKey: "finished", deadlineAt: "2026-01-01T00:05:00.000Z" }] },
      { ...packet, entries: [{ nodeKey: "scout", deadlineAt: observedAt }] }]) {
      const cleared = replaceTaskGraphChildDeadlineObservation(fresh, { revision: 7, nodes, packet: invalidPacket })
      expect(cleared.toolObservations.map(item => item.id)).toEqual(["kept"])
    }
  })

  it("rejects accessor and hidden packet fields without reading accessors", () => {
    let getterReads = 0
    const accessorPacket = { revision: 7, observedAt, entries: packet.entries }
    Object.defineProperty(accessorPacket, "revision", {
      enumerable: true,
      get: () => { getterReads += 1; return 7 },
    })
    const hiddenField = { ...packet }
    Object.defineProperty(hiddenField, "private", { value: true })
    const symbolField = { ...packet }
    Object.defineProperty(symbolField, Symbol("private"), { value: true })
    const accessorEntries = [{ ...packet.entries[0]! }]
    Object.defineProperty(accessorEntries, "0", {
      enumerable: true,
      get: () => { getterReads += 1; return packet.entries[0] },
    })

    for (const invalidPacket of [accessorPacket, hiddenField, symbolField, { ...packet, entries: accessorEntries }]) {
      const result = replaceTaskGraphChildDeadlineObservation(snapshot(), { revision: 7, nodes, packet: invalidPacket })
      expect(result.toolObservations).toEqual([])
    }
    expect(getterReads).toBe(0)
  })
})
