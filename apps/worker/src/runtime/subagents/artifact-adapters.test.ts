import { describe, expect, it } from "vitest"

import {
  ArtifactAdapterError,
  InMemoryArtifactAdapter,
  hashArtifactContent,
  validateFinding,
  type ArtifactFinding,
} from "./artifact-adapters.js"

describe("subagent artifact adapters", () => {
  it("hashes equivalent object content deterministically and versions drafts", async () => {
    expect(hashArtifactContent({ b: 2, a: 1 })).toBe(hashArtifactContent({ a: 1, b: 2 }))
    const adapter = new InMemoryArtifactAdapter()
    const first = await adapter.writeDraft({ artifactId: "resume-1", artifactType: "resume", content: { text: "one" }, writerTaskId: "writer-1" })
    const second = await adapter.writeDraft({ artifactId: "resume-1", artifactType: "resume", content: { text: "two" }, writerTaskId: "writer-2", expectedPreviousHash: first.hash })
    expect(second).toMatchObject({ id: "resume-1", version: 2, writerTaskId: "writer-2" })
    expect(second.hash).not.toBe(first.hash)
  })

  it("rejects a stale draft overwrite and findings with the wrong hash", async () => {
    const adapter = new InMemoryArtifactAdapter()
    const draft = await adapter.writeDraft({ artifactType: "cover_letter", content: "draft", writerTaskId: "writer-1" })
    await expect(adapter.writeDraft({ artifactId: draft.id, artifactType: draft.type, content: "changed", writerTaskId: "writer-2", expectedPreviousHash: "sha256:stale" })).rejects.toThrow(ArtifactAdapterError)
    const finding: ArtifactFinding = { id: "finding-1", code: "tone", severity: "warning", message: "Tone needs review", artifactHash: "sha256:stale", evidence: [{ artifactHash: "sha256:stale", path: "$.text", summary: "Old text" }] }
    expect(() => validateFinding(finding, draft.hash)).toThrow(/stale artifact hash/)
  })
})
