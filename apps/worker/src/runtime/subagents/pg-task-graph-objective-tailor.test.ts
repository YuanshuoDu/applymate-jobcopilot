import { beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { makeObjectiveTailorCandidateSelection } from "./objective-tailor-witness.js"
import { objectiveTailorNodeKeysForCandidate } from "./objective-task-graph-child-authority.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { appendObjectiveTailorWithClient, readObjectiveTailorCatalogWithClient } from "./pg-task-graph-objective-tailor.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

const mocks = vi.hoisted(() => ({
  lock: vi.fn(), load: vi.fn(), assertSteering: vi.fn(), buildCatalog: vi.fn(), resolve: vi.fn(), currentDigest: vi.fn(),
  create: vi.fn(), budget: vi.fn(), hasReceipt: vi.fn(), write: vi.fn(),
}))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load }))
vi.mock("./pg-store-create.js", () => ({ assertPlanningRootHasNoUnresolvedSteering: mocks.assertSteering }))
vi.mock("./objective-tailor-candidate.js", () => ({ buildObjectiveTailorCandidateCatalog: mocks.buildCatalog, resolveObjectiveTailorCandidate: mocks.resolve }))
vi.mock("./scheduled-draft-job-material.js", () => ({ readCurrentScheduledDraftJobMaterialDigest: mocks.currentDigest }))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: mocks.create }))
vi.mock("./pg-task-graph-command-port-schedule.js", () => ({ requireTaskGraphContinuationBudget: mocks.budget, hasPersistedPlanReceipt: mocks.hasReceipt }))
vi.mock("./task-graph-pg-events.js", () => ({ writePlanReceipt: mocks.write }))

const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const digest = `sha256:${"d".repeat(64)}`
const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-new", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const readScope: TaskGraphReadScope = (({ stepId: _stepId, ...read }) => read)(scope)
const turnInput = { goal: "Find roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const parent = { id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: null,
  role: "orchestrator", taskType: "root", status: "running", leaseOwner: scope.parentLeaseOwner, attemptCount: scope.parentAttemptCount,
  interruptRequestedAt: null, allowedActions: ["agent.plan", "agent.tailor"], budgetSnapshot: {} }
const analyst = { key: "analyst-a", templateId: "analyst", goal: "Analyze evidence", successCriteria: ["Find evidence"], dependsOn: [], depth: 1, taskId: "analyst-task" }
const baseSnapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [analyst] })
const baseLoaded = (): LoadedGraph => ({ rootTaskId: scope.rootTaskId,
  item: { id: taskGraphItemId(scope.rootTaskId), revision: 1, content: baseSnapshot, createdAt: "2026-11-24T10:00:00.000Z" },
  snapshot: baseSnapshot, state: { revision: 1, nodes: [{ ...analyst, status: "completed", failureReason: null }], appliedEvents: [] } as never,
  tasks: new Map(), discoveryTurnEligibility: "ordinary" })
const selection = () => makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: 1, sourceGraphDigest: "a".repeat(64),
  sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64), candidate: { jobId, score: 8.4, materialDigest: digest },
  sourceAnalystKeys: [analyst.key] })!

function client(replayRows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: turnInput, source: "user", executionMode: "canonical_task_graph" }], rowCount: 1 }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: jobId }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: replayRows, rowCount: replayRows.length }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as never, calls, query }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lock.mockResolvedValue(parent)
  mocks.load.mockImplementation(async () => baseLoaded())
  mocks.assertSteering.mockResolvedValue(undefined)
  mocks.currentDigest.mockResolvedValue(digest)
  mocks.budget.mockResolvedValue(undefined)
  mocks.hasReceipt.mockResolvedValue(false)
  mocks.write.mockResolvedValue(undefined)
})

