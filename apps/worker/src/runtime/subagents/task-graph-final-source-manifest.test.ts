import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { finalTaskGraphArtifactProofInput, SELECTED_JOB_BATCH_TEMPLATE_CATALOG } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentNode } from "./task-graph-command-port.js"
import type { SelectedJobBatchCompletionWitness } from "../multi-selected-job-completion-gate.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { attachSelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

function graph(rows: readonly GraphTaskRow[]): LoadedGraph {
  const nodes = rows.map((task, nodeIndex) => ({ key: `private-node-${nodeIndex}`,
    templateId: task.role === "scout" && task.taskType === "job_discovery" ? "scout" : task.taskType!, taskId: task.id }))
  return { rootTaskId: "private-root-id", item: { id: taskGraphItemId("private-root-id"), revision: 7, content: {}, createdAt: new Date(0) },
    snapshot: { nodes } as unknown as TaskGraphSnapshot, state: { revision: 7 } as LoadedGraph["state"],
    tasks: new Map(rows.map(task => [task.id, task])) } as LoadedGraph
}

function task(id: string, role: string, taskType: string, structuredResult?: unknown, status: GraphTaskRow["status"] = "completed"): GraphTaskRow {
  return { id, role, taskType, status, failureReason: null,
    result: structuredResult === undefined ? { status: "completed" } : { status: "completed", structuredResult } }
}

const scoutResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "PRIVATE_TEXT" }
const analystResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "PRIVATE_ANALYST_TEXT" }
const digest = (letter: string) => `sha256:${letter.repeat(64)}`

function graphWithNodes(rows: readonly GraphTaskRow[], nodes: readonly { key: string; templateId: string; taskId: string }[], revision = 7): LoadedGraph {
  return { rootTaskId: "private-root-id", item: { id: taskGraphItemId("private-root-id"), revision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes } as unknown as TaskGraphSnapshot, state: { revision } as LoadedGraph["state"],
    tasks: new Map(rows.map(row => [row.id, row])) } as LoadedGraph
}

function selectedJobBatchFixture(options: { failedSlot?: number } = {}) {
  const rows: GraphTaskRow[] = [], taskNodes: { key: string; templateId: string; taskId: string }[] = [], currentNodes: TaskGraphCurrentNode[] = []
  const slots: SelectedJobBatchCompletionWitness["slots"][number][] = []
  const artifactRefs: { artifactId: string; version: number; contentHash: string; sourceDigest: string }[] = []
  for (let index = 0; index < 2; index++) {
    const catalog = SELECTED_JOB_BATCH_TEMPLATE_CATALOG[index]!
    const writerKey = `writer-node-${index + 1}`, reviewerKey = `reviewer-node-${index + 1}`
    const writerTaskId = `writer-task-${index + 1}`, reviewerTaskId = `reviewer-task-${index + 1}`
    const artifactRef = { artifactId: `private-artifact-${index + 1}`, version: index + 1,
      contentHash: digest(index === 0 ? "a" : "c"), sourceDigest: digest(index === 0 ? "b" : "d") }
    artifactRefs.push(artifactRef)
    const failed = options.failedSlot === index
    const reviewHash = digest(index === 0 ? "e" : "f")
    const writerResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }
    const reviewerResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
      reviewStatus: "passed", reviewHash }
    rows.push(task(writerTaskId, "writer", "cover_letter_draft", failed ? undefined : writerResult, failed ? "failed" : "completed"))
    rows.push(task(reviewerTaskId, "reviewer", "cover_letter_review", failed ? undefined : reviewerResult, failed ? "cancelled" : "completed"))
    taskNodes.push({ key: writerKey, templateId: catalog.writerTemplateId, taskId: writerTaskId },
      { key: reviewerKey, templateId: catalog.reviewerTemplateId, taskId: reviewerTaskId })
    currentNodes.push(batchNode(writerKey, catalog.writerTemplateId, writerTaskId, "writer", artifactRef,
      failed ? "failed" : "completed", []), batchNode(reviewerKey, catalog.reviewerTemplateId, reviewerTaskId, "reviewer",
      artifactRef, failed ? "cancelled" : "completed", [writerKey], "passed", reviewHash))
    slots.push(failed
      ? { slotId: catalog.slotId, jobId: `private-job-${index + 1}`, status: "failed", writerTaskId, reviewerTaskId }
      : { slotId: catalog.slotId, jobId: `private-job-${index + 1}`, status: "completed", writerTaskId, reviewerTaskId,
        evidence: { artifactRef, artifactVersion: { ...artifactRef, artifactType: "cover_letter" as const, taskId: writerTaskId, previousHash: null },
          reviewReceipt: { taskId: reviewerTaskId, artifactId: artifactRef.artifactId,
          version: artifactRef.version, contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest,
          currentSourceDigest: artifactRef.sourceDigest, status: "passed", reviewHash } } })
  }
  const revision = 12
  const binding = buildTaskGraphFinalSummaryBinding(graphWithNodes(rows, taskNodes, revision))!
  const witness: SelectedJobBatchCompletionWitness = { graph: { revision, nodes: currentNodes }, slots }
  const attached = attachSelectedJobBatchFinalOutcome(binding, witness)
  if (!attached) throw new Error("Expected an exact selected-job batch final outcome")
  return { binding: attached, artifactRefs }
}

