import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, taskGraphState } from "./task-graph-snapshot.js"
import { readObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { bindObjectiveTailorWaveCandidateWitness, makeObjectiveTailorWaveCandidateSelection,
  objectiveTailorWavePairPlan } from "./objective-tailor-wave-witness.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ proof: vi.fn(), receipt: vi.fn(), correction: vi.fn() }))
vi.mock("./scheduled-draft-candidate-analyst-proof.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-draft-candidate-analyst-proof.js")>(), readScheduledDraftAnalystProof: mocks.proof,
}))
vi.mock("../../db/agent-artifact-repo.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../db/agent-artifact-repo.js")>(), findReviewReceiptWithClient: mocks.receipt,
}))
vi.mock("./objective-tailor-correction-inventory.js", async importOriginal => ({
  ...await importOriginal<typeof import("./objective-tailor-correction-inventory.js")>(), readObjectiveTailorCorrectionInventory: mocks.correction,
}))
import { bindObjectiveTailorCorrectionProof, objectiveTailorCorrectionNodeKeys } from "./objective-tailor-correction-proof.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobs = [
  "f47ac10b-58cc-4372-a567-0e02b2c3d471", "f47ac10b-58cc-4372-a567-0e02b2c3d472",
  "f47ac10b-58cc-4372-a567-0e02b2c3d473", "f47ac10b-58cc-4372-a567-0e02b2c3d474",
]
const material = `sha256:${"d".repeat(64)}`
const binding = { nodeKey: "analyst-node", taskId: "analyst-task", attemptCount: 1, resultDigest: "a".repeat(64),
  evidenceDigest: "b".repeat(64), reportDigest: "c".repeat(64), scouts: [] }
