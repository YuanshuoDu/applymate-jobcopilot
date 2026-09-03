import { describe, expect, it } from "vitest"

import { InMemoryArtifactAdapter, type ArtifactEvidence, type ArtifactFinding } from "./artifact-adapters.js"
import { ReviewContractError, ReviewerTaskHandler } from "./reviewer.js"

const task = { id: "reviewer-1", rootTaskId: "root-1", role: "reviewer" }
const evidence = (artifactHash: string): ArtifactEvidence => ({ artifactHash, path: "$.text", summary: "Observed text" })

describe("ReviewerTaskHandler", () => {
  it("reviews a current artifact through a read-only adapter", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const artifact = await adapter.writeDraft({ artifactId: "resume-1", artifactType: "resume", content: { text: "draft" }, writerTaskId: "writer-1" })
    const finding: ArtifactFinding = { id: "finding-1", code: "tone", severity: "warning", message: "Review tone", artifactHash: artifact.hash, evidence: [evidence(artifact.hash)] }
    const result = await new ReviewerTaskHandler(adapter).run({ task, artifactId: artifact.id, expectedArtifactHash: artifact.hash, decision: "passed", findings: [finding], evidence: [evidence(artifact.hash)] })
    expect(result.review).toMatchObject({ status: "passed", artifactHash: artifact.hash, reviewerTaskId: "reviewer-1" })
    expect(result.reviewOnly).toBe(true)
    expect(result).not.toHaveProperty("draft")
  })

  it("returns stale instead of reviewing an artifact after a Writer update", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const first = await adapter.writeDraft({ artifactId: "resume-1", artifactType: "resume", content: "one", writerTaskId: "writer-1" })
    await adapter.writeDraft({ artifactId: "resume-1", artifactType: "resume", content: "two", writerTaskId: "writer-2", expectedPreviousHash: first.hash })
    const result = await new ReviewerTaskHandler(adapter).run({ task, artifactId: "resume-1", expectedArtifactHash: first.hash, decision: "passed", findings: [], evidence: [evidence(first.hash)] })
    expect(result.review.status).toBe("stale")
    expect(result.review.artifactHash).not.toBe(first.hash)
    expect(result.review.findings).toEqual([])
  })

  it("rejects a pass without evidence", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const artifact = await adapter.writeDraft({ artifactType: "resume", content: "draft", writerTaskId: "writer-1" })
    await expect(new ReviewerTaskHandler(adapter).run({ task, artifactId: artifact.id, decision: "passed", findings: [], evidence: [] })).rejects.toMatchObject({ code: "missing_evidence" } satisfies Partial<ReviewContractError>)
  })
})
