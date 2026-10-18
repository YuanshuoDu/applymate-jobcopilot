import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { DISCOVERY_RECOVERY_SCHEMA_VERSION } from "./task-graph-discovery-recovery-contract.js"
import { projectTaskGraphDiscoveryRecoveryPage } from "./task-graph-discovery-recovery-page.js"
import { TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, type TaskGraphDiscoveryRecoveryPageRequest } from "./task-graph-discovery-recovery-page-contract.js"

const id = (index: number) => `c${String(index).padStart(24, "0")}`
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const report = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
  criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null }
const expectedEnvelope = {
  role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
  expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
  allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
}
const request: TaskGraphDiscoveryRecoveryPageRequest = { mode: "discovery_recovery", nodeKey: "scout-a", expectedRevision: 8, offset: 0 }

type Fixture = Partial<{
  attemptCount: number; taskStatus: GraphTaskRow["status"]; taskType: string; role: string; templateId: string;
  expectedSchema: unknown; allowedActions: unknown; context: unknown; contextIsObject: unknown; hasPrivateSelectionContext: unknown;
  envelope: unknown; sidecar: unknown; result: unknown; revision: number; stateRevision: number;
  repair: boolean; native: boolean; omitEnvelope: boolean;
}>

function sidecar(attemptCount = 3, count = 5) {
  return { schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount,
    jobIds: Array.from({ length: count }, (_, index) => id(index + 1)), truncated: count === 24 }
}

function loaded(options: Fixture = {}): LoadedGraph {
  const taskId = "task-scout-a", revision = options.revision ?? 8, taskStatus = options.taskStatus ?? "failed"
  const graphNode: Record<string, unknown> = {
    key: "scout-a", templateId: "scout", goal: "Find jobs", successCriteria: ["Persist candidates"],
    dependsOn: [], depth: 1, taskId, verificationDisposition: "typed", verification,
    ...(options.omitEnvelope ? {} : { registeredScoutEnvelope: options.envelope ?? expectedEnvelope }),
  }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [graphNode] })
  const node = snapshot.nodes[0]!
  const { registeredScoutEnvelope: _removed, ...withoutEnvelope } = node
  const finalNode = {
    ...(options.omitEnvelope ? withoutEnvelope : node), ...(options.templateId ? { templateId: options.templateId } : {}),
    ...(options.repair ? { repairOf: { graphRootTaskId: "root-1", nodeKey: "older", taskId: "old-task", criterionIds: ["candidate-count"] } } : {}),
    ...(options.native ? { nativeDelegation: { callerTaskId: "root-1" } } : {}),
  } as StoredTaskGraphNode
  const currentSnapshot = { ...snapshot, nodes: [finalNode] }
  const currentRevision = options.stateRevision ?? revision
  const result = options.result ?? { status: "failed", stepCount: 4, toolCallCount: 3, finalItemId: "private-final-id",
    taskGraphVerificationReport: report, discoveryRecovery: options.sidecar === undefined ? sidecar() : options.sidecar }
  const context = Object.hasOwn(options, "context") ? options.context : { taskGraphDependencyResults: { items: [] } }
  const contextIsObject = context !== null && typeof context === "object" && !Array.isArray(context)
  const hasPrivateSelectionContext = contextIsObject && ["selectedJobPreparation", "coverLetterBase", "writerReviewFeedback"]
    .some(key => Object.hasOwn(context, key))
  const task: GraphTaskRow = {
    id: taskId, status: taskStatus, role: options.role ?? "scout", taskType: options.taskType ?? "job_discovery",
    expectedOutputSchema: options.expectedSchema ?? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    allowedActions: Object.hasOwn(options, "allowedActions") ? options.allowedActions : [...expectedEnvelope.allowedActions],
    contextIsObject: Object.hasOwn(options, "contextIsObject") ? options.contextIsObject as boolean : contextIsObject,
    hasPrivateSelectionContext: Object.hasOwn(options, "hasPrivateSelectionContext")
      ? options.hasPrivateSelectionContext as boolean : hasPrivateSelectionContext,
    attemptCount: options.attemptCount ?? 3,
    failureReason: "private provider detail", result,
  }
  const state = taskGraphState(currentSnapshot, currentRevision, new Map([[taskId, { status: task.status, failureReason: task.failureReason }]]), [])
  return { rootTaskId: "root-1", snapshot: currentSnapshot, item: { id: "graph-1", revision, content: currentSnapshot, createdAt: new Date(0) },
    state, tasks: new Map([[taskId, task]]) }
}

