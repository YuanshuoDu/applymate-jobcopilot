import { describe, expect, it } from "vitest"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import {
  attachSelectedJobBatchFinalOutcome, readBoundSelectedJobBatchFinalOutcome, renderSelectedJobBatchFinalOutcome,
  readSelectedJobBatchFinalOutcome,
} from "./selected-job-batch-final-outcome.js"
import { sameTaskGraphFinalSummaryBinding, type TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentNode } from "./task-graph-command-port.js"
import { selectedJobBatchTemplatesForSlot } from "@jobcopilot/agent-protocol"
import type { SelectedJobBatchCompletionWitness } from "../multi-selected-job-completion-gate.js"

const jobSlots = [
  { slotId: "slot-1", jobId: "job-a" }, { slotId: "slot-2", jobId: "job-b" }, { slotId: "slot-3", jobId: "job-c" },
] as const
const digest = (letter: string) => `sha256:${letter.repeat(64)}`
type ArtifactRef = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>

function witness(options: { thirdFailed?: boolean; changedHash?: boolean; staleSource?: boolean; slotCount?: number; writersBeforeReviewers?: boolean } = {}): SelectedJobBatchCompletionWitness {
  const nodes: TaskGraphCurrentNode[] = [], outcomes: SelectedJobBatchCompletionWitness["slots"][number][] = []
  const slots = jobSlots.slice(0, options.slotCount ?? jobSlots.length)
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!, templates = selectedJobBatchTemplatesForSlot(slot.slotId)!
    const suffix = String.fromCharCode(97 + index), writerKey = `writer-${suffix}`, reviewerKey = `reviewer-${suffix}`
    const writerTaskId = `${writerKey}-task`, reviewerTaskId = `${reviewerKey}-task`, artifactId = `artifact-${suffix}`
    const artifactRef = { artifactId, version: index + 1, contentHash: digest(suffix), sourceDigest: digest(String.fromCharCode(100 + index)) }
    const isFailed = options.thirdFailed && index === 2, reviewHash = digest(options.changedHash && index === 0 ? "f" : String.fromCharCode(97 + index))
    nodes.push(makeNode(writerKey, templates.writerTemplateId, writerTaskId, "writer", artifactRef, isFailed ? "failed" : "completed", []))
    nodes.push(makeNode(reviewerKey, templates.reviewerTemplateId, reviewerTaskId, "reviewer", artifactRef,
      isFailed ? "cancelled" : "completed", [writerKey], ["passed", "needs_revision", "rejected"][index] as "passed" | "needs_revision" | "rejected", reviewHash))
    outcomes.push(isFailed
      ? { slotId: slot.slotId, jobId: slot.jobId, status: "failed", writerTaskId, reviewerTaskId }
      : { slotId: slot.slotId, jobId: slot.jobId, status: "completed", writerTaskId, reviewerTaskId, evidence: {
        artifactRef, artifactVersion: { ...artifactRef, artifactType: "cover_letter" as const, taskId: writerTaskId, previousHash: null },
        reviewReceipt: { taskId: reviewerTaskId, artifactId, version: artifactRef.version,
          contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest,
          currentSourceDigest: options.staleSource && index === 0 ? digest("q") : artifactRef.sourceDigest,
          status: ["passed", "needs_revision", "rejected"][index] as "passed" | "needs_revision" | "rejected", reviewHash },
      } })
  }
  const graphNodes = options.writersBeforeReviewers ? [...nodes.filter(node => node.templateId.includes("writer")), ...nodes.filter(node => node.templateId.includes("reviewer"))] : nodes
  return { graph: { revision: 12, nodes: graphNodes }, slots: outcomes }
}

