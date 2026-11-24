import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentArtifactReviewReceipt } from "../db/agent-artifact-repo.js"
import type { ObjectiveTailorWaveInventory } from "./subagents/objective-tailor-wave-inventory.js"
import type { ObjectiveTailorWaveCandidateWitness } from "./subagents/objective-tailor-wave-witness.js"
import type { LoadedGraph } from "./subagents/task-graph-pg-state.js"
import type { PoolClient } from "pg"
import type { selectedJobArtifactCompletionGateWithWitness } from "./selected-job-completion-gate.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys, parseObjectiveTailorCorrectionProof, verifyAndBindObjectiveTailorCorrectionProof } from "./subagents/objective-tailor-correction-proof.js"
import { readObjectiveTailorCorrectionCompletion } from "./subagents/objective-tailor-correction-completion.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection } from "./subagents/objective-tailor-wave-witness.js"

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), head: vi.fn(), receipt: vi.fn(), source: vi.fn(), material: vi.fn(), gate: vi.fn(), project: vi.fn() }))
vi.mock("./subagents/objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))
vi.mock("../db/agent-artifact-repo.js", () => ({ findCurrentDraftHeadWithClient: mocks.head, findReviewReceiptWithClient: mocks.receipt }))
vi.mock("./subagents/selected-job-artifact-context.js", () => ({ readSelectedJobSourceDigestWithClient: mocks.source }))
vi.mock("./subagents/scheduled-draft-job-material.js", () => ({ readCurrentScheduledDraftJobMaterialDigest: mocks.material }))
vi.mock("./selected-job-completion-gate.js", () => ({ selectedJobArtifactCompletionGateWithWitness: mocks.gate }))
vi.mock("./subagents/task-graph-result-projection.js", () => ({ projectTaskGraphResult: mocks.project }))

import { verifyCanonicalObjectiveTailorWaveCompletion, verifyCompletedObjectiveTailorWaveSlots } from "./canonical-objective-tailor-wave-completion.js"

const HASH = `sha256:${"a".repeat(64)}`
const changedHash = `sha256:${"b".repeat(64)}`
const user = "user-1", session = "session-1", turn = "turn-1", rootId = "root-1"

function witness(index: number, materialDigest = HASH): ObjectiveTailorWaveCandidateWitness {
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope: { userId: user, sessionId: session, turnId: turn, rootTaskId: rootId, parentTaskId: rootId },
    sourceGraphRevision: 1, sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
    candidate: { jobId: jobIdForIndex(index), score: 8, materialDigest }, sourceAnalystKey: `analyst-${index}` })!
  return bindObjectiveTailorWaveCandidateWitness(selection, { slotId: `tailor-${index}`, admittedRevision: 2 })!
}
function jobIdForIndex(index: number): string { return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }
function makeFixture(entries: { index: number; writerStatus?: string; reviewerStatus?: string; review?: string; material?: string; source?: string }[]) {
  const slots = entries.map(({ index }) => {
    const proof = witness(index)
    return { slotId: proof.slotId, jobId: proof.candidate.jobId, sourceAnalystNodeKey: `analyst-${index}`, witness: proof,
      writerTaskId: `writer-task-${index}`, reviewerTaskId: `reviewer-task-${index}` }
  })
  const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
    slots: slots.map(slot => ({ slotId: slot.slotId, sourceAnalystNodeKey: slot.sourceAnalystNodeKey,
      writerNodeKey: slot.witness.writerNodeKey, reviewerNodeKey: slot.witness.reviewerNodeKey })) }
  const nodes = [
    { key: "scout", taskId: "scout-task", templateId: "scout", goal: "search", successCriteria: [], dependsOn: [] },
    { key: "analyst-1", taskId: "analyst-task", templateId: "analyst", goal: "analyze", successCriteria: [], dependsOn: ["scout"] },
    ...slots.flatMap(slot => [
      { key: slot.witness.writerNodeKey, taskId: slot.writerTaskId, templateId: "cover_letter_writer", goal: "draft", successCriteria: [], dependsOn: [slot.sourceAnalystNodeKey] },
      { key: slot.witness.reviewerNodeKey, taskId: slot.reviewerTaskId, templateId: "cover_letter_reviewer", goal: "review", successCriteria: [], dependsOn: [slot.witness.writerNodeKey] },
    ]),
  ]
  const tasks = new Map<string, Record<string, unknown>>()
  const states = nodes.map(node => {
    const entry = entries.find(value => value.index === Number(node.key.match(/[0-9]+$/)?.[0]))
    const role = node.templateId === "cover_letter_writer" ? "writer" : node.templateId === "cover_letter_reviewer" ? "reviewer" : node.templateId
    const status = node.templateId === "cover_letter_writer" ? entry?.writerStatus ?? "completed"
      : node.templateId === "cover_letter_reviewer" ? entry?.reviewerStatus ?? "completed" : "completed"
    const reviewStatus = entry?.review ?? "passed"
    const task = { id: node.taskId, role, taskType: role, status, result: Number(node.key.match(/[0-9]+$/)?.[0]) }
    tasks.set(node.taskId, task)
    return { key: node.key, taskId: node.taskId, templateId: node.templateId, status, readiness: "ready", dependsOn: node.dependsOn }
  })
  const byJob = new Map(entries.map(value => [jobIdForIndex(value.index), value]))
  const loaded = { rootTaskId: rootId, item: { id: "graph-item", revision: 3, content: {}, createdAt: new Date(0) },
    snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", nodes, objectiveTailor: marker },
    state: { revision: 3, nodes: states, objectiveTailor: marker }, tasks, discoveryTurnEligibility: "ordinary" } as unknown as LoadedGraph
  const inventory = { graphRevision: 3, sourceNodeCount: 2, sourceGraphRevision: 1, sourceGraphDigest: "a".repeat(64),
    sourceStatusDigest: "b".repeat(64), sourceSnapshot: { nodes: nodes.slice(0, 2) }, occupiedSlots: slots,
    occupiedJobIds: slots.map(slot => slot.jobId), marker } as unknown as ObjectiveTailorWaveInventory
  mocks.inventory.mockResolvedValue(inventory)
  mocks.project.mockImplementation((role: string, _status: string, result: number) => {
    const index = result
    const ref = { artifactId: `artifact-${index}`, version: 1, contentHash: HASH, sourceDigest: HASH }
    const reviewStatus = byJob.get(jobIdForIndex(index))?.review ?? "passed"
    return role === "writer" ? { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available", role, status: "completed", artifactRef: ref }
      : { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "available", role, status: "completed", artifactRef: ref, reviewStatus, reviewHash: HASH }
  })
  mocks.source.mockImplementation(async (_client: unknown, _userId: string, selectedJobId: string) => byJob.get(selectedJobId)?.source ?? HASH)
  mocks.material.mockImplementation(async (_client: unknown, _userId: string, selectedJobId: string) => byJob.get(selectedJobId)?.material ?? HASH)
  mocks.head.mockImplementation(async (_client: unknown, scope: { artifactId: string }) => ({ artifactId: scope.artifactId, version: 1, contentHash: HASH, sourceDigest: HASH }))
  mocks.receipt.mockImplementation(async (_client: unknown, scope: Record<string, unknown>) => reviewReceipt(scope))
  mocks.gate.mockImplementation(async (input: Parameters<typeof selectedJobArtifactCompletionGateWithWitness>[0]) => {
    const index = Number(input.selectedJobId?.match(/[0-9]+$/)?.[0])
    const status = (byJob.get(input.selectedJobId ?? "")?.review ?? "passed") as AgentArtifactReviewReceipt["status"]
    const checkedReceipt = await input.readCurrentReviewReceipt?.({ userId: user, sessionId: session, jobId: jobIdForIndex(index),
      artifactId: `artifact-${index}`, version: 1, contentHash: HASH, sourceDigest: HASH,
      currentSourceDigest: HASH, status, taskId: `reviewer-task-${index}`, reviewHash: HASH })
    return checkedReceipt ? { ok: true, witness: { revision: 3, nodes: [] } }
      : { ok: false, blocker: "selected_job_draft_review_required", feedback: "Complete review." }
  })
  return { loaded, inventory, slots, entries }
}
function reviewReceipt(scope: Record<string, unknown>): AgentArtifactReviewReceipt {
  return { userId: user, sessionId: session, jobId: String(scope.jobId), artifactId: String(scope.artifactId), version: Number(scope.version),
    contentHash: String(scope.contentHash), sourceDigest: String(scope.sourceDigest), currentSourceDigest: String(scope.currentSourceDigest),
    status: scope.status as AgentArtifactReviewReceipt["status"], taskId: String(scope.taskId), toolCallId: "review-call", reviewHash: String(scope.reviewHash) }
}
function input(fixture: ReturnType<typeof makeFixture>, allowAbsent = false) {
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => sql.includes('FROM "agent_artifact_version"')
    ? ({ rows: [{ artifactId: values[3], artifactType: "cover_letter", taskId: values[5], version: values[4], contentHash: HASH, sourceDigest: HASH, previousHash: null }] })
    : ({ rows: [{ userId: values[0], sessionId: values[1], jobId: values[2], artifactId: values[3], version: values[4],
      contentHash: values[5], sourceDigest: values[6], currentSourceDigest: changedHash, status: "stale", taskId: values[7],
      toolCallId: "stale-call", reviewHash: values[8] }] })) } as unknown as PoolClient
  return { client, lease: { userId: user, sessionId: session, turnId: turn, ownerId: "owner-1", leaseVersion: 1,
    leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000) }, root: { id: rootId, attemptCount: 1 }, loaded: fixture.loaded,
    allowAbsent }
}
function addPendingCorrection(fixture: ReturnType<typeof makeFixture>, index: number) {
  const slot = fixture.slots[index - 1]!
  const proof = bindObjectiveTailorCorrectionProof({ graphRevision: 3, slotId: slot.slotId, candidateWitness: slot.witness,
    writerTaskId: slot.writerTaskId, reviewerTaskId: slot.reviewerTaskId,
    artifactRef: { artifactId: `artifact-${index}`, version: 1, contentHash: HASH, sourceDigest: HASH },
    artifactVersion: { artifactId: `artifact-${index}`, artifactType: "cover_letter", taskId: slot.writerTaskId,
      version: 1, contentHash: HASH, sourceDigest: HASH, previousHash: null },
    reviewReceipt: { jobId: slot.jobId, artifactId: `artifact-${index}`, version: 1, contentHash: HASH,
      sourceDigest: HASH, currentSourceDigest: HASH, status: "needs_revision", taskId: slot.reviewerTaskId,
      toolCallId: "prior-review", reviewHash: HASH } })!
  const keys = objectiveTailorCorrectionNodeKeys(slot.slotId)!, writerTaskId = `writer-correction-${index}`, reviewerTaskId = `reviewer-correction-${index}`
  const correction = { proof, writerTaskId, reviewerTaskId }
  const oldMarker = fixture.inventory.marker!
  const marker = { ...oldMarker, slots: oldMarker.slots.map((item, slotIndex) => slotIndex === index - 1 ? { ...item, correction: keys } : item) }
  const writerNode = { key: keys.writerNodeKey, taskId: writerTaskId, templateId: "cover_letter_writer", goal: "correct",
    successCriteria: [], dependsOn: [slot.witness.reviewerNodeKey] }
  const reviewerNode = { key: keys.reviewerNodeKey, taskId: reviewerTaskId, templateId: "cover_letter_reviewer", goal: "review",
    successCriteria: [], dependsOn: [keys.writerNodeKey] }
  const loaded = fixture.loaded as unknown as { item: { revision: number }; snapshot: { nodes: unknown[]; objectiveTailor: unknown }; state: { revision: number; nodes: unknown[]; objectiveTailor: unknown }; tasks: Map<string, unknown> }
  loaded.item.revision = 4
  loaded.snapshot.objectiveTailor = marker; loaded.snapshot.nodes.push(writerNode, reviewerNode)
  loaded.state.revision = 4; loaded.state.objectiveTailor = marker
  loaded.state.nodes.push({ key: writerNode.key, taskId: writerTaskId, templateId: writerNode.templateId, status: "running", readiness: "ready", dependsOn: writerNode.dependsOn },
    { key: reviewerNode.key, taskId: reviewerTaskId, templateId: reviewerNode.templateId, status: "queued", readiness: "waiting", dependsOn: reviewerNode.dependsOn })
  loaded.tasks.set(writerTaskId, { id: writerTaskId, role: "writer", taskType: "cover_letter_draft", status: "running", result: null })
  loaded.tasks.set(reviewerTaskId, { id: reviewerTaskId, role: "reviewer", taskType: "cover_letter_review", status: "queued", result: null })
  const inventory = fixture.inventory as unknown as { graphRevision: number; marker: typeof fixture.inventory.marker; occupiedSlots: Array<typeof fixture.inventory.occupiedSlots[number]> }
  inventory.graphRevision = 4
  inventory.marker = marker as typeof inventory.marker
  inventory.occupiedSlots[index - 1] = { ...slot, correction }
  return { proof, writerTaskId, reviewerTaskId }
}
beforeEach(() => { vi.clearAllMocks() })

