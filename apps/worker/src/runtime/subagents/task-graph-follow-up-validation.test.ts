import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA, type ArtifactVersionReference } from "./role-results.js"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import {
  buildTaskGraphFinalSummaryBinding,
  readResolvedRepairTaskIds,
  type TaskGraphFinalSummaryBinding,
  type TaskGraphFinalSummaryMember,
  type TaskGraphRetiredScoutProof,
} from "./task-graph-final-summary-binding.js"
import { reduceTaskGraphFollowUpSuggestions } from "./task-graph-follow-up-suggestions.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"

const hash = (value: string) => `sha256:${value.repeat(64)}`
const ref = (artifactId: string): ArtifactVersionReference => ({ artifactId, version: 1, contentHash: hash("a"), sourceDigest: hash("b") })

function preparedBinding(materialRef: ArtifactVersionReference): TaskGraphFinalSummaryBinding {
  const summary = reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: [{ kind: "business", taskId: "prepare-task-1", role: "prepare", taskStatus: "completed", attemptCount: 1,
    structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-task-1", attemptCount: 1,
      snapshotDigest: hash("c"), checkpointDigest: "d".repeat(64), jobs: [{ jobId: "job-1", status: "prepared" }],
      materials: [{ jobId: "job-1", kind: "resume", artifactRef: materialRef }] } }] })
  const members: TaskGraphFinalSummaryMember[] = [{ nodeIndex: 0, nodeKey: "prepare-node", templateId: "prepare", taskId: "prepare-task-1",
    role: "prepare", taskType: "prepare_task", taskStatus: "completed", kind: "business" }]
  return { rootTaskId: "root-task-1", graphItemId: "graph-item-1", graphRevision: 3, members, summary }
}

const retiredScoutResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "retired-job", source: "fixture", url: null, evidenceIds: ["retired-evidence"] }],
  evidence: [{ id: "retired-evidence", kind: "job", ref: "retired-job", source: "fixture" }],
  summary: "PRIVATE_RETIRED_SCOUT_PROSE",
}
const failedAnalystResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
  findings: [{ jobId: "current-job", score: 8, evidenceIds: ["current-evidence"] }],
  evidence: [{ id: "current-evidence", kind: "job", ref: "current-job", source: "fixture" }],
  summary: "PRIVATE_FAILED_ANALYST_PROSE",
}
const retirement: TaskGraphRetiredScoutProof = {
  nodeKey: "node-retired", taskId: "task-retired", attempt: 2, interruptRequestedAt: "2026-11-19T10:00:00.000Z",
  receiptEventId: "private-retirement-event", lifecycleEventId: "private-interrupted-event",
}

function mixedRetirementRepairBinding(): TaskGraphFinalSummaryBinding {
  const retired: GraphTaskRow = {
    id: "task-retired", role: "scout", taskType: "job_discovery", status: "interrupted",
    failureReason: "Subagent task subtree was interrupted", result: { structuredResult: retiredScoutResult }, attemptCount: 2,
  }
  const failed: GraphTaskRow = {
    id: "task-failed-analyst", role: "analyst", taskType: "job_analysis", status: "failed",
    failureReason: "task_graph_verification_failed", result: { structuredResult: failedAnalystResult },
  }
  const loaded = {
    rootTaskId: "root-task",
    item: { id: "task-graph:root-task", revision: 3, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: [
      { taskId: retired.id, key: retirement.nodeKey, templateId: "scout" },
      { taskId: failed.id, key: "node-failed", templateId: "analyst" },
    ] } as unknown as TaskGraphSnapshot,
    state: { revision: 3 } as LoadedGraph["state"],
    tasks: new Map([[retired.id, retired], [failed.id, failed]]),
  } as LoadedGraph
  return buildTaskGraphFinalSummaryBinding(loaded, undefined, new Set([failed.id]), new Map([[retirement.nodeKey, retirement]]))!
}