const verification = (role: "scout" | "analyst") => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
  criteria: [{ id: "proof", check: role === "scout" ? { kind: "candidate_count_gte", minimum: 1 }
    : { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-node" } }] })

function sourceSnapshot() {
  return parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
    { key: "scout-node", taskId: "scout-task", templateId: "scout", goal: "Find candidates", successCriteria: ["Find jobs"],
      dependsOn: [], depth: 1, verificationDisposition: "typed", verification: verification("scout") },
    { key: "analyst-node", taskId: "analyst-task", templateId: "analyst", goal: "Verify candidates", successCriteria: ["Verify jobs"],
      dependsOn: ["scout-node"], depth: 2, verificationDisposition: "typed", verification: verification("analyst") },
  ] })
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function fixture(options: { revision?: number; corrections?: boolean | number; mismatch?: "row" | "witness" | "owner" | "job" | "material" | "correction-proof" | "prior" } = {}) {
  const base = sourceSnapshot(), sourceGraphDigest = hash(base)
  const sourceStatusDigest = hash([{ key: "scout-node", status: "completed" }, { key: "analyst-node", status: "completed" }])
  const witnesses = jobs.map((jobId, index) => {
    const candidateJobId = options.mismatch === "job" && index === 0 ? "f47ac10b-58cc-4372-a567-0e02b2c3d475" : jobId
    const candidateMaterial = options.mismatch === "material" && index === 0 ? `sha256:${"f".repeat(64)}` : material
    const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: 4, sourceGraphDigest, sourceStatusDigest,
      analystProofDigest: hash(binding), candidate: { jobId: candidateJobId, score: 9 - index, materialDigest: candidateMaterial }, sourceAnalystKey: "analyst-node" })!
    return bindObjectiveTailorWaveCandidateWitness(selection, { slotId: `tailor-${index + 1}`, admittedRevision: index + 5 })!
  })
  const pairs = witnesses.map(witness => objectiveTailorWavePairPlan(witness)!)
  const nodes = [...base.nodes]
  const statuses = new Map<string, { status: "completed" | "queued" | "waiting"; failureReason: null }>([
    ["scout-task", { status: "completed", failureReason: null }], ["analyst-task", { status: "completed", failureReason: null }],
  ])
  const tasks = new Map<string, Record<string, unknown>>([
    ["scout-task", { id: "scout-task", status: "completed", role: "scout", taskType: "job_discovery", failureReason: null, result: null }],
    ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", taskType: "job_analysis", failureReason: null, result: null }],
  ])
  const rows: Record<string, unknown>[] = [], corrections = new Map<number, { writerNodeKey: string; reviewerNodeKey: string }>()
  for (const [index, pair] of pairs.entries()) {
    const writerKey = pair.witness.writerNodeKey, reviewerKey = pair.witness.reviewerNodeKey
    nodes.push({ ...pair.proposal.nodes[0], taskId: `writer-task-${index + 1}`, depth: 3 })
    nodes.push({ ...pair.proposal.nodes[1], taskId: `reviewer-task-${index + 1}`, depth: 4 })
    statuses.set(`writer-task-${index + 1}`, { status: "queued", failureReason: null })
    statuses.set(`reviewer-task-${index + 1}`, { status: "waiting", failureReason: null })
    tasks.set(`writer-task-${index + 1}`, { id: `writer-task-${index + 1}`, status: "queued", role: "writer", taskType: "cover_letter_draft", failureReason: null, result: null })
    tasks.set(`reviewer-task-${index + 1}`, { id: `reviewer-task-${index + 1}`, status: "waiting", role: "reviewer", taskType: "cover_letter_review", failureReason: null, result: null })
    const writerContext = pair.templatesByNodeKey.get(writerKey)!.context
    const reviewerContext = pair.templatesByNodeKey.get(reviewerKey)!.context
    rows.push({ id: `writer-task-${index + 1}`, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, userId: options.mismatch === "owner" && index === 0 ? "foreign-user" : scope.userId,
      turnRootTaskId: scope.rootTaskId, turnUserId: scope.userId, role: "writer", taskType: "cover_letter_draft", status: "queued", context: writerContext })
    rows.push({ id: `reviewer-task-${index + 1}`, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId, turnUserId: scope.userId,
      role: "reviewer", taskType: "cover_letter_review", status: "waiting",
      context: options.mismatch === "witness" && index === 0 ? { ...reviewerContext as object, objectiveTailorCandidateWitness: { ...pair.witness, candidate: { ...pair.witness.candidate, score: 1 } } } : reviewerContext })
  }
  const correctionCount = typeof options.corrections === "number" ? options.corrections : options.corrections ? 1 : 0
  for (let index = 0; index < correctionCount; index += 1) {
    const witness = witnesses[index]!, keys = objectiveTailorCorrectionNodeKeys(witness.slotId)!
    const writerId = `correction-writer-${index + 1}`, reviewerId = `correction-reviewer-${index + 1}`
    corrections.set(index, keys)
    nodes.push({ key: keys.writerNodeKey, taskId: writerId, templateId: "cover_letter_writer", goal: "Correct",
      successCriteria: ["Correct"], dependsOn: [witness.reviewerNodeKey], depth: 5 })
    nodes.push({ key: keys.reviewerNodeKey, taskId: reviewerId, templateId: "cover_letter_reviewer", goal: "Review",
      successCriteria: ["Review"], dependsOn: [keys.writerNodeKey], depth: 6 })
    statuses.set(writerId, { status: "queued", failureReason: null }); statuses.set(reviewerId, { status: "waiting", failureReason: null })
    tasks.set(writerId, { id: writerId, status: "queued", role: "writer", taskType: "cover_letter_draft", failureReason: null, result: null })
    tasks.set(reviewerId, { id: reviewerId, status: "waiting", role: "reviewer", taskType: "cover_letter_review", failureReason: null, result: null })
    const context = { objectiveTailorCandidateMode: true, objectiveTailorCandidateWitness: witness }
    for (const [id, role, taskType, status] of [[writerId, "writer", "cover_letter_draft", "queued"],
      [reviewerId, "reviewer", "cover_letter_review", "waiting"]] as const) {
      rows.push({ id, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
        userId: scope.userId, turnRootTaskId: scope.rootTaskId, turnUserId: scope.userId, role, taskType, status, context })
    }
  }
  const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2,
    slots: witnesses.map(witness => ({ slotId: witness.slotId, sourceAnalystNodeKey: "analyst-node",
      writerNodeKey: witness.writerNodeKey, reviewerNodeKey: witness.reviewerNodeKey,
      ...(corrections.has(Number(witness.slotId.slice(-1)) - 1) ? { correction: corrections.get(Number(witness.slotId.slice(-1)) - 1) } : {}) })) }
  const snapshot = parseTaskGraphSnapshot({ ...base, nodes, objectiveTailor: marker })
  const revision = options.revision ?? 12
  const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId, item: { id: taskGraphItemId(scope.rootTaskId), revision, content: snapshot, createdAt: new Date(0) },
    snapshot, state: taskGraphState(snapshot, revision, statuses, []), tasks: tasks as never, discoveryTurnEligibility: "ordinary" }
  const client = { query: vi.fn(async () => ({ rows: options.mismatch === "row" ? rows.slice(0, -1) : rows, rowCount: rows.length })) }
  mocks.proof.mockResolvedValue({ result: { findings: jobs.map((jobId, index) => ({ jobId, score: 9 - index })) },
    materialDigests: new Map(jobs.map(jobId => [jobId, material])), binding })
  return { client, loaded, rows, witnesses }
}

beforeEach(() => { vi.clearAllMocks(); mocks.correction.mockReset() })

