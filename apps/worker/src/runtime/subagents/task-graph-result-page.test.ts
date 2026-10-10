import { describe, expect, it } from "vitest"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState } from "./task-graph-snapshot.js"
import type { LoadedGraph, GraphTaskRow } from "./task-graph-pg-state.js"
import { projectTaskGraphResultPage } from "./task-graph-result-page.js"

const CUID = (value: number) => `c${String(value).padStart(24, "0")}`
type Role = "scout" | "analyst"
type Spec = Readonly<{ key: string; role: Role; templateId: string; taskType: string; taskStatus?: GraphTaskRow["status"]; resultStatus?: "completed" | "partial"; count?: number; summary?: string; callerTaskId?: string }>

function result(spec: Spec): unknown {
  const jobIds = Array.from({ length: spec.count ?? 5 }, (_, index) => CUID(index + 1))
  const evidence = jobIds.flatMap(jobId => [
    { id: `job-${jobId}`, kind: "job", ref: jobId, source: "private-source" },
    { id: `profile-${jobId}`, kind: "persona", ref: "private-profile", source: "private-source" },
  ])
  const structuredResult = spec.role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role: spec.role, status: spec.resultStatus ?? "completed",
      candidates: jobIds.map(jobId => ({ jobId, source: " Greenhouse ", url: `https://private.example/${jobId}`, evidenceIds: [`job-${jobId}`, `profile-${jobId}`] })),
      evidence, summary: spec.summary ?? "PRIVATE_RESULT_SUMMARY" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role: spec.role, status: spec.resultStatus ?? "completed",
      findings: jobIds.map((jobId, index) => ({ jobId, score: index + 5, evidenceIds: [`job-${jobId}`, `profile-${jobId}`] })),
      evidence, summary: spec.summary ?? "PRIVATE_RESULT_SUMMARY" }
  return { status: "completed", finalItemId: "final-private", finalText: "PRIVATE_FINAL_TEXT", stepCount: 1, toolCallCount: 1, structuredResult }
}

function nativeMetadata(spec: Spec) {
  return {
    schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: `op-${spec.key}`,
    requestFingerprint: "a".repeat(64), callerTaskId: spec.callerTaskId ?? "root-1", role: spec.role,
    taskType: spec.taskType, contextDigest: "b".repeat(64), contextBytes: 1,
  }
}

function loaded(specs: readonly Spec[], revision = 7): LoadedGraph {
  const nodes = specs.map(spec => ({
    key: spec.key, templateId: spec.templateId, goal: `Run ${spec.role}`, successCriteria: ["Persist valid result"],
    dependsOn: [], depth: 1, taskId: `task-${spec.key}`,
    ...(spec.templateId === TASK_GRAPH_NATIVE_TEMPLATE_ID ? { verificationDisposition: "legacy_unverified", nativeDelegation: nativeMetadata(spec) } : {}),
  }))
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes })
  const tasks = new Map<string, GraphTaskRow>(specs.map(spec => {
    const expectedOutputSchema = { schemaVersion: ROLE_RESULT_SCHEMA, role: spec.role }
    const task: GraphTaskRow = {
      id: `task-${spec.key}`, role: spec.role, taskType: spec.taskType,
      status: spec.taskStatus ?? "completed", expectedOutputSchema, failureReason: null, result: result(spec),
    }
    return [task.id, task]
  }))
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  return {
    rootTaskId: "root-1", snapshot, item: { id: "graph-1", revision, content: snapshot, createdAt: new Date(0) },
    state: taskGraphState(snapshot, revision, statuses, []), tasks,
  }
}

function registered(role: Role, key = `${role}-1`, overrides: Partial<Spec> = {}): Spec {
  return { key, role, templateId: role, taskType: role === "scout" ? "job_discovery" : "job_analysis", ...overrides }
}

