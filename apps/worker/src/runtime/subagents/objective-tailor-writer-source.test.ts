import { beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { bindObjectiveTailorCandidateWitness, makeObjectiveTailorCandidateSelection } from "./objective-tailor-witness.js"
import { objectiveTailorNodeKeysForCandidate, objectiveTailorPlan } from "./objective-task-graph-child-authority.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection,
  objectiveTailorWavePairPlan } from "./objective-tailor-wave-witness.js"
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-proof.js"
import { loadObjectiveTailorChildSource } from "./objective-tailor-writer-source.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import type { SubagentLease } from "./types.js"

const mocks = vi.hoisted(() => ({ binding: vi.fn(), waveInventory: vi.fn(), source: vi.fn(), readMaterial: vi.fn(), digest: vi.fn() }))
vi.mock("./objective-tailor-current-binding.js", () => ({ readCurrentObjectiveTailorBinding: mocks.binding }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.waveInventory }))
vi.mock("./selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext: mocks.source }))
vi.mock("./scheduled-draft-job-material.js", () => ({
  readCurrentScheduledDraftJobMaterialDigest: mocks.readMaterial, scheduledDraftJobMaterialDigest: mocks.digest,
}))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479", materialDigest = `sha256:${"d".repeat(64)}`
const selection = makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: 4, sourceGraphDigest: "a".repeat(64),
  sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64), candidate: { jobId, score: 8, materialDigest }, sourceAnalystKeys: ["analyst-node"] })!
const witness = bindObjectiveTailorCandidateWitness(selection, { ...objectiveTailorNodeKeysForCandidate(selection.candidateRef)!, admittedRevision: 5 })!
const plan = objectiveTailorPlan(witness)!
const waveSelection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 4, sourceGraphDigest: "a".repeat(64),
  sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
  candidate: { jobId, score: 8, materialDigest }, sourceAnalystKey: "analyst-node" })!
const waveWitness = bindObjectiveTailorWaveCandidateWitness(waveSelection, { slotId: "tailor-1", admittedRevision: 5 })!
const wavePlan = objectiveTailorWavePairPlan(waveWitness)!
const loaded = {} as LoadedGraph
const waveLoaded = { rootTaskId: scope.rootTaskId,
  snapshot: { objectiveTailor: { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2, slots: [] } },
  state: { objectiveTailor: { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2, slots: [] } } } as unknown as LoadedGraph
const source = { preparation: { jobId, sourceDigest: `sha256:${"e".repeat(64)}`, evidenceRefs: ["job"] }, baseResumeId: "resume-1",
  transientSources: [{ sourceRef: `job:${jobId}`, content: { id: jobId, company: "Acme" } }] }

function fixture(role: "writer" | "reviewer" = "writer") {
  const writer = role === "writer", taskId = writer ? "writer-task" : "reviewer-task"
  const taskType = writer ? "cover_letter_draft" : "cover_letter_review"
  const context = plan.templates[writer ? "cover_letter_writer" : "cover_letter_reviewer"]!.context
  const lease = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType, status: "running", attemptCount: 2, maxAttempts: 3,
    leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date(0), interruptRequestedAt: null, signal: new AbortController().signal,
    context, goal: "", path: "root.0", depth: 1, constraints: [], successCriteria: [], allowedActions: [], expectedOutputSchema: {},
    result: null, failureReason: null, budgetSnapshot: null, toolPolicySnapshot: null } as unknown as SubagentLease
  const row = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType, status: "running", attemptCount: 2, leaseOwner: "worker-1",
    interruptRequestedAt: null, context }
  const client = { query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row], rowCount: 1 })) }
  mocks.binding.mockResolvedValue({ status: "bound", witness, writerTaskId: "writer-task", reviewerTaskId: "reviewer-task" })
  mocks.source.mockResolvedValue(source)
  mocks.digest.mockReturnValue(materialDigest)
  mocks.readMaterial.mockResolvedValue(materialDigest)
  return { client, row, lease, context }
}

