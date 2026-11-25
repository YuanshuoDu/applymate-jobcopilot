import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION,
  OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { makeObjectiveTailorWaveCandidateSelection, bindObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphState } from "./task-graph-snapshot.js"
import { appendWaveWithClient, readCatalogWithClient } from "./pg-task-graph-objective-tailor-wave.js"
import type { LoadedGraph, GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), turnChecks: vi.fn(), assertSteering: vi.fn(),
  inventory: vi.fn(), build: vi.fn(), resolve: vi.fn(), digest: vi.fn(), create: vi.fn(), budget: vi.fn(),
  hasReceipt: vi.fn(), write: vi.fn(), requirements: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load }))
vi.mock("./pg-store-create.js", () => ({ assertPlanningRootHasNoUnresolvedSteering: mocks.assertSteering }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))
vi.mock("./objective-tailor-candidate-v2.js", () => ({ buildObjectiveTailorWaveCandidateCatalog: mocks.build,
  resolveObjectiveTailorWaveCandidates: mocks.resolve }))
vi.mock("./scheduled-draft-job-material.js", () => ({ readCurrentScheduledDraftJobMaterialDigest: mocks.digest }))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: mocks.create }))
vi.mock("./pg-task-graph-command-port-schedule.js", () => ({ requireTaskGraphContinuationBudget: mocks.budget, hasPersistedPlanReceipt: mocks.hasReceipt }))
vi.mock("./task-graph-pg-events.js", () => ({ writePlanReceipt: mocks.write }))
vi.mock("../context/root-task-objective.js", () => ({ resolveRootTaskVerificationRequirements: mocks.requirements }))

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-2", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const readScope: TaskGraphReadScope = (({ stepId: _stepId, ...value }) => value)(scope)
const graphScope: GraphIdentityScope = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
  rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId }
const turnInput = { goal: "Find matching roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }
const profile = { limits: { maxSteps: 96 }, objectiveTailorProfile: "agent-harness.v2.objective-tailor-execution-budget.v1" }
const parent = { id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: null,
  role: "orchestrator", taskType: "root", status: "running", leaseOwner: scope.parentLeaseOwner,
  attemptCount: scope.parentAttemptCount, interruptRequestedAt: null, allowedActions: ["agent.plan", "agent.tailor"], budgetSnapshot: profile }
const digest = `sha256:${"d".repeat(64)}`
const source = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
  { key: "scout-a", templateId: "scout", goal: "Find candidates", successCriteria: ["Return candidates"], dependsOn: [], taskId: "scout-task", depth: 1, verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
  { key: "analyst-a", templateId: "analyst", goal: "Verify candidates", successCriteria: ["Verify evidence"], dependsOn: ["scout-a"], taskId: "analyst-task", depth: 2, verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] } },
] })
const baseLoaded = (): LoadedGraph => ({ rootTaskId: scope.rootTaskId,
  item: { id: taskGraphItemId(scope.rootTaskId), revision: 1, content: source, createdAt: "2026-11-24T10:00:00.000Z" }, snapshot: source,
  state: taskGraphState(source, 1, new Map(source.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }])), []),
  tasks: new Map(), discoveryTurnEligibility: "ordinary" })
const baseInventory = () => ({ graphRevision: 1, sourceNodeCount: 2, sourceGraphRevision: 1,
  sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), sourceSnapshot: source,
  occupiedSlots: [], occupiedJobIds: [], marker: null })
