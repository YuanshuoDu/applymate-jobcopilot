import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"
import {
  taskGraphReviewConflictObservation, type TaskGraphReviewConflict,
  type TaskGraphReviewStatus,
} from "./task-graph-review-conflicts.js"

const SCHEMA = "agent-harness.v2.task-graph.result-projection"
const hash = (digit: string) => `sha256:${digit.repeat(64)}`

function reviewer(taskId: string, reviewStatus: TaskGraphReviewStatus, patch: Readonly<{
  artifactId?: string; version?: number; contentHash?: string; sourceDigest?: string
  taskStatus?: string; role?: string; availability?: string; projectionPatch?: Record<string, unknown>
}> = {}): TaskGraphCurrentNode {
  const projection = {
    schemaVersion: SCHEMA, trust: "untrusted", availability: patch.availability ?? "available",
    role: patch.role ?? "reviewer", status: "completed", reviewStatus, reviewHash: hash("e"),
    artifactRef: {
      artifactId: patch.artifactId ?? "draft-1", version: patch.version ?? 2,
      contentHash: patch.contentHash ?? hash("a"), sourceDigest: patch.sourceDigest ?? hash("b"),
    },
    ...patch.projectionPatch,
  }
  return {
    key: taskId, templateId: "cover_letter_reviewer", goal: "Review exact draft", successCriteria: [], dependsOn: [],
    taskId, status: (patch.taskStatus ?? "completed") as TaskGraphCurrentNode["status"], readiness: "terminal",
    resultSummary: null, failureReason: null, resultProjection: projection as never,
  }
}

function conflicts(value: ReturnType<typeof taskGraphReviewConflictObservation>): readonly TaskGraphReviewConflict[] {
  return value.reviewConflicts ?? []
}

