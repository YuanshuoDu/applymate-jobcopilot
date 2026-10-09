import { describe, expect, it } from "vitest"
import { projectTaskGraphPlanningCounts, withTaskGraphPlanningCounts } from "./task-graph-planning-facts-context.js"

const counts = {
  discoveredJobs: { knownCount: 8, coverage: "complete" },
  analyzedJobs: { knownCount: 3, coverage: "partial" },
  artifactReferences: { knownCount: null, coverage: "unavailable" },
  reviewOutcomes: { knownCount: null, coverage: "not_requested" },
}
const facts = { graphRevision: 7, counts }

describe("projectTaskGraphPlanningCounts", () => {
  it("returns fresh counts only when the facts revision matches", () => {
    const projected = projectTaskGraphPlanningCounts(facts, 7)

    expect(projected).toEqual(counts)
    expect(projected).not.toBe(counts)
    expect(projected?.discoveredJobs).not.toBe(counts.discoveredJobs)
    expect(Object.keys(projected ?? {})).toEqual([
      "discoveredJobs", "analyzedJobs", "artifactReferences", "reviewOutcomes",
    ])
  })

  it("preserves valid empty-role and zero-result semantics", () => {
    const empty = {
      graphRevision: 7,
      counts: {
        discoveredJobs: { knownCount: 0, coverage: "complete" },
        analyzedJobs: { knownCount: 0, coverage: "partial" },
        artifactReferences: { knownCount: null, coverage: "not_requested" },
        reviewOutcomes: { knownCount: null, coverage: "unavailable" },
      },
    }

    expect(projectTaskGraphPlanningCounts(empty, 7)).toEqual(empty.counts)
  })

  it.each([
    ["missing facts", undefined, 7],
    ["null facts", null, 7],
    ["stale revision", { ...facts, graphRevision: 6 }, 7],
    ["unsafe revision", { ...facts, graphRevision: Number.MAX_SAFE_INTEGER + 1 }, 7],
    ["unsafe current revision", facts, Number.MAX_SAFE_INTEGER + 1],
    ["extra envelope key", { ...facts, taskIds: ["private-task"] }, 7],
    ["extra count category", { ...facts, counts: { ...counts, taskIds: ["private-task"] } }, 7],
    ["extra count key", { ...facts, counts: { ...counts, discoveredJobs: { ...counts.discoveredJobs, hash: "private-hash" } } }, 7],
    ["partial without known count", { ...facts, counts: { ...counts, analyzedJobs: { knownCount: null, coverage: "partial" } } }, 7],
    ["unavailable with invented count", { ...facts, counts: { ...counts, artifactReferences: { knownCount: 0, coverage: "unavailable" } } }, 7],
    ["negative count", { ...facts, counts: { ...counts, discoveredJobs: { knownCount: -1, coverage: "complete" } } }, 7],
    ["unsafe count", { ...facts, counts: { ...counts, discoveredJobs: { knownCount: Number.MAX_SAFE_INTEGER + 1, coverage: "complete" } } }, 7],
    ["array envelope", [], 7],
    ["class instance", new Date(), 7],
  ])("omits %s", (_label, value, revision) => {
    expect(projectTaskGraphPlanningCounts(value, revision)).toBeNull()
  })

  it("omits symbol-augmented facts", () => {
    const augmented = { ...facts, [Symbol("private")]: "hidden" }

    expect(projectTaskGraphPlanningCounts(augmented, 7)).toBeNull()
  })

  it("never invokes getters while validating facts", () => {
    let getterRead = false
    const unsafeCount = Object.defineProperty({}, "knownCount", {
      enumerable: true,
      get() {
        getterRead = true
        return 1
      },
    })
    Object.defineProperty(unsafeCount, "coverage", { enumerable: true, value: "complete" })
    const unsafe = { ...facts, counts: { ...counts, discoveredJobs: unsafeCount } }

    expect(projectTaskGraphPlanningCounts(unsafe, 7)).toBeNull()
    expect(getterRead).toBe(false)
  })

  it("rejects proxies and keeps the rebuilt aggregate under 1000 characters", () => {
    const proxied = new Proxy(facts, { getPrototypeOf: () => Object.prototype })

    expect(projectTaskGraphPlanningCounts(proxied, 7)).toBeNull()
    const largestCounts = {
      discoveredJobs: { knownCount: Number.MAX_SAFE_INTEGER, coverage: "complete" },
      analyzedJobs: { knownCount: Number.MAX_SAFE_INTEGER, coverage: "partial" },
      artifactReferences: { knownCount: null, coverage: "unavailable" },
      reviewOutcomes: { knownCount: null, coverage: "not_requested" },
    }
    const projected = projectTaskGraphPlanningCounts({ graphRevision: 7, counts: largestCounts }, 7)

    expect(projected).toEqual(largestCounts)
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(projected)).not.toContain("taskId")
    expect(JSON.stringify(projected)).not.toContain("private-hash")
  })
})

describe("withTaskGraphPlanningCounts", () => {
  it("omits only the optional aggregate when it would exceed the observation budget", () => {
    const maxChars = 160_000
    const emptyBase = { kind: "task_graph_current", revision: 7, nodes: [""] }
    const baseContent = { ...emptyBase, nodes: ["x".repeat(maxChars - JSON.stringify(emptyBase).length)] }
    const baseLength = JSON.stringify(baseContent).length
    const projected = projectTaskGraphPlanningCounts(facts, 7)!
    const withCountsLength = JSON.stringify({ ...baseContent, taskReportedCounts: projected }).length

    expect(baseLength).toBe(maxChars)
    expect(withCountsLength).toBeGreaterThan(maxChars)
    expect(withTaskGraphPlanningCounts(baseContent, projected, maxChars)).toBe(baseContent)
    const oversizedBase = { ...emptyBase, nodes: ["x".repeat(maxChars - JSON.stringify(emptyBase).length + 1)] }
    expect(withTaskGraphPlanningCounts(oversizedBase, projected, maxChars)).toBe(oversizedBase)
  })

  it("includes fresh counts when the aggregate fits and leaves null facts byte-equivalent", () => {
    const baseContent = { kind: "task_graph_current", revision: 7, nodes: [] }
    const projected = projectTaskGraphPlanningCounts(facts, 7)!
    const complete = withTaskGraphPlanningCounts(baseContent, projected, 1_000)

    expect(complete).toEqual({ ...baseContent, taskReportedCounts: projected })
    expect(withTaskGraphPlanningCounts(baseContent, null, 1_000)).toBe(baseContent)
  })
})
