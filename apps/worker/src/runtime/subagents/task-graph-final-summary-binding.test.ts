import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import {
  buildTaskGraphFinalSummaryBinding,
  readResolvedRepairTaskIds,
  sameTaskGraphFinalSummaryBinding,
  TASK_GRAPH_FINAL_SUMMARY_BINDING,
} from "./task-graph-final-summary-binding.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const scoutResult = (jobId: string) => ({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "scout",
  status: "completed",
  candidates: [{ jobId, source: "greenhouse", url: "https://private.test/job", evidenceIds: ["evidence-job"] }],
  evidence: [{ id: "evidence-job", kind: "job", ref: jobId, source: "private-source" }],
  summary: "PRIVATE_ROLE_NARRATIVE",
})
const analystResult = (jobId: string) => ({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: "analyst",
  status: "completed",
  findings: [{ jobId, score: 8, evidenceIds: ["evidence-job"] }],
  evidence: [{ id: "evidence-job", kind: "job", ref: jobId, source: "private-source" }],
  summary: "PRIVATE_ANALYST_NARRATIVE",
})

function row(id: string, role: string, taskType: string, result: unknown, attemptCount?: number): GraphTaskRow {
  return { id, role, taskType, status: "completed", failureReason: null, result,
    ...(attemptCount === undefined ? {} : { attemptCount }) }
}
function failedRow(id: string, role: string, taskType: string): GraphTaskRow {
  return { ...row(id, role, taskType, null), status: "failed", failureReason: "task_graph_verification_failed" }
}

function graph(revision: number, nodeIds: readonly string[], rows: readonly GraphTaskRow[], stateRevision = revision): LoadedGraph {
  const taskTypes = new Map(rows.map(task => [task.id, task.taskType ?? "task"]))
  return {
    rootTaskId: "root-task",
    item: { id: "task-graph:root-task", revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: nodeIds.map((taskId, nodeIndex) => ({ taskId, key: `node-${nodeIndex}`,
      templateId: taskTypes.get(taskId) === "job_discovery" ? "scout" : taskTypes.get(taskId) ?? "task" })) } as unknown as TaskGraphSnapshot,
    state: { revision: stateRevision } as LoadedGraph["state"],
    tasks: new Map(rows.map(task => [task.id, task])),
  } as LoadedGraph
}

