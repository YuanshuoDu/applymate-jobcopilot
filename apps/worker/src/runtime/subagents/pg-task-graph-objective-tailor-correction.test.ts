import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { appendCorrectionWithClient } from "./pg-task-graph-objective-tailor-correction.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), turnChecks: vi.fn(), assertSteering: vi.fn(), proof: vi.fn(), plan: vi.fn(),
  digest: vi.fn(), create: vi.fn(), budget: vi.fn(), hasReceipt: vi.fn(), write: vi.fn(), requirements: vi.fn(), inventory: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load }))
vi.mock("./pg-store-create.js", () => ({ assertPlanningRootHasNoUnresolvedSteering: mocks.assertSteering }))
vi.mock("./objective-tailor-correction-proof.js", () => ({ verifyAndBindObjectiveTailorCorrectionProof: mocks.proof,
  parseObjectiveTailorCorrectionProof: (value: unknown) => value, objectiveTailorCorrectionNodeKeys: (slotId: string) => slotId === "tailor-1"
    ? { writerNodeKey: "objective-tailor-wave-correction-writer-tailor-1", reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-1" } : undefined }))
vi.mock("./objective-tailor-correction-plan.js", () => ({ prepareObjectiveTailorCorrectionPlan: mocks.plan }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))
vi.mock("./scheduled-draft-job-material.js", () => ({ readCurrentScheduledDraftJobMaterialDigest: mocks.digest }))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: mocks.create }))
vi.mock("./pg-task-graph-command-port-schedule.js", () => ({ requireTaskGraphContinuationBudget: mocks.budget, hasPersistedPlanReceipt: mocks.hasReceipt }))
vi.mock("./task-graph-pg-events.js", () => ({ writePlanReceipt: mocks.write }))
vi.mock("../context/root-task-objective.js", () => ({ resolveRootTaskVerificationRequirements: mocks.requirements }))

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-2", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const turnInput = { goal: "Find matching roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const profile = { limits: { maxSteps: 96 }, objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v1" }
const parent = { id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: null,
  role: "orchestrator", taskType: "root", status: "running", leaseOwner: scope.parentLeaseOwner,
  attemptCount: scope.parentAttemptCount, interruptRequestedAt: null, allowedActions: ["agent.plan", "agent.tailor"], budgetSnapshot: profile }
const oldMarker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [{ slotId: "tailor-1",
  sourceAnalystNodeKey: "analyst-a", writerNodeKey: "objective-tailor-wave-writer-tailor-1", reviewerNodeKey: "objective-tailor-wave-reviewer-tailor-1" }] }
const newMarker = { ...oldMarker, slots: [{ ...oldMarker.slots[0], correction: { writerNodeKey: "objective-tailor-wave-correction-writer-tailor-1",
  reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-1" } }] }
const ref = { artifactId: "artifact-1", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
const proof = { schemaVersion: "agent-harness.v2.objective-tailor-correction-proof.v1", graphRevision: 4, admittedRevision: 5, slotId: "tailor-1",
  candidateWitness: { slotId: "tailor-1", candidate: { jobId: "job-1", materialDigest: `sha256:${"c".repeat(64)}` } },
  writerNodeKey: "objective-tailor-wave-correction-writer-tailor-1", reviewerNodeKey: "objective-tailor-wave-correction-reviewer-tailor-1",
  prior: { writerTaskId: "initial-writer", reviewerTaskId: "initial-reviewer", artifactRef: ref,
    artifactVersion: { ...ref, artifactType: "cover_letter", taskId: "initial-writer", previousHash: null },
    reviewReceipt: { jobId: "job-1", ...ref, currentSourceDigest: ref.sourceDigest, status: "needs_revision", taskId: "initial-reviewer",
      toolCallId: "review-call", reviewHash: `sha256:${"d".repeat(64)}` } } }
const plan = { proof, proposal: { expectedRevision: 4, nodes: [{ key: proof.writerNodeKey }, { key: proof.reviewerNodeKey }] }, marker: newMarker,
  templates: { cover_letter_writer: {}, cover_letter_reviewer: {} }, templatesByNodeKey: new Map([[proof.writerNodeKey, {}], [proof.reviewerNodeKey, {}]]) }
const nodes = [
  { key: proof.writerNodeKey, taskId: "correction-writer", status: "queued" as const },
  { key: proof.reviewerNodeKey, taskId: "correction-reviewer", status: "waiting" as const },
]
const created = { state: { revision: 5, objectiveTailor: newMarker, nodes: nodes.map(value => ({ ...value })) },
  snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: newMarker, nodes: nodes.map(value => ({ ...value })) },
  taskIds: new Map(nodes.map(value => [value.key, value.taskId])), created: nodes, readyTaskIds: ["correction-writer"] }

function loaded(revision = 4) {
  const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: oldMarker, nodes: [] }
  return { rootTaskId: scope.rootTaskId, item: { id: taskGraphItemId(scope.rootTaskId), revision, content: snapshot, createdAt: "2026-11-24T10:00:00.000Z" },
    snapshot, state: { revision, objectiveTailor: oldMarker, nodes: [], appliedEvents: [] }, tasks: new Map(), discoveryTurnEligibility: "ordinary" }
}

function dbClient(events: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: turnInput, source: "user", executionMode: "canonical_task_graph",
      leaseStartedAt: "2026-11-24T10:00:00.000Z", leaseExpiresAt: "2026-11-24T10:01:00.000Z" }], rowCount: 1 }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: values?.[0] }], rowCount: 1 }
    if (sql.includes('FROM "agent_artifact" AS artifact')) return { rows: [{ artifactId: ref.artifactId, userId: scope.userId, jobId: "job-1",
      artifactType: "cover_letter", lifecycle: "draft", headVersion: ref.version, headHash: ref.contentHash,
      version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest, taskId: "initial-writer",
      previousHash: null, sessionId: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events, rowCount: events.length }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as never, calls, query }
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES", "1")
  mocks.lock.mockResolvedValue(parent); mocks.load.mockImplementation(async () => loaded())
  mocks.turnChecks.mockResolvedValue(undefined); mocks.assertSteering.mockResolvedValue(undefined)
  mocks.proof.mockResolvedValue(proof); mocks.plan.mockReturnValue(plan); mocks.inventory.mockResolvedValue(undefined)
  mocks.digest.mockResolvedValue(proof.candidateWitness.candidate.materialDigest); mocks.create.mockResolvedValue(created)
  mocks.budget.mockResolvedValue(undefined); mocks.hasReceipt.mockResolvedValue(false); mocks.write.mockResolvedValue(undefined)
  mocks.requirements.mockReturnValue({ status: "valid", requirements: [] })
})
afterEach(() => vi.unstubAllEnvs())

