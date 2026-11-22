import { describe, expect, it } from "vitest"
import { selectedJobBatchTemplatesForSlot } from "@jobcopilot/agent-protocol"
import { projectSelectedJobBatchFinalCorrection, readSelectedJobBatchFinalCorrection } from "./selected-job-batch-final-correction.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentNode } from "./task-graph-command-port.js"

const ref = { artifactId: "draft-a", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
const reviewHash = `sha256:${"c".repeat(64)}`
const evidence = {
  writerTaskId: "writer-a-task", reviewerTaskId: "reviewer-a-task", artifactRef: ref,
  artifactVersion: { ...ref, artifactType: "cover_letter", taskId: "writer-a-task", previousHash: null },
  reviewStatus: "needs_revision", reviewHash,
  reviewReceipt: { taskId: "reviewer-a-task", artifactId: ref.artifactId, version: ref.version,
    contentHash: ref.contentHash, sourceDigest: ref.sourceDigest, currentSourceDigest: ref.sourceDigest,
    status: "needs_revision", reviewHash },
}

function node(role: "writer" | "reviewer", overrides: Partial<TaskGraphCurrentNode> = {}): TaskGraphCurrentNode {
  const templates = selectedJobBatchTemplatesForSlot("slot-1")!
  const key = `${role}-a`, taskId = `${key}-task`
  const resultProjection = role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const,
      availability: "available" as const, role, status: "completed" as const, artifactRef: ref }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const,
      availability: "available" as const, role, status: "completed" as const, artifactRef: ref,
      reviewStatus: "needs_revision" as const, reviewHash }
  return { key, taskId, templateId: role === "writer" ? templates.writerTemplateId : templates.reviewerTemplateId,
    goal: "Prepare", successCriteria: ["Review"], dependsOn: [], status: "completed", readiness: "terminal",
    resultSummary: null, failureReason: null, resultProjection, ...overrides }
}

function input(value: unknown = evidence) {
  return { slotId: "slot-1" as const, value, writer: node("writer"), reviewer: node("reviewer"), writerIndex: 0, reviewerIndex: 1 }
}

describe("selected-job batch final correction projection", () => {
  it("retains the exact completed initial pair and immutable needs-revision evidence", () => {
    const projected = projectSelectedJobBatchFinalCorrection(input())
    expect(projected).toMatchObject({
      writer: { nodeIndex: 0, taskId: "writer-a-task", role: "writer", status: "completed" },
      reviewer: { nodeIndex: 1, taskId: "reviewer-a-task", role: "reviewer", status: "completed" },
      evidence: { writerTaskId: "writer-a-task", reviewerTaskId: "reviewer-a-task", reviewStatus: "needs_revision", artifactVersion: { artifactType: "cover_letter" } },
    })
    expect(readSelectedJobBatchFinalCorrection(projected, "slot-1")).toEqual(projected)
  })

  it.each([
    ["cross-pair task", { ...evidence, writerTaskId: "writer-b-task" }, {}],
    ["mutable extra evidence", { ...evidence, content: "unbounded" }, {}],
    ["wrong immutable writer", { ...evidence, artifactVersion: { ...evidence.artifactVersion, taskId: "writer-b-task" } }, {}],
    ["passed initial receipt", { ...evidence, reviewStatus: "passed" }, {}],
    ["reviewer projection drift", evidence, { reviewer: node("reviewer", { resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "reviewer",
      status: "completed", artifactRef: ref, reviewStatus: "needs_revision", reviewHash: `sha256:${"d".repeat(64)}`,
    } }) }],
  ])("rejects %s", (_label, value, overrides) => {
    expect(projectSelectedJobBatchFinalCorrection({ ...input(value), ...overrides })).toBeNull()
  })

  it("does not parse a changed or extended stored prior pair", () => {
    const projected = projectSelectedJobBatchFinalCorrection(input())!
    expect(readSelectedJobBatchFinalCorrection({ ...projected, extra: true }, "slot-1")).toBeNull()
    expect(readSelectedJobBatchFinalCorrection({ ...projected, evidence: { ...projected.evidence, reviewHash: `sha256:${"d".repeat(64)}` } }, "slot-1")).toBeNull()
  })
})