function correctionWitness(): SelectedJobBatchCompletionWitness {
  const initial = witness({ slotCount: 2 }), first = initial.slots[0]!
  if (first.status !== "completed") throw new Error("fixture must have completed initial evidence")
  const originalWriter = initial.graph.nodes.find(node => node.taskId === first.writerTaskId)!
  const originalReviewer = initial.graph.nodes.find(node => node.taskId === first.reviewerTaskId)!
  const priorReviewHash = digest("e"), priorRef = first.evidence.artifactRef
  const initialNodes = initial.graph.nodes.map(node => node.taskId === first.reviewerTaskId
    ? { ...node, resultProjection: { ...node.resultProjection!, reviewStatus: "needs_revision" as const, reviewHash: priorReviewHash } } : node)
  const currentRef = { ...priorRef, version: priorRef.version + 1, contentHash: digest("f") }
  const templates = selectedJobBatchTemplatesForSlot("slot-1")!
  const correctionWriter = makeNode("writer-a-correction", templates.writerTemplateId, "writer-a-correction-task", "writer", currentRef, "completed", [originalReviewer.key])
  const correctionReviewer = makeNode("reviewer-a-correction", templates.reviewerTemplateId, "reviewer-a-correction-task", "reviewer", currentRef,
    "completed", [correctionWriter.key], "passed", digest("9"))
  const priorEvidence = {
    writerTaskId: originalWriter.taskId, reviewerTaskId: originalReviewer.taskId, artifactRef: priorRef,
    artifactVersion: { ...priorRef, artifactType: "cover_letter" as const, taskId: originalWriter.taskId, previousHash: null },
    reviewStatus: "needs_revision" as const, reviewHash: priorReviewHash,
    reviewReceipt: { taskId: originalReviewer.taskId, artifactId: priorRef.artifactId, version: priorRef.version,
      contentHash: priorRef.contentHash, sourceDigest: priorRef.sourceDigest, currentSourceDigest: priorRef.sourceDigest,
      status: "needs_revision" as const, reviewHash: priorReviewHash },
  }
  const second = initial.slots[1]!
  if (second.status !== "completed") throw new Error("fixture must have completed second branch")
  return { graph: { revision: initial.graph.revision + 1, nodes: [...initialNodes, correctionWriter, correctionReviewer] }, slots: [
    { ...first, writerTaskId: correctionWriter.taskId, reviewerTaskId: correctionReviewer.taskId,
      evidence: { artifactRef: currentRef, artifactVersion: { ...currentRef, artifactType: "cover_letter" as const,
        taskId: correctionWriter.taskId, previousHash: priorRef.contentHash }, reviewReceipt: { taskId: correctionReviewer.taskId, artifactId: currentRef.artifactId,
        version: currentRef.version, contentHash: currentRef.contentHash, sourceDigest: currentRef.sourceDigest,
        currentSourceDigest: currentRef.sourceDigest, status: "passed", reviewHash: digest("9") } }, priorEvidence },
    second,
  ] }
}

function makeNode(
  key: string, templateId: string, taskId: string, role: "writer" | "reviewer", artifactRef: ArtifactRef,
  status: TaskGraphCurrentNode["status"], dependsOn: readonly string[], reviewStatus?: "passed" | "needs_revision" | "rejected", reviewHash?: string,
): TaskGraphCurrentNode {
  const resultProjection = status !== "completed" ? undefined : role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const, role, status, artifactRef,
      reviewStatus: reviewStatus ?? "passed", reviewHash: reviewHash ?? digest("a") }
  return { key, templateId, taskId, status, goal: "Prepare", successCriteria: ["Review"], dependsOn,
    readiness: status === "completed" || status === "failed" || status === "cancelled" ? "terminal" : "waiting_for_dependencies",
    resultSummary: null, failureReason: status === "failed" ? "branch_failed" : null,
    ...(resultProjection ? { resultProjection } : {}) }
}

