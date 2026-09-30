import { describe, expect, it } from "vitest"
import { loadTaskGraphCurrentObservation, mergeTaskGraphCurrentObservation } from "./canonical-turn-task-graph-context.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import type { TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"

const state: TaskGraphCurrentState = {
  revision: 3,
  nodes: [{
    key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return links"], dependsOn: [],
    taskId: "child-1", status: "completed", readiness: "terminal",
    resultSummary: "Alice Example found two roles", failureReason: "Alice Example failed at https://private.example/apply",
    resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "scout", status: "completed",
      candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
    },
  }],
}

function snapshot(): StepContextSnapshot {
  return {
    system: [], profile: [], steerHistory: [], businessRefs: [],
    toolObservations: [
      { id: "existing", content: { kept: true } },
      { id: "task-graph-current", content: { kind: "task_graph_current", revision: 1, nodes: [] } },
    ],
  }
}

describe("TaskGraph turn observation", () => {
  it("refreshes the old graph observation while preserving other observations and live outcomes", () => {
    const result = mergeTaskGraphCurrentObservation(snapshot(), state)

    expect(result.toolObservations).toEqual([
      { id: "existing", content: { kept: true } },
      { id: "task-graph-current", content: { kind: "task_graph_current", revision: 3, nodes: [{ ...state.nodes[0]!, resultSummary: null, failureReason: null }] } },
    ])
    const encoded = JSON.stringify(result.toolObservations.at(-1)?.content)
    expect(encoded).not.toContain("Alice Example")
    expect(encoded).not.toContain("private.example")
  })

  it("fails closed instead of giving the model a partial or unbounded graph", () => {
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: Array.from({ length: 17 }, () => state.nodes[0]!) })).toThrow("task_graph_current_state_invalid")
    const bounded = mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, resultSummary: "x".repeat(30_000) }] })
    expect((bounded.toolObservations.at(-1)?.content as { nodes: Array<{ resultSummary: string | null }> }).nodes[0]?.resultSummary).toBeNull()
    expect(() => mergeTaskGraphCurrentObservation(snapshot(), { ...state, nodes: [{ ...state.nodes[0]!, taskId: "x".repeat(129) }] })).toThrow("task_graph_current_state_invalid:taskId")
  })

  it("carries the bounded persisted result into a resumed root model observation", async () => {
    const persistedState: TaskGraphCurrentState = {
      ...state,
      nodes: [{ ...state.nodes[0]!, resultSummary: "Alice Example summary must stay hidden" }],
    }
    const port: TaskGraphCommandPort = {
      readCurrent: async () => persistedState,
      appendAndSchedule: async () => { throw new Error("unused") },
    }
    const lease: TurnLease = {
      turnId: "turn-1", sessionId: "session-1", ownerId: "turn-owner", userId: "user-1", leaseVersion: 2,
      leaseStartedAt: new Date("2026-09-25T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-25T00:01:00.000Z"),
    }
    const resumed = await loadTaskGraphCurrentObservation(snapshot(), port, lease, { id: "root-1", attemptCount: 2 })
    const observation = resumed.toolObservations.at(-1)?.content as {
      nodes: Array<{ resultSummary: string | null; resultProjection: unknown }>
    }

    expect(observation.nodes[0]).toMatchObject({
      resultSummary: null,
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
        trust: "untrusted", availability: "available", role: "scout", candidateCount: 1,
        candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
      },
    })
    expect(JSON.stringify(observation)).not.toContain("Alice Example")
    expect(JSON.stringify(observation)).not.toContain("private.example")
  })

  it("replaces unsafe result projections with an untrusted unavailable marker", () => {
    const invalidProjection = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
      trust: "untrusted", availability: "available", role: "scout", status: "completed",
      candidateCount: 1, evidenceCount: 1,
      candidates: [{
        jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"],
        url: "https://private.example/apply", summary: "Jane Doe",
      }],
    }
    const result = mergeTaskGraphCurrentObservation(snapshot(), {
      ...state, nodes: [{ ...state.nodes[0]!, resultProjection: invalidProjection as never }],
    })
    const observation = result.toolObservations.at(-1)?.content as { nodes: Array<{ resultProjection: unknown }> }

    expect(observation.nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
    expect(JSON.stringify(observation)).not.toContain("private.example")
    expect(JSON.stringify(observation)).not.toContain("Jane Doe")
  })
})
