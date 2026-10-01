import { describe, expect, it } from "vitest"
import { createSelectedJobPreparation, InMemoryArtifactToolStore, type ArtifactToolScope } from "./artifact-tools.js"

const prep = createSelectedJobPreparation("job-a", [{ sourceRef: "resume:r-1", content: { skills: ["TypeScript"] } }])
function scopeFor(taskId = "task-a", toolCallId = "call-a"): ArtifactToolScope {
  return { userId: "user-a", sessionId: "session-a", taskId, toolCallId, taskFence: { taskId, userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 1 }, ...prep }
}
const scope = scopeFor()

describe("InMemoryArtifactToolStore persistence contract", () => {
  it("scopes a version to user, session and selected job while preserving historical rows", async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const first = await store.writeDraft(scope, { baseArtifactId: base.id, baseHash: base.hash, content: "one", constraints: {}, requestHash: "sha256:first" })
    const second = await store.writeDraft(scopeFor("task-b", "call-b"), { baseArtifactId: base.id, baseHash: base.hash, content: "two", constraints: {}, expectedPreviousHash: first.contentHash, requestHash: "sha256:second" })
    await expect(store.readVersion(scope, { artifactId: first.artifactId, version: 1, contentHash: first.contentHash, sourceDigest: first.sourceDigest })).resolves.toMatchObject({ content: "one" })
    expect(second).toMatchObject({ artifactId: first.artifactId, version: 2 })
    await expect(store.readVersion({ ...scope, userId: "user-b" }, { artifactId: first.artifactId, version: 1, contentHash: first.contentHash, sourceDigest: first.sourceDigest })).resolves.toBeNull()
    await expect(store.readVersion({ ...scope, sessionId: "session-b" }, { artifactId: first.artifactId, version: 1, contentHash: first.contentHash, sourceDigest: first.sourceDigest })).resolves.toBeNull()
    await expect(store.listForUser(scope.userId, "job-a")).resolves.toHaveLength(2)
  })

  it("returns same task receipt for replay and rejects a different request under that receipt", async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    const input = { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: "sha256:request" }
    const first = await store.writeDraft(scope, input)
    await expect(store.writeDraft(scope, input)).resolves.toEqual(first)
    await expect(store.writeDraft(scope, { ...input, content: "changed", requestHash: "sha256:changed" })).rejects.toMatchObject({ code: "receipt_conflict" })
  })

  it("rejects stale base and previous hashes", async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: "base-a", type: "cover_letter", userId: scope.userId, jobId: scope.jobId, content: "base" })
    await expect(store.writeDraft(scope, { baseArtifactId: base.id, baseHash: "sha256:stale", content: "draft", constraints: {}, requestHash: "sha256:a" })).rejects.toMatchObject({ code: "stale_hash" })
    const first = await store.writeDraft(scope, { baseArtifactId: base.id, baseHash: base.hash, content: "draft", constraints: {}, requestHash: "sha256:first" })
    await expect(store.writeDraft(scopeFor("task-b", "call-b"), { baseArtifactId: base.id, baseHash: base.hash, content: "draft2", constraints: {}, expectedPreviousHash: "sha256:stale", requestHash: "sha256:second" })).rejects.toMatchObject({ code: "precondition_failed" })
    expect(first.version).toBe(1)
  })
})
