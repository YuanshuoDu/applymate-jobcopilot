import { beforeEach, describe, expect, it, vi } from "vitest"
import { validateScheduledGateTaskGraphFinish, verifyPersistedScheduledPreparePrefix, verifyScheduledGateCompletion,
  scheduledGateResultDigest } from "./pg-scheduled-task-graph-gate-verification.js"
import { scheduledGateProposal, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"

const mocks = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), current: vi.fn(), evidence: vi.fn(), jobIds: vi.fn(),
  envelope: vi.fn(), persistedProof: vi.fn(), registration: vi.fn(), snapshot: vi.fn(), verifyPrepare: vi.fn() }))

vi.mock("./task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-state.js")>()
  return { ...actual, lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load, currentTaskGraph: mocks.current }
})
vi.mock("./scheduled-gate-contract.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-gate-contract.js")>()
  return { ...actual, scheduledGateCheckpointEvidence: mocks.evidence, scheduledGatePreparedJobIds: mocks.jobIds,
    parseScheduledGateTaskEnvelope: mocks.envelope }
})
vi.mock("./scheduled-gate-wait-match.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-gate-wait-match.js")>()
  return { ...actual, loadPersistedScheduledPrepareProof: mocks.persistedProof }
})
vi.mock("./scheduled-gate-registration-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-gate-registration-receipt.js")>()
  return { ...actual, readScheduledGateRegistrationReceipt: mocks.registration }
})
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>()
  return { ...actual, scheduledSnapshotMatches: mocks.snapshot }
})
vi.mock("./scheduled-prepare-task-graph-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-prepare-task-graph-verification.js")>()
  return { ...actual, verifyScheduledPrepareTaskGraphEvidence: mocks.verifyPrepare }
})

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 3 }
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, turnLeaseOwner: "turn-owner", turnLeaseVersion: 5, parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const continuationKey = "scheduled-taskgraph:sha256:" + "a".repeat(64)
const prepareWaitContinuationKey = "scheduled-taskgraph:sha256:" + "f".repeat(64)
const snapshotDigest = "sha256:" + "b".repeat(64)
const evidence = { owner, continuationKey, prepareWaitContinuationKey, snapshotDigest, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7 }
const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-prepare-receipt.v1", owner,
  continuationKey, snapshotDigest, evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
  analyzeGraphRevision: evidence.analyzeGraphRevision, prepareScheduleRevision: 8 }