describe("canonical Objective Tailor V2 terminal evidence", () => {
  it("rebuilds only selected completed slots without a source Turn lease", async () => {
    const fixture = makeFixture([{ index: 1 }, { index: 2, source: changedHash }]), args = input(fixture)
    const result = await verifyCompletedObjectiveTailorWaveSlots({ client: args.client as PoolClient,
      scope: { userId: user, sessionId: session, turnId: turn, rootTaskId: rootId, parentTaskId: rootId },
      loaded: fixture.loaded, selectedSlotIds: ["tailor-1"] })
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes.map(value => [value.slotId, value.status])).toEqual([["tailor-1", "ready"]])
    expect(mocks.source.mock.calls.every(call => call[2] === jobIdForIndex(1))).toBe(true)
  })

  it("fails closed for noncanonical, duplicate, or unknown selected slot identities", async () => {
    const fixture = makeFixture([{ index: 1 }, { index: 2 }]), client = input(fixture).client as PoolClient
    const scope = { userId: user, sessionId: session, turnId: turn, rootTaskId: rootId, parentTaskId: rootId }
    for (const selectedSlotIds of [["tailor-2", "tailor-1"], ["tailor-1", "tailor-1"], ["tailor-3"]]) {
      await expect(verifyCompletedObjectiveTailorWaveSlots({ client, scope, loaded: fixture.loaded, selectedSlotIds })).resolves.toMatchObject({ status: "blocked" })
    }
  })

  it("keeps slot outcomes independent and in marker order", async () => {
    const fixture = makeFixture([
      { index: 1, review: "passed" }, { index: 2, source: changedHash }, { index: 3, review: "needs_revision" },
      { index: 4, review: "rejected" }, { index: 5, writerStatus: "failed", reviewerStatus: "failed" },
    ])
    const args = input(fixture)
    const result = await verifyCanonicalObjectiveTailorWaveCompletion(args)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes.map(item => [item.slotId, item.status])).toEqual([
      ["tailor-1", "ready"], ["tailor-2", "stale"], ["tailor-3", "needs_revision"],
      ["tailor-4", "rejected"], ["tailor-5", "failed"],
    ])
    expect(result.outcomes[2]?.artifactVersion?.previousHash).toBeNull()
    expect(result.outcomes[2]?.reviewReceipt?.toolCallId).toBe("review-call")
    expect(mocks.inventory).toHaveBeenCalledWith(args.client, expect.objectContaining({ userId: user, rootTaskId: rootId }), fixture.loaded)
  })

  it("keeps a failed pair pending while its sibling task is still active", async () => {
    const fixture = makeFixture([{ index: 1, writerStatus: "failed", reviewerStatus: "running" }])
    const result = await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture))
    expect(result.status).toBe("pending")
    if (result.status !== "pending") return
    expect(result.outcomes[0]?.status).toBe("pending")
  })

  it("still issues a distinct needs-revision slot proof while a prior slot correction is pending", async () => {
    const fixture = makeFixture([{ index: 1 }, { index: 2, review: "needs_revision" }])
    const correction = addPendingCorrection(fixture, 1), args = input(fixture)
    expect(parseObjectiveTailorCorrectionProof(correction.proof)).toBeDefined()
    expect(fixture.loaded.item?.revision).toBe(4)
    const direct = await readObjectiveTailorCorrectionCompletion({ client: args.client as PoolClient, lease: args.lease,
      root: args.root, loaded: fixture.loaded, scope: { userId: user, sessionId: session, turnId: turn, rootTaskId: rootId, parentTaskId: rootId },
      slot: fixture.inventory.occupiedSlots[0]! })
    expect(direct).toMatchObject({ status: "pending", writerTaskId: correction.writerTaskId })
    const pending = await verifyCanonicalObjectiveTailorWaveCompletion(args)
    expect(pending).toMatchObject({ status: "pending" })
    if (pending.status !== "pending") return
    expect(pending.outcomes.map(value => [value.slotId, value.status, value.writerTaskId])).toEqual([
      ["tailor-1", "pending", correction.writerTaskId], ["tailor-2", "needs_revision", "writer-task-2"],
    ])
    const next = await verifyAndBindObjectiveTailorCorrectionProof({ client: args.client as never, lease: args.lease,
      root: args.root, loaded: fixture.loaded, slotId: "tailor-2", expectedRevision: 4 })
    expect(next).toMatchObject({ slotId: "tailor-2", prior: { reviewerTaskId: "reviewer-task-2" } })
  })

  it("blocks a final read when one slot's material changes after candidate acceptance", async () => {
    const fixture = makeFixture([{ index: 1 }, { index: 2 }])
    const args = input(fixture)
    const accepted = await verifyCanonicalObjectiveTailorWaveCompletion(args)
    expect(accepted.status).toBe("ready")
    if (accepted.status !== "ready") return
    const entry = fixture.entries[1]
    if (!entry) throw new Error("test fixture entry missing")
    entry.source = changedHash
    const final = await verifyCanonicalObjectiveTailorWaveCompletion({ ...args, acceptedWitness: accepted.witness })
    expect(final.status).toBe("blocked")
    if (final.status !== "blocked") return
    expect(final.outcomes[1]?.status).toBe("stale")
  })

  it("keeps a stale receipt stale even when the live source digest returns to its earlier value", async () => {
    const fixture = makeFixture([{ index: 1, review: "stale" }])
    const args = input(fixture)
    const result = await verifyCanonicalObjectiveTailorWaveCompletion(args)
    expect(result).toMatchObject({ status: "ready" })
    if (result.status !== "ready") return
    expect(result.outcomes[0]?.status).toBe("stale")
  })

  it.each(["missing", "newer"] as const)("isolates an unchanged-source %s draft head to its own slot", async drift => {
    const fixture = makeFixture([{ index: 1 }, { index: 2 }])
    const actual = await vi.importActual<typeof import("./selected-job-completion-gate.js")>("./selected-job-completion-gate.js")
    mocks.gate.mockImplementation(actual.selectedJobArtifactCompletionGateWithWitness)
    mocks.head.mockImplementation(async (_client: unknown, scope: { artifactId: string }) => scope.artifactId === "artifact-1"
      ? drift === "missing" ? null : { artifactId: "artifact-1", version: 2, contentHash: changedHash, sourceDigest: HASH }
      : { artifactId: scope.artifactId, version: 1, contentHash: HASH, sourceDigest: HASH })
    const result = await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture))
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.outcomes.map(value => [value.slotId, value.status])).toEqual([["tailor-1", "stale"], ["tailor-2", "ready"]])
  })

  it("requires explicit absence and blocks correction or ambiguous inventory", async () => {
    const fixture = makeFixture([])
    mocks.inventory.mockResolvedValueOnce({ ...fixture.inventory, marker: null, occupiedSlots: [] })
    expect((await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture, true))).status).toBe("absent")
    mocks.inventory.mockResolvedValueOnce({ ...fixture.inventory, marker: null, occupiedSlots: [] })
    expect((await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture))).status).toBe("blocked")
    mocks.inventory.mockResolvedValueOnce({ ...fixture.inventory, marker: { ...fixture.inventory.marker, slots: [{ correction: {} }] } })
    expect((await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture))).status).toBe("blocked")
    mocks.inventory.mockResolvedValueOnce(undefined)
    expect((await verifyCanonicalObjectiveTailorWaveCompletion(input(fixture))).status).toBe("blocked")
  })
})
