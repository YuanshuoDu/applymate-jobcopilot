import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appendScheduledGate } from "./pg-scheduled-task-graph-gate-command.js"
import { scheduledGateCandidateSetDigest, scheduledGateProposal, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE,
  SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import type { TaskGraphScheduledGateInput } from "./task-graph-command-port.js"
import { SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA } from "./scheduled-gate-registration-receipt.js"
import { SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

type GateGraphFixture = Pick<LoadedGraph, "rootTaskId"> & Readonly<{
  item: Pick<NonNullable<LoadedGraph["item"]>, "id" | "revision" | "content">
  snapshot: Readonly<{ schemaVersion: string; rootSuccessCriteria: readonly string[]; nodes: readonly Record<string, unknown>[] }>
  state: Readonly<{ revision: number; appliedEvents: readonly unknown[]; nodes?: readonly Record<string, unknown>[] }>
  tasks: ReadonlyMap<string, Record<string, unknown>>
}>

const mocks = vi.hoisted(() => ({
  contract: vi.fn(), snapshot: vi.fn(), receiptMatches: vi.fn(), lock: vi.fn(), load: vi.fn(),
  current: vi.fn(), prepareProof: vi.fn(), registration: vi.fn(), prefix: vi.fn(),
}))
const creation = vi.hoisted(() => ({ child: vi.fn(), enqueue: vi.fn(), plan: vi.fn(), event: vi.fn() }))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>()
  return { ...actual, createScheduledTaskGraphContinuationContract: mocks.contract,
    scheduledSnapshotMatches: mocks.snapshot, scheduledTaskGraphContinuationReceiptMatches: mocks.receiptMatches }
})
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: mocks.lock, loadTaskGraph: mocks.load, currentTaskGraph: mocks.current }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ loadPersistedScheduledPrepareProof: mocks.prepareProof }))
vi.mock("./scheduled-gate-registration-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-gate-registration-receipt.js")>()
  return { ...actual, readScheduledGateRegistrationReceipt: mocks.registration }
})
vi.mock("./pg-scheduled-task-graph-gate-verification.js", () => ({ verifyPersistedScheduledPreparePrefix: mocks.prefix }))
vi.mock("./pg-store-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-store-create.js")>(),
  createSubagentTask: creation.child,
}))
vi.mock("./task-graph-pg-create.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-create.js")>(),
  enqueueGraphTask: creation.enqueue,
}))
vi.mock("./task-graph-pg-events.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-events.js")>(),
  writePlanReceipt: creation.plan,
  appendTaskGraphReceipt: creation.event,
}))

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-owner", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 3 }
const continuationKey = "scheduled-taskgraph:sha256:" + "a".repeat(64)
const stableReceiptKey = "scheduled-taskgraph:sha256:" + "9".repeat(64)
const claimToken = "claim-secret"
const claimTokenDigest = "sha256:" + createHash("sha256").update(claimToken).digest("hex")
const binding = { owner, continuationKey, snapshotDigest: "sha256:" + "b".repeat(64), evidenceDigest: "c".repeat(64),
  checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, prepareScheduleRevision: 8 }
const continuationReceipt = { schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, ...binding,
  continuationKey: stableReceiptKey }
const contract = { binding, receipt: continuationReceipt, bindingDigest: "e".repeat(64), proposalFingerprint: "f".repeat(64), claimTokenDigest }
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, stepId: "root-step", turnLeaseOwner: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion,
  parentLeaseOwner: owner.turnLeaseOwnerId, parentAttemptCount: owner.rootAttemptCount }
const proof = {
  receipt: continuationReceipt,
  completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 7,
    nodes: [{ key: "scout", taskId: "scout-task" }, { key: "analyst", taskId: "analyst-task" },
      { key: "prepare", taskId: "prepare-task" }] as unknown as readonly [{ key: string }, { key: string }, { key: string }],
    wait: { waitId: "prepare-wait" } },
  result: { jobs: [{ jobId: "job-1", status: "prepared" }] },
}
const proofFacts = { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt: continuationReceipt,
  completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 7, nodes: proof.completion.nodes }, result: proof.result }
