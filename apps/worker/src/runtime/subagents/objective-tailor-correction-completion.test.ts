import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentArtifactReviewReceipt } from "../../db/agent-artifact-repo.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-proof.js"
import { makeObjectiveTailorWaveCandidateSelection, bindObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { readObjectiveTailorCorrectionCompletion } from "./objective-tailor-correction-completion.js"
import type { ObjectiveTailorWaveOccupiedSlot } from "./objective-tailor-wave-inventory.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import type { TurnLease } from "../turns/lease.js"
import type { PoolClient } from "pg"

const mocks = vi.hoisted(() => ({ source: vi.fn(), material: vi.fn(), head: vi.fn(), receipt: vi.fn(), gate: vi.fn(), project: vi.fn() }))
vi.mock("../../db/agent-artifact-repo.js", () => ({ findCurrentDraftHeadWithClient: mocks.head, findReviewReceiptWithClient: mocks.receipt }))
vi.mock("./selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: mocks.source }))
vi.mock("./scheduled-draft-job-material.js", () => ({ readCurrentScheduledDraftJobMaterialDigest: mocks.material }))
vi.mock("../selected-job-completion-gate.js", () => ({ selectedJobArtifactCompletionGateWithWitness: mocks.gate }))
vi.mock("./task-graph-result-projection.js", () => ({ projectTaskGraphResult: mocks.project }))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const lease: TurnLease = { ...scope, ownerId: "owner-1", leaseVersion: 2, leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000) }
const hash = `sha256:${"a".repeat(64)}`, nextHash = `sha256:${"b".repeat(64)}`
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

function fixture(writerStatus = "completed", reviewerStatus = "completed", reviewStatus = "passed") {
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "1".repeat(64),
    sourceStatusDigest: "2".repeat(64), analystProofDigest: "3".repeat(64), candidate: { jobId, score: 8, materialDigest: hash },
    sourceAnalystKey: "analyst-1" })!
  const witness = bindObjectiveTailorWaveCandidateWitness(selection, { slotId: "tailor-1", admittedRevision: 2 })!
  const keys = objectiveTailorCorrectionNodeKeys(witness.slotId)!
  const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 3, slotId: witness.slotId, candidateWitness: witness,
    writerTaskId: "writer-initial", reviewerTaskId: "reviewer-initial",
    artifactRef: { artifactId: "artifact-1", version: 1, contentHash: hash, sourceDigest: hash },
    artifactVersion: { artifactId: "artifact-1", artifactType: "cover_letter", taskId: "writer-initial", version: 1,
      contentHash: hash, sourceDigest: hash, previousHash: null },
    reviewReceipt: { jobId, artifactId: "artifact-1", version: 1, contentHash: hash, sourceDigest: hash,
      currentSourceDigest: hash, status: "needs_revision", taskId: "reviewer-initial", toolCallId: "prior-review", reviewHash: hash } })!
  const correction = { proof, writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction" }
  const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
    slots: [{ slotId: witness.slotId, sourceAnalystNodeKey: "analyst-1", writerNodeKey: witness.writerNodeKey,
      reviewerNodeKey: witness.reviewerNodeKey, correction: keys }] }
  const nodes = [
    { key: "scout-1", taskId: "scout-task", templateId: "scout", goal: "search", successCriteria: [], dependsOn: [] },
    { key: "analyst-1", taskId: "analyst-task", templateId: "analyst", goal: "analyze", successCriteria: [], dependsOn: ["scout-1"] },
    { key: witness.writerNodeKey, taskId: "writer-initial", templateId: "cover_letter_writer", goal: "draft", successCriteria: [], dependsOn: ["analyst-1"] },
    { key: witness.reviewerNodeKey, taskId: "reviewer-initial", templateId: "cover_letter_reviewer", goal: "review", successCriteria: [], dependsOn: [witness.writerNodeKey] },
    { key: keys.writerNodeKey, taskId: correction.writerTaskId, templateId: "cover_letter_writer", goal: "correct", successCriteria: [], dependsOn: [witness.reviewerNodeKey] },
    { key: keys.reviewerNodeKey, taskId: correction.reviewerTaskId, templateId: "cover_letter_reviewer", goal: "re-review", successCriteria: [], dependsOn: [keys.writerNodeKey] },
  ]
  const states = nodes.map(node => ({ key: node.key, taskId: node.taskId, templateId: node.templateId,
    status: node.taskId === correction.writerTaskId ? writerStatus : node.taskId === correction.reviewerTaskId ? reviewerStatus : "completed",
    readiness: "terminal", dependsOn: node.dependsOn }))
  const tasks = new Map(nodes.map(node => [node.taskId, { id: node.taskId,
    role: node.templateId === "cover_letter_writer" ? "writer" : node.templateId === "cover_letter_reviewer" ? "reviewer" : node.templateId,
    taskType: node.templateId === "cover_letter_writer" ? "cover_letter_draft" : node.templateId === "cover_letter_reviewer" ? "cover_letter_review" : node.templateId,
    status: states.find(state => state.taskId === node.taskId)?.status, result: node.taskId === correction.writerTaskId ? "correction-writer" : "correction-reviewer" }]))
  const loaded = { rootTaskId: scope.rootTaskId, item: { revision: 4 }, snapshot: { schemaVersion: "agent-harness.v2.task-graph", nodes, objectiveTailor: marker },
    state: { revision: 4, nodes: states, objectiveTailor: marker }, tasks } as unknown as LoadedGraph
  const slot: ObjectiveTailorWaveOccupiedSlot = { slotId: witness.slotId, jobId, sourceAnalystNodeKey: "analyst-1", witness,
    writerTaskId: "writer-initial", reviewerTaskId: "reviewer-initial", correction }
  const ref = { artifactId: "artifact-1", version: 2, contentHash: nextHash, sourceDigest: hash }
  const version = { ...ref, artifactType: "cover_letter" as const, taskId: correction.writerTaskId, previousHash: hash }
  const receipt: AgentArtifactReviewReceipt = { userId: scope.userId, sessionId: scope.sessionId, jobId, ...ref,
    currentSourceDigest: hash, status: reviewStatus as AgentArtifactReviewReceipt["status"], taskId: correction.reviewerTaskId,
    toolCallId: "correction-review", reviewHash: nextHash }
  const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_artifact_version"') ? [version] : [] })) } as unknown as PoolClient
  mocks.project.mockImplementation((role: string, status: string, result: string) => ({
    schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available", role, status,
    artifactRef: ref, ...(role === "reviewer" ? { reviewStatus, reviewHash: nextHash } : {}),
  }))
  mocks.source.mockResolvedValue(hash); mocks.material.mockResolvedValue(hash)
  mocks.head.mockResolvedValue(ref)
  mocks.receipt.mockResolvedValue(receipt)
  mocks.gate.mockImplementation(async (input: { readCurrentReviewReceipt: (value: unknown) => Promise<unknown> }) => {
    const checked = await input.readCurrentReviewReceipt({ userId: scope.userId, sessionId: scope.sessionId, jobId,
      artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest,
      currentSourceDigest: hash, status: reviewStatus, taskId: correction.reviewerTaskId, reviewHash: nextHash })
    return checked ? { ok: true, witness: { revision: 4, nodes: [] } } : { ok: false, blocker: "selected_job_draft_review_required", feedback: "Review needed." }
  })
  return { client, loaded, slot, proof, correction, ref, version, receipt, nodes }
}

