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

  const locationSnapshot = (revision: number | null, status: TaskGraphObjectiveProgressStatus = "active",
    locations: readonly string[] = ["berlin", "dublin"]): ObjectiveProgressSnapshot => ({
    schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION, advisory: true, revision,
    requirements: [{ id: "berlin", kind: "candidate_location_in", locations, status }],
  })

  it("parses canonical location snapshots and mixed numeric requirements in either order", () => {
    const location = locationSnapshot(4)
    expect(parseObjectiveProgressSnapshot(location)).toEqual(location)
    for (const requirements of [
      [snapshot(4).requirements[0], location.requirements[0]],
      [location.requirements[0], snapshot(4).requirements[0]],
    ]) {
      expect(parseObjectiveProgressSnapshot({ ...snapshot(4), requirements })).toMatchObject({ requirements })
    }
  })

  it("rejects noncanonical, malformed, accessor-backed, and overlarge location lists", () => {
    const base = locationSnapshot(4)
    const row = base.requirements[0]
    for (const locations of [
      ["Dublin", "Berlin"], ["berlin", "berlin"], [], Array(9).fill("berlin"), ["x".repeat(129)],
    ]) {
      expect(parseObjectiveProgressSnapshot({ ...base, requirements: [{ ...row, locations }] })).toBeNull()
    }
    expect(parseObjectiveProgressSnapshot({ ...base, requirements: [{ ...row, minimum: 1 }] })).toBeNull()

    const accessorRow = { id: row.id, kind: row.kind, status: row.status } as Record<string, unknown>
    Object.defineProperty(accessorRow, "locations", { enumerable: true, get: () => ["berlin", "dublin"] })
    expect(() => parseObjectiveProgressSnapshot({ ...base, requirements: [accessorRow] })).not.toThrow()
    expect(parseObjectiveProgressSnapshot({ ...base, requirements: [accessorRow] })).toBeNull()

    const accessorLocations = ["berlin", "dublin"]
    Object.defineProperty(accessorLocations, "0", { enumerable: true, get: () => "berlin" })
    expect(parseObjectiveProgressSnapshot({ ...base, requirements: [{ ...row, locations: accessorLocations }] })).toBeNull()

    const oversized = { ...snapshot(4), requirements: Array.from({ length: 8 }, (_, index) => ({
      id: "location-" + index, kind: "candidate_location_in" as const,
      locations: Array.from({ length: 8 }, (_, item) => String(item) + "x".repeat(127)), status: "active" as const,
    })) }
    expect(parseObjectiveProgressSnapshot(oversized)).toBeNull()
  })

  it("compares location status and omits location arrays from the progress delta", () => {
    const previous = locationSnapshot(4, "active")
    const current = locationSnapshot(9, "reported_passed")
    const delta = taskGraphObjectiveProgressDelta(previous, current, true)
    expect(delta).toMatchObject({ availability: "available", previousPlanRevision: 4, currentPlanRevision: 9,
      requirements: [{ id: "berlin", kind: "candidate_location_in", beforeStatus: "active", afterStatus: "reported_passed" }] })
    expect(JSON.stringify(delta)).not.toContain("dublin")
    expect(delta.requirements[0]).not.toHaveProperty("locations")
    expect(parseObjectiveProgressDelta(delta)).toEqual(delta)

    const mixed = { ...current, requirements: [
      current.requirements[0], { id: "candidate-count", kind: "candidate_count_gte" as const, minimum: 3, status: "active" as const },
    ] }
    const mixedDelta = taskGraphObjectiveProgressDelta(null, mixed, false)
    expect(mixedDelta).toMatchObject({ availability: "unavailable", previousPlanRevision: null,
      requirements: [{ id: "berlin", beforeStatus: "unknown" }, { id: "candidate-count", beforeStatus: "unknown" }] })
  })

  it("fails closed when location identity or revision moves backwards", () => {
    const previous = locationSnapshot(9, "active")
    const changedLocations = locationSnapshot(10, "reported_passed", ["berlin", "cork"])
    expect(taskGraphObjectiveProgressDelta(previous, changedLocations, true)).toMatchObject({
      availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 10,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }],
    })

    const reversed = taskGraphObjectiveProgressDelta(snapshot(9), snapshot(4, "reported_passed"), true)
    expect(reversed).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 4,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
    const available = taskGraphObjectiveProgressDelta(snapshot(4), snapshot(9), true)
    expect(parseObjectiveProgressDelta({ ...available, previousPlanRevision: 9, currentPlanRevision: 4 })).toBeNull()
  })

  it("rejects duplicate delta identities and any location payload or digest", () => {
    const delta = taskGraphObjectiveProgressDelta(null, locationSnapshot(4), false)
    const row = delta.requirements[0]
    expect(parseObjectiveProgressDelta({ ...delta, requirements: [row, row] })).toBeNull()
    expect(parseObjectiveProgressDelta({ ...delta, requirements: [{ ...row, locations: ["berlin", "dublin"] }] })).toBeNull()
    expect(parseObjectiveProgressDelta({ ...delta, requirements: [{ ...row, locationDigest: "a".repeat(64) }] })).toBeNull()
  })

  it("rejects top-level and array accessors without invoking them", () => {
    let getterCalls = 0
    const base = locationSnapshot(4)
    const snapshotGetter = { ...base }
    Object.defineProperty(snapshotGetter, "schemaVersion", { enumerable: true, get: () => {
      getterCalls += 1
      throw new Error("must not execute")
    } })
    expect(() => parseObjectiveProgressSnapshot(snapshotGetter)).not.toThrow()
    expect(parseObjectiveProgressSnapshot(snapshotGetter)).toBeNull()

    const locationGetter = ["berlin", "dublin"]
    Object.defineProperty(locationGetter, "0", { enumerable: true, get: () => {
      getterCalls += 1
      throw new Error("must not execute")
    } })
    const locationRow = base.requirements[0]
    expect(parseObjectiveProgressSnapshot({ ...base, requirements: [{ ...locationRow, locations: locationGetter }] })).toBeNull()

    const requirementGetter = [base.requirements[0]]
    Object.defineProperty(requirementGetter, "0", { enumerable: true, get: () => {
      getterCalls += 1
      throw new Error("must not execute")
    } })
    expect(parseObjectiveProgressSnapshot({ ...base, requirements: requirementGetter })).toBeNull()

    const delta = taskGraphObjectiveProgressDelta(null, snapshot(4), false)
    const deltaGetter = { ...delta }
    Object.defineProperty(deltaGetter, "availability", { enumerable: true, get: () => {
      getterCalls += 1
      throw new Error("must not execute")
    } })
    expect(() => parseObjectiveProgressDelta(deltaGetter)).not.toThrow()
    expect(parseObjectiveProgressDelta(deltaGetter)).toBeNull()

    const rowGetter = [delta.requirements[0]]
    Object.defineProperty(rowGetter, "0", { enumerable: true, get: () => {
      getterCalls += 1
      throw new Error("must not execute")
    } })
    expect(parseObjectiveProgressDelta({ ...delta, requirements: rowGetter })).toBeNull()
    expect(getterCalls).toBe(0)
  })
})