describe("Objective Tailor correction PostgreSQL command", () => {
  it("fences the reviewed slot and atomically appends its exact successor pair", async () => {
    const fake = dbClient()
    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" }))
      .resolves.toEqual({ status: "accepted", revision: 5, nodes, readyTaskIds: ["correction-writer"] })
    expect(fake.calls.some(call => call.sql.includes('JOIN "agent_steps"') && call.sql.includes("step.\"status\" = 'streaming'"))).toBe(true)
    expect(mocks.proof).toHaveBeenCalledWith(expect.objectContaining({ slotId: "tailor-1", expectedRevision: 4,
      lease: expect.objectContaining({ ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion }) }))
    expect(fake.calls.some(call => call.sql.includes('FROM "Job"') && call.sql.includes("FOR SHARE"))).toBe(false)
    const headFence = fake.calls.find(call => call.sql.includes('FROM "agent_artifact" AS artifact'))
    expect(headFence?.sql).toContain("FOR SHARE OF artifact NOWAIT")
    expect(headFence?.values).toEqual([ref.artifactId, scope.userId, "job-1", scope.sessionId, "initial-writer", ref.contentHash, ref.sourceDigest, null])
    expect(mocks.create).toHaveBeenCalledWith(fake.client, expect.objectContaining({ proposal: plan.proposal }), parent, expect.any(Object),
      expect.any(Map), expect.any(Object), undefined, true, undefined, false, expect.objectContaining({ marker: newMarker }))
    expect(mocks.write).toHaveBeenCalledWith(fake.client, expect.objectContaining({ expectedRevision: 4,
      idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 4), fingerprint: taskGraphFingerprint({
        kind: "objective_tailor_same_slot_correction", scope: { userId: scope.userId, sessionId: scope.sessionId,
          turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId }, expectedRevision: 4, correctionSlotId: "tailor-1" }) }))
  })

  it("replays the writePlanReceipt item.delta envelope through the persisted proposal parser", async () => {
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: newMarker, nodes: [
      { key: "scout-a", templateId: "scout", goal: "Find candidates", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
        taskId: "scout-task", verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
          role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
      { key: "analyst-a", templateId: "analyst", goal: "Verify candidates", successCriteria: ["Return findings"], dependsOn: ["scout-a"], depth: 2,
        taskId: "analyst-task", verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
          role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
      { key: oldMarker.slots[0]!.writerNodeKey, templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save draft"],
        dependsOn: ["analyst-a"], depth: 3, taskId: "initial-writer", verificationDisposition: "specialized" },
      { key: oldMarker.slots[0]!.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Save review"],
        dependsOn: [oldMarker.slots[0]!.writerNodeKey], depth: 4, taskId: "initial-reviewer", verificationDisposition: "specialized" },
      { key: proof.writerNodeKey, templateId: "cover_letter_writer", goal: "Revise", successCriteria: ["Save correction"],
        dependsOn: [oldMarker.slots[0]!.reviewerNodeKey], depth: 5, taskId: "correction-writer", verificationDisposition: "specialized" },
      { key: proof.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Review correction", successCriteria: ["Save review"],
        dependsOn: [proof.writerNodeKey], depth: 6, taskId: "correction-reviewer", verificationDisposition: "specialized" },
    ] })
    const itemId = taskGraphItemId(scope.rootTaskId), timestamp = "2026-11-24T10:00:00.000Z"
    const receipt = { status: "accepted", revision: 5, nodes, readyTaskIds: ["correction-writer"] }
    const fingerprint = taskGraphFingerprint({ kind: "objective_tailor_same_slot_correction", scope: {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
    }, expectedRevision: 4, correctionSlotId: "tailor-1" })
    const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: scope.stepId, taskId: scope.parentTaskId, type: "task_graph", status: "streaming", phase: null, revision: 5,
      content: snapshot, startedAt: timestamp, completedAt: null, createdAt: timestamp, updatedAt: timestamp }
    const payload = { kind: "proposal", fingerprint, receipt, revision: 5, item, content: snapshot }
    const event = { type: "item.delta", itemId, taskId: scope.parentTaskId, actor: "orchestrator", correlationId: scope.turnId,
      causationId: scope.stepId, idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 4), sequence: 10, payload }
    const fake = dbClient([event])
    const state = { revision: 5, objectiveTailor: newMarker, nodes: snapshot.nodes.map(node => ({ ...node,
      status: node.taskId === "correction-writer" ? "queued" : node.taskId === "correction-reviewer" ? "waiting" : "completed" })), appliedEvents: [] }
    mocks.load.mockResolvedValue({ rootTaskId: scope.rootTaskId, item: { id: itemId, revision: 5, content: snapshot, createdAt: timestamp },
      snapshot, state, tasks: new Map(), discoveryTurnEligibility: "ordinary" })
    mocks.inventory.mockResolvedValue({ marker: newMarker, occupiedSlots: [{ slotId: "tailor-1", witness: proof.candidateWitness,
      writerTaskId: "initial-writer", reviewerTaskId: "initial-reviewer",
      correction: { proof, writerTaskId: "correction-writer", reviewerTaskId: "correction-reviewer" } }] })

    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" }))
      .resolves.toEqual({ status: "duplicate", revision: 5, nodes, readyTaskIds: ["correction-writer"] })
    expect(mocks.proof).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })

  it("does not write a receipt when the create adapter cannot realize the exact queued/waiting pair", async () => {
    mocks.create.mockResolvedValue({ ...created, created: [nodes[0], { ...nodes[1], status: "queued" }], readyTaskIds: ["correction-writer", "correction-reviewer"] })
    const fake = dbClient()
    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("does not create or receipt on source drift or missing reviewed proof", async () => {
    const fake = dbClient()
    mocks.digest.mockResolvedValue(`sha256:${"e".repeat(64)}`)
    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" }))
      .rejects.toMatchObject({ code: "objective_tailor_correction_source_stale" })
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
    mocks.digest.mockResolvedValue(proof.candidateWitness.candidate.materialDigest); mocks.proof.mockResolvedValue(undefined)
    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" })).rejects.toThrow()
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })

  it("fails closed if another draft version replaced the reviewed head", async () => {
    const fake = dbClient()
    fake.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT turn."input"')) return { rows: [{ input: turnInput, source: "user", executionMode: "canonical_task_graph",
        leaseStartedAt: "2026-11-24T10:00:00.000Z", leaseExpiresAt: "2026-11-24T10:01:00.000Z" }], rowCount: 1 }
      if (sql.includes('FROM "Job"')) return { rows: [{ id: values?.[0] }], rowCount: 1 }
      if (sql.includes('FROM "agent_artifact" AS artifact')) return { rows: [{ artifactId: ref.artifactId, userId: scope.userId, jobId: "job-1",
        artifactType: "cover_letter", lifecycle: "draft", headVersion: ref.version + 1, headHash: "sha256:other",
        version: ref.version + 1, contentHash: "sha256:other", sourceDigest: ref.sourceDigest, taskId: "other-writer",
        previousHash: ref.contentHash, sessionId: scope.sessionId }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    await expect(appendCorrectionWithClient(fake.client, { scope, expectedRevision: 4, correctionSlotId: "tailor-1" }))
      .rejects.toMatchObject({ code: "objective_tailor_correction_stale" })
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })
})
