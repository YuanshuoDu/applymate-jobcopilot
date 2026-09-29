import { describe, expect, it } from "vitest"
import { createSelectedJobPreparation, InMemoryArtifactToolStore, createArtifactTools, type ArtifactToolExecutionContext, type ArtifactVersionRef } from "./artifact-tools.js"

const materials = [{ sourceRef: "job:job-a", content: { title: "Engineer" } }, { sourceRef: "resume:resume-a", content: { facts: ["TypeScript"] } }]
const prep = createSelectedJobPreparation("job-a", materials)
function context(overrides: Partial<ArtifactToolExecutionContext> = {}): ArtifactToolExecutionContext {
  const base = { scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "task-a", rootTaskId: "root-a", toolCallId: "call-a", selectedJobPreparation: prep, signal: new AbortController().signal, capabilities: [], reportProgress: async () => undefined, ...overrides }
  const taskFence = overrides.taskFence ?? { taskId: base.taskId, userId: base.scope.userId, sessionId: base.sessionId, turnId: base.turnId, rootTaskId: base.rootTaskId, parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 1 }
  return { ...base, taskFence } as ArtifactToolExecutionContext
}
function base(store: InMemoryArtifactToolStore) {
  return store.registerBase({ id: "cover-base", type: "cover_letter", userId: "user-a", jobId: "job-a", content: { text: "Base letter" } })
}
function draftInput(baseId: string, baseHash: string, content = "Dear Example") {
  return { baseArtifactId: baseId, baseHash, content, constraints: { maxWords: 300 } }
}
function tool(store: InMemoryArtifactToolStore, name: string) { return createArtifactTools(store).find(definition => definition.name === name)! }