describe("failed Scout discovery-recovery observation pages", () => {
  it("pages only canonical IDs with an explicit unverified status and attempt-pinned continuation", () => {
    const graph = loaded()
    expect(graph.tasks.get("task-scout-a")).toMatchObject({ contextIsObject: true, hasPrivateSelectionContext: false })
    expect(graph.tasks.get("task-scout-a")).not.toHaveProperty("context")
    const first = projectTaskGraphDiscoveryRecoveryPage(graph, request)
    expect(first).toEqual({ schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
      observation: "partial_discovery", verificationStatus: "unverified", graphRevision: 8, attemptCount: 3, taskStatus: "failed",
      totalCount: 5, offset: 0, nextOffset: 3, truncated: false, items: [{ jobId: id(1) }, { jobId: id(2) }, { jobId: id(3) }] })
    const next = projectTaskGraphDiscoveryRecoveryPage(graph, { ...request, offset: 3, expectedAttemptCount: 3 })
    expect(next).toMatchObject({ offset: 3, nextOffset: null, items: [{ jobId: id(4) }, { jobId: id(5) }] })
    expect(JSON.stringify(first)).not.toContain("private")
    expect(JSON.stringify(first)).not.toContain("evidence")
    expect(JSON.stringify(first)).not.toContain("score")
  })

  it("projects only capped server recovery IDs when model text and structured output remain persisted", () => {
    const modelText = JSON.stringify({ jobIds: [id(99)], summary: "MODEL_AUTHORED_TEXT_SECRET" })
    const modelPayload = { jobIds: [id(98)], summary: "MODEL_AUTHORED_STRUCTURED_SECRET", privateNotes: "PRIVATE_MODEL_DATA" }
    const graph = loaded({ result: {
      status: "completed", finalText: modelText, structuredResult: modelPayload, discoveryRecovery: sidecar(3, 24),
    } })

    const page = projectTaskGraphDiscoveryRecoveryPage(graph, request)
    expect(page).toEqual({ schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
      observation: "partial_discovery", verificationStatus: "unverified", graphRevision: 8, attemptCount: 3, taskStatus: "failed",
      totalCount: 24, offset: 0, nextOffset: 3, truncated: true,
      items: [{ jobId: id(1) }, { jobId: id(2) }, { jobId: id(3) }] })
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain(modelText)
    expect(serialized).not.toContain("MODEL_AUTHORED")
    expect(serialized).not.toContain("PRIVATE_MODEL_DATA")
    expect(serialized).not.toContain(id(98))
    expect(serialized).not.toContain(id(99))
  })

  it("requires the current failed ordinary generic Scout and its exact current-attempt sidecar", () => {
    const selectedEnvelope = { ...expectedEnvelope, allowedActions: ["jobs.get"] }
    const invalidGraphs = [
      loaded({ sidecar: undefined, result: { status: "failed" } }),
      loaded({ sidecar: { ...sidecar(), attemptCount: 2 } }),
      loaded({ attemptCount: 4 }),
      loaded({ taskStatus: "completed" }), loaded({ role: "analyst" }), loaded({ taskType: "private_research" }),
      loaded({ envelope: selectedEnvelope }), loaded({ omitEnvelope: true }), loaded({ templateId: "native" }),
      loaded({ allowedActions: ["jobs.get"] }), loaded({ allowedActions: [...expectedEnvelope.allowedActions, "private.tool"] }),
      loaded({ allowedActions: "jobs.discover" }), loaded({ allowedActions: undefined }),
      loaded({ contextIsObject: undefined }), loaded({ hasPrivateSelectionContext: undefined }),
      loaded({ contextIsObject: "true" }), loaded({ hasPrivateSelectionContext: false, contextIsObject: false }),
      loaded({ context: { selectedJobPreparation: undefined } }), loaded({ context: { coverLetterBase: null } }),
      loaded({ context: { writerReviewFeedback: false } }), loaded({ context: null }), loaded({ context: undefined }),
      loaded({ repair: true }), loaded({ native: true }), loaded({ stateRevision: 7 }),
      loaded({ result: { status: "failed", taskGraphRepairReceipt: { taskId: "private-repair" }, discoveryRecovery: sidecar() } }),
      loaded({ result: { status: "pending", discoveryRecovery: sidecar() } }),
      loaded({ sidecar: { ...sidecar(), secret: "provider error" } }),
    ]
    for (const graph of invalidGraphs) {
      expect(projectTaskGraphDiscoveryRecoveryPage(graph, request)).toMatchObject({ availability: "unavailable" })
    }
    expect(projectTaskGraphDiscoveryRecoveryPage(loaded(), { ...request, expectedAttemptCount: 2 }))
      .toMatchObject({ availability: "unavailable", reason: "attempt_mismatch" })
    expect(projectTaskGraphDiscoveryRecoveryPage(loaded(), { ...request, offset: 6, expectedAttemptCount: 3 }))
      .toMatchObject({ availability: "unavailable", reason: "offset_out_of_range" })
  })

  it("rejects stale revisions and never falls back to a model-authored typed result", () => {
    expect(projectTaskGraphDiscoveryRecoveryPage(loaded(), { ...request, expectedRevision: 7 }))
      .toMatchObject({ availability: "unavailable", reason: "revision_mismatch" })
    const typedOnly = loaded({ result: { status: "failed", structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial", candidates: [{ jobId: id(1), source: "other", evidenceIds: [] }], evidence: [], summary: "private" },
    } })
    expect(projectTaskGraphDiscoveryRecoveryPage(typedOnly, request)).toMatchObject({ availability: "unavailable", reason: "recovery_unavailable" })
    expect(projectTaskGraphDiscoveryRecoveryPage({ rootTaskId: "root-1", item: null, snapshot: null, state: null, tasks: new Map() }, request))
      .toMatchObject({ availability: "unavailable", reason: "no_graph" })
  })
})
