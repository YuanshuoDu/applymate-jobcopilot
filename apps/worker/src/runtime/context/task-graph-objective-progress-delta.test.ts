import { describe, expect, it } from "vitest"

import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION,
  type TaskGraphObjectiveProgressStatus } from "./task-graph-objective-progress.js"
import { objectiveProgressSnapshotFromContext, parseObjectiveProgressDelta, parseObjectiveProgressSnapshot,
  taskGraphObjectiveProgressDelta, type ObjectiveProgressSnapshot } from "./task-graph-objective-progress-delta.js"
import type { StepContext } from "./step-context-builder.js"

const snapshot = (revision: number | null, status: TaskGraphObjectiveProgressStatus = "active"): ObjectiveProgressSnapshot => ({
  schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION, advisory: true, revision,
  requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3, status }],
})

function context(content: unknown): StepContext {
  return { schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    inputThroughSequence: 0n, consumedInputIds: [], canonicalJson: "{}", blocks: [{ id: TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID,
      layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent", content: content as never }] }
}

describe("TaskGraph objective progress delta", () => {
  it("copies only the bounded existing projection from one exact observation", () => {
    expect(objectiveProgressSnapshotFromContext(context(snapshot(4)))).toEqual(snapshot(4))
    expect(objectiveProgressSnapshotFromContext(context({ ...snapshot(4), extra: "private" }))).toBeNull()
    expect(objectiveProgressSnapshotFromContext({ ...context(snapshot(4)), blocks: [
      ...context(snapshot(4)).blocks, ...context(snapshot(4)).blocks,
    ] })).toBeNull()
  })

  it("rejects malformed rows, duplicate criteria, and unknown statuses", () => {
    expect(parseObjectiveProgressSnapshot({ ...snapshot(1), requirements: [{ ...snapshot(1).requirements[0], status: "passed" }] })).toBeNull()
    expect(parseObjectiveProgressSnapshot({ ...snapshot(1), requirements: [snapshot(1).requirements[0], snapshot(1).requirements[0]] })).toBeNull()
    expect(parseObjectiveProgressSnapshot({ ...snapshot(1), requirements: [{ ...snapshot(1).requirements[0], minimum: 0 }] })).toBeNull()
  })

  it("requires null-revision snapshots to contain only unknown statuses", () => {
    const unavailable = snapshot(null, "unknown")
    expect(parseObjectiveProgressSnapshot(unavailable)).toEqual(unavailable)
    expect(parseObjectiveProgressSnapshot(snapshot(null))).toBeNull()
    expect(objectiveProgressSnapshotFromContext(context(snapshot(null)))).toBeNull()
  })

  it("marks missing history unknown instead of treating it as zero", () => {
    const delta = taskGraphObjectiveProgressDelta(null, snapshot(4, "reported_passed"), false)
    expect(delta).toEqual({ schemaVersion: "agent-harness.v2.objective-progress-delta.v1", availability: "unavailable",
      previousPlanRevision: null, currentPlanRevision: 4, requirements: [{ id: "candidate-count", kind: "candidate_count_gte",
        minimum: 3, beforeStatus: "unknown", afterStatus: "reported_passed" }] })
    expect(parseObjectiveProgressDelta(delta)).toEqual(delta)
    expect(parseObjectiveProgressDelta({ ...delta, requirements: [{ ...delta.requirements[0], beforeStatus: "missing" }] })).toBeNull()
  })

  it("does not compare snapshots when either plan revision is unavailable", () => {
    const previousUnknown = taskGraphObjectiveProgressDelta(snapshot(null, "unknown"), snapshot(9, "reported_passed"), true)
    const currentUnknown = taskGraphObjectiveProgressDelta(snapshot(4), snapshot(null, "unknown"), true)
    expect(previousUnknown).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
    expect(currentUnknown).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: null,
      requirements: [{ beforeStatus: "unknown", afterStatus: "unknown" }] })
  })

  it("compares changed or unchanged status across different plan revisions", () => {
    const changed = taskGraphObjectiveProgressDelta(snapshot(4), snapshot(9, "reported_passed"), true)
    const unchanged = taskGraphObjectiveProgressDelta(snapshot(4), snapshot(9), true)
    expect(changed).toMatchObject({ availability: "available", previousPlanRevision: 4, currentPlanRevision: 9,
      requirements: [{ beforeStatus: "active", afterStatus: "reported_passed" }] })
    expect(unchanged.requirements[0]).toMatchObject({ beforeStatus: "active", afterStatus: "active" })
    expect(taskGraphObjectiveProgressDelta(snapshot(4), snapshot(9, "failed"), false).availability).toBe("unavailable")
    expect(taskGraphObjectiveProgressDelta(snapshot(4), { ...snapshot(9), requirements: [{ ...snapshot(9).requirements[0], id: "different" }] }, true).availability).toBe("unavailable")
  })

  it("matches reordered immutable requirements by ID and preserves current projection order", () => {
    const previous = { ...snapshot(4), requirements: [
      { id: "candidate-count", kind: "candidate_count_gte" as const, minimum: 3, status: "active" as const },
      { id: "finding-count", kind: "finding_count_gte" as const, minimum: 2, status: "failed" as const },
    ] }
    const current = { ...snapshot(8), requirements: [
      { id: "finding-count", kind: "finding_count_gte" as const, minimum: 2, status: "unverified" as const },
      { id: "candidate-count", kind: "candidate_count_gte" as const, minimum: 3, status: "reported_passed" as const },
    ] }
    expect(taskGraphObjectiveProgressDelta(previous, current, true)).toMatchObject({ availability: "available",
      requirements: [{ id: "finding-count", beforeStatus: "failed", afterStatus: "unverified" },
        { id: "candidate-count", beforeStatus: "active", afterStatus: "reported_passed" }] })
  })
})