function waveFixture(role: "writer" | "reviewer" = "writer") {
  const writer = role === "writer", taskId = writer ? "wave-writer-task" : "wave-reviewer-task"
  const nodeKey = writer ? waveWitness.writerNodeKey : waveWitness.reviewerNodeKey
  const context = wavePlan.templatesByNodeKey.get(nodeKey)!.context
  const lease = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType: writer ? "cover_letter_draft" : "cover_letter_review", status: "running",
    attemptCount: 1, maxAttempts: 2, leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000),
    interruptRequestedAt: null, signal: new AbortController().signal, context, goal: "", path: "root.0", depth: 1,
    constraints: [], successCriteria: [], allowedActions: [], expectedOutputSchema: {}, result: null, failureReason: null,
    budgetSnapshot: null, toolPolicySnapshot: null } as unknown as SubagentLease
  const row = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType: lease.taskType, status: "running", attemptCount: 1, leaseOwner: "worker-1",
    interruptRequestedAt: null, context }
  const client = { query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row], rowCount: 1 })) }
  const exactSlot = { slotId: "tailor-1", jobId, sourceAnalystNodeKey: "analyst-node", witness: waveWitness,
    writerTaskId: "wave-writer-task", reviewerTaskId: "wave-reviewer-task" }
  mocks.waveInventory.mockResolvedValue({ marker: waveLoaded.snapshot!.objectiveTailor, occupiedSlots: [exactSlot,
    { ...exactSlot, slotId: "tailor-2", jobId: "other-job", writerTaskId: "other-writer", reviewerTaskId: "other-reviewer" }] })
  mocks.source.mockResolvedValue(source)
  mocks.digest.mockReturnValue(materialDigest)
  mocks.readMaterial.mockResolvedValue(materialDigest)
  return { client, row, lease, context }
}

const correctionKeys = objectiveTailorCorrectionNodeKeys("tailor-1")!
const correctionProof = bindObjectiveTailorCorrectionProof({ graphRevision: 5, slotId: "tailor-1", candidateWitness: waveWitness,
  writerTaskId: "wave-writer-task", reviewerTaskId: "wave-reviewer-task",
  artifactRef: { artifactId: "artifact-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: materialDigest },
  artifactVersion: { artifactId: "artifact-1", artifactType: "cover_letter", taskId: "wave-writer-task", version: 2,
    contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: materialDigest, previousHash: `sha256:${"b".repeat(64)}` },
  reviewReceipt: { jobId, artifactId: "artifact-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`,
    sourceDigest: materialDigest, currentSourceDigest: materialDigest, status: "needs_revision", taskId: "wave-reviewer-task",
    toolCallId: "review-call", reviewHash: `sha256:${"c".repeat(64)}` } })!

function correctionWaveFixture(role: "writer" | "reviewer" = "writer") {
  const writer = role === "writer", taskId = writer ? "wave-correction-writer" : "wave-correction-reviewer"
  const base = wavePlan.templatesByNodeKey.get(writer ? waveWitness.writerNodeKey : waveWitness.reviewerNodeKey)!.context as Record<string, unknown>
  const context = { ...base, objectiveTailorCorrectionProof: correctionProof }
  const lease = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType: writer ? "cover_letter_draft" : "cover_letter_review", status: "running",
    attemptCount: 1, maxAttempts: 2, leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000),
    interruptRequestedAt: null, signal: new AbortController().signal, context, goal: "", path: "root.0", depth: 1,
    constraints: [], successCriteria: [], allowedActions: [], expectedOutputSchema: {}, result: null, failureReason: null,
    budgetSnapshot: null, toolPolicySnapshot: null } as unknown as SubagentLease
  const row = { id: taskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentTaskId, role, taskType: lease.taskType, status: "running", attemptCount: 1, leaseOwner: "worker-1",
    interruptRequestedAt: null, context }
  const client = { query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row], rowCount: 1 })) }
  const correction = { proof: correctionProof, writerTaskId: "wave-correction-writer", reviewerTaskId: "wave-correction-reviewer" }
  const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2,
    slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst-node", writerNodeKey: waveWitness.writerNodeKey,
      reviewerNodeKey: waveWitness.reviewerNodeKey, correction: correctionKeys }] }
  const nodes = [
    { key: waveWitness.writerNodeKey, taskId: "wave-writer-task", templateId: "cover_letter_writer", dependsOn: [] },
    { key: waveWitness.reviewerNodeKey, taskId: "wave-reviewer-task", templateId: "cover_letter_reviewer", dependsOn: [waveWitness.writerNodeKey] },
    { key: correctionKeys.writerNodeKey, taskId: correction.writerTaskId, templateId: "cover_letter_writer", dependsOn: [waveWitness.reviewerNodeKey] },
    { key: correctionKeys.reviewerNodeKey, taskId: correction.reviewerTaskId, templateId: "cover_letter_reviewer", dependsOn: [correctionKeys.writerNodeKey] },
  ]
  const taskRows = new Map(nodes.map(node => [node.taskId, { id: node.taskId,
    role: node.templateId === "cover_letter_writer" ? "writer" : "reviewer", status: node.taskId === correction.writerTaskId ? "running" : "completed",
    taskType: node.templateId === "cover_letter_writer" ? "cover_letter_draft" : "cover_letter_review" }]))
  const loaded = { ...waveLoaded, item: { revision: 6 }, snapshot: { ...waveLoaded.snapshot!, nodes, objectiveTailor: marker },
    state: { ...waveLoaded.state!, revision: 6, nodes: nodes.map(node => ({ ...node, status: taskRows.get(node.taskId)?.status })) },
    tasks: taskRows } as unknown as LoadedGraph
  mocks.waveInventory.mockResolvedValue({ marker,
    occupiedSlots: [{ slotId: "tailor-1", jobId, sourceAnalystNodeKey: "analyst-node", witness: waveWitness,
      writerTaskId: "wave-writer-task", reviewerTaskId: "wave-reviewer-task", correction }] })
  mocks.source.mockResolvedValue(source)
  mocks.digest.mockReturnValue(materialDigest)
  mocks.readMaterial.mockResolvedValue(materialDigest)
  return { client, lease, context, loaded }
}