describe("current TaskGraph review conflict observation", () => {
  it("is order invariant, groups by the full artifact identity, and deduplicates task/status pairs", () => {
    const nodes = [
      reviewer("reviewer-b", "rejected"), reviewer("reviewer-a", "passed"), reviewer("reviewer-a", "passed"),
      reviewer("other-version-a", "passed", { version: 3 }), reviewer("other-version-b", "rejected", { version: 4 }),
      reviewer("other-content-a", "passed", { contentHash: hash("c") }),
      reviewer("other-content-b", "rejected", { contentHash: hash("d") }),
      reviewer("other-source-a", "passed", { sourceDigest: hash("c") }),
      reviewer("other-source-b", "rejected", { sourceDigest: hash("d") }),
    ]
    const result = conflicts(taskGraphReviewConflictObservation(nodes))

    expect(result).toEqual(conflicts(taskGraphReviewConflictObservation([...nodes].reverse())))
    expect(result).toEqual([{
      artifactId: "draft-1", version: 2,
      outcomes: [
        { taskId: "reviewer-a", reviewStatus: "passed" },
        { taskId: "reviewer-b", reviewStatus: "rejected" },
      ], truncated: false,
    }])
  })

  it("does not treat a duplicate task identity as two independent reviewers", () => {
    expect(taskGraphReviewConflictObservation([
      reviewer("same-task", "passed"), reviewer("same-task", "rejected"),
      reviewer("other-task", "passed"),
    ])).toEqual({})
    expect(taskGraphReviewConflictObservation([
      reviewer("first-task", "passed"), reviewer("second-task", "passed"),
    ])).toEqual({})
  })

  it("caps conflict groups deterministically", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => [
      reviewer(`reviewer-${index}-a`, "passed", { artifactId: `draft-${index}`, contentHash: hash(String(index + 1)) }),
      reviewer(`reviewer-${index}-b`, "rejected", { artifactId: `draft-${index}`, contentHash: hash(String(index + 1)) }),
    ]).flat()
    const result = conflicts(taskGraphReviewConflictObservation(nodes))

    expect(result).toHaveLength(4)
    expect(result.map(group => group.artifactId)).toEqual(["draft-0", "draft-1", "draft-2", "draft-3"])
    expect(conflicts(taskGraphReviewConflictObservation([...nodes].reverse()))).toEqual(result)
  })

  it.each([
    ["unfinished", reviewer("unfinished", "rejected", { taskStatus: "running" })],
    ["unavailable", reviewer("unavailable", "rejected", { availability: "unavailable" })],
    ["wrong role", reviewer("wrong-role", "rejected", { role: "writer" })],
    ["invalid status", reviewer("invalid-status", "rejected", { projectionPatch: { reviewStatus: "unknown" } })],
    ["malformed projection", reviewer("malformed", "rejected", { projectionPatch: { extra: "field" } })],
    ["malformed artifact", reviewer("bad-artifact", "rejected", { contentHash: "not-a-hash" })],
  ])("omits an %s projection from conflict detection", (_label, invalid) => {
    expect(taskGraphReviewConflictObservation([reviewer("valid", "passed"), invalid])).toEqual({})
  })

  it("truncates outcomes deterministically while retaining every distinct status", () => {
    const statuses: TaskGraphReviewStatus[] = ["passed", "needs_revision", "rejected", "stale"]
    const nodes = Array.from({ length: 12 }, (_, index) => reviewer(
      `reviewer-${String(index).padStart(2, "0")}`, statuses[index % statuses.length]!,
    ))
    const conflict = conflicts(taskGraphReviewConflictObservation(nodes))[0]!

    expect(conflict.outcomes).toHaveLength(8)
    expect(conflict.truncated).toBe(true)
    expect(new Set(conflict.outcomes.map(item => item.reviewStatus))).toEqual(new Set(statuses))
    expect(conflicts(taskGraphReviewConflictObservation([...nodes].reverse()))).toEqual([conflict])
  })

  it("omits whole groups when their complete field would exceed the UTF-8 byte budget", () => {
    const statuses: TaskGraphReviewStatus[] = ["passed", "needs_revision", "rejected", "stale"]
    const nodes = Array.from({ length: 4 }, (_, group) => Array.from({ length: 8 }, (_, index) => {
      const prefix = `g${group}-r${index}-`
      return reviewer(`${prefix}${"x".repeat(128 - prefix.length)}`, statuses[index % statuses.length]!, {
        artifactId: `draft-${group}`, contentHash: hash(String(group + 1)), sourceDigest: hash(String(group + 5)),
      })
    })).flat()
    const allGroups: TaskGraphReviewConflict[] = Array.from({ length: 4 }, (_, group) => ({
      artifactId: `draft-${group}`, version: 2,
      outcomes: Array.from({ length: 8 }, (_, index) => {
        const prefix = `g${group}-r${index}-`
        return { taskId: `${prefix}${"x".repeat(128 - prefix.length)}`, reviewStatus: statuses[index % statuses.length]! }
      }).sort((left, right) => left.reviewStatus.localeCompare(right.reviewStatus) || left.taskId.localeCompare(right.taskId)),
      truncated: false,
    }))
    expect(Buffer.byteLength(JSON.stringify({ reviewConflicts: allGroups }), "utf8")).toBeGreaterThan(4 * 1024)

    const included = conflicts(taskGraphReviewConflictObservation(nodes))
    expect(Buffer.byteLength(JSON.stringify({ reviewConflicts: included }), "utf8")).toBeLessThanOrEqual(4 * 1024)
    expect(included.length).toBeGreaterThan(1)
    expect(included.length).toBeLessThan(4)
    expect(included.every(group => group.outcomes.length === 8 && group.truncated === false)).toBe(true)
    expect(included.every(group => new Set(group.outcomes.map(item => item.reviewStatus)).size >= 2)).toBe(true)
  })

  it("counts multibyte task IDs as UTF-8 bytes and omits the whole overflowing group", () => {
    const statuses: TaskGraphReviewStatus[] = ["passed", "needs_revision", "rejected", "stale"]
    const nodes = Array.from({ length: 3 }, (_, group) => Array.from({ length: 8 }, (_, index) => {
      const taskId = `g${group}-r${index}-${"é".repeat(90)}`
      return reviewer(taskId, statuses[index % statuses.length]!, {
        artifactId: `draft-${group}`, contentHash: hash(String(group + 1)), sourceDigest: hash(String(group + 5)),
      })
    })).flat()
    const completeConflicts: TaskGraphReviewConflict[] = Array.from({ length: 3 }, (_, group) => ({
      artifactId: `draft-${group}`, version: 2,
      outcomes: Array.from({ length: 8 }, (_, index) => ({
        taskId: `g${group}-r${index}-${"é".repeat(90)}`, reviewStatus: statuses[index % statuses.length]!,
      })).sort((left, right) => left.reviewStatus < right.reviewStatus ? -1 : left.reviewStatus > right.reviewStatus ? 1
        : left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
      truncated: false,
    }))
    const completeField = JSON.stringify({ reviewConflicts: completeConflicts })
    expect(nodes.every(node => node.taskId.length <= 128 && node.taskId.trim() === node.taskId)).toBe(true)
    expect(completeField.length).toBeLessThanOrEqual(4 * 1024)
    expect(Buffer.byteLength(completeField, "utf8")).toBeGreaterThan(4 * 1024)

    const included = conflicts(taskGraphReviewConflictObservation(nodes))
    const includedField = JSON.stringify({ reviewConflicts: included })
    expect(Buffer.byteLength(includedField, "utf8")).toBeLessThanOrEqual(4 * 1024)
    expect(included.map(group => group.artifactId)).toEqual(["draft-0", "draft-1"])
    expect(included.every(group => group.outcomes.length === 8 && !group.truncated
      && new Set(group.outcomes.map(item => item.reviewStatus)).size === 4)).toBe(true)
  })

  it("keeps the new DTO closed and omits hashes and review prose", () => {
    const conflict = conflicts(taskGraphReviewConflictObservation([
      reviewer("reviewer-a", "passed"), reviewer("reviewer-b", "needs_revision"),
    ]))[0]!
    expect(Object.keys(conflict).sort()).toEqual(["artifactId", "outcomes", "truncated", "version"])
    expect(Object.keys(conflict.outcomes[0]!).sort()).toEqual(["reviewStatus", "taskId"])
    expect(JSON.stringify(conflict)).not.toContain("sha256:")
    expect(JSON.stringify(conflict)).not.toContain("reviewHash")
    expect(JSON.stringify(conflict)).not.toContain("artifactRef")
  })
})
