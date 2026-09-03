import { describe, expect, it } from "vitest"

import { InMemoryArtifactAdapter } from "./artifact-adapters.js"
import { WriterTaskHandler } from "./writer.js"

const task = { id: "writer-1", rootTaskId: "root-1", role: "writer" }

describe("WriterTaskHandler", () => {
  it("returns a hashed draft and cannot report review or execution authority", async () => {
    const result = await new WriterTaskHandler(new InMemoryArtifactAdapter()).run({ task, artifactType: "resume", content: { text: "draft" } })
    expect(result).toMatchObject({ role: "writer", taskId: "writer-1", rootTaskId: "root-1", draftOnly: true })
    expect(result.artifact.hash).toMatch(/^sha256:/)
    expect(result).not.toHaveProperty("review")
    expect(result.profile.role).toBe("writer")
  })

  it("rejects a reviewer task before any artifact write", async () => {
    const adapter = new InMemoryArtifactAdapter()
    await expect(new WriterTaskHandler(adapter).run({ task: { ...task, role: "reviewer" }, artifactType: "resume", content: {} })).rejects.toThrow(/Expected a writer task/)
    await expect(adapter.read("artifact-1")).resolves.toBeNull()
  })
})