function batchNode(key: string, templateId: string, taskId: string, role: "writer" | "reviewer",
  artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string },
  status: TaskGraphCurrentNode["status"], dependsOn: readonly string[], reviewStatus?: "passed", reviewHash?: string): TaskGraphCurrentNode {
  const resultProjection = status !== "completed" ? undefined : role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const,
      role, status, artifactRef, reviewStatus: reviewStatus ?? "passed", reviewHash: reviewHash ?? digest("e") }
  return { key, templateId, taskId, status, goal: "Prepare", successCriteria: ["Review"], dependsOn,
    readiness: status === "completed" || status === "failed" || status === "cancelled" ? "terminal" : "waiting_for_dependencies",
    resultSummary: null, failureReason: status === "failed" ? "branch_failed" : null,
    ...(resultProjection ? { resultProjection } : {}) }
}

describe("TaskGraph final source manifest", () => {
  it("emits every business outcome in graph order using final-item-bound opaque keys", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([
      task("private-scout-task", "scout", "research", scoutResult),
      task("private-native-control", "auditor", "native_verification"),
      task("private-unknown-task", "odd-role", "custom"),
    ]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    const digest = createHash("sha256").update(`taskGraphSource:v1\0private-final-item\0${binding.graphRevision}\0${0}`).digest("base64url")

    expect(manifest).toEqual({ schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: 7, sources: [
      { sourceKey: `src_${digest}`, nodeIndex: 0, role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
      { sourceKey: expect.stringMatching(/^src_[A-Za-z0-9_-]{43}$/), nodeIndex: 2, role: "unsupported", taskStatus: "completed", resultState: "unsupported_role" },
    ] })
    expect(Object.keys(manifest ?? {}).sort()).toEqual(["graphRevision", "schemaVersion", "sources"])
    expect(JSON.stringify(manifest)).not.toMatch(/private-root-id|private-final-item|private-scout-task|private-native-control|private-unknown-task|PRIVATE_TEXT/)
    expect(buildTaskGraphFinalSourceManifest(binding, "another-final-item")?.sources[0]?.sourceKey).not.toBe(manifest?.sources[0]?.sourceKey)
  })

  it("fails closed when business outcomes are missing, duplicated, or no longer match their graph member", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-scout-task", "scout", "research", scoutResult)]))!
    const missing = { ...binding, summary: { ...binding.summary, taskOutcomes: [] } }
    const duplicate = { ...binding, summary: { ...binding.summary, taskOutcomes: [...binding.summary.taskOutcomes, binding.summary.taskOutcomes[0]!] } }
    const wrongRole = { ...binding, summary: { ...binding.summary, taskOutcomes: binding.summary.taskOutcomes.map(item => ({ ...item, role: "analyst" as const })) } }
    const missingMember = { ...binding, members: [] }
    const duplicateMember = { ...binding, members: [...binding.members!, { ...binding.members![0]!, nodeIndex: 1 }] }
    const wrongGraph = { ...binding, graphItemId: "task-graph-other-root" }

    for (const invalid of [missing, duplicate, wrongRole, missingMember, duplicateMember, wrongGraph]) {
      expect(() => buildTaskGraphFinalSourceManifest(invalid, "final-item")).toThrow()
    }
  })

  it("keeps a current control-only graph free of user-facing source entries", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-native-control", "auditor", "native_verification")]))!
    expect(buildTaskGraphFinalSourceManifest(binding, "private-final-item")).toBeNull()
  })

  it("emits sorted historical indices in v2 without historical source links", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([
      task("private-old-scout", "scout", "scout", scoutResult),
      task("private-current-analyst", "analyst", "analyst", analystResult),
      task("private-old-analyst", "analyst", "analyst", analystResult),
      task("private-current-unknown", "odd-role", "custom"),
    ]), new Set([2, 0]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")

    expect(manifest).toEqual({ schemaVersion: "agent-harness.v2.task-graph-sources.v2", graphRevision: 7,
      historicalNodeIndices: [0, 2], sources: [
        { sourceKey: expect.stringMatching(/^src_[A-Za-z0-9_-]{43}$/), nodeIndex: 1, role: "analyst", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
        { sourceKey: expect.stringMatching(/^src_[A-Za-z0-9_-]{43}$/), nodeIndex: 3, role: "unsupported", taskStatus: "completed", resultState: "unsupported_role" },
      ] })
    expect(JSON.stringify(manifest)).not.toMatch(/private-old-scout|private-old-analyst|PRIVATE_TEXT|PRIVATE_ANALYST_TEXT/)
    expect(manifest?.sources.map(source => source.nodeIndex)).toEqual([1, 3])
  })

  it("emits v4 artifact proofs only for exact completed canonical cover-letter members", () => {
    const artifactRef = { artifactId: "private-letter", version: 4, contentHash: digest("a"), sourceDigest: digest("b") }
    const writer = { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }
    const reviewer = { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef,
      reviewStatus: "passed", reviewHash: digest("c") }
    const binding = buildTaskGraphFinalSummaryBinding(graphWithNodes([
      task("private-writer-task", "writer", "cover_letter_draft", writer),
      task("private-reviewer-task", "reviewer", "cover_letter_review", reviewer),
      task("private-lookalike-task", "writer", "cover_letter_draft", writer),
    ], [
      { key: "writer", templateId: "cover_letter_writer", taskId: "private-writer-task" },
      { key: "reviewer", templateId: "cover_letter_reviewer", taskId: "private-reviewer-task" },
      { key: "lookalike", templateId: "custom_cover_letter_writer", taskId: "private-lookalike-task" },
    ]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    if (!manifest || manifest.schemaVersion !== "agent-harness.v2.task-graph-sources.v4") throw new Error("Expected a v4 source manifest")
    const sources = manifest.sources
    expect(manifest.historicalNodeIndices).toEqual([])
    expect(sources.slice(0, 2).map(source => source.artifactVersionProof)).toEqual([
      expect.stringMatching(/^avp_[a-f0-9]{64}$/), expect.stringMatching(/^avp_[a-f0-9]{64}$/),
    ])
    expect(sources[0]?.artifactVersionProof).toBe(`avp_${createHash("sha256")
      .update(finalTaskGraphArtifactProofInput(sources[0]!.sourceKey, artifactRef)).digest("hex")}`)
    expect(sources[0]?.artifactVersionProof).not.toBe(sources[1]?.artifactVersionProof)
    expect(sources[2]).not.toHaveProperty("artifactVersionProof")
    expect(JSON.stringify(manifest)).not.toMatch(/private-letter|sha256:|private-writer-task|private-root-id|private-final-item/)
  })

  it("binds batch proofs to each completed catalog slot and preserves job artifact separation", () => {
    const { binding, artifactRefs } = selectedJobBatchFixture()
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    if (!manifest || manifest.schemaVersion !== "agent-harness.v2.task-graph-sources.v4") throw new Error("Expected a v4 batch source manifest")
    const proofs = manifest.sources.filter(source => Object.hasOwn(source, "artifactVersionProof"))
    expect(manifest.historicalNodeIndices).toEqual([])
    expect(proofs).toHaveLength(4)
    expect(new Set(proofs?.map(source => source.artifactVersionProof)).size).toBe(4)
    expect(artifactRefs[0]).not.toEqual(artifactRefs[1])
    for (const source of manifest.sources) {
      const expectedRef = artifactRefs[Math.floor(source.nodeIndex / 2)]!
      expect(source.artifactVersionProof).toBe(`avp_${createHash("sha256")
        .update(finalTaskGraphArtifactProofInput(source.sourceKey, expectedRef)).digest("hex")}`)
    }
    expect(JSON.stringify(manifest)).not.toMatch(/private-job-|private-artifact-|sha256:/)

    const { binding: partial } = selectedJobBatchFixture({ failedSlot: 1 })
    const partialManifest = buildTaskGraphFinalSourceManifest(partial, "private-final-item")
    if (!partialManifest || partialManifest.schemaVersion !== "agent-harness.v2.task-graph-sources.v4") throw new Error("Expected a v4 partial batch manifest")
    expect(partialManifest.sources.filter(source => Object.hasOwn(source, "artifactVersionProof"))).toHaveLength(2)
    expect(partialManifest.sources.filter(source => source.nodeIndex >= 2).every(source => !Object.hasOwn(source, "artifactVersionProof"))).toBe(true)
  })

  it("emits v3 retired indices separately from historical and current sources", () => {
    const interrupted = { ...task("private-retired-scout", "scout", "job_discovery", scoutResult), status: "interrupted" as const, attemptCount: 2 }
    const binding = buildTaskGraphFinalSummaryBinding(graph([
      task("private-old-scout", "scout", "scout", scoutResult), interrupted,
      task("private-current-analyst", "analyst", "analyst", analystResult),
    ]), new Set([0]), new Map([["private-node-1", { nodeKey: "private-node-1", taskId: "private-retired-scout", attempt: 2,
      interruptRequestedAt: "2026-11-19T10:00:00.000Z", receiptEventId: "private-retirement-event", lifecycleEventId: "private-ack-event" }]]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")

    expect(manifest).toEqual({ schemaVersion: "agent-harness.v2.task-graph-sources.v3", graphRevision: 7,
      historicalNodeIndices: [0], retiredNodeIndices: [1], sources: [
        { sourceKey: expect.stringMatching(/^src_[A-Za-z0-9_-]{43}$/), nodeIndex: 2, role: "analyst", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
      ] })
    expect(Object.keys(manifest ?? {}).sort()).toEqual(["graphRevision", "historicalNodeIndices", "retiredNodeIndices", "schemaVersion", "sources"])
    expect(JSON.stringify(manifest)).not.toMatch(/private-root-id|private-retired-scout|private-retirement-event|private-ack-event|PRIVATE_TEXT/)
  })

  it("preserves retired indices alongside a current Writer artifact proof", () => {
    const retired = { ...task("retired-scout", "scout", "job_discovery", scoutResult), status: "interrupted" as const, attemptCount: 2 }
    const artifactRef = { artifactId: "private-letter", version: 1, contentHash: digest("a"), sourceDigest: digest("b") }
    const writer = task("current-writer", "writer", "cover_letter_draft",
      { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef })
    const binding = buildTaskGraphFinalSummaryBinding(graphWithNodes([retired, writer], [
      { key: "retired", templateId: "scout", taskId: retired.id },
      { key: "writer", templateId: "cover_letter_writer", taskId: writer.id },
    ]), new Set(), new Map([["retired", { nodeKey: "retired", taskId: retired.id, attempt: 2,
      interruptRequestedAt: "2026-11-19T10:00:00.000Z", receiptEventId: "retirement", lifecycleEventId: "ack" }]]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    expect(manifest).toMatchObject({ schemaVersion: "agent-harness.v2.task-graph-sources.v4",
      retiredNodeIndices: [0], historicalNodeIndices: [], sources: [{ nodeIndex: 1, artifactVersionProof: expect.stringMatching(/^avp_/) }] })
  })

  it("rejects a retired-only binding without current business evidence", () => {
    const interrupted = { ...task("private-retired-scout", "scout", "job_discovery", scoutResult), status: "interrupted" as const, attemptCount: 2 }
    const binding = buildTaskGraphFinalSummaryBinding(graph([interrupted]), new Set(), new Map([[
      "private-node-0", { nodeKey: "private-node-0", taskId: "private-retired-scout", attempt: 2,
        interruptRequestedAt: "2026-11-19T10:00:00.000Z", receiptEventId: "private-retirement-event", lifecycleEventId: "private-ack-event" },
    ]]))!
    expect(() => buildTaskGraphFinalSourceManifest(binding, "private-final-item"))
      .toThrow("task_graph_final_source_retirement_without_current_source")
  })

  it("keeps the existing eight-member manifest bound when historical members are present", () => {
    const rows = [task("private-history", "scout", "scout", scoutResult),
      ...Array.from({ length: 8 }, (_, index) => task(`private-current-${index}`, "odd-role", "custom"))]
    const binding = buildTaskGraphFinalSummaryBinding(graph(rows), new Set([0]))!

    expect(() => buildTaskGraphFinalSourceManifest(binding, "private-final-item"))
      .toThrow("task_graph_final_source_binding_invalid")
  })

  it("supports the full eight-node disclosure bound without dropping a business outcome", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph(Array.from({ length: 8 }, (_, index) =>
      task(`private-task-${index}`, "unregistered", "custom"))))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    expect(manifest?.sources).toHaveLength(8)
    expect(manifest?.sources.map(source => source.nodeIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(manifest?.sources.map(source => source.sourceKey)).size).toBe(8)
  })

  it("rejects legacy summary-only bindings and malformed final item identities", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-scout-task", "scout", "research", scoutResult)]))!
    expect(() => buildTaskGraphFinalSourceManifest({ graphRevision: binding.graphRevision, summary: binding.summary }, "final-item"))
      .toThrow("task_graph_final_source_binding_invalid")
    expect(() => buildTaskGraphFinalSourceManifest(binding, "bad\0item")).toThrow("task_graph_final_source_binding_invalid")
  })
})