function followUpBinding(binding: TaskGraphFinalSummaryBinding) {
  return {
    rootTaskId: binding.rootTaskId,
    graphItemId: binding.graphItemId,
    graphRevision: binding.graphRevision,
    members: binding.members,
    summary: binding.summary,
  }
}

function mutateRetired(
  binding: TaskGraphFinalSummaryBinding,
  update: (member: Extract<TaskGraphFinalSummaryMember, { kind: "retired" }>) => unknown,
): unknown {
  return {
    ...followUpBinding(binding),
    members: binding.members?.map(member => member.kind === "retired" ? update(member) : member),
  }
}

describe("TaskGraph follow-up binding validation", () => {
  it("accepts current Prepare facts with material references nested under their prepared job", () => {
    const materialRef = ref("artifact-current")
    const current = preparedBinding(materialRef)

    expect(current.summary.prepareResults[0]?.jobs).toEqual([{ jobId: "job-1", status: "prepared", materials: [{ kind: "resume", artifactRef: materialRef }] }])
    expect(validateTaskGraphFollowUpBinding(current)).not.toBeNull()
  })

  it("accepts a bounded space-containing node key accepted by the current snapshot parser", () => {
    const current = preparedBinding(ref("artifact-current"))
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "search jobs", templateId: "prepare",
      goal: "Prepare materials", successCriteria: ["Save a material"], dependsOn: [], depth: 1, taskId: "prepare-task-1" }] })
    const bindingWithValidKey = { ...current, members: current.members?.map(member => ({ ...member, nodeKey: snapshot.nodes[0]!.key })) }

    expect(snapshot.nodes[0]?.key).toBe("search jobs")
    expect(validateTaskGraphFollowUpBinding(bindingWithValidKey)).not.toBeNull()
  })

  it("accepts eligible private history without requiring historical outcomes", () => {
    const current = preparedBinding(ref("artifact-current"))
    const history: TaskGraphFinalSummaryMember = { nodeIndex: 0, nodeKey: "history-node", templateId: "scout", taskId: "history-task",
      role: "scout", taskType: "scout", taskStatus: "completed", kind: "historical" }
    const prepared = { ...current.members![0]!, nodeIndex: 1 }
    const partitioned = { ...current, members: [history, prepared] }
    const facts = validateTaskGraphFollowUpBinding(partitioned)

    expect(facts?.outcomes.has("history-task")).toBe(false)
    expect(facts?.outcomes.has("prepare-task-1")).toBe(true)
    expect(validateTaskGraphFollowUpBinding({ ...partitioned, members: [history], summary: reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: [] }) })).toBeNull()
    expect(validateTaskGraphFollowUpBinding({ ...partitioned, members: [{ ...history, role: "unsupported", templateId: "unsupported" }, prepared] })).toBeNull()
    expect(validateTaskGraphFollowUpBinding({ ...partitioned, members: [{ ...history, templateId: "research" }, prepared] })).toBeNull()
    expect(validateTaskGraphFollowUpBinding({ ...partitioned, members: [{ ...history, taskStatus: "running" as const }, prepared] })).toBeNull()
    expect(validateTaskGraphFollowUpBinding({ ...partitioned, summary: { ...partitioned.summary, taskOutcomes: [
      ...partitioned.summary.taskOutcomes,
      { taskId: "history-task", role: "scout", taskStatus: "completed", resultState: "missing" },
    ] } })).toBeNull()
  })

  it("rejects outer-level materials or a nested reference inconsistent with the artifact summary", () => {
    const current = preparedBinding(ref("artifact-current"))
    const prepareRow = current.summary.prepareResults[0]!
    const job = prepareRow.jobs[0]!
    const outerMaterials = { ...current, summary: { ...current.summary, prepareResults: [{ ...prepareRow,
      jobs: [{ ...job, materials: [] }], materials: job.materials }] } } as unknown as TaskGraphFinalSummaryBinding
    const wrongRef = ref("artifact-other")
    const mismatchedNestedRef = { ...current, summary: { ...current.summary, prepareResults: [{ ...prepareRow,
      jobs: [{ ...job, materials: [{ kind: "resume" as const, artifactRef: wrongRef }] }] }] } } as unknown as TaskGraphFinalSummaryBinding
    const missingArtifactSummary = { ...current, summary: { ...current.summary, counts: { ...current.summary.counts,
      artifactReferences: { coverage: "complete" as const, knownCount: 0 } }, artifactReferences: [] } } as unknown as TaskGraphFinalSummaryBinding

    expect(validateTaskGraphFollowUpBinding(outerMaterials)).toBeNull()
    expect(validateTaskGraphFollowUpBinding(mismatchedNestedRef)).toBeNull()
    expect(validateTaskGraphFollowUpBinding(missingArtifactSummary)).toBeNull()
  })
})