describe("current TaskGraph final-summary binding", () => {
  it("reduces only latest snapshot members using scoped rows and nested structured results", () => {
    const loaded = graph(8, ["scout-current", "native-control", "unknown-role"], [
      row("scout-current", "scout", "research", JSON.stringify({ status: "completed", structuredResult: scoutResult("job-current"), finalText: "PRIVATE_FINAL_TEXT" })),
      row("native-control", "auditor", "native_verification", { structuredResult: scoutResult("control-job") }),
      row("unknown-role", "unknown_role", "custom", { structuredResult: { private: "not a role result" } }),
      row("history-only", "scout", "research", { structuredResult: scoutResult("old-job") }),
    ])

    const binding = buildTaskGraphFinalSummaryBinding(loaded)
    expect(binding?.graphRevision).toBe(8)
    expect(binding?.summary.counts.discoveredJobs).toEqual({ knownCount: 1, coverage: "complete" })
    expect(binding?.summary.discoveredJobs.map(item => item.jobId)).toEqual(["job-current"])
    expect(binding?.summary.taskOutcomes.map(item => item.taskId)).toEqual(["scout-current", "unknown-role"])
    expect(binding?.summary.taskOutcomes[1]?.resultState).toBe("unsupported_role")
    expect(binding?.members).toEqual([
      { nodeIndex: 0, nodeKey: "node-0", templateId: "research", taskId: "scout-current", role: "scout", taskType: "research", taskStatus: "completed", kind: "business" },
      { nodeIndex: 1, nodeKey: "node-1", templateId: "native_verification", taskId: "native-control", role: "auditor", taskType: "native_verification", taskStatus: "completed", kind: "internal_control" },
      { nodeIndex: 2, nodeKey: "node-2", templateId: "custom", taskId: "unknown-role", role: "unknown_role", taskType: "custom", taskStatus: "completed", kind: "business" },
    ])
    expect(JSON.stringify(binding)).not.toContain("PRIVATE_ROLE_NARRATIVE")
    expect(JSON.stringify(binding)).not.toContain("PRIVATE_FINAL_TEXT")
    expect(JSON.stringify(binding)).not.toContain("control-job")
    expect(JSON.stringify(binding)).not.toContain("old-job")
  })

  it("keeps historical Scout and Analyst members private while reducing current rows at original indices", () => {
    const loaded = graph(8, ["old-scout", "current-analyst", "old-analyst", "current-scout"], [
      row("old-scout", "scout", "scout", { status: "completed", structuredResult: scoutResult("old-job") }),
      row("current-analyst", "analyst", "analyst", { status: "completed", structuredResult: analystResult("current-job") }),
      row("old-analyst", "analyst", "analyst", { status: "completed", structuredResult: { ...analystResult("old-job"), status: "partial" } }),
      row("current-scout", "scout", "scout", { status: "completed", structuredResult: scoutResult("current-job") }),
    ])
    const binding = buildTaskGraphFinalSummaryBinding(loaded, new Set([0, 2]))!

    expect(binding.members?.map(member => [member.nodeIndex, member.kind])).toEqual([
      [0, "historical"], [1, "business"], [2, "historical"], [3, "business"],
    ])
    expect(binding.summary.discoveredJobs).toEqual([{ jobId: "current-job", taskIds: ["current-scout"] }])
    expect(binding.summary.analyzedJobs).toEqual([{ jobId: "current-job", findings: [{ taskId: "current-analyst", score: 8 }] }])
    expect(binding.summary.taskOutcomes.map(outcome => outcome.taskId)).toEqual(["current-analyst", "current-scout"])
    expect(JSON.stringify(binding)).not.toMatch(/old-job|PRIVATE_ROLE_NARRATIVE|PRIVATE_ANALYST_NARRATIVE/)
  })

  it("binds an interrupted Scout as private retirement metadata and excludes its result from reduction", () => {
    const interrupted = { ...row("retired-scout", "scout", "job_discovery", { structuredResult: scoutResult("retired-job") }),
      status: "interrupted" as const, failureReason: "Subagent task subtree was interrupted", attemptCount: 2 }
    const loaded = graph(9, ["retired-scout", "current-scout"], [interrupted,
      row("current-scout", "scout", "job_discovery", { structuredResult: scoutResult("current-job") })])
    const proof = { nodeKey: "node-0", taskId: "retired-scout", attempt: 2, interruptRequestedAt: "2026-11-19T10:00:00.000Z",
      receiptEventId: "private-retirement-event", lifecycleEventId: "private-interrupted-event" }
    const binding = buildTaskGraphFinalSummaryBinding(loaded, undefined, new Map([[proof.nodeKey, proof]]))!

    expect(binding.members?.map(member => member.kind)).toEqual(["retired", "business"])
    expect(binding.members?.[0]).toMatchObject({ kind: "retired", taskStatus: "interrupted", retirement: {
      attempt: 2, interruptRequestedAt: proof.interruptRequestedAt,
      receiptEventId: proof.receiptEventId, lifecycleEventId: proof.lifecycleEventId,
    } })
    expect(binding.summary.discoveredJobs).toEqual([{ jobId: "current-job", taskIds: ["current-scout"] }])
    expect(binding.summary.taskOutcomes.map(item => item.taskId)).toEqual(["current-scout"])
    expect(JSON.stringify(binding.summary)).not.toMatch(/retired-scout|retired-job|private-retirement-event|private-interrupted-event/)
  })

  it("rejects a retirement that does not match the exact interrupted Scout attempt", () => {
    const interrupted = { ...row("retired-scout", "scout", "job_discovery", { structuredResult: scoutResult("retired-job") }),
      status: "interrupted" as const, attemptCount: 2 }
    const loaded = graph(9, ["retired-scout"], [interrupted])
    const proof = { nodeKey: "node-0", taskId: "retired-scout", attempt: 1, interruptRequestedAt: "2026-11-19T10:00:00.000Z",
      receiptEventId: "receipt-event", lifecycleEventId: "ack-event" }
    expect(() => buildTaskGraphFinalSummaryBinding(loaded, undefined, new Map([[proof.nodeKey, proof]])))
      .toThrow("task_graph_final_summary_retired_selection_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(loaded, undefined, new Map([["unknown-node", { ...proof, nodeKey: "unknown-node" }]])))
      .toThrow("task_graph_final_summary_retired_selection_invalid")
  })

  it("rejects invalid, unsupported, stale, and all-historical selections", () => {
    const validScout = graph(4, ["historical-scout"], [
      row("historical-scout", "scout", "scout", { status: "completed", structuredResult: scoutResult("old-job") }),
    ])
    const unsupported = graph(4, ["unsupported"], [row("unsupported", "odd-role", "scout", { status: "completed", structuredResult: scoutResult("old-job") })])
    const staleRole = graph(4, ["stale-role"], [row("stale-role", "scout", "scout", { status: "completed", structuredResult: analystResult("old-job") })])
    const staleStatusTask = { ...row("stale-status", "scout", "scout", { status: "completed", structuredResult: scoutResult("old-job") }), status: "failed" as const }
    const staleStatus = graph(4, ["stale-status"], [staleStatusTask])
    const wrongTemplate = graph(4, ["wrong-template"], [row("wrong-template", "scout", "research", { status: "completed", structuredResult: scoutResult("old-job") })])

    for (const index of [-1, 0.5, 1]) expect(() => buildTaskGraphFinalSummaryBinding(validScout, new Set([index])))
      .toThrow("task_graph_final_summary_historical_selection_invalid")
    for (const candidate of [unsupported, staleRole, staleStatus, wrongTemplate]) expect(() => buildTaskGraphFinalSummaryBinding(candidate, new Set([0])))
      .toThrow("task_graph_final_summary_historical_selection_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(validScout, new Set([0])))
      .toThrow("task_graph_final_summary_historical_selection_invalid")
  })

  it("keeps no-graph legacy calls unbound and rejects inconsistent current graph scope", () => {
    const absent = { rootTaskId: "root-task", item: null, snapshot: null, state: null, tasks: new Map() } as LoadedGraph
    expect(buildTaskGraphFinalSummaryBinding(absent)).toBeNull()
    expect(() => buildTaskGraphFinalSummaryBinding({ ...graph(3, [], []), state: null }))
      .toThrow("task_graph_final_summary_graph_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(graph(3, ["missing"], [])))
      .toThrow("task_graph_final_summary_task_scope_invalid")
    expect(() => buildTaskGraphFinalSummaryBinding(graph(3, [], [], 2)))
      .toThrow("task_graph_final_summary_graph_invalid")
  })

  it("binds an eleven-node persisted graph and rejects a twelfth node", () => {
    const taskIds = Array.from({ length: 11 }, (_, index) => `scheduled-task-${index}`)
    const rows = taskIds.map(taskId => row(taskId, "executor", "scheduled_execute", null))
    expect(buildTaskGraphFinalSummaryBinding(graph(9, taskIds, rows))?.members).toHaveLength(11)
    expect(() => buildTaskGraphFinalSummaryBinding(graph(9, [...taskIds, "scheduled-overflow"], [
      ...rows, row("scheduled-overflow", "executor", "scheduled_execute", null),
    ]))).toThrow("task_graph_final_summary_graph_invalid")
  })

  it("preserves the reducer's specific error for duplicate current task identities", () => {
    const duplicate = graph(3, ["scout", "scout"], [row("scout", "scout", "research", {})])
    expect(() => buildTaskGraphFinalSummaryBinding(duplicate))
      .toThrow("task_graph_final_summary_task_identity_conflict")
  })

  it("compares revision and full facts, including same-count result changes", () => {
    const first = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!
    const sameFacts = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!
    const sameCountDifferentFact = buildTaskGraphFinalSummaryBinding(graph(4, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-b") }),
    ]))!
    const changedRevision = buildTaskGraphFinalSummaryBinding(graph(5, ["scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
    ]))!

    expect(sameTaskGraphFinalSummaryBinding(first, sameFacts)).toBe(true)
    expect(sameTaskGraphFinalSummaryBinding(first, sameCountDifferentFact)).toBe(false)
    expect(sameTaskGraphFinalSummaryBinding(first, changedRevision)).toBe(false)
  })

  it("binds hidden controls and exact graph membership even when the public summary is unchanged", () => {
    const first = buildTaskGraphFinalSummaryBinding(graph(4, ["scout", "control-a"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
      row("control-a", "auditor", "native_verification", {}),
    ]))!
    const changedControl = buildTaskGraphFinalSummaryBinding(graph(4, ["scout", "control-b"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
      row("control-b", "auditor", "native_verification", {}),
    ]))!
    const reordered = buildTaskGraphFinalSummaryBinding(graph(4, ["control-a", "scout"], [
      row("scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
      row("control-a", "auditor", "native_verification", {}),
    ]))!

    expect(changedControl.summary).toEqual(first.summary)
    expect(reordered.summary).toEqual(first.summary)
    expect(sameTaskGraphFinalSummaryBinding(first, changedControl)).toBe(false)
    expect(sameTaskGraphFinalSummaryBinding(first, reordered)).toBe(false)
  })

  it("normalizes resolution metadata to current failed business members and binds it for freshness", () => {
    const loaded = graph(4, ["failed-scout", "completed-scout", "control"], [
      failedRow("failed-scout", "scout", "research"),
      row("completed-scout", "scout", "research", { structuredResult: scoutResult("job-a") }),
      row("control", "auditor", "native_verification", {}),
    ])
    const resolved = buildTaskGraphFinalSummaryBinding(loaded, undefined, new Set(["missing", "control", "completed-scout", "failed-scout"]))!
    const unresolved = buildTaskGraphFinalSummaryBinding(loaded)!
    const stale = { ...resolved, members: resolved.members?.map(member => member.taskId === "failed-scout"
      ? { ...member, taskStatus: "completed" as const } : member) }

    expect(resolved.resolvedRepairTaskIds).toEqual(["failed-scout"])
    expect(readResolvedRepairTaskIds(resolved)).toEqual(new Set(["failed-scout"]))
    expect(readResolvedRepairTaskIds(stale)).toEqual(new Set())
    expect(sameTaskGraphFinalSummaryBinding(resolved, unresolved)).toBe(false)
    expect(sameTaskGraphFinalSummaryBinding(resolved, stale)).toBe(false)
  })

  it("binds Prepare results to the persisted task attempt", () => {
    const result = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed",
      taskId: "prepare-task", attemptCount: 2, snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64),
      jobs: [{ jobId: "job-a", status: "prepared" }],
      materials: [{ jobId: "job-a", kind: "resume", artifactRef: {
        artifactId: "resume-a", version: 1, contentHash: `sha256:${"c".repeat(64)}`, sourceDigest: `sha256:${"d".repeat(64)}`,
      } }],
    }
    const matching = buildTaskGraphFinalSummaryBinding(graph(6, ["prepare-task"], [
      row("prepare-task", "prepare", "scheduled_application_prepare", { status: "completed", structuredResult: result }, 2),
    ]))
    const stale = buildTaskGraphFinalSummaryBinding(graph(6, ["prepare-task"], [
      row("prepare-task", "prepare", "scheduled_application_prepare", { status: "completed", structuredResult: { ...result, attemptCount: 1 } }, 2),
    ]))

    expect(matching?.summary.prepareResults[0]?.attemptCount).toBe(2)
    expect(matching?.summary.taskOutcomes[0]?.resultState).toBe("valid")
    expect(stale?.summary.prepareResults).toEqual([])
    expect(stale?.summary.taskOutcomes[0]?.resultState).toBe("invalid")
  })

  it("uses an enumerable private symbol that survives spread but not JSON serialization", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph(2, [], []))!
    const carrier = { [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
    expect(Object.getOwnPropertyDescriptor(carrier, TASK_GRAPH_FINAL_SUMMARY_BINDING)?.enumerable).toBe(true)
    expect({ ...carrier }[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toBe(binding)
    expect(Object.keys(carrier)).toEqual([])
    expect(JSON.stringify(carrier)).toBe("{}")
  })
})
