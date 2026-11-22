import { describe, expect, it, vi } from "vitest"
import type { AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "../db/agent-artifact-repo.js"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import {
  isSelectedJobBatchCorrectionSuccessor, readSelectedJobBatchCorrectionPriorEvidence,
  type SelectedJobBatchArtifactVersion,
} from "./multi-selected-job-correction-evidence.js"

const ref = { artifactId: "draft-a", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
const reviewHash = `sha256:${"c".repeat(64)}`
const version: SelectedJobBatchArtifactVersion = { ...ref, artifactType: "cover_letter", taskId: "writer-a", previousHash: null }
const scope = { userId: "user-1", sessionId: "session-1", jobId: "job-a" }

function node(key: string, taskId: string, role: "writer" | "reviewer"): TaskGraphCurrentNode {
  return {
    key, taskId, templateId: `cover_letter_${role}_slot_1`, status: "completed", goal: "Prepare", successCriteria: ["Review"],
    dependsOn: [], readiness: "terminal", resultSummary: null, failureReason: null,
    resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
      role, status: "completed", artifactRef: ref, ...(role === "reviewer" ? { reviewStatus: "needs_revision", reviewHash } : {}) },
  } as TaskGraphCurrentNode
}

function dependencyContext(options: { jobId?: string; taskId?: string; artifactRef?: typeof ref; reviewHash?: string } = {}) {
  return {
    selectedJobPreparation: { jobId: options.jobId ?? scope.jobId },
    taskGraphDependencyResults: { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [{
      dependencyKey: "reviewer", dependencyTaskId: options.taskId ?? "reviewer-a", role: "reviewer", taskStatus: "completed",
      result: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available",
        role: "reviewer", status: "completed", artifactRef: options.artifactRef ?? ref, reviewStatus: "needs_revision", reviewHash: options.reviewHash ?? reviewHash },
    }] },
  }
}

function setup(overrides: Partial<Parameters<typeof readSelectedJobBatchCorrectionPriorEvidence>[0]> = {}) {
  const readCurrentSourceDigest = vi.fn(async () => ref.sourceDigest)
  const readArtifactVersion = vi.fn(async () => version)
  const readCurrentReviewReceipt = vi.fn(async (value: AgentArtifactReviewReceiptScope) => ({ ...value, toolCallId: "review-call" } as AgentArtifactReviewReceipt))
  return {
    input: {
      ...scope, writer: node("writer-a", "writer-a", "writer"), reviewer: node("reviewer-a", "reviewer-a", "reviewer"),
      correctionWriterContext: dependencyContext(), requireWriterDependency: true,
      readCurrentSourceDigest, readArtifactVersion, readCurrentReviewReceipt, ...overrides,
    }, readCurrentSourceDigest, readArtifactVersion, readCurrentReviewReceipt,
  }
}

describe("selected-job batch correction evidence", () => {
  it("binds the correction Writer to the exact prior needs-revision artifact and persisted receipt", async () => {
    const state = setup()
    const result = await readSelectedJobBatchCorrectionPriorEvidence(state.input)
    expect(result).toMatchObject({ writerTaskId: "writer-a", reviewerTaskId: "reviewer-a", artifactRef: ref,
      artifactVersion: version, reviewStatus: "needs_revision", reviewHash,
      reviewReceipt: { taskId: "reviewer-a", status: "needs_revision", reviewHash } })
    expect(state.readCurrentSourceDigest).toHaveBeenCalledTimes(2)
    expect(state.readArtifactVersion).toHaveBeenCalledWith({ ...scope, artifactId: ref.artifactId, taskId: "writer-a", version: ref.version })
    expect(state.readCurrentReviewReceipt).toHaveBeenCalledOnce()
  })

  it.each([
    ["another Job", { correctionWriterContext: dependencyContext({ jobId: "job-b" }) }],
    ["another Reviewer", { correctionWriterContext: dependencyContext({ taskId: "reviewer-b" }) }],
    ["another artifact", { correctionWriterContext: dependencyContext({ artifactRef: { ...ref, version: 2 } }) }],
    ["another review", { correctionWriterContext: dependencyContext({ reviewHash: `sha256:${"d".repeat(64)}` }) }],
    ["passed review", { reviewer: { ...node("reviewer-a", "reviewer-a", "reviewer"), resultProjection: {
      ...node("reviewer-a", "reviewer-a", "reviewer").resultProjection!, reviewStatus: "passed",
    } as TaskGraphCurrentNode["resultProjection"] } }],
    ["missing immutable version", { readArtifactVersion: vi.fn(async () => null) }],
    ["stale source", { readCurrentSourceDigest: vi.fn(async () => `sha256:${"f".repeat(64)}`) }],
    ["changed receipt", { readCurrentReviewReceipt: vi.fn(async value => ({ ...value, reviewHash: `sha256:${"f".repeat(64)}` } as AgentArtifactReviewReceipt)) }],
  ])("denies a %s correction witness", async (_label, overrides) => {
    const state = setup(overrides)
    expect(await readSelectedJobBatchCorrectionPriorEvidence(state.input)).toBeUndefined()
  })

  it("accepts only the exact next immutable version of the same prior draft", () => {
    const state = setup()
    return readSelectedJobBatchCorrectionPriorEvidence(state.input).then(prior => {
      if (!prior) throw new Error("test setup did not verify prior review")
      const next = { ...ref, artifactType: "cover_letter" as const, taskId: "writer-a-correction", version: 4, previousHash: ref.contentHash }
      expect(isSelectedJobBatchCorrectionSuccessor(prior, next)).toBe(true)
      expect(isSelectedJobBatchCorrectionSuccessor(prior, { ...next, version: 5 })).toBe(false)
      expect(isSelectedJobBatchCorrectionSuccessor(prior, { ...next, previousHash: `sha256:${"f".repeat(64)}` })).toBe(false)
      expect(isSelectedJobBatchCorrectionSuccessor(prior, { ...next, artifactId: "other" })).toBe(false)
      expect(isSelectedJobBatchCorrectionSuccessor(prior, { ...next, taskId: "writer-a" })).toBe(false)
    })
  })
})