const proof = { receipt, completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 8,
  nodes: [{ taskId: "scout-task", role: "scout", taskType: "job_discovery", attemptCount: 1,
    status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "analyst-task", role: "analyst", taskType: "job_analysis", attemptCount: 1,
      status: "completed", verification: "passed", dependsOnTaskIds: ["scout-task"] },
    { taskId: "prepare-task", role: "prepare", taskType: "scheduled_application_prepare", attemptCount: 2,
      status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-task"] }], wait: { waitId: "prepare-wait" } },
  result: { jobs: [{ jobId: "job-1", status: "prepared" }] } }
const proofFacts = { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt,
  completion: { schemaVersion: proof.completion.schemaVersion, graphRevision: proof.completion.graphRevision, nodes: proof.completion.nodes },
  result: proof.result }
const questionResult = { status: "completed", approvedJobIds: [], pendingJobIds: ["job-1"], skippedJobIds: [] }
const gateResult = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: questionResult }
const gateDefinition = scheduledGateProposal(0).nodes[0]!
const prefix = [
  { key: "scout", templateId: "scout", taskId: "scout-task", depth: 1, dependsOn: [], verificationDisposition: "typed" },
  { key: "analyst", templateId: "analyst", taskId: "analyst-task", depth: 2, dependsOn: ["scout"], verificationDisposition: "typed" },
  { key: "prepare", templateId: "prepare", taskId: "prepare-task", depth: 3, dependsOn: ["analyst"], verificationDisposition: "specialized" },
]
const nodes = [...prefix, { ...gateDefinition, taskId: "gate-task", depth: 4, verificationDisposition: "specialized" }]
const currentNodes = nodes.map(node => ({ key: node.key, taskId: node.taskId, status: "completed" }))
const state = { revision: 20, nodes: currentNodes, appliedEvents: [{ nodeKey: "gate", type: "task.completed",
  idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.completed"), expectedRevision: 19 }] }
const loaded = { rootTaskId: owner.rootTaskId, item: { id: "graph", revision: 20, content: {} },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria: [], nodes }, state,
  tasks: new Map<string, Record<string, unknown>>([
    ["scout-task", { id: "scout-task", status: "completed", role: "scout", taskType: "job_discovery", attemptCount: 1, failureReason: null, result: {} }],
    ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", taskType: "job_analysis", attemptCount: 1, failureReason: null, result: {} }],
    ["prepare-task", { id: "prepare-task", status: "completed", role: "prepare", taskType: "scheduled_application_prepare", attemptCount: 2, failureReason: null,
      result: { structuredResult: {}, taskGraphScheduledPrepareProofFacts: proofFacts } }],
    ["gate-task", { id: "gate-task", status: "completed", attemptCount: 1, failureReason: null, result: gateResult }],
  ]) }
const gateRow = { id: "gate-task", status: "completed", attemptCount: 1, maxAttempts: 3, role: SCHEDULED_GATE_ROLE,
  taskType: SCHEDULED_GATE_TASK_TYPE, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], context: {},
  result: gateResult, failureReason: null, leaseOwner: null, leaseExpiresAt: null }
const registration = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1", owner, continuationKey,
  snapshotDigest, evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
  analyzeGraphRevision: evidence.analyzeGraphRevision, prepareScheduleRevision: 8, prepareWaitId: "prepare-wait",
  gateTaskId: "gate-task", gateAppendRevision: 9 }
const finishStartedEvent = { nodeKey: "gate", type: "task.started",
  idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.started"), expectedRevision: 9 }
const finishLoaded = { ...loaded, item: { ...loaded.item, revision: 10 }, state: { revision: 10, nodes: currentNodes.map(node =>
  node.key === "gate" ? { ...node, status: "running" } : node), appliedEvents: [finishStartedEvent] },
  tasks: new Map(loaded.tasks).set("gate-task", { id: "gate-task", status: "running", attemptCount: 1,
    role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA,
    allowedActions: [], contextIsEmpty: true, failureReason: null, result: null }) }
const finishGraph = { duplicate: false, taskId: "gate-task", itemId: "graph", scope, snapshot: loaded.snapshot,
  expectedRevision: 10, event: { type: "task.completed", nodeKey: "gate",
    idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.completed"), expectedRevision: 10 },
  state: { revision: 11, nodes: currentNodes.map(node => ({ ...node, status: "completed" })), appliedEvents: [finishStartedEvent,
    { nodeKey: "gate", type: "task.completed", idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.completed"), expectedRevision: 10 }] } }
const suspendedOwner = { sessionId: owner.sessionId, sessionUserId: owner.userId, sessionStatus: "running", turnId: owner.turnId,
  turnSessionId: owner.sessionId, turnUserId: owner.userId, turnRootTaskId: owner.rootTaskId, turnStatus: "waiting_for_dependency",
  turnLeaseOwnerId: null, turnLeaseVersion: 6, source: "automation", executionMode: "canonical_task_graph", input: {},
  rootId: owner.rootTaskId, rootSessionId: owner.sessionId, rootTurnId: owner.turnId, rootStatus: "running",
  rootAttemptCount: owner.rootAttemptCount, rootInterruptRequestedAt: null, rootClosedAt: null }

function database() {
  const query = vi.fn(async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [gateRow], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: owner.executionId, status: "running",
      attemptCount: owner.executionAttemptCount, state: {} }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "automation", executionMode: "canonical_task_graph", input: {} }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return { client: { query }, query }
}

function finishDatabase(rootAndTurn: Record<string, unknown> = suspendedOwner) {
  const db = database()
  mocks.load.mockResolvedValue(finishLoaded)
  mocks.current.mockReturnValue({ nodes: finishLoaded.state.nodes })
  db.query.mockImplementation(async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "gate-task", status: "running", attemptCount: 1,
      maxAttempts: 3, role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
      expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], context: {}, failureReason: null,
      leaseOwner: "gate-owner", leaseExpiresAt: new Date("2026-10-24T10:01:00Z"), leaseValid: true, interruptRequestedAt: null }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [rootAndTurn], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: owner.executionId, status: "running",
      attemptCount: owner.executionAttemptCount, state: {} }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return db
}

function preparePrefixFixture(keys: readonly [string, string, string] = ["scout", "analyst", "prepare"]) {
  const prefixNodes = prefix.map((node, index) => ({ ...node, key: keys[index]!,
    dependsOn: index === 0 ? [] : [keys[index - 1]!] }))
  const prefixCurrentNodes = prefixNodes.map(node => ({ key: node.key, taskId: node.taskId, status: "completed" }))
  return { proof, facts: proofFacts, currentNodes: prefixCurrentNodes,
    loaded: { ...loaded, snapshot: { ...loaded.snapshot, nodes: prefixNodes }, state: { ...loaded.state, nodes: prefixCurrentNodes } } }
}

describe("persisted scheduled Gate completion proof", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.lock.mockResolvedValue(undefined)
    mocks.load.mockResolvedValue(loaded)
    mocks.current.mockReturnValue({ nodes: currentNodes })
    mocks.evidence.mockReturnValue(evidence)
    mocks.jobIds.mockReturnValue(["job-1"])
    mocks.envelope.mockReturnValue({ structuredResult: questionResult })
    mocks.persistedProof.mockImplementation(async (_client, _scope, _taskId, _result, key) =>
      key === prepareWaitContinuationKey ? proof : null)
    mocks.registration.mockResolvedValue(registration)
    mocks.snapshot.mockReturnValue(true)
    mocks.verifyPrepare.mockResolvedValue({ verified: true, facts: proofFacts })
  })

  it.each([
    ["canonical", ["scout", "analyst", "prepare"] as const],
    ["persisted scheduled", ["scheduled-scout", "scheduled-analyst", "prepare"] as const],
  ])("accepts the %s Scout/Analyst keys with the exact certified role and dependency chain", async (_label, keys) => {
    const fixture = preparePrefixFixture(keys)
    const db = database()
    mocks.current.mockReturnValue({ nodes: fixture.currentNodes })
    mocks.verifyPrepare.mockResolvedValue({ verified: true, facts: fixture.facts })

    await expect(verifyPersistedScheduledPreparePrefix(db.client as never, scope as never,
      fixture.loaded as never, fixture.proof as never)).resolves.toBe(true)
    expect(mocks.verifyPrepare).toHaveBeenCalledOnce()
    expect(mocks.verifyPrepare).toHaveBeenCalledWith(db.client, expect.objectContaining({ checkpointStage: "gate" }))
  })

  it.each(["role", "certified task identity", "dependency chain"] as const)("rejects a wrong Prepare prefix %s", async mismatch => {
    const fixture = preparePrefixFixture(["scheduled-scout", "scheduled-analyst", "prepare"])
    const nodes = [...fixture.loaded.snapshot.nodes]
    const certificates = [...fixture.proof.completion.nodes]
    const currentNodes = [...fixture.currentNodes]
    if (mismatch === "role") nodes[0] = { ...nodes[0]!, templateId: "analyst" }
    if (mismatch === "certified task identity") {
      nodes[0] = { ...nodes[0]!, taskId: "analyst-task" }
      currentNodes[0] = { ...currentNodes[0]!, taskId: "analyst-task" }
    }
    if (mismatch === "dependency chain") nodes[1] = { ...nodes[1]!, dependsOn: ["unrelated-key"] }
    const candidate = { ...fixture, proof: { ...fixture.proof,
      completion: { ...fixture.proof.completion, nodes: certificates } },
      currentNodes, loaded: { ...fixture.loaded, snapshot: { ...fixture.loaded.snapshot, nodes },
        state: { ...fixture.loaded.state, nodes: currentNodes } } }
    mocks.current.mockReturnValue({ nodes: currentNodes })

    await expect(verifyPersistedScheduledPreparePrefix(database().client as never, scope as never,
      candidate.loaded as never, candidate.proof as never)).resolves.toBe(false)
    expect(mocks.verifyPrepare).not.toHaveBeenCalled()
  })

  it("returns the exact persisted Prepare proof and whole-envelope digest when the supplied proof matches", async () => {
    const db = database()
    const result = await verifyScheduledGateCompletion(db.client as never, { scope, executionOwner: {
      executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }, prepareProof: proof } as never)
    expect(result).toMatchObject({ prepareProof: proof, graphRevision: 20,
      gate: { taskId: "gate-task", attemptCount: 1, resultDigest: scheduledGateResultDigest(gateResult), completedEventRevision: 20 } })
    expect(mocks.persistedProof).toHaveBeenCalledOnce()
    expect(mocks.persistedProof).toHaveBeenCalledWith(db.client, expect.anything(), "prepare-task",
      expect.anything(), prepareWaitContinuationKey, "prepare-wait")
  })

  it.each(["stale", "different"] as const)("rejects a %s supplied Prepare proof instead of substituting the database proof", async kind => {
    const db = database()
    const supplied = kind === "stale" ? { ...proof, completion: { ...proof.completion, graphRevision: 7 } }
      : { ...proof, result: { jobs: [{ jobId: "job-other", status: "prepared" }] } }
    await expect(verifyScheduledGateCompletion(db.client as never, { scope, executionOwner: {
      executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }, prepareProof: supplied } as never)).resolves.toBeNull()
    expect(mocks.persistedProof).toHaveBeenCalledOnce()
    expect(mocks.envelope).not.toHaveBeenCalled()
  })

  it.each(["in_progress", "waiting_for_dependency"] as const)("admits the exact Gate lease while its Root Turn is %s", async turnStatus => {
    const db = finishDatabase({ ...suspendedOwner, turnStatus,
      turnLeaseOwnerId: turnStatus === "in_progress" ? "turn-owner" : null })
    const result = await validateScheduledGateTaskGraphFinish(db.client as never, { graph: finishGraph as never,
      taskId: "gate-task", ownerId: "gate-owner", attemptCount: 1, status: "completed", result: gateResult })
    expect(result).toEqual({ structuredResult: questionResult })
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('"turn"."leaseOwnerId"'))).toBe(false)
    expect(mocks.persistedProof).toHaveBeenCalledWith(db.client, expect.anything(), "prepare-task",
      expect.anything(), prepareWaitContinuationKey, "prepare-wait")
  })

  it.each(["queued", "interrupted", "waiting_for_user", "waiting_for_tool", "unknown"])(
    "rejects a Gate finish while the Turn has unsupported status %s", async turnStatus => {
      const db = finishDatabase({ ...suspendedOwner, turnStatus })
      await expect(validateScheduledGateTaskGraphFinish(db.client as never, { graph: finishGraph as never,
        taskId: "gate-task", ownerId: "gate-owner", attemptCount: 1, status: "completed", result: gateResult })).resolves.toBeNull()
      expect(mocks.registration).not.toHaveBeenCalled()
    })

  it.each([
    ["Turn session", { ...suspendedOwner, turnSessionId: "other-session" }],
    ["Turn user", { ...suspendedOwner, turnUserId: "other-user" }],
    ["Turn root", { ...suspendedOwner, turnRootTaskId: "other-root" }],
  ])("rejects an extant Gate finish row with a mismatched %s", async (_label, row) => {
    const db = finishDatabase(row)
    await expect(validateScheduledGateTaskGraphFinish(db.client as never, { graph: finishGraph as never,
      taskId: "gate-task", ownerId: "gate-owner", attemptCount: 1, status: "completed", result: gateResult })).resolves.toBeNull()
    expect(mocks.registration).not.toHaveBeenCalled()
  })

  it("rejects a Gate finish if the locked Root attempt advanced after Prepare", async () => {
    const db = finishDatabase({ ...suspendedOwner, rootAttemptCount: owner.rootAttemptCount + 1 })
    await expect(validateScheduledGateTaskGraphFinish(db.client as never, { graph: finishGraph as never,
      taskId: "gate-task", ownerId: "gate-owner", attemptCount: 1, status: "completed", result: gateResult })).resolves.toBeNull()
    expect(mocks.registration).not.toHaveBeenCalled()
  })

  it.each([
    ["terminal Root", { ...suspendedOwner, rootStatus: "cancelled" }],
    ["interrupted Root", { ...suspendedOwner, rootInterruptRequestedAt: new Date("2026-10-24T09:00:00Z") }],
    ["closed Root", { ...suspendedOwner, rootClosedAt: new Date("2026-10-24T09:00:00Z") }],
  ])("rejects a finish for a %s", async (_label, rootAndTurn) => {
    const db = finishDatabase(rootAndTurn)
    await expect(validateScheduledGateTaskGraphFinish(db.client as never, { graph: finishGraph as never,
      taskId: "gate-task", ownerId: "gate-owner", attemptCount: 1, status: "completed", result: gateResult })).resolves.toBeNull()
    expect(mocks.registration).not.toHaveBeenCalled()
  })
})
