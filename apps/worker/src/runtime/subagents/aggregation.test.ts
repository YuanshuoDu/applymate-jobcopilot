import { describe, expect, it } from "vitest"

import { aggregateRootResults, invalidateStaleReview, type RootChildResult } from "./aggregation.js"
import { InMemoryArtifactAdapter } from "./artifact-adapters.js"
import { ReviewerTaskHandler } from "./reviewer.js"
import { WriterTaskHandler } from "./writer.js"

describe("Writer/Reviewer root aggregation", () => {
  it("aggregates a Writer draft and an evidence-backed Reviewer pass", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const writer = await new WriterTaskHandler(adapter).run({ task: { id: "writer-1", rootTaskId: "root-1", role: "writer" }, artifactType: "resume", content: "draft" })
    const reviewer = await new ReviewerTaskHandler(adapter).run({ task: { id: "reviewer-1", rootTaskId: "root-1", role: "reviewer" }, artifactId: writer.artifact.id, expectedArtifactHash: writer.artifact.hash, decision: "passed", findings: [], evidence: [{ artifactHash: writer.artifact.hash, path: "$.text", summary: "Draft exists" }] })
    const result = aggregateRootResults("root-1", [writer, reviewer])
    expect(result.status).toBe("passed")
    expect(result.evidenceChain).toHaveLength(1)
  })

  it("blocks a stale review and never aggregates it as a pass", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const writer = new WriterTaskHandler(adapter)
    const first = await writer.run({ task: { id: "writer-1", rootTaskId: "root-1", role: "writer" }, artifactId: "resume-1", artifactType: "resume", content: "one" })
    const reviewer = await new ReviewerTaskHandler(adapter).run({ task: { id: "reviewer-1", rootTaskId: "root-1", role: "reviewer" }, artifactId: first.artifact.id, expectedArtifactHash: first.artifact.hash, decision: "passed", findings: [], evidence: [{ artifactHash: first.artifact.hash, path: "$.text", summary: "Old draft" }] })
    const second = await writer.run({ task: { id: "writer-2", rootTaskId: "root-1", role: "writer" }, artifactId: "resume-1", artifactType: "resume", content: "two", expectedPreviousHash: first.artifact.hash })
    const current = await adapter.read(second.artifact.id)
    expect(current).not.toBeNull()
    const stale = invalidateStaleReview(reviewer.review, current!)
    const result = aggregateRootResults("root-1", [first, { ...reviewer, review: stale }, second] as RootChildResult[])
    expect(result.status).toBe("blocked")
    expect(result.evidenceChain).toEqual([])
  })

  it("does not allow a Reviewer pass without evidence to reach the root", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const writer = await new WriterTaskHandler(adapter).run({ task: { id: "writer-1", rootTaskId: "root-1", role: "writer" }, artifactType: "resume", content: "draft" })
    const reviewer = await new ReviewerTaskHandler(adapter).run({ task: { id: "reviewer-1", rootTaskId: "root-1", role: "reviewer" }, artifactId: writer.artifact.id, expectedArtifactHash: writer.artifact.hash, decision: "passed", findings: [], evidence: [{ artifactHash: writer.artifact.hash, path: "$.text", summary: "Draft exists" }] })
    const result = aggregateRootResults("root-1", [writer, { ...reviewer, review: { ...reviewer.review, evidence: [] } }])
    expect(result.status).toBe("blocked")
    expect(result.reasons).toContain("Review reviewer-1 passed without evidence")
  })
})