describe("TaskGraph follow-up bindings with retired Scouts", () => {
  it("keeps resolved repair provenance while retirement remains noncontributing", () => {
    const binding = mixedRetirementRepairBinding()
    const facts = validateTaskGraphFollowUpBinding(followUpBinding(binding))
    const suggestions = reduceTaskGraphFollowUpSuggestions(binding)

    expect(binding.members?.map(member => member.kind)).toEqual(["retired", "business"])
    expect(readResolvedRepairTaskIds(binding)).toEqual(new Set(["task-failed-analyst"]))
    expect([...facts?.outcomes.keys() ?? []]).toEqual(["task-failed-analyst"])
    expect(facts?.summary.taskOutcomes.map(outcome => outcome.taskId)).toEqual(["task-failed-analyst"])
    expect(suggestions).not.toContainEqual(expect.objectContaining({ kind: "inspect_task_result", taskId: "task-failed-analyst" }))
    expect(suggestions).toContainEqual({
      kind: "view_reported_results", taskId: "task-failed-analyst", resultKind: "analysis",
      jobIds: ["current-job"], artifactRefs: [],
    })
    expect(JSON.stringify(facts?.summary)).not.toMatch(/task-retired|retired-job|private-retirement-event/)
    expect(JSON.stringify(suggestions)).not.toMatch(/task-retired|retired-job|private-retirement-event|private-interrupted-event/)
  })

  it("rejects malformed retirement members and their private metadata", () => {
    const binding = mixedRetirementRepairBinding()
    const malformed = [
      mutateRetired(binding, member => ({ ...member, leaked: "private" })),
      mutateRetired(binding, member => ({ ...member, retirement: { ...member.retirement, leaked: "private" } })),
      mutateRetired(binding, member => ({ ...member, role: "analyst" })),
      mutateRetired(binding, member => ({ ...member, taskStatus: "completed" })),
      mutateRetired(binding, member => ({ ...member, retirement: { ...member.retirement, attempt: 0 } })),
      mutateRetired(binding, member => ({ ...member, retirement: { ...member.retirement, interruptRequestedAt: "2026-11-19" } })),
      mutateRetired(binding, member => ({ ...member, retirement: { ...member.retirement, receiptEventId: "x".repeat(257) } })),
    ]

    for (const value of malformed) expect(validateTaskGraphFollowUpBinding(value)).toBeNull()
  })

  it("rejects retired Scouts inserted into business outcomes", () => {
    const binding = mixedRetirementRepairBinding(), base = followUpBinding(binding)
    const retiredOutcome = {
      taskId: "task-retired", role: "scout" as const, taskStatus: "interrupted" as const, resultState: "not_terminal" as const,
    }

    expect(validateTaskGraphFollowUpBinding({
      ...base, summary: { ...base.summary, taskOutcomes: [retiredOutcome] },
    })).toBeNull()
    expect(validateTaskGraphFollowUpBinding({
      ...base, summary: { ...base.summary, taskOutcomes: [...base.summary.taskOutcomes, retiredOutcome] },
    })).toBeNull()
  })
})
