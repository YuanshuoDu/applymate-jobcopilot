import { describe, expect, it } from "vitest"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { buildTaskGraphFinalSummaryBinding, type TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA } from "./objective-tailor-final-summary-binding.js"
import { buildObjectiveTailorSourceGroups, objectiveTailorSourceGroupsValueMatches, readObjectiveTailorSourceGroups } from "./objective-tailor-source-groups.js"
import { buildTaskGraphFinalSidecars } from "./objective-tailor-final-sidecar.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"

type SourceSpec = Readonly<{ role: "scout" | "analyst"; status?: "completed" | "failed"; jobs?: readonly string[]; malformed?: boolean }>

function binding(specs: readonly SourceSpec[], historical?: ReadonlySet<number>): TaskGraphFinalSummaryBinding {
  const rootTaskId = "root-source-groups", graphRevision = 7
  const rows = specs.map((spec, index): GraphTaskRow => {
    const taskId = `source-task-${index}`, jobs = spec.jobs ?? []
    const structuredResult = spec.role === "scout"
      ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
        candidates: jobs.map((jobId, jobIndex) => ({ jobId, source: "fixture", url: null, evidenceIds: [`e-${index}-${jobIndex}`] })),
        evidence: jobs.map((jobId, jobIndex) => ({ id: `e-${index}-${jobIndex}`, kind: "job", ref: jobId, source: "fixture" })), summary: "fixture" }
      : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
        findings: jobs.map((jobId, jobIndex) => ({ jobId, score: 8 - jobIndex, evidenceIds: [`e-${index}-${jobIndex}`] })),
        evidence: jobs.map((jobId, jobIndex) => ({ id: `e-${index}-${jobIndex}`, kind: "job", ref: jobId, source: "fixture" })), summary: "fixture" }
    const result = spec.malformed ? { status: "completed", structuredResult: { malformed: true } } : spec.jobs === undefined ? null : { status: "completed", structuredResult }
    return { id: taskId, role: spec.role, taskType: spec.role === "scout" ? "job_discovery" : "job_analysis",
      status: spec.status ?? "completed", failureReason: spec.status === "failed" ? "fixture_failed" : null,
      result }
  })
  const loaded = {
    rootTaskId, item: { id: taskGraphItemId(rootTaskId), revision: graphRevision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: rows.map((row, index) => ({ taskId: row.id, key: `source-${index}`, templateId: row.role })) },
    state: { revision: graphRevision }, tasks: new Map(rows.map(row => [row.id, row])),
  } as unknown as LoadedGraph
  const base = buildTaskGraphFinalSummaryBinding(loaded, historical)
  if (!base) throw new Error("expected Objective binding")
  return { ...base, objectiveTailorFinalOutcome: { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
    graphRevision, rootAttemptCount: 1, graphDigest: "a".repeat(64), sourceNodeCount: specs.length,
    sourceGraphDigest: "b".repeat(64), sourceStatusDigest: "c".repeat(64),
    slots: [{ ordinal: 1, status: "ready", evidenceDigest: "d".repeat(64) }] } }
}

function sourceKeys(value: TaskGraphFinalSummaryBinding): readonly string[] {
  const manifest = buildTaskGraphFinalSourceManifest(value, "final-source-groups")
  if (!manifest) throw new Error("expected source manifest")
  return manifest.sources.map(source => source.sourceKey)
}