function baseBinding(value: SelectedJobBatchCompletionWitness): TaskGraphFinalSummaryBinding {
  const roleByTemplate = new Map<string, "writer" | "reviewer">()
  for (const slot of jobSlots) {
    const templates = selectedJobBatchTemplatesForSlot(slot.slotId)!
    roleByTemplate.set(templates.writerTemplateId, "writer"); roleByTemplate.set(templates.reviewerTemplateId, "reviewer")
  }
  return {
    rootTaskId: "root-batch", graphItemId: "graph-batch", graphRevision: value.graph.revision,
    members: value.graph.nodes.map((node, nodeIndex) => ({ nodeIndex, nodeKey: node.key, templateId: node.templateId,
      taskId: node.taskId, role: roleByTemplate.get(node.templateId)!,
      taskType: roleByTemplate.get(node.templateId) === "writer" ? "cover_letter_draft" : "cover_letter_review",
      taskStatus: node.status, kind: "business" as const })),
    summary: reduceTaskGraphFinalSummary({ graphRevision: value.graph.revision, nodes: [] }),
  }
}

describe("grounded selected-job batch final outcome", () => {
  it("attaches only ordered verified slots and retains explicit mixed branch/review outcomes", () => {
    const ready = witness({ thirdFailed: true }), binding = attachSelectedJobBatchFinalOutcome(baseBinding(ready), ready)
    expect(binding).not.toBeNull()
    const outcome = readBoundSelectedJobBatchFinalOutcome(binding!)
    expect(outcome?.slots.map(slot => [slot.slotId, slot.jobId, slot.status])).toEqual([
      ["slot-1", "job-a", "completed"], ["slot-2", "job-b", "completed"], ["slot-3", "job-c", "failed"],
    ])
    expect(outcome?.slots.slice(0, 2).map(slot => slot.reviewStatus)).toEqual(["passed", "needs_revision"])
    expect(outcome?.slots[2]).toMatchObject({ status: "failed", writer: { status: "failed" }, reviewer: { status: "cancelled" } })
  })

  it("accepts legal parallel Writer ordering while preserving shortlist slot order", () => {
    const ready = witness({ slotCount: 2, writersBeforeReviewers: true })
    const binding = attachSelectedJobBatchFinalOutcome(baseBinding(ready), ready)
    expect(binding).not.toBeNull()
    expect(binding?.members?.map(member => member.taskId)).toEqual(["writer-a-task", "writer-b-task", "reviewer-a-task", "reviewer-b-task"])
    expect(readBoundSelectedJobBatchFinalOutcome(binding!)?.slots.map(slot => [slot.slotId, slot.jobId])).toEqual([
      ["slot-1", "job-a"], ["slot-2", "job-b"],
    ])
  })

  it("binds the latest correction pair and its immutable initial review to every graph member", () => {
    const ready = correctionWitness(), attached = attachSelectedJobBatchFinalOutcome(baseBinding(ready), ready)
    expect(attached).not.toBeNull()
    const outcome = readBoundSelectedJobBatchFinalOutcome(attached!)
    expect(outcome?.slots[0]).toMatchObject({
      writer: { taskId: "writer-a-correction-task" }, reviewer: { taskId: "reviewer-a-correction-task" },
      artifactRef: { version: 2 }, reviewStatus: "passed",
      priorPair: { writer: { taskId: "writer-a-task" }, reviewer: { taskId: "reviewer-a-task" },
        evidence: { reviewStatus: "needs_revision", artifactRef: { version: 1 }, artifactVersion: { taskId: "writer-a-task", artifactType: "cover_letter" } } },
    })
    expect(attached?.members).toHaveLength(6)
    expect(renderSelectedJobBatchFinalOutcome(attached!)).toEqual([
      "Per-Job preparation outcomes:",
      "Job 1: Writer completed; Reviewer completed; review passed.",
      "Job 2: Writer completed; Reviewer completed; review needs revision.",
    ])
    expect(renderSelectedJobBatchFinalOutcome(attached!).join("\n")).not.toMatch(/writer-a-task|draft-a|sha256:|reviewHash/)
    const changed = { ...outcome!, slots: outcome!.slots.map((slot, index) => index ? slot : ({ ...slot,
      priorPair: { ...slot.priorPair!, evidence: { ...slot.priorPair!.evidence, reviewHash: digest("q") } } })) }
    expect(readSelectedJobBatchFinalOutcome(changed, ready.graph.revision)).toBeNull()
    const unrelatedDraft = { ...outcome!, slots: outcome!.slots.map((slot, index) => index ? slot : ({ ...slot,
      artifactRef: { ...slot.artifactRef!, artifactId: "draft-other" } })) }
    expect(readSelectedJobBatchFinalOutcome(unrelatedDraft, ready.graph.revision)).toBeNull()
    expect(readBoundSelectedJobBatchFinalOutcome({ ...attached!, members: attached!.members?.slice(1) })).toBeNull()
  })

  it("rejects changed member, slot, graph revision, duplicate identity, pending, or stale evidence", () => {
    const ready = witness(), base = baseBinding(ready)
    expect(attachSelectedJobBatchFinalOutcome({ ...base, graphRevision: base.graphRevision + 1 }, ready)).toBeNull()
    expect(attachSelectedJobBatchFinalOutcome({ ...base, members: base.members?.map((member, index) => index === 0
      ? { ...member, taskId: "borrowed-writer-task" } : member) }, ready)).toBeNull()
    expect(attachSelectedJobBatchFinalOutcome({ ...base, members: base.members?.map((member, index) => index === 0
      ? { ...member, taskType: "cover_letter_review" } : member) }, ready)).toBeNull()
    expect(attachSelectedJobBatchFinalOutcome(base, { ...ready, slots: [...ready.slots].reverse() })).toBeNull()
    const duplicate = { ...ready, slots: ready.slots.map((slot, index) => index === 1 ? { ...slot, jobId: "job-a" } : slot) }
    expect(attachSelectedJobBatchFinalOutcome(base, duplicate)).toBeNull()
    const pending = { ...ready, slots: ready.slots.map((slot, index) => index === 0 ? { ...slot, status: "pending" } : slot) }
    expect(attachSelectedJobBatchFinalOutcome(base, pending as unknown as SelectedJobBatchCompletionWitness)).toBeNull()
    expect(attachSelectedJobBatchFinalOutcome(baseBinding(witness({ staleSource: true })), witness({ staleSource: true }))).toBeNull()
  })

  it("binds candidate and terminal evidence projection and fails comparison on changed receipt evidence", () => {
    const candidate = witness(), accepted = attachSelectedJobBatchFinalOutcome(baseBinding(candidate), candidate)!
    const terminalSame = witness(), rechecked = attachSelectedJobBatchFinalOutcome(baseBinding(terminalSame), terminalSame)!
    const terminalChanged = witness({ changedHash: true }), changed = attachSelectedJobBatchFinalOutcome(baseBinding(terminalChanged), terminalChanged)!
    expect(sameTaskGraphFinalSummaryBinding(accepted, rechecked)).toBe(true)
    expect(sameTaskGraphFinalSummaryBinding(accepted, changed)).toBe(false)
    expect(sameTaskGraphFinalSummaryBinding(accepted, { ...rechecked, selectedJobBatchFinalOutcome: undefined })).toBe(false)
  })

  it("renders only static per-Job statuses and leaves ordinary TaskGraph output unchanged", () => {
    const ready = witness({ thirdFailed: true }), binding = attachSelectedJobBatchFinalOutcome(baseBinding(ready), ready)!
    expect(renderSelectedJobBatchFinalOutcome(binding)).toEqual([
      "Per-Job preparation outcomes:",
      "Job 1: Writer completed; Reviewer completed; review passed.",
      "Job 2: Writer completed; Reviewer completed; review needs revision.",
      "Job 3: preparation failed; Writer failed; Reviewer cancelled.",
    ])
    expect(renderSelectedJobBatchFinalOutcome(baseBinding(witness()))).toEqual(["Per-Job preparation outcomes: unavailable (current verified batch proof is missing)."])
    const ordinary = { ...baseBinding(ready), members: [] }
    expect(renderSelectedJobBatchFinalOutcome(ordinary)).toEqual([])
    const response = renderSelectedJobBatchFinalOutcome(binding).join("\n")
    expect(response).not.toMatch(/job-a|artifact-a|sha256:|reviewHash|review findings/)
  })
})