const proposal = scheduledGateProposal(7)
const input = { scope, executionOwner: { executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  handoff: { status: "analyze_checkpointed", continuationKey, checkpointDigest: binding.checkpointDigest, claimTokenDigest,
    executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  attestation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1" }, prepareProof: proof, proposal } as unknown as TaskGraphScheduledGateInput
const gateDefinition = scheduledGateProposal(0).nodes[0]!
const gateNode = { ...gateDefinition, taskId: "gate-task", depth: 4, status: "waiting_for_user", readiness: "blocked",
  verificationDisposition: "specialized" }
const nodes = [
  { key: "scout", templateId: "scout", taskId: "scout-task", depth: 1, dependsOn: [], verificationDisposition: "typed" },
  { key: "analyst", templateId: "analyst", taskId: "analyst-task", depth: 2, dependsOn: ["scout"], verificationDisposition: "typed" },
  { key: "prepare", templateId: "prepare", taskId: "prepare-task", depth: 3, dependsOn: ["analyst"], verificationDisposition: "specialized" },
  gateNode,
]
const claim = { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1", key: continuationKey, claimToken,
  owner, claimedAt: "2026-10-22T10:00:00.000Z", leaseExpiresAt: "2026-10-22T10:10:00.000Z" }
const currentTime = new Date("2026-10-22T10:11:00.000Z")
const preparedTask = { id: "prepare-task", status: "completed", result: { taskGraphScheduledPrepareProofFacts: proofFacts } }
const question = { status: "question_required", kind: "weak_cover_letter", jobIds: ["job-1"],
  candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", ["job-1"]), allowedChoiceIds: ["continue", "review", "skip"] }
const gateResult = { finalItemId: null, finalText: "", status: "waiting_for_user", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: question }
const gateTask = { id: "gate-task", status: "waiting_for_user", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
  expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], contextIsEmpty: true, attemptCount: 1, result: gateResult }
const loadedGate = { rootTaskId: owner.rootTaskId, item: { id: "graph", revision: 12, content: {} },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria: [], nodes },
  state: { revision: 12, appliedEvents: [{ nodeKey: "gate", type: "task.started",
    idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.started"), expectedRevision: 11 }] },
  tasks: new Map<string, Record<string, unknown>>([["prepare-task", preparedTask], ["gate-task", gateTask]]) }
const registration = { schemaVersion: SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA, owner: {
  userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
  continuationKey: stableReceiptKey, snapshotDigest: binding.snapshotDigest, evidenceDigest: binding.evidenceDigest, checkpointDigest: binding.checkpointDigest,
  analyzeGraphRevision: 7, prepareScheduleRevision: 8, prepareWaitId: "prepare-wait", gateTaskId: "gate-task", gateAppendRevision: 11 }

function database(graph: GateGraphFixture, allowedActions: unknown = [], persistedClaim = claim) {
  const calls: string[] = []
  const query = vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "automation", executionMode: "canonical_task_graph", input: {} }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ context: {}, allowedActions, status: "waiting_for_user", attemptCount: 1 }], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: owner.executionId, status: "running", attemptCount: owner.executionAttemptCount,
      state: { scheduledTaskGraphClaim: persistedClaim }, now: currentTime }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
  mocks.load.mockResolvedValue(graph)
  mocks.current.mockReturnValue({ revision: 12, nodes: [{ key: "gate", taskId: "gate-task", status: "waiting_for_user", readiness: "blocked" }] })
  return { query, calls, client: { query } }
}
function baseGraph() {
  const rootSuccessCriteria: string[] = []
  return { rootTaskId: owner.rootTaskId, item: { id: "graph", revision: 7, content: {} },
    snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria, nodes: nodes.slice(0, 3) },
    state: { revision: 7, appliedEvents: [] }, tasks: new Map([["prepare-task", preparedTask]]) }
}

describe("scheduled Gate append claim replay", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.contract.mockReturnValue(contract)
    mocks.snapshot.mockReturnValue(true)
    mocks.receiptMatches.mockReturnValue(true)
    mocks.lock.mockResolvedValue({ budgetSnapshot: {} })
    mocks.prepareProof.mockResolvedValue(proof)
    mocks.registration.mockResolvedValue(registration)
    mocks.prefix.mockResolvedValue(true)
    creation.child.mockResolvedValue({
      id: "gate-task", rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, path: "/root-1/gate",
      depth: 4, role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, status: "queued",
    })
    creation.enqueue.mockResolvedValue(undefined)
    creation.plan.mockResolvedValue(undefined)
    creation.event.mockResolvedValue(undefined)
  })

  it("allows only an exact duplicate replay after the Web claim expires, locking Gate before execution", async () => {
    const db = database(loadedGate)
    await expect(appendScheduledGate(db.client as never, input)).resolves.toMatchObject({
      status: "duplicate", revision: 12, nodes: [{ key: "gate", taskId: "gate-task", status: "waiting" }], readyTaskIds: [],
    })
    const gateLock = db.calls.findIndex(sql => sql.includes('FROM "sub_agent_tasks"'))
    const executionLock = db.calls.findIndex(sql => sql.includes('FROM "agent_executions"'))
    expect(gateLock).toBeGreaterThanOrEqual(0)
    expect(executionLock).toBeGreaterThan(gateLock)
    expect(db.calls[executionLock]).toContain("FOR UPDATE")
    expect(db.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(mocks.registration).toHaveBeenCalledTimes(1)
    expect(mocks.prefix).toHaveBeenCalledTimes(1)
  })

  it("replays the stored claim across a fresh Turn lease without changing stable Run ownership", async () => {
    const renewedOwner = { ...owner, turnLeaseOwnerId: "turn-owner-v2", turnLeaseVersion: 5 }
    mocks.contract.mockReturnValue({ ...contract, binding: { ...binding, owner: renewedOwner } })
    const renewedInput = { ...input, scope: { ...scope, turnLeaseOwner: renewedOwner.turnLeaseOwnerId,
      turnLeaseVersion: renewedOwner.turnLeaseVersion, parentLeaseOwner: "root-owner-v2" } }
    const db = database(loadedGate)
    await expect(appendScheduledGate(db.client as never, renewedInput as unknown as TaskGraphScheduledGateInput)).resolves.toMatchObject({
      status: "duplicate", nodes: [{ key: "gate", taskId: "gate-task", status: "waiting" }],
    })
    expect(mocks.contract).toHaveBeenCalledOnce()
    expect(db.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(db.calls.some(sql => sql.includes('FROM "agent_executions"') && sql.includes("FOR UPDATE"))).toBe(true)
  })

  it.each([{}, "not-an-array"]) ("rejects duplicate replay when allowedActions is malformed: %s", async allowedActions => {
    const db = database(loadedGate, allowedActions)
    await expect(appendScheduledGate(db.client as never, input)).rejects.toMatchObject({ code: "scheduled_gate_task_policy" })
    expect(db.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(db.calls.some(sql => sql.includes('FROM "agent_executions"'))).toBe(false)
  })

  it("still rejects an expired claim before the first Gate append", async () => {
    const db = database(baseGraph())
    await expect(appendScheduledGate(db.client as never, input)).rejects.toMatchObject({ code: "scheduled_gate_claim_stale" })
    expect(db.calls.some(sql => sql.includes('FROM "agent_events"'))).toBe(true)
    expect(db.calls.some(sql => sql.includes('FROM "agent_executions"'))).toBe(true)
    expect(mocks.registration).not.toHaveBeenCalled()
  })

  it("opts the canonical scheduled Gate into its server-owned deadline at creation", async () => {
    const prefix = [
      { key: "scout", templateId: "scout", taskId: "scout-task", goal: "Find roles", successCriteria: ["Found roles"],
        dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" },
      { key: "analyst", templateId: "analyst", taskId: "analyst-task", goal: "Review roles", successCriteria: ["Reviewed roles"],
        dependsOn: ["scout"], depth: 2, status: "completed", verificationDisposition: "legacy_unverified" },
      { key: "prepare", templateId: "prepare", taskId: "prepare-task", goal: "Prepare applications", successCriteria: ["Prepared"],
        dependsOn: ["analyst"], depth: 3, status: "completed", verificationDisposition: "specialized" },
    ]
    const snapshotPrefix = prefix.map(({ status: _status, ...node }) => node)
    const base = baseGraph()
    const graph = {
      ...base,
      snapshot: { ...base.snapshot, rootSuccessCriteria: ["Finish the scheduled objective"], nodes: snapshotPrefix },
      state: { revision: 7, nodes: prefix, appliedEvents: [] },
    }
    const db = database(graph, [], { ...claim, leaseExpiresAt: "2026-10-22T10:12:00.000Z" })
    mocks.current.mockReturnValue({ revision: 7, nodes: prefix })

    await expect(appendScheduledGate(db.client as never, input)).resolves.toMatchObject({
      status: "accepted", nodes: [{ key: "gate", taskId: "gate-task", status: "queued" }],
    })
    expect(creation.child).toHaveBeenCalledWith(db.client, expect.objectContaining({
      role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE,
    }), true, { preserveEmptyAllowedActions: true, taskGraphChildDeadline: true })
  })

  it("appends Gate after a two-Scout v2 Analyze plus Prepare prefix", async () => {
    const v2Key = "scheduled-taskgraph:v2:sha256:" + "8".repeat(64), v2StableKey = "scheduled-taskgraph:v2:sha256:" + "7".repeat(64)
    const scouts = [
      { key: "scout-a", templateId: "scout", taskId: "scout-task-a", goal: "Find roles A", successCriteria: ["Found roles A"],
        dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" },
      { key: "scout-b", templateId: "scout", taskId: "scout-task-b", goal: "Find roles B", successCriteria: ["Found roles B"],
        dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" },
    ]
    const analyst = { key: "analyst", templateId: "analyst", taskId: "analyst-task", goal: "Review roles", successCriteria: ["Reviewed roles"],
      dependsOn: ["scout-a", "scout-b"], depth: 2, status: "completed", verificationDisposition: "legacy_unverified" }
    const prepare = { key: "prepare", templateId: "prepare", taskId: "prepare-task", goal: "Prepare applications", successCriteria: ["Prepared"],
      dependsOn: ["analyst"], depth: 3, status: "completed", verificationDisposition: "specialized" }
    const prefix = [...scouts, analyst, prepare], snapshotPrefix = prefix.map(({ status: _status, ...node }) => node)
    const v2StableReceipt = { ...continuationReceipt, continuationKey: v2StableKey }
    const v2ProofNodes: ScheduledPrepareTaskGraphProof["completion"]["nodes"] = [
      ...scouts.map(source => ({ taskId: source.taskId, attemptCount: 1, role: "scout" as const, taskType: "job_discovery",
        status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: [] })),
      { taskId: analyst.taskId, attemptCount: 1, role: "analyst", taskType: "job_analysis", status: "completed", verification: "passed",
        dependsOnTaskIds: scouts.map(source => source.taskId) },
      { taskId: prepare.taskId, attemptCount: 1, role: "prepare", taskType: "scheduled_application_prepare", status: "completed", verification: "passed",
        dependsOnTaskIds: [analyst.taskId], tool: "scheduled.application.prepare@1", resultDigest: "a".repeat(64) },
    ]
    const v2Proof: ScheduledPrepareTaskGraphProof = { receipt: v2StableReceipt as ScheduledPrepareTaskGraphProof["receipt"],
      completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 7, nodes: v2ProofNodes,
        wait: { waitId: "prepare-wait", status: "ready", mode: "all", targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"] } },
      result: proof.result as unknown as ScheduledPrepareTaskGraphProof["result"] }
    const v2PreparedTask = { ...preparedTask, result: { taskGraphScheduledPrepareProofFacts: { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
      receipt: v2Proof.receipt, completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 7, nodes: v2ProofNodes },
      result: v2Proof.result } } }
    const v2Contract = { ...contract, binding: { ...binding, continuationKey: v2Key }, receipt: v2StableReceipt }
    mocks.contract.mockReturnValue(v2Contract)
    mocks.prepareProof.mockResolvedValue(v2Proof)
    const graph = { ...baseGraph(), snapshot: { ...baseGraph().snapshot, rootSuccessCriteria: ["Finish the scheduled objective"], nodes: snapshotPrefix },
      state: { revision: 7, nodes: prefix, appliedEvents: [] }, tasks: new Map([["prepare-task", v2PreparedTask]]) }
    const db = database(graph, [], { ...claim, key: v2Key, leaseExpiresAt: "2026-10-22T10:12:00.000Z" })
    mocks.current.mockReturnValue({ revision: 7, nodes: prefix })
    const v2Input = { ...input, handoff: { ...input.handoff, continuationKey: v2Key },
      attestation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v2" }, prepareProof: v2Proof }

    await expect(appendScheduledGate(db.client as never, v2Input as unknown as TaskGraphScheduledGateInput)).resolves.toMatchObject({
      status: "accepted", nodes: [{ key: "gate", taskId: "gate-task", status: "queued" }],
    })
    expect(mocks.prepareProof).toHaveBeenCalledWith(db.client, scope, "prepare-task", v2PreparedTask.result, v2Key, "prepare-wait")
    expect(creation.child).toHaveBeenCalledWith(db.client, expect.objectContaining({ taskType: SCHEDULED_GATE_TASK_TYPE }), true,
      { preserveEmptyAllowedActions: true, taskGraphChildDeadline: true })

    const gate = { ...gateDefinition, taskId: "gate-task", depth: 4, status: "waiting_for_user", readiness: "blocked",
      verificationDisposition: "specialized" }
    const replayState = { revision: 10, nodes: [...prefix, { ...gate, readiness: undefined }], appliedEvents: [
      { nodeKey: "gate", type: "task.started", idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.started"), expectedRevision: 8 },
      { nodeKey: "gate", type: "task.waiting_for_user", idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.waiting_for_user"), expectedRevision: 9 },
    ] }
    const replayTasks = new Map<string, Record<string, unknown>>([["prepare-task", v2PreparedTask], ["gate-task", {
      id: "gate-task", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, status: "waiting_for_user",
      attemptCount: 1, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA,
    }]])
    const replayGraph = { ...graph, snapshot: { ...graph.snapshot, nodes: [...snapshotPrefix, gate] }, state: replayState, tasks: replayTasks }
    mocks.registration.mockResolvedValue({ ...registration, continuationKey: v2StableKey, gateAppendRevision: 8 })
    mocks.prepareProof.mockResolvedValue(v2Proof)
    creation.child.mockClear(); creation.plan.mockClear(); creation.enqueue.mockClear(); creation.event.mockClear()
    const replayDb = database(replayGraph, [], { ...claim, key: v2Key })
    mocks.current.mockReturnValue({ revision: 10, nodes: replayState.nodes })
    await expect(appendScheduledGate(replayDb.client as never, v2Input as unknown as TaskGraphScheduledGateInput)).resolves.toMatchObject({
      status: "duplicate", revision: 10, nodes: [{ key: "gate", taskId: "gate-task", status: "waiting" }],
    })
    expect(creation.child).not.toHaveBeenCalled()
    expect(replayDb.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
  })

  it("loads the Prepare wait with the handoff key while replaying the stable receipt identity", async () => {
    expect(continuationReceipt.continuationKey).not.toBe(continuationKey)
    mocks.prepareProof.mockImplementation(async (_client, _scope, _taskId, _result, key, waitId) =>
      key === continuationKey && waitId === "prepare-wait" ? proof : null)
    const db = database(loadedGate)
    await expect(appendScheduledGate(db.client as never, input)).resolves.toMatchObject({ status: "duplicate", nodes: [{ taskId: "gate-task" }] })
    expect(mocks.prepareProof).toHaveBeenCalledWith(db.client, scope, "prepare-task", preparedTask.result, continuationKey, "prepare-wait")
    expect(db.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(mocks.registration).toHaveBeenCalledWith(db.client, expect.objectContaining({ gateTaskId: "gate-task" }))

    mocks.prepareProof.mockClear()
    mocks.registration.mockResolvedValue({ ...registration, continuationKey })
    const wrongKeyDb = database(loadedGate)
    await expect(appendScheduledGate(wrongKeyDb.client as never, input)).rejects.toMatchObject({ code: "scheduled_gate_receipt_conflict" })
    expect(mocks.prepareProof).toHaveBeenCalledWith(wrongKeyDb.client, scope, "prepare-task", preparedTask.result,
      continuationKey, "prepare-wait")
    expect(wrongKeyDb.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
  })
})
