import { describe, expect, it, vi } from "vitest"
import type { AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "../../db/agent-artifact-repo.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentState } from "./task-graph-command-port.js"
import { selectedJobReviewedDraftEvidenceWithWitness } from "./selected-job-reviewed-draft-evidence.js"

const artifactRef = { artifactId: "draft-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
const reviewHash = `sha256:${"c".repeat(64)}`
function graph(): TaskGraphCurrentState {
  const projection = (role: "writer" | "reviewer") => role === "writer"
    ? { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const,
      role: "writer" as const, status: "completed" as const, artifactRef }
    : { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "available" as const,
      role: "reviewer" as const, status: "completed" as const, artifactRef, reviewStatus: "passed" as const, reviewHash }
  return { revision: 17, nodes: [
    { key: "writer-key", taskId: "writer-row-id", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Persist"],
      dependsOn: [], status: "completed", readiness: "terminal", resultSummary: null, resultProjection: projection("writer"), failureReason: null },
    { key: "reviewer-key", taskId: "reviewer-row-id", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Decide"],
      dependsOn: ["writer-key"], status: "completed", readiness: "terminal", resultSummary: null, resultProjection: projection("reviewer"), failureReason: null },
  ] }
}
function receipt(scope: AgentArtifactReviewReceiptScope): AgentArtifactReviewReceipt {
  return { ...scope, toolCallId: "review-call-1" }
}
function input(overrides: Partial<Parameters<typeof selectedJobReviewedDraftEvidenceWithWitness>[0]> = {}) {
  return {
    graph: graph(), userId: "owner-1", sessionId: "session-1", selectedJobId: "job-1",
    readCurrentDraftHead: vi.fn(async (scope: AgentArtifactDraftHeadScope) => ({ ...artifactRef, artifactId: scope.artifactId })),
    readCurrentSourceDigest: vi.fn(async () => artifactRef.sourceDigest),
    readCurrentReviewReceipt: vi.fn(async (scope: AgentArtifactReviewReceiptScope) => receipt(scope)),
    ...overrides,
  }
}

describe("selected-job reviewed draft evidence", () => {
  it("verifies already-authenticated graph facts without a Turn lease", async () => {
    const value = input()
    const result = await selectedJobReviewedDraftEvidenceWithWitness(value)
    expect(result).toEqual({ ok: true, witness: { revision: value.graph.revision, nodes: value.graph.nodes } })
    expect(value.readCurrentDraftHead).toHaveBeenCalledWith({ userId: "owner-1", sessionId: "session-1", jobId: "job-1", artifactId: "draft-1" })
    expect(value.readCurrentReviewReceipt).toHaveBeenCalledWith({ userId: "owner-1", sessionId: "session-1", jobId: "job-1",
      artifactId: "draft-1", version: 2, contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest,
      currentSourceDigest: artifactRef.sourceDigest, taskId: "reviewer-row-id", status: "passed", reviewHash })
  })

  it.each([
    ["unrelated reviewer", (value: TaskGraphCurrentState) => ({ ...value, nodes: value.nodes.map(node => ({ ...node,
      ...(node.key === "reviewer-key" ? { dependsOn: ["other-writer"] } : {}) })) })],
    ["changed writer material", (value: TaskGraphCurrentState) => ({ ...value, nodes: value.nodes.map(node => ({ ...node,
      ...(node.key === "writer-key" ? { resultProjection: { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const,
        availability: "available" as const, role: "writer" as const, status: "completed" as const,
        artifactRef: { ...artifactRef, contentHash: `sha256:${"d".repeat(64)}` } } } : {}) })) })],
  ])("rejects %s graph facts", async (_name, change) => {
    await expect(selectedJobReviewedDraftEvidenceWithWitness(input({ graph: change(graph()) }))).resolves.toMatchObject({ ok: false })
  })

  it("rejects a persisted head or review receipt that no longer matches", async () => {
    await expect(selectedJobReviewedDraftEvidenceWithWitness(input({
      readCurrentDraftHead: async () => ({ ...artifactRef, version: 1 }),
    }))).resolves.toMatchObject({ ok: false })
    await expect(selectedJobReviewedDraftEvidenceWithWitness(input({
      readCurrentReviewReceipt: async scope => ({ ...receipt(scope), jobId: "other-job" }),
    }))).resolves.toMatchObject({ ok: false })
  })

  it("rechecks source material after the exact head and receipt reads", async () => {
    const readCurrentSourceDigest = vi.fn().mockResolvedValueOnce(artifactRef.sourceDigest).mockResolvedValueOnce(`sha256:${"e".repeat(64)}`)
    const result = await selectedJobReviewedDraftEvidenceWithWitness(input({ readCurrentSourceDigest }))
    expect(result).toMatchObject({ ok: false })
    expect(readCurrentSourceDigest).toHaveBeenCalledTimes(2)
  })

  it("fails closed for malformed identity or unavailable selected-job readers", async () => {
    await expect(selectedJobReviewedDraftEvidenceWithWitness(input({ userId: " owner-1" }))).resolves.toMatchObject({ ok: false })
    await expect(selectedJobReviewedDraftEvidenceWithWitness(input({ readCurrentSourceDigest: undefined }))).resolves.toMatchObject({ ok: false })
  })
})
