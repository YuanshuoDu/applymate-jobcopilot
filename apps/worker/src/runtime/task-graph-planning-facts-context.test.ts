import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import { withTaskGraphCurrentPlanningObservation } from "./canonical-turn-task-graph-capacity.js"
import {
  projectTaskGraphPlanningCounts,
  projectTaskGraphPlanningScoutOverlap,
  withTaskGraphPlanningCounts,
  withTaskGraphPlanningScoutOverlap,
} from "./task-graph-planning-facts-context.js"

const counts = {
  discoveredJobs: { knownCount: 8, coverage: "complete" },
  analyzedJobs: { knownCount: 3, coverage: "partial" },
  prepareJobs: { knownCount: 2, coverage: "partial" },
  artifactReferences: { knownCount: null, coverage: "unavailable" },
  reviewOutcomes: { knownCount: null, coverage: "not_requested" },
}
const facts = { graphRevision: 7, counts }

function scoutNode(key: string, status: TaskGraphCurrentNode["status"] = "completed"): TaskGraphCurrentNode {
  return {
    key, templateId: "scout", goal: "Find candidates", successCriteria: ["Return candidates"], dependsOn: [],
    taskId: `private-task-${key}`, status, readiness: "terminal", resultSummary: null, failureReason: null,
  }
}

function scoutRow(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key, taskStatus: "completed", resultStatus: "completed", resultCoverage: "complete",
    reportedCount: 2, sharedCount: 1, ...overrides,
  }
}

