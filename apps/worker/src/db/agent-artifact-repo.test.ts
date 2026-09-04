import { describe, expect, it, vi } from "vitest"
import { createAgentArtifactRepository } from "./agent-artifact-repo.js"

describe("agent artifact repository", () => {
  it("keeps find tenant-scoped and parameterized", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const repository = createAgentArtifactRepository({ query } as never)

    await expect(repository.find("user-a", "artifact-a")).resolves.toBeNull()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE "id" = $1 AND "userId" = $2'), ["artifact-a", "user-a"])
  })

  it("normalizes a typed row returned by the database", async () => {
    const row = {
      id: "artifact-a",
      userId: "user-a",
      jobId: "job-a",
      artifactType: "resume",
      lifecycle: "base",
      baseId: "artifact-a",
      baseHash: "sha256:base",
      content: { summary: "Engineer" },
      hash: "sha256:base",
      constraintHash: "sha256:constraints",
      provenanceRefs: ["resume:artifact-a"],
      evidenceRefs: ["resume:artifact-a"],
      previousHash: null,
      version: 1,
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      updatedAt: new Date("2026-09-03T00:00:00.000Z"),
    }
    const repository = createAgentArtifactRepository({ query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) } as never)

    await expect(repository.find("user-a", "artifact-a")).resolves.toMatchObject(row)
  })
})