describe("immutable selected-job artifact tools", () => {
  it("computes stable source digests independent of material ordering", () => {
    expect(createSelectedJobPreparation("job-a", materials).sourceDigest).toBe(createSelectedJobPreparation("job-a", [...materials].reverse()).sourceDigest)
    expect(createSelectedJobPreparation("job-b", materials).sourceDigest).not.toBe(prep.sourceDigest)
  })

  it("creates only a reference, binds server provenance, and returns the original immutable version on replay", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    const writer = tool(store, "cover_letter.draft")
    const first = await writer.execute(context(), draftInput(baseRow.id, baseRow.hash)) as { artifactRef: Record<string, unknown> }
    const replay = await writer.execute(context(), draftInput(baseRow.id, baseRow.hash)) as { artifactRef: Record<string, unknown> }
    expect(first).toEqual(replay)
    expect(Object.keys(first)).toEqual(["artifactRef"])
    const ref = first.artifactRef as { artifactId: string; version: number; contentHash: string; sourceDigest: string }
    const stored = await store.readVersion({ userId: "user-a", sessionId: "session-a", jobId: "job-a" }, ref)
    expect(stored).toMatchObject({ content: "Dear Example", sourceDigest: prep.sourceDigest, evidenceRefs: ["job:job-a", "resume:resume-a"], version: 1 })
    await expect(writer.execute(context({ toolCallId: "call-a" }), draftInput(baseRow.id, baseRow.hash, "different retry"))).rejects.toMatchObject({ code: "receipt_conflict" })
  })

  it("keeps old version content immutable when a new task creates the next version", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    const writer = tool(store, "cover_letter.draft")
    const first = await writer.execute(context(), draftInput(baseRow.id, baseRow.hash)) as { artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string } }
    const second = await writer.execute(context({ taskId: "task-b", toolCallId: "call-b" }), { ...draftInput(baseRow.id, baseRow.hash, "Updated letter"), expectedPreviousHash: first.artifactRef.contentHash }) as { artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string } }
    expect(second.artifactRef).toMatchObject({ artifactId: first.artifactRef.artifactId, version: 2 })
    await expect(store.readVersion({ userId: "user-a", sessionId: "session-a", jobId: "job-a" }, first.artifactRef)).resolves.toMatchObject({ version: 1, content: "Dear Example" })
  })

  it("lets Reviewer read an exact scoped version and persists a hash-bound review without returning findings", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    const writer = tool(store, "cover_letter.draft")
    const draft = await writer.execute(context(), draftInput(baseRow.id, baseRow.hash)) as { artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string } }
    const read = await tool(store, "artifact.version.read").execute(context({ taskId: "review-task", toolCallId: "read-call" }), { artifactRef: draft.artifactRef }) as Record<string, unknown>
    expect(read).toEqual({ artifactRef: draft.artifactRef, content: "Dear Example" })
    const finding = { id: "grammar", code: "grammar", severity: "info", message: "Clear", artifactHash: draft.artifactRef.contentHash, evidence: [{ artifactHash: draft.artifactRef.contentHash, path: "text", summary: "Opening is clear" }] }
    const reviewTool = tool(store, "artifact.review")
    const review = await reviewTool.execute(context({ taskId: "review-task", toolCallId: "review-call" }), { artifactRef: draft.artifactRef, decision: "passed", findings: [finding] }) as Record<string, unknown>
    expect(Object.keys(review).sort()).toEqual(["artifactRef", "reviewHash", "status"])
    expect(review).toMatchObject({ status: "passed", reviewHash: expect.stringMatching(/^sha256:/) })
    await expect(store.findReview({ userId: "user-a", sessionId: "session-a", jobId: "job-a" }, draft.artifactRef)).resolves.toMatchObject({ status: "passed", contentHash: draft.artifactRef.contentHash, sourceDigest: prep.sourceDigest, findings: [finding] })
    await expect(store.readVersion({ userId: "user-b", sessionId: "session-a", jobId: "job-a" }, draft.artifactRef)).resolves.toBeNull()
    await expect(store.readVersion({ userId: "user-a", sessionId: "session-b", jobId: "job-a" }, draft.artifactRef)).resolves.toBeNull()
  })

  it("persists stale reviews against the original version but strips findings after source changes", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    const draft = await tool(store, "cover_letter.draft").execute(context(), draftInput(baseRow.id, baseRow.hash)) as { artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string } }
    const changed = createSelectedJobPreparation("job-a", [...materials, { sourceRef: "persona:fact-2", content: "new fact" }])
    const finding = { id: "stale", code: "stale", severity: "warning", message: "Changed", artifactHash: draft.artifactRef.contentHash, evidence: [{ artifactHash: draft.artifactRef.contentHash, path: "text", summary: "Old source" }] }
    const reviewed = await tool(store, "artifact.review").execute(context({ taskId: "review-task", toolCallId: "review-call", selectedJobPreparation: changed }), { artifactRef: draft.artifactRef, decision: "passed", findings: [finding] }) as Record<string, unknown>
    expect(reviewed).toMatchObject({ status: "stale" })
    await expect(store.findReview({ userId: "user-a", sessionId: "session-a", jobId: "job-a" }, draft.artifactRef)).resolves.toMatchObject({ status: "stale", sourceDigest: prep.sourceDigest, currentSourceDigest: changed.sourceDigest, findings: [] })
  })

  it("fails closed when trusted task and selected-job scope are absent", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    await expect(tool(store, "cover_letter.draft").execute(context({ selectedJobPreparation: undefined }), draftInput(baseRow.id, baseRow.hash))).rejects.toMatchObject({ code: "precondition_failed" })
  })

  it.each([
    ["object", { text: "letter" }],
    ["empty", ""],
    ["whitespace", " \n "],
    ["oversized", "x".repeat(20_001)],
  ])("rejects %s draft bodies before persistence", async (_label, content) => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    await expect(tool(store, "cover_letter.draft").execute(context(), draftInput(baseRow.id, baseRow.hash, content as string)))
      .rejects.toMatchObject({ code: "precondition_failed" })
    await expect(store.listForUser("user-a", "job-a")).resolves.toHaveLength(1)
  })

  it("accepts a 20,000-character body and preserves the route-compatible string exactly", async () => {
    const store = new InMemoryArtifactToolStore()
    const baseRow = base(store)
    const content = ` ${"x".repeat(19_998)} `
    const result = await tool(store, "cover_letter.draft").execute(context(), draftInput(baseRow.id, baseRow.hash, content)) as { artifactRef: ArtifactVersionRef }
    await expect(store.readVersion({ userId: "user-a", sessionId: "session-a", jobId: "job-a" }, result.artifactRef)).resolves.toMatchObject({ content })
  })
})