function candidate(index: number) {
  return makeObjectiveTailorWaveCandidateSelection({ scope: graphScope, sourceGraphRevision: 1,
    sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), analystProofDigest: String(index).repeat(64),
    candidate: { jobId: `f47ac10b-58cc-4372-a567-0e02b2c3d47${index}`, score: 8, materialDigest: digest }, sourceAnalystKey: "analyst-a" })!
}
function dbClient(events: Record<string, unknown>[] = []) {
  return dbClientWithInput(events, turnInput)
}
function dbClientWithInput(events: Record<string, unknown>[], input: unknown) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input, source: "user", executionMode: "canonical_task_graph" }], rowCount: 1 }
    if (sql.includes('FROM "Job"')) return { rows: [{ id: values?.[0] }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events, rowCount: events.length }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as never, calls, query }
}
function loadedWithOneSlot(marker: Record<string, unknown>): LoadedGraph {
  const slot = { slotId: "tailor-1", sourceAnalystNodeKey: "analyst-a", writerNodeKey: "writer-a", reviewerNodeKey: "reviewer-a" }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: { ...marker, slots: [slot] },
    nodes: [...source.nodes, { key: "writer-a", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save"],
      dependsOn: ["analyst-a"], depth: 3, taskId: "writer-task" }, { key: "reviewer-a", templateId: "cover_letter_reviewer",
      goal: "Review", successCriteria: ["Review"], dependsOn: ["writer-a"], depth: 4, taskId: "reviewer-task" }] })!
  const state = taskGraphState(snapshot, 3, new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }])), [])
  return { ...baseLoaded(), item: { id: taskGraphItemId(scope.rootTaskId), revision: 3, content: snapshot, createdAt: "2026-11-24T10:00:00.000Z" },
    snapshot, state }
}
function accepted(nodes: readonly { key: string; taskId: string; status: "queued" | "waiting" }[]) {
  return { state: { revision: 2, nodes: nodes.map(node => ({ ...node })), appliedEvents: [] },
    snapshot: { ...source, nodes: [...source.nodes, ...nodes.map(({ key, taskId }) => ({ key, taskId }))] },
    taskIds: new Map(nodes.map(node => [node.key, node.taskId])), created: nodes,
    readyTaskIds: nodes.filter(node => node.status === "queued").map(node => node.taskId) }
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES", "1")
  mocks.lock.mockResolvedValue(parent); mocks.load.mockImplementation(async () => baseLoaded())
  mocks.assertSteering.mockResolvedValue(undefined); mocks.inventory.mockResolvedValue(baseInventory())
  mocks.build.mockResolvedValue({ schemaVersion: "agent-harness.v2.objective-tailor-wave-catalog.v1", graphRevision: 1, candidates: [] })
  mocks.resolve.mockResolvedValue(undefined); mocks.digest.mockResolvedValue(digest); mocks.create.mockResolvedValue(accepted([]))
  mocks.budget.mockResolvedValue(undefined); mocks.hasReceipt.mockResolvedValue(false); mocks.write.mockResolvedValue(undefined)
  mocks.requirements.mockReturnValue({ status: "valid", requirements: [] })
})
afterEach(() => vi.unstubAllEnvs())