beforeEach(() => vi.clearAllMocks())

describe("Objective tailor child source", () => {
  it("admits the exact live Writer attempt and rechecks material under the artifact client", async () => {
    const { client, lease } = fixture()
    const result = await loadObjectiveTailorChildSource(client as never, scope, loaded, lease)
    expect(result?.context).toBe(source)
    expect(result?.assertCurrentDraftMaterial).toBeTypeOf("function")
    expect(await result!.assertCurrentDraftMaterial!(client as never, scope.userId, jobId)).toBe(true)
    expect(mocks.binding).toHaveBeenCalledWith(client, scope, loaded)
    expect(mocks.source).toHaveBeenCalledWith(client, scope.userId, jobId)
    expect(mocks.readMaterial).toHaveBeenCalledWith(client, scope.userId, jobId)
    const [sql, params] = client.query.mock.calls[0]!
    expect(sql).toContain('session."userId" AS "userId"')
    expect(sql).not.toContain('task."userId"')
    expect(sql).toContain('root."rootTaskId" = root."id"')
    expect(sql).toContain('root."interruptRequestedAt" IS NULL')
    expect(sql).toContain('turn."status" NOT IN')
    expect(params).toEqual([scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, lease.id, scope.parentTaskId,
      "writer", "cover_letter_draft", lease.attemptCount, lease.ownerId])
  })

  it("resolves Reviewer source without granting a Writer material-commit callback", async () => {
    const { client, lease } = fixture("reviewer")
    const result = await loadObjectiveTailorChildSource(client as never, scope, loaded, lease)
    expect(result).toEqual({ context: source })
  })

  it.each(["wrong task owner", "stale attempt", "wrong role", "interrupted lease", "wrong context"]) ("rejects %s before loading Job material", async failure => {
    const { client, row, lease } = fixture()
    if (failure === "wrong task owner") row.sessionId = "foreign-session"
    if (failure === "stale attempt") row.attemptCount++
    if (failure === "wrong role") lease.role = "analyst"
    if (failure === "interrupted lease") lease.interruptRequestedAt = new Date()
    if (failure === "wrong context") lease.context = { ...plan.templates.cover_letter_writer!.context as object, selectedJobPreparation: { jobId: "other-job" } }
    await expect(loadObjectiveTailorChildSource(client as never, scope, loaded, lease)).resolves.toBeUndefined()
    expect(mocks.source).not.toHaveBeenCalled()
  })

  it.each(["invalid binding", "stale Job", "duplicate Job source", "missing Job source"]) ("fails closed for %s", async failure => {
    const { client, lease } = fixture()
    if (failure === "invalid binding") mocks.binding.mockResolvedValue({ status: "invalid" })
    if (failure === "stale Job") mocks.digest.mockReturnValue(`sha256:${"f".repeat(64)}`)
    if (failure === "duplicate Job source") mocks.source.mockResolvedValue({ ...source,
      transientSources: [...source.transientSources, ...source.transientSources] })
    if (failure === "missing Job source") mocks.source.mockResolvedValue({ ...source,
      transientSources: source.transientSources.filter(item => item.sourceRef !== `job:${jobId}`) })
    await expect(loadObjectiveTailorChildSource(client as never, scope, loaded, lease)).resolves.toBeUndefined()
    expect(mocks.readMaterial).not.toHaveBeenCalled()
  })

  it("does not allow a changed material through the artifact callback", async () => {
    const { client, lease } = fixture()
    const result = await loadObjectiveTailorChildSource(client as never, scope, loaded, lease)
    mocks.readMaterial.mockResolvedValue(`sha256:${"f".repeat(64)}`)
    await expect(result!.assertCurrentDraftMaterial!(client as never, scope.userId, jobId)).resolves.toBe(false)
    await expect(result!.assertCurrentDraftMaterial!(client as never, "other-user", jobId)).resolves.toBe(false)
  })

  it("admits a V2 Writer by its exact persisted slot and leaves stale sibling material independent", async () => {
    const { client, lease } = waveFixture()
    const result = await loadObjectiveTailorChildSource(client as never, scope, waveLoaded, lease)
    expect(result?.context).toBe(source)
    expect(result?.assertCurrentDraftMaterial).toBeTypeOf("function")
    expect(mocks.waveInventory).toHaveBeenCalledWith(client, scope, waveLoaded)
    expect(mocks.binding).not.toHaveBeenCalled()
    expect(mocks.source).toHaveBeenCalledWith(client, scope.userId, jobId)
  })

  it("admits the exact V2 Reviewer without granting Writer material commit authority", async () => {
    const { client, lease } = waveFixture("reviewer")
    const result = await loadObjectiveTailorChildSource(client as never, scope, waveLoaded, lease)
    expect(result).toEqual({ context: source })
  })

  it("admits only the persisted correction Writer and pins source plus prior artifact head during save", async () => {
    const { client, lease, loaded } = correctionWaveFixture()
    const result = await loadObjectiveTailorChildSource(client as never, scope, loaded, lease)
    expect(result?.context).toBe(source)
    expect(result?.assertCurrentDraftMaterial).toBeTypeOf("function")
    expect(result?.allowOwnCorrectionSuccessor).toBe(true)
    expect(await result!.assertCurrentDraftMaterial!(client as never, scope.userId, jobId)).toBe(true)
    mocks.readMaterial.mockResolvedValue(`sha256:${"9".repeat(64)}`)
    await expect(result!.assertCurrentDraftMaterial!(client as never, scope.userId, jobId)).resolves.toBe(false)
  })

  it("rejects a correction proof that differs from its persisted slot", async () => {
    const { client, lease, loaded } = correctionWaveFixture()
    mocks.waveInventory.mockResolvedValue({ marker: loaded.snapshot!.objectiveTailor,
      occupiedSlots: [{ slotId: "tailor-1", jobId, witness: waveWitness, writerTaskId: "wave-writer-task",
        reviewerTaskId: "wave-reviewer-task", correction: { proof: { ...correctionProof, graphRevision: 4 },
          writerTaskId: "wave-correction-writer", reviewerTaskId: "wave-correction-reviewer" } }] })
    await expect(loadObjectiveTailorChildSource(client as never, scope, loaded, lease)).resolves.toBeUndefined()
    expect(mocks.source).not.toHaveBeenCalled()
  })

  it.each(["V1 context on V2 graph", "V2 context on unmarked graph", "wrong V2 task slot"] as const)(
    "fails closed for %s without falling back to V1", async failure => {
      const { client, lease } = waveFixture()
      if (failure === "V1 context on V2 graph") lease.context = plan.templates.cover_letter_writer!.context
      if (failure === "V2 context on unmarked graph") {
        await expect(loadObjectiveTailorChildSource(client as never, scope, loaded, lease)).resolves.toBeUndefined()
      } else if (failure === "wrong V2 task slot") {
        mocks.waveInventory.mockResolvedValue({ marker: waveLoaded.snapshot!.objectiveTailor, occupiedSlots: [] })
        await expect(loadObjectiveTailorChildSource(client as never, scope, waveLoaded, lease)).resolves.toBeUndefined()
      } else {
        await expect(loadObjectiveTailorChildSource(client as never, scope, waveLoaded, lease)).resolves.toBeUndefined()
      }
      expect(mocks.binding).not.toHaveBeenCalled()
      expect(mocks.source).not.toHaveBeenCalled()
    })
})