describe("TaskGraph current result pages", () => {
  it("pages full Scout results beyond the old 16 KiB limit without exposing prose, URLs, or evidence IDs", () => {
    const graph = loaded([registered("scout", "scout-1", { count: 5, summary: "x".repeat(20_000) })])
    const first = projectTaskGraphResultPage(graph, { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })
    expect(first).toMatchObject({ availability: "available", graphRevision: 7, role: "scout", taskStatus: "completed",
      resultStatus: "completed", totalCount: 5, evidenceCount: 10, offset: 0, nextOffset: 3 })
    expect(first).toHaveProperty("items.0.source", "greenhouse")
    expect(JSON.stringify(first)).not.toContain("private.example")
    expect(JSON.stringify(first)).not.toContain("PRIVATE_")
    expect(JSON.stringify(first)).not.toContain("evidence:")

    const second = projectTaskGraphResultPage(graph, { nodeKey: "scout-1", expectedRevision: 7, offset: 3 })
    expect(second).toMatchObject({ availability: "available", offset: 3, nextOffset: null, totalCount: 5 })
    expect(second).toHaveProperty("items.0.jobId", CUID(4))
    const end = projectTaskGraphResultPage(graph, { nodeKey: "scout-1", expectedRevision: 7, offset: 5 })
    expect(end).toMatchObject({ availability: "available", offset: 5, items: [], nextOffset: null })
    const beyond = projectTaskGraphResultPage(graph, { nodeKey: "scout-1", expectedRevision: 7, offset: 6 })
    expect(beyond).toMatchObject({ availability: "unavailable", reason: "offset_out_of_range" })
    expect(beyond).not.toHaveProperty("items")
  })

  it("projects Analyst findings with deterministic linked evidence kinds", () => {
    const page = projectTaskGraphResultPage(loaded([registered("analyst")]), { nodeKey: "analyst-1", expectedRevision: 7, offset: 1 })
    expect(page).toMatchObject({ availability: "available", role: "analyst", items: [
      { jobId: CUID(2), score: 6, evidenceKinds: ["job", "persona"] },
      { jobId: CUID(3), score: 7, evidenceKinds: ["job", "persona"] },
      { jobId: CUID(4), score: 8, evidenceKinds: ["job", "persona"] },
    ] })
  })

  it.each(["failed", "interrupted", "cancelled", "closed"] as const)("allows validated partial results for terminal task status %s", taskStatus => {
    const page = projectTaskGraphResultPage(loaded([registered("scout", "scout-1", { taskStatus, resultStatus: "partial" })]),
      { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })
    expect(page).toMatchObject({ availability: "available", taskStatus, resultStatus: "partial" })
  })

  it("does not page stale revisions, nonterminal output, missing graphs, or nodes outside current contracts", () => {
    const graph = loaded([registered("scout")])
    expect(projectTaskGraphResultPage(graph, { nodeKey: "scout-1", expectedRevision: 6, offset: 0 }))
      .toMatchObject({ availability: "unavailable", reason: "revision_mismatch", graphRevision: 7 })
    expect(projectTaskGraphResultPage(loaded([registered("scout", "scout-1", { taskStatus: "running" })]),
      { nodeKey: "scout-1", expectedRevision: 7, offset: 0 }))
      .toMatchObject({ availability: "unavailable", reason: "result_unavailable" })
    expect(projectTaskGraphResultPage({ rootTaskId: "root-1", item: null, snapshot: null, state: null, tasks: new Map() },
      { nodeKey: "scout-1", expectedRevision: 0, offset: 0 }))
      .toMatchObject({ availability: "unavailable", reason: "no_graph", graphRevision: 0 })
    expect(projectTaskGraphResultPage(loaded([registered("scout", "scout-1", { taskType: "job_analysis" })]),
      { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })).toMatchObject({ availability: "unavailable", reason: "node_unavailable" })
    expect(projectTaskGraphResultPage(loaded([registered("scout", "scout-1", { callerTaskId: "foreign-root", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID })]),
      { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })).toMatchObject({ availability: "unavailable", reason: "node_unavailable" })
  })

  it("does not page a result node absent from current graph membership", () => {
    const graph = loaded([registered("scout", "scout-1")])
    const withoutCurrentNode: LoadedGraph = { ...graph, state: { ...graph.state!, nodes: [] } }
    const page = projectTaskGraphResultPage(withoutCurrentNode, { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })

    expect(page).toMatchObject({ availability: "unavailable", graphRevision: 7, reason: "node_unavailable" })
    expect(page).not.toHaveProperty("items")
  })

  it("does not page results whose expected output schema marker mismatches the role", () => {
    const graph = loaded([registered("scout", "scout-1")])
    const task = graph.tasks.get("task-scout-1")!
    const tasks = new Map(graph.tasks)
    tasks.set(task.id, { ...task, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" } })
    const page = projectTaskGraphResultPage({ ...graph, tasks }, { nodeKey: "scout-1", expectedRevision: 7, offset: 0 })

    expect(page).toMatchObject({ availability: "unavailable", graphRevision: 7, reason: "node_unavailable" })
    expect(page).not.toHaveProperty("items")
  })

  it("accepts current native Scout nodes only with root caller and matching persisted role metadata", () => {
    const native = { ...registered("scout", "native-scout", { templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, taskType: "server_admitted_discovery" }) }
    expect(projectTaskGraphResultPage(loaded([native]), { nodeKey: native.key, expectedRevision: 7, offset: 0 }))
      .toMatchObject({ availability: "available", role: "scout", totalCount: 5 })
  })

  it("returns source_too_large only after identifying a current terminal role result", () => {
    const huge = loaded([registered("analyst", "analyst-1", { summary: "x".repeat(270 * 1024) })])
    expect(projectTaskGraphResultPage(huge, { nodeKey: "analyst-1", expectedRevision: 7, offset: 0 }))
      .toMatchObject({ availability: "unavailable", reason: "source_too_large", graphRevision: 7 })
  })
})