describe("Objective Tailor wave PostgreSQL command", () => {
  it("reads a catalog on the owner-fenced Root scope without requiring a Step", async () => {
    const fake = dbClient(), catalog = { schemaVersion: "agent-harness.v2.objective-tailor-wave-catalog.v1", graphRevision: 1, candidates: [] }
    mocks.build.mockResolvedValue(catalog)
    await expect(readCatalogWithClient(fake.client, readScope)).resolves.toEqual(catalog)
    expect(fake.calls.find(call => call.sql.includes('SELECT turn."input"'))?.sql).not.toContain('"agent_steps"')
    expect(mocks.load).toHaveBeenCalledWith(fake.client, readScope, true)
    expect(mocks.build).toHaveBeenCalledWith(fake.client, readScope, expect.any(Object))
  })

  it("appends four exact per-Job pairs and one atomic revision/receipt", async () => {
    const selected = [1, 2, 3, 4].map(candidate)
    mocks.resolve.mockResolvedValue({ inventory: baseInventory(), selections: selected })
    const nodes = selected.flatMap((_, index) => [
      { key: `objective-tailor-wave-writer-tailor-${index + 1}`, taskId: `writer-${index + 1}`, status: "queued" as const },
      { key: `objective-tailor-wave-reviewer-tailor-${index + 1}`, taskId: `reviewer-${index + 1}`, status: "waiting" as const },
    ])
    mocks.create.mockResolvedValue(accepted(nodes))
    const fake = dbClient()
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: selected.map(value => value.candidateRef) }))
      .resolves.toMatchObject({ status: "accepted", revision: 2, nodes, readyTaskIds: ["writer-1", "writer-2", "writer-3", "writer-4"] })
    expect(fake.calls.filter(call => call.sql.includes('FROM "Job"') && call.sql.includes("FOR SHARE")).map(call => call.values?.[0]))
      .toEqual(selected.map(value => value.candidate.jobId).sort())
    const createArgs = mocks.create.mock.calls[0]!
    expect(createArgs[10].marker.schemaVersion).toBe(OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION)
    expect(Object.hasOwn(createArgs[10].marker, "reportScoreFloor")).toBe(false)
    expect(createArgs[1].proposal.nodes).toHaveLength(8)
    expect(createArgs[1].proposal.nodes[0].dependsOn).toEqual(["analyst-a"])
    expect(createArgs[1].proposal.nodes[1].dependsOn).toEqual([createArgs[1].proposal.nodes[0].key])
    expect(createArgs[10].templatesByNodeKey.size).toBe(8)
    expect(createArgs[10].marker.slots).toHaveLength(4)
    expect(JSON.stringify(createArgs[10].marker)).not.toContain(selected[0]!.candidateRef)
    expect(mocks.write).toHaveBeenCalledWith(fake.client, expect.objectContaining({ expectedRevision: 1,
      idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 1), fingerprint: taskGraphFingerprint({ kind: "objective_tailor_candidate_wave",
        scope: graphScope, expectedRevision: 1, candidateRefs: selected.map(value => value.candidateRef) }) }))
  })

  it("copies the persisted explicit floor into the first V2 wave marker", async () => {
    const selected = candidate(1)
    mocks.resolve.mockResolvedValue({ inventory: baseInventory(), selections: [selected] })
    const nodes = [
      { key: "objective-tailor-wave-writer-tailor-1", taskId: "writer-1", status: "queued" as const },
      { key: "objective-tailor-wave-reviewer-tailor-1", taskId: "reviewer-1", status: "waiting" as const },
    ]
    mocks.create.mockResolvedValue(accepted(nodes))
    const fake = dbClientWithInput([], { ...turnInput, reportScoreFloor: 8 })
    await appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: [selected.candidateRef] })
    expect(mocks.create.mock.calls[0]?.[10]?.marker).toMatchObject({
      schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, reportScoreFloor: 8,
    })
  })

  it("preserves the same V2 floor when appending another wave", async () => {
    const marker = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, sourceNodeCount: 2, reportScoreFloor: 8 }
    const loaded = loadedWithOneSlot(marker), currentMarker = loaded.snapshot!.objectiveTailor!
    mocks.load.mockResolvedValue(loaded)
    const selected = candidate(2), witness = bindObjectiveTailorWaveCandidateWitness(selected, { slotId: "tailor-2", admittedRevision: 4 })!
    const nextMarker = { ...currentMarker, slots: [...currentMarker.slots,
      { slotId: witness.slotId, sourceAnalystNodeKey: "analyst-a", writerNodeKey: witness.writerNodeKey, reviewerNodeKey: witness.reviewerNodeKey }] }
    const nodes = [
      { key: witness.writerNodeKey, taskId: "writer-2", status: "queued" as const },
      { key: witness.reviewerNodeKey, taskId: "reviewer-2", status: "waiting" as const },
    ]
    const addedSnapshotNodes = nodes.map(node => ({ ...node, templateId: node.key.includes("writer") ? "cover_letter_writer" : "cover_letter_reviewer",
      goal: "Wave node", successCriteria: ["Complete"], dependsOn: [node.key.includes("writer") ? "analyst-a" : witness.writerNodeKey], depth: 5 }))
    const inventory = { ...baseInventory(), marker: currentMarker, occupiedSlots: [{}], occupiedJobIds: ["job-1"] }
    mocks.inventory.mockResolvedValue(inventory)
    mocks.resolve.mockResolvedValue({ inventory, selections: [selected] })
    mocks.create.mockResolvedValue({ state: { revision: 4, objectiveTailor: nextMarker,
      nodes: [...loaded.state!.nodes, ...nodes] }, snapshot: { ...loaded.snapshot!, objectiveTailor: nextMarker,
      nodes: [...loaded.snapshot!.nodes, ...addedSnapshotNodes] }, taskIds: new Map(nodes.map(node => [node.key, node.taskId])),
      created: nodes, readyTaskIds: ["writer-2"] })
    const fake = dbClientWithInput([], { ...turnInput, reportScoreFloor: 8 })
    await appendWaveWithClient(fake.client, { scope, expectedRevision: 3, candidateRefs: [selected.candidateRef] })
    expect(mocks.create.mock.calls[0]?.[10]?.marker).toMatchObject({
      schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, reportScoreFloor: 8,
    })
    expect(mocks.create.mock.calls[0]?.[10]?.marker.slots).toHaveLength(2)
  })

  it("rejects Turn/marker drift before catalog construction or replay lookup", async () => {
    const v1 = { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: 2 }
    mocks.load.mockResolvedValue(loadedWithOneSlot(v1))
    const explicitTurn = { ...turnInput, reportScoreFloor: 8 }
    const catalogDb = dbClientWithInput([], explicitTurn)
    await expect(readCatalogWithClient(catalogDb.client, readScope)).resolves.toBeUndefined()
    expect(mocks.build).not.toHaveBeenCalled()

    const appendDb = dbClientWithInput([], explicitTurn)
    await expect(appendWaveWithClient(appendDb.client, { scope, expectedRevision: 3, candidateRefs: [candidate(1).candidateRef] }))
      .rejects.toMatchObject({ code: "objective_tailor_wave_not_eligible" })
    expect(appendDb.calls.some(call => call.sql.includes('FROM "agent_events" AS event'))).toBe(false)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it("does not persist a receipt if the create adapter cannot realize queued Writer and waiting Reviewer pairs", async () => {
    const selected = candidate(1); mocks.resolve.mockResolvedValue({ inventory: baseInventory(), selections: [selected] })
    mocks.create.mockResolvedValue(accepted([
      { key: "objective-tailor-wave-writer-tailor-1", taskId: "writer-1", status: "waiting" },
      { key: "objective-tailor-wave-reviewer-tailor-1", taskId: "reviewer-1", status: "waiting" },
    ]))
    const fake = dbClient()
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: [selected.candidateRef] }))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("rejects stale revision, disabled rollout, and batch-owned Turn bindings before creating", async () => {
    const selected = candidate(1), fake = dbClient()
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 0, candidateRefs: [selected.candidateRef] }))
      .rejects.toMatchObject({ code: "objective_tailor_wave_not_eligible" })
    vi.stubEnv("ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES", "0")
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: [selected.candidateRef] }))
      .rejects.toMatchObject({ code: "objective_tailor_wave_not_eligible" })
    vi.stubEnv("ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES", "1")
    const batch = dbClient(); batch.query.mockImplementation(async (sql, values) => {
      if (sql.includes('SELECT turn."input"')) return { rows: [{ input: { ...turnInput, selectedJobBatchPreparation: {} }, source: "user", executionMode: "canonical_task_graph" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    await expect(appendWaveWithClient(batch.client, { scope, expectedRevision: 1, candidateRefs: [selected.candidateRef] }))
      .rejects.toMatchObject({ code: "objective_tailor_wave_not_eligible" })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("rejects source material drift after deterministic Job locks", async () => {
    const selected = candidate(1); mocks.resolve.mockResolvedValue({ inventory: baseInventory(), selections: [selected] })
    mocks.digest.mockResolvedValue(`sha256:${"e".repeat(64)}`)
    const fake = dbClient()
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: [selected.candidateRef] }))
      .rejects.toMatchObject({ code: "objective_tailor_wave_source_stale" })
    expect(fake.calls.some(call => call.sql.includes('FROM "Job"') && call.sql.includes("FOR SHARE"))).toBe(true)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("returns only a receipt matching the exact ordered slot identities on replay", async () => {
    const selected = [candidate(1), candidate(2)], witnesses = selected.map((value, index) => bindObjectiveTailorWaveCandidateWitness(value,
      { slotId: `tailor-${index + 1}`, admittedRevision: 2 })!)
    const occupiedSlots = witnesses.map((value, index) => ({ slotId: value.slotId, jobId: value.candidate.jobId,
      sourceAnalystNodeKey: "analyst-a", witness: value, writerTaskId: `writer-${index + 1}`, reviewerTaskId: `reviewer-${index + 1}` }))
    const currentMarker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
      slots: witnesses.map(value => ({ slotId: value.slotId, sourceAnalystNodeKey: "analyst-a", writerNodeKey: value.writerNodeKey, reviewerNodeKey: value.reviewerNodeKey })) }
    mocks.inventory.mockResolvedValue({ ...baseInventory(), graphRevision: 2, marker: currentMarker, occupiedSlots })
    const current = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: currentMarker,
      nodes: [...source.nodes, ...witnesses.flatMap((value, index) => [
        { key: value.writerNodeKey, templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save"], dependsOn: ["analyst-a"], depth: 3,
          taskId: `writer-${index + 1}`, verificationDisposition: "specialized" },
        { key: value.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: [value.writerNodeKey], depth: 4,
          taskId: `reviewer-${index + 1}`, verificationDisposition: "specialized" },
      ])] })
    mocks.load.mockResolvedValue({ ...baseLoaded(), item: { ...baseLoaded().item!, revision: 2, content: current }, snapshot: current,
      state: taskGraphState(current, 2, new Map(current.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }])), []) })
    const refs = selected.map(value => value.candidateRef), key = taskGraphProposalKey(scope.rootTaskId, 1)
    const fingerprint = taskGraphFingerprint({ kind: "objective_tailor_candidate_wave", scope: graphScope, expectedRevision: 1, candidateRefs: refs })
    const receipt = { status: "accepted", revision: 2, nodes: occupiedSlots.flatMap(slot => [
      { key: slot.witness.writerNodeKey, taskId: slot.writerTaskId, status: "queued" },
      { key: slot.witness.reviewerNodeKey, taskId: slot.reviewerTaskId, status: "waiting" },
    ]), readyTaskIds: occupiedSlots.map(slot => slot.writerTaskId) }
    const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
      turnId: scope.turnId, stepId: "step-old", taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null,
      revision: 2, content: current, startedAt: "2026-11-24T10:00:00.000Z", completedAt: null,
      createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z" }
    const event = { type: "item.delta", itemId: taskGraphItemId(scope.rootTaskId), taskId: scope.rootTaskId, actor: "orchestrator",
      correlationId: scope.turnId, causationId: "step-old", idempotencyKey: key, sequence: "10",
      payload: { kind: "proposal", fingerprint, receipt, revision: 2, item, content: current } }
    const fake = dbClient([event])
    await expect(appendWaveWithClient(fake.client, { scope, expectedRevision: 1, candidateRefs: refs }))
      .resolves.toMatchObject({ status: "duplicate", revision: 2, nodes: receipt.nodes, readyTaskIds: receipt.readyTaskIds })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