describe("Objective Tailor wave inventory", () => {
  it("opens V2 on an exact terminal typed source graph", async () => {
    const snapshot = sourceSnapshot(), statuses = new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
    const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId, item: { id: taskGraphItemId(scope.rootTaskId), revision: 4, content: snapshot, createdAt: new Date(0) },
      snapshot, state: taskGraphState(snapshot, 4, statuses, []), tasks: new Map([
        ["scout-task", { id: "scout-task", status: "completed", role: "scout", taskType: "job_discovery", failureReason: null, result: null }],
        ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", taskType: "job_analysis", failureReason: null, result: null }],
      ]) as never, discoveryTurnEligibility: "ordinary" }
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
    const inventory = await readObjectiveTailorWaveInventory(client as never, scope, loaded)
    expect(inventory).toMatchObject({ graphRevision: 4, sourceGraphRevision: 4, sourceNodeCount: 2, occupiedJobIds: [], marker: null })
    expect(inventory?.sourceSnapshot.nodes.map(node => node.key)).toEqual(["scout-node", "analyst-node"])
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('task."context" ? \'objectiveTailorCandidateMode\''), expect.any(Array))
  })

  it("reconstructs four exact slots across later graph revisions and preserves stale Jobs as occupied", async () => {
    const { client, loaded, rows } = fixture({ revision: 12 })
    const inventory = await readObjectiveTailorWaveInventory(client as never, scope, loaded)
    expect(inventory).toMatchObject({ graphRevision: 12, sourceGraphRevision: 4, sourceNodeCount: 2,
      occupiedJobIds: jobs, marker: { slots: expect.arrayContaining([expect.objectContaining({ slotId: "tailor-4" })]) } })
    expect(inventory?.occupiedSlots.map(slot => [slot.slotId, slot.jobId, slot.writerTaskId, slot.reviewerTaskId])).toEqual(
      jobs.map((jobId, index) => [`tailor-${index + 1}`, jobId, `writer-task-${index + 1}`, `reviewer-task-${index + 1}`]))
    expect(rows).toHaveLength(8)
    expect(mocks.proof).toHaveBeenCalledTimes(1)
  })

  it.each(["row", "witness", "owner"] as const)("rejects unaccounted marked slot when %s is mismatched", async mismatch => {
    const { client, loaded } = fixture({ mismatch })
    expect(await readObjectiveTailorWaveInventory(client as never, scope, loaded)).toBeUndefined()
  })

  it.each(["job", "material"] as const)("rejects a recalculated witness with an unproved %s", async mismatch => {
    const { client, loaded } = fixture({ mismatch })
    expect(await readObjectiveTailorWaveInventory(client as never, scope, loaded)).toBeUndefined()
  })

  it("retains two independent correction witnesses beside their initial slot pairs", async () => {
    const { client, loaded } = fixture({ corrections: 2 })
    mocks.correction.mockImplementation(async (input: { slot: { slotId: string } }) => ({
      proof: { slotId: input.slot.slotId }, writerTaskId: `correction-writer-${input.slot.slotId.slice(-1)}`,
      reviewerTaskId: `correction-reviewer-${input.slot.slotId.slice(-1)}`,
    }))
    const inventory = await readObjectiveTailorWaveInventory(client as never, scope, loaded)
    expect(inventory?.occupiedSlots.map(slot => [slot.slotId, slot.writerTaskId, slot.reviewerTaskId,
      slot.correction?.writerTaskId, slot.correction?.reviewerTaskId])).toEqual([
      ["tailor-1", "writer-task-1", "reviewer-task-1", "correction-writer-1", "correction-reviewer-1"],
      ["tailor-2", "writer-task-2", "reviewer-task-2", "correction-writer-2", "correction-reviewer-2"],
      ["tailor-3", "writer-task-3", "reviewer-task-3", undefined, undefined],
      ["tailor-4", "writer-task-4", "reviewer-task-4", undefined, undefined],
    ])
    expect(mocks.correction).toHaveBeenCalledTimes(2)
  })

  it("rejects a marked correction with unbound proof and an unmarked legacy pair", async () => {
    const corrected = fixture({ corrections: true })
    expect(await readObjectiveTailorWaveInventory(corrected.client as never, scope, corrected.loaded)).toBeUndefined()
    const legacy = fixture()
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: legacy.loaded.snapshot!.nodes.filter(node =>
      node.templateId !== "cover_letter_writer" && node.templateId !== "cover_letter_reviewer") })
    const statuses = new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
    const loaded = { ...legacy.loaded, snapshot, item: { ...legacy.loaded.item!, content: snapshot }, state: taskGraphState(snapshot, 12, statuses, []) }
    expect(await readObjectiveTailorWaveInventory(legacy.client as never, scope, loaded)).toBeUndefined()
  })
})