beforeEach(() => vi.clearAllMocks())

describe("objective tailor correction completion", () => {
  it("requires the effective successor pair, exact v+1 lineage and current review receipt", async () => {
    const value = fixture()
    const actual = await vi.importActual<typeof import("../selected-job-completion-gate.js")>("../selected-job-completion-gate.js")
    mocks.gate.mockImplementation(actual.selectedJobArtifactCompletionGateWithWitness)
    const outcome = await readObjectiveTailorCorrectionCompletion({ client: value.client, lease, root: { id: "root-1", attemptCount: 1 },
      loaded: value.loaded, scope, slot: value.slot })
    expect(outcome).toMatchObject({ status: "ready", writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction",
      artifactRef: value.ref, artifactVersion: { ...value.version }, reviewReceipt: { taskId: "reviewer-correction", status: "passed" },
      correction: { proof: value.proof, writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction" } })
    expect(value.client.query).toHaveBeenCalledWith(expect.stringContaining('FROM "agent_artifact_version"'),
      [scope.userId, scope.sessionId, jobId, value.ref.artifactId, value.ref.version, "writer-correction"])
    expect(mocks.gate).toHaveBeenCalledOnce()
  })

  it("keeps a partial correction pending and never falls back to the initial needs-revision pair", async () => {
    const value = fixture("completed", "running")
    const outcome = await readObjectiveTailorCorrectionCompletion({ client: value.client, lease, root: { id: "root-1", attemptCount: 1 },
      loaded: value.loaded, scope, slot: value.slot })
    expect(outcome).toMatchObject({ status: "pending", writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction" })
    expect(outcome?.writerTaskId).not.toBe(value.slot.writerTaskId)
    expect(mocks.project).not.toHaveBeenCalled()
  })

  it.each(["version", "artifact", "previousHash", "source"] as const)("rejects correction lineage drift in %s", async mutation => {
    const value = fixture()
    const altered = { ...value.version, ...(mutation === "version" ? { version: 3 }
      : mutation === "artifact" ? { artifactId: "foreign-artifact" }
      : mutation === "previousHash" ? { previousHash: nextHash } : { sourceDigest: nextHash }) }
    const client = { query: vi.fn(async () => ({ rows: [altered] })) } as unknown as PoolClient
    await expect(readObjectiveTailorCorrectionCompletion({ client, lease, root: { id: "root-1", attemptCount: 1 },
      loaded: value.loaded, scope, slot: value.slot })).resolves.toBeUndefined()
    expect(mocks.gate).not.toHaveBeenCalled()
  })

  it("reports a persisted but now stale successor without reopening the old pair", async () => {
    const value = fixture(), changed = `sha256:${"9".repeat(64)}`
    mocks.source.mockResolvedValue(changed)
    const outcome = await readObjectiveTailorCorrectionCompletion({ client: value.client, lease, root: { id: "root-1", attemptCount: 1 },
      loaded: value.loaded, scope, slot: value.slot })
    expect(outcome).toMatchObject({ status: "stale", writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction" })
    expect(mocks.gate).not.toHaveBeenCalled()
  })

  it("reports a changed scoped successor head as stale after exact proof checks", async () => {
    const value = fixture()
    const actual = await vi.importActual<typeof import("../selected-job-completion-gate.js")>("../selected-job-completion-gate.js")
    mocks.gate.mockImplementation(actual.selectedJobArtifactCompletionGateWithWitness)
    mocks.head.mockResolvedValue({ ...value.ref, version: 3, contentHash: nextHash })
    const outcome = await readObjectiveTailorCorrectionCompletion({ client: value.client, lease, root: { id: "root-1", attemptCount: 1 },
      loaded: value.loaded, scope, slot: value.slot })
    expect(outcome).toMatchObject({ status: "stale", writerTaskId: "writer-correction", reviewerTaskId: "reviewer-correction",
      artifactVersion: value.version, reviewReceipt: { taskId: "reviewer-correction", status: "passed" } })
    expect(mocks.gate).toHaveBeenCalledOnce()
    expect(mocks.source).toHaveBeenCalledTimes(3)
    expect(mocks.material).toHaveBeenCalledTimes(2)
  })
})