describe("Objective Tailor source groups", () => {
  it("deduplicates reducer facts and emits current sources in graph order", () => {
    const value = binding([{ role: "scout", jobs: ["job-a", "job-a", "job-b"] }, { role: "analyst", jobs: ["job-a", "job-a"] }])
    const groups = buildObjectiveTailorSourceGroups(value, "final-source-groups")
    const keys = sourceKeys(value)
    expect(groups?.groups).toEqual({ discoveredJobs: [keys[0]], analyzedJobs: [keys[1]] })
    expect(groups?.graphRevision).toBe(7)
    const repeatedBase = binding([{ role: "scout", jobs: ["job-a"] }, { role: "analyst", jobs: ["job-a", "job-b"] }])
    const repeatedScore = { ...repeatedBase, summary: { ...repeatedBase.summary, analyzedJobs: repeatedBase.summary.analyzedJobs.map(row => ({
      ...row, findings: row.findings.map(finding => ({ ...finding, score: 8 })) })) } }
    expect(buildObjectiveTailorSourceGroups(repeatedScore, "final-source-groups")).toBeDefined()
    const sidecars = buildTaskGraphFinalSidecars(value, "final-source-groups")
    expect(sidecars?.objectiveTailorSourceGroups).toEqual(groups)
    expect(JSON.stringify(sidecars)).not.toContain("source-task-")
  })

  it("omits zero-contribution and failed current sources while retaining a valid partial source", () => {
    const value = binding([{ role: "scout", malformed: true }, { role: "scout", status: "failed" },
      { role: "scout", jobs: ["job-a"] }, { role: "analyst", jobs: ["job-a"] }])
    const groups = buildObjectiveTailorSourceGroups(value, "final-source-groups")
    const keys = sourceKeys(value)
    expect(groups?.groups.discoveredJobs).toEqual([keys[2]])
    expect(groups?.groups.analyzedJobs).toEqual([keys[3]])
    for (const [jobId, taskId] of [["forged-invalid", "source-task-0"], ["forged-failed", "source-task-1"]]) {
      const forged = { ...value, summary: { ...value.summary,
        counts: { ...value.summary.counts, discoveredJobs: { knownCount: 2, coverage: "partial" as const } },
        discoveredJobs: [...value.summary.discoveredJobs, { jobId, taskIds: [taskId] }] } }
      expect(() => buildObjectiveTailorSourceGroups(forged, "final-source-groups")).toThrow()
    }
  })

  it("excludes historical sources and rejects forged references to excluded members", () => {
    const value = binding([{ role: "scout", jobs: ["job-a"] }, { role: "analyst", jobs: ["job-a"] }, { role: "scout", jobs: ["job-a"] }], new Set([1]))
    const groups = buildObjectiveTailorSourceGroups(value, "final-source-groups")
    const keys = sourceKeys(value)
    expect(groups?.groups).toEqual({ discoveredJobs: [keys[0], keys[1]], analyzedJobs: [] })

    const forged = { ...value, summary: { ...value.summary,
      counts: { ...value.summary.counts, discoveredJobs: { knownCount: 2, coverage: "complete" as const } },
      discoveredJobs: [...value.summary.discoveredJobs, { jobId: "job-forged", taskIds: ["source-task-1"] }] } }
    expect(() => buildObjectiveTailorSourceGroups(forged, "final-source-groups")).toThrow()
  })

  it("fails closed on invalid source membership, revision, and item-bound keys", () => {
    const value = binding([{ role: "scout", jobs: ["job-a"] }, { role: "analyst", jobs: ["job-a"] }])
    const groups = buildObjectiveTailorSourceGroups(value, "final-source-groups")!
    expect(readObjectiveTailorSourceGroups(value, "final-source-groups")).toEqual({ status: "ready", groups })
    const read = readObjectiveTailorSourceGroups(value, "final-source-groups")
    expect(objectiveTailorSourceGroupsValueMatches(read, groups)).toBe(true)
    expect(objectiveTailorSourceGroupsValueMatches(readObjectiveTailorSourceGroups(value, "other-final"), groups)).toBe(false)
    expect(objectiveTailorSourceGroupsValueMatches(read, { ...groups, graphRevision: 8 })).toBe(false)
    expect(objectiveTailorSourceGroupsValueMatches(read, { ...groups,
      groups: { ...groups.groups, discoveredJobs: ["src_" + "A".repeat(43)] } })).toBe(false)
    const { objectiveTailorFinalOutcome: _outcome, ...ordinary } = value
    expect(readObjectiveTailorSourceGroups(ordinary, "final-source-groups")).toEqual({ status: "absent" })
  })
})