describe("projectTaskGraphPlanningCounts", () => {
  it("returns fresh counts only when the facts revision matches", () => {
    const projected = projectTaskGraphPlanningCounts(facts, 7)

    expect(projected).toEqual(counts)
    expect(projected).not.toBe(counts)
    expect(projected?.discoveredJobs).not.toBe(counts.discoveredJobs)
    expect(Object.keys(projected ?? {})).toEqual([
      "discoveredJobs", "analyzedJobs", "prepareJobs", "artifactReferences", "reviewOutcomes",
    ])
  })

  it("projects valid Prepare counts", () => {
    const prepareCounts = { ...counts, prepareJobs: { knownCount: 5, coverage: "complete" as const } }

    expect(projectTaskGraphPlanningCounts({ graphRevision: 7, counts: prepareCounts }, 7)).toEqual(prepareCounts)
  })

  it.each([
    ["partial Prepare without a known count", { knownCount: null, coverage: "partial" }],
    ["unknown Prepare coverage", { knownCount: 1, coverage: "scheduled" }],
    ["extra Prepare count key", { knownCount: 1, coverage: "complete", taskIds: ["private-task"] }],
  ])("omits %s", (_label, prepareJobs) => {
    const malformed = { ...facts, counts: { ...counts, prepareJobs } }

    expect(projectTaskGraphPlanningCounts(malformed, 7)).toBeNull()
  })

  it("preserves valid empty-role and zero-result semantics", () => {
    const empty = {
      graphRevision: 7,
      counts: {
        discoveredJobs: { knownCount: 0, coverage: "complete" },
        analyzedJobs: { knownCount: 0, coverage: "partial" },
        prepareJobs: { knownCount: 0, coverage: "complete" },
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
      prepareJobs: { knownCount: Number.MAX_SAFE_INTEGER, coverage: "complete" },
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

describe("projectTaskGraphPlanningScoutOverlap", () => {
  it("projects distinct report overlap by current Scout node key without exposing identifiers", () => {
    const overlap = {
      coverage: "complete",
      scouts: [scoutRow("scout-a"), scoutRow("scout-b", { reportedCount: 3, sharedCount: 2 })],
    }
    const projected = projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: overlap }, 7, [scoutNode("scout-a"), scoutNode("scout-b")])

    expect(projected).toEqual({
      coverage: "complete",
      scouts: [
        { key: "scout-a", taskStatus: "completed", resultCoverage: "complete", reportedCount: 2, sharedCount: 1 },
        { key: "scout-b", taskStatus: "completed", resultCoverage: "complete", reportedCount: 3, sharedCount: 2 },
      ],
    })
    expect(JSON.stringify(projected)).not.toMatch(/jobId|taskId|private-task/)
  })

  it("keeps valid completed-empty, partial, unavailable, and no-Scout states distinct", () => {
    const empty = { coverage: "complete", scouts: [scoutRow("empty", { reportedCount: 0, sharedCount: 0 })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: empty }, 7, [scoutNode("empty")])?.scouts[0])
      .toMatchObject({ resultCoverage: "complete", reportedCount: 0, sharedCount: 0 })

    const partial = { coverage: "partial", scouts: [scoutRow("partial", { resultStatus: "partial", resultCoverage: "partial", reportedCount: 2, sharedCount: 0 })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: partial }, 7, [scoutNode("partial")])?.scouts[0])
      .toMatchObject({ taskStatus: "completed", resultCoverage: "partial", reportedCount: 2 })

    const unavailable = { coverage: "unavailable", scouts: [scoutRow("failed", {
      taskStatus: "failed", resultStatus: null, resultCoverage: "unavailable", reportedCount: null, sharedCount: null,
    })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: unavailable }, 7, [scoutNode("failed", "failed")]))
      .toMatchObject({ coverage: "unavailable", scouts: [{ taskStatus: "failed", resultCoverage: "unavailable", reportedCount: null }] })

    const notRequested = { coverage: "not_requested", scouts: [] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: notRequested }, 7, [])).toEqual(notRequested)
  })

  it("marks nonterminal results unavailable and requires lifecycle and result coverage to agree", () => {
    const unavailable = { coverage: "unavailable", scouts: [scoutRow("running", {
      taskStatus: "running", resultStatus: null, resultCoverage: "unavailable", reportedCount: null, sharedCount: null,
    })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: unavailable }, 7, [scoutNode("running", "running")]))
      .toMatchObject({ coverage: "unavailable" })
    const invented = { coverage: "complete", scouts: [scoutRow("running", { taskStatus: "running" })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: invented }, 7, [scoutNode("running", "running")])).toBeNull()

    const terminalButFailed = { coverage: "partial", scouts: [scoutRow("failed", { taskStatus: "failed" })] }
    expect(projectTaskGraphPlanningScoutOverlap({ ...facts, scoutOverlap: terminalButFailed }, 7, [scoutNode("failed", "failed")]))
      .toMatchObject({ coverage: "partial", scouts: [{ resultCoverage: "complete", reportedCount: 2 }] })
  })

  it.each([
    ["stale revision", { ...facts, graphRevision: 6, scoutOverlap: { coverage: "complete", scouts: [scoutRow("scout-a")] } }, [scoutNode("scout-a")]],
    ["duplicate key", { ...facts, scoutOverlap: { coverage: "complete", scouts: [scoutRow("scout-a"), scoutRow("scout-a")] } }, [scoutNode("scout-a"), scoutNode("scout-b")]],
    ["unbound key", { ...facts, scoutOverlap: { coverage: "complete", scouts: [scoutRow("private-task-id")] } }, [scoutNode("scout-a")]],
    ["mismatched task status", { ...facts, scoutOverlap: { coverage: "complete", scouts: [scoutRow("scout-a", { taskStatus: "failed" })] } }, [scoutNode("scout-a")]],
    ["negative count", { ...facts, scoutOverlap: { coverage: "complete", scouts: [scoutRow("scout-a", { sharedCount: -1 })] } }, [scoutNode("scout-a")]],
    ["shared exceeds reported", { ...facts, scoutOverlap: { coverage: "complete", scouts: [scoutRow("scout-a", { reportedCount: 1, sharedCount: 2 })] } }, [scoutNode("scout-a")]],
    ["raw IDs in row", { ...facts, scoutOverlap: { coverage: "complete", scouts: [{ ...scoutRow("scout-a"), jobIds: ["private-job"] }] } }, [scoutNode("scout-a")]],
    ["invalid outer coverage", { ...facts, scoutOverlap: { coverage: "unavailable", scouts: [scoutRow("scout-a")] } }, [scoutNode("scout-a")]],
  ])("omits %s overlap", (_label, input, nodes) => {
    expect(projectTaskGraphPlanningScoutOverlap(input, 7, nodes as TaskGraphCurrentNode[])).toBeNull()
  })

  it("keeps valid counts when the optional overlap is malformed or stale", () => {
    const malformed = { ...facts, scoutOverlap: { coverage: "complete", scouts: [] } }
    expect(projectTaskGraphPlanningCounts(malformed, 7)).toEqual(counts)
    expect(projectTaskGraphPlanningScoutOverlap(malformed, 7, [scoutNode("scout-a")])).toBeNull()
  })
})

describe("withTaskGraphPlanningScoutOverlap", () => {
  it("omits only overlap on budget overflow, preserving projected counts and capacity", () => {
    const nodes = [scoutNode("scout-a")]
    const overlap = { coverage: "complete", scouts: [scoutRow("scout-a")] }
    const base = { kind: "task_graph_current", revision: 7, nodes: ["x".repeat(1_000)] }
    const full = withTaskGraphCurrentPlanningObservation(base, { ...facts, scoutOverlap: overlap }, 7, nodes, 10_000)
    const noOverlap = { ...full }
    Reflect.deleteProperty(noOverlap, "taskReportedScoutOverlap")
    const budget = JSON.stringify(full).length - 1

    expect(JSON.stringify(noOverlap).length).toBeLessThanOrEqual(budget)
    const bounded = withTaskGraphCurrentPlanningObservation(base, { ...facts, scoutOverlap: overlap }, 7, nodes, budget)
    expect(bounded).toHaveProperty("taskReportedCounts")
    expect(bounded).toHaveProperty("nodeCapacity")
    expect(bounded).not.toHaveProperty("taskReportedScoutOverlap")
  })
})