describe("Objective Tailor PostgreSQL command", () => {
  it("reads the catalog with an owner/Root/Turn scope that has no Step", async () => {
    const fake = client(), catalog = { schemaVersion: "agent-harness.v2.objective-tailor-candidate-catalog.v1", graphRevision: 1, candidates: [] }
    mocks.buildCatalog.mockResolvedValue(catalog)
    await expect(readObjectiveTailorCatalogWithClient(fake.client, readScope)).resolves.toEqual(catalog)
    const turnRead = fake.calls.find(call => call.sql.includes('SELECT turn."input"'))
    expect(turnRead?.sql).not.toContain('"agent_steps"')
    expect(mocks.load).toHaveBeenCalledWith(fake.client, readScope, true)
    expect(mocks.buildCatalog).toHaveBeenCalledWith(fake.client, readScope, expect.any(Object))
  })

  it("re-resolves and material-locks one exact candidate before writing the ordinary pair receipt", async () => {
    const selected = selection(), ref = selected.candidateRef, keys = objectiveTailorNodeKeysForCandidate(ref)!
    mocks.resolve.mockResolvedValue(selected)
    mocks.create.mockResolvedValue({ state: { revision: 2, nodes: [], appliedEvents: [] }, snapshot: baseSnapshot,
      created: [{ key: keys.writerNodeKey, taskId: "writer-task", status: "queued" }, { key: keys.reviewerNodeKey, taskId: "reviewer-task", status: "waiting" }],
      readyTaskIds: ["writer-task"] })
    const fake = client()
    await expect(appendObjectiveTailorWithClient(fake.client, { scope, expectedRevision: 1, candidateRef: ref })).resolves.toMatchObject({
      status: "accepted", revision: 2, nodes: [{ key: keys.writerNodeKey }, { key: keys.reviewerNodeKey }], readyTaskIds: ["writer-task"],
    })
    expect(mocks.resolve).toHaveBeenCalledWith(fake.client, scope, expect.any(Object), 1, ref)
    expect(fake.calls.some(call => call.sql.includes('FROM "Job"') && call.sql.includes("FOR SHARE"))).toBe(true)
    expect(mocks.currentDigest).toHaveBeenCalledWith(fake.client, scope.userId, jobId)
    const createInput = mocks.create.mock.calls[0]?.[1]
    expect(createInput.proposal.nodes[0].dependsOn).toEqual([analyst.key])
    expect(createInput.proposal.nodes[1].dependsOn).toEqual([keys.writerNodeKey])
    expect(createInput.templates.cover_letter_writer.context).toMatchObject({ objectiveTailorCandidateMode: true,
      selectedJobPreparation: { jobId }, objectiveTailorCandidateWitness: expect.objectContaining({ candidateRef: ref }) })
    expect(mocks.create.mock.calls[0]?.[9]).toBe(true)
    expect(mocks.write).toHaveBeenCalledWith(fake.client, expect.objectContaining({ expectedRevision: 1,
      idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 1), receipt: expect.objectContaining({ status: "accepted" }) }))
  })

  it("returns an exact persisted pair replay before candidate or source re-resolution", async () => {
    const selected = selection(), keys = objectiveTailorNodeKeysForCandidate(selected.candidateRef)!
    const tailPlan = (await import("./objective-task-graph-child-authority.js")).objectiveTailorPlan(
      (await import("./objective-tailor-witness.js")).bindObjectiveTailorCandidateWitness(selected, { ...keys, admittedRevision: 2 }))!
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [analyst,
      { ...tailPlan.proposal.nodes[0], depth: 2, taskId: "writer-task", verificationDisposition: "specialized" },
      { ...tailPlan.proposal.nodes[1], depth: 3, taskId: "reviewer-task", verificationDisposition: "specialized" }] })
    mocks.load.mockResolvedValue({ ...baseLoaded(), item: { ...baseLoaded().item!, revision: 2, content: snapshot }, snapshot,
      state: { revision: 2, nodes: [], appliedEvents: [] } })
    const fingerprint = taskGraphFingerprint({ kind: "objective_tailor_candidate", scope: {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
    }, expectedRevision: 1, candidateRef: selected.candidateRef })
    const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: "step-old", taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null, revision: 2, content: snapshot,
      startedAt: "2026-11-24T10:00:00.000Z", completedAt: null, createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z" }
    const receipt = { status: "accepted", revision: 2, nodes: [
      { key: keys.writerNodeKey, taskId: "writer-task", status: "queued" },
      { key: keys.reviewerNodeKey, taskId: "reviewer-task", status: "waiting" }], readyTaskIds: ["writer-task"] }
    const payload = { kind: "proposal", fingerprint, receipt, revision: 2, item, content: snapshot }
    const event = { type: "item.delta", itemId: taskGraphItemId(scope.rootTaskId), taskId: scope.rootTaskId, actor: "orchestrator",
      correlationId: scope.turnId, causationId: "step-old", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 1), sequence: "10", payload }
    const fake = client([event])
    await expect(appendObjectiveTailorWithClient(fake.client, { scope, expectedRevision: 1, candidateRef: selected.candidateRef }))
      .resolves.toMatchObject({ status: "duplicate", revision: 2, nodes: receipt.nodes, readyTaskIds: receipt.readyTaskIds })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.currentDigest).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.assertSteering).not.toHaveBeenCalled()
  })

  it("fails closed when the post-resolution Job material differs", async () => {
    const selected = selection()
    mocks.resolve.mockResolvedValue(selected)
    mocks.currentDigest.mockResolvedValue(`sha256:${"e".repeat(64)}`)
    const fake = client()
    await expect(appendObjectiveTailorWithClient(fake.client, { scope, expectedRevision: 1, candidateRef: selected.candidateRef }))
      .rejects.toMatchObject({ code: "objective_tailor_source_material_stale" })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
