import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readScheduledAuditInvocationProof, readScheduledAuditRegistration } from "./scheduled-audit-invocation.js"
import { SCHEDULED_PIPELINE_ATTESTATION_SCHEMA } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledGateProposal, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"
import { scheduledAuditProposal, scheduledAuditRegistrationReceiptKey, SCHEDULED_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE } from "./scheduled-audit-contract.js"

const mocks = vi.hoisted(() => ({ load: vi.fn(), current: vi.fn(), evidence: vi.fn(), snapshot: vi.fn(), analyze: vi.fn(),
  gateRegistration: vi.fn(), prepareProof: vi.fn(), verifyPrefix: vi.fn(), jobIds: vi.fn(), gateEnvelope: vi.fn() }))

vi.mock("./task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-state.js")>()
  return { ...actual, loadTaskGraph: mocks.load, currentTaskGraph: mocks.current }
})
vi.mock("./scheduled-gate-contract.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-gate-contract.js")>()
  return { ...actual, scheduledGateCheckpointEvidence: mocks.evidence, scheduledGatePreparedJobIds: mocks.jobIds,
    parseScheduledGateTaskEnvelope: mocks.gateEnvelope }
})
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>()
  return { ...actual, scheduledSnapshotMatches: mocks.snapshot, scheduledAnalyzeGraphMatches: mocks.analyze }
})
vi.mock("./scheduled-gate-registration-receipt.js", () => ({ readScheduledGateRegistrationReceipt: mocks.gateRegistration }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ loadPersistedScheduledPrepareProof: mocks.prepareProof }))
vi.mock("./pg-scheduled-task-graph-gate-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-scheduled-task-graph-gate-verification.js")>()
  return { ...actual, verifyPersistedScheduledPreparePrefix: mocks.verifyPrefix }
})

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 3 }
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId }
const continuationKey = `scheduled-taskgraph:sha256:${"a".repeat(64)}`
const snapshotDigest = `sha256:${"b".repeat(64)}`
const evidence = { owner, continuationKey, prepareWaitContinuationKey: `scheduled-taskgraph:sha256:${"c".repeat(64)}`,
  snapshotDigest, evidenceDigest: "d".repeat(64), checkpointDigest: "e".repeat(64), analyzeGraphRevision: 7 }
const attestation = { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_SCHEMA,
  owner: { ...scope, rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: "turn-owner", turnLeaseVersion: 5 },
  snapshotDigest, graphRevision: 7, scout: {}, analyst: {}, evidenceDigest: evidence.evidenceDigest }
const prepare = { receipt: { owner, continuationKey, prepareWaitId: "prepare-wait" },
  completion: { wait: { waitId: "prepare-wait" } }, result: { jobs: [{ jobId: "job-1" }] } }
const gateResult = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: { status: "completed" } }
const gateResultDigest = `sha256:${createHash("sha256").update(canonicalTaskGraphJson(gateResult), "utf8").digest("hex")}`
const gateProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 12, prepareProof: prepare,
  gate: { taskId: "gate-task", attemptCount: 1, resultDigest: gateResultDigest, completedEventRevision: 12 } }
const gateProofDigest = `sha256:${createHash("sha256").update(canonicalTaskGraphJson(gateProof), "utf8").digest("hex")}`
const registration = { schemaVersion: SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA, owner, continuationKey, snapshotDigest,
  evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest, analyzeGraphRevision: 7,
  prepareScheduleRevision: 8, prepareWaitId: "prepare-wait", gateTaskId: "gate-task", gateAttemptCount: 1,
  gateResultDigest, gateCompletedEventRevision: 12, gateProofDigest, scheduledWaitId: "scheduled-wait", auditTaskId: "audit-task",
  gateGraphRevision: 12, auditAppendRevision: 13, expectedAttemptCount: 1 }
const gateRegistration = { owner, continuationKey, prepareWaitId: "prepare-wait", gateAppendRevision: 9 }
const gateDefinition = scheduledGateProposal(11).nodes[0]!
const auditDefinition = scheduledAuditProposal(12).nodes[0]!
const nodes = [
  { key: "scout", templateId: "scout", taskId: "scout-task", goal: "Find", successCriteria: ["Found"], dependsOn: [], depth: 1, verificationDisposition: "typed" },
  { key: "analyst", templateId: "analyst", taskId: "analyst-task", goal: "Review", successCriteria: ["Reviewed"], dependsOn: ["scout"], depth: 2, verificationDisposition: "typed" },
  { key: "prepare", templateId: "prepare", taskId: "prepare-task", goal: "Prepare", successCriteria: ["Prepared"], dependsOn: ["analyst"], depth: 3, verificationDisposition: "specialized" },
  { ...gateDefinition, taskId: "gate-task", depth: 4, verificationDisposition: "specialized" },
  { ...auditDefinition, taskId: "audit-task", depth: 5, verificationDisposition: "specialized" },
]
const statuses = ["completed", "completed", "completed", "completed", "running"]
const current = nodes.map((node, index) => ({ key: node.key, taskId: node.taskId, status: statuses[index], failureReason: null }))
const task = (id: string, status: string, role: string, taskType: string, expectedOutputSchema: unknown, attemptCount: number, result: unknown) =>
  ({ id, status, role, taskType, expectedOutputSchema, allowedActions: [], contextIsEmpty: true, attemptCount, failureReason: null, result })
const loaded = { rootTaskId: owner.rootTaskId, item: { id: "graph", revision: 14, content: {} },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria: [], nodes },
  state: { revision: 14, nodes: current, appliedEvents: [{ nodeKey: "gate", type: "task.completed",
    idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, "gate", 1, "task.completed"), expectedRevision: 11 }] },
  tasks: new Map<string, ReturnType<typeof task>>([
    ["scout-task", task("scout-task", "completed", "scout", "job_discovery", {}, 1, {})],
    ["analyst-task", task("analyst-task", "completed", "analyst", "job_analysis", {}, 1, {})],
    ["prepare-task", task("prepare-task", "completed", "prepare", "scheduled_taskgraph_prepare", {}, 1, {})],
    ["gate-task", task("gate-task", "completed", SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_OUTPUT_SCHEMA, 1, gateResult)],
    ["audit-task", task("audit-task", "running", SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_OUTPUT_SCHEMA, 2, null)],
  ]) }

function database(eventPayload: unknown = registration, hasOutbox = false, executionStatus = "running"): Queryable {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM \"agent_events\" AS event")) return { rows: [{ itemId: null, taskId: null, actor: "system",
      idempotencyKey: scheduledAuditRegistrationReceiptKey(continuationKey, "audit-task"), payload: eventPayload, hasOutbox }], rowCount: 1 }
    if (sql.includes("FROM \"agent_executions\"")) return { rows: [{ id: owner.executionId, status: executionStatus,
      attemptCount: owner.executionAttemptCount, state: {} }], rowCount: 1 }
    if (sql.includes("FROM \"agent_turns\"")) return { rows: [{ source: "automation", executionMode: "canonical_task_graph", input: {} }], rowCount: 1 }
    if (sql.includes("FROM \"sub_agent_tasks\"")) return { rows: [{ status: "completed", attemptCount: 1,
      role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA,
      allowedActions: [], context: {}, result: gateResult, failureReason: null, leaseOwner: null, leaseExpiresAt: null }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  return { query } as unknown as Queryable
}

describe("scheduled Audit invocation proof readback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockResolvedValue(loaded)
    mocks.current.mockReturnValue({ revision: loaded.state.revision, nodes: loaded.state.nodes })
    mocks.evidence.mockReturnValue(evidence)
    mocks.snapshot.mockReturnValue(true)
    mocks.analyze.mockReturnValue(true)
    mocks.gateRegistration.mockResolvedValue(gateRegistration)
    mocks.prepareProof.mockResolvedValue(prepare)
    mocks.verifyPrefix.mockResolvedValue(true)
    mocks.jobIds.mockReturnValue(["job-1"])
    mocks.gateEnvelope.mockReturnValue({ structuredResult: { status: "completed" } })
  })

  it("rebinds the exact owner, attestation, Gate proof, wait ID, and current Audit attempt", async () => {
    const db = database()
    const result = await readScheduledAuditInvocationProof(db, { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never)
    expect(result).toMatchObject({ owner, snapshotDigest, attestation, prepareProof: prepare, gateProof,
      scheduledWaitId: "scheduled-wait", auditTaskId: "audit-task", attemptCount: 2, graphRevision: 14 })
    expect(mocks.load).toHaveBeenCalledWith(db, { ...scope, parentTaskId: scope.rootTaskId }, false)
    expect(mocks.verifyPrefix).toHaveBeenCalledOnce()
  })

  it("rebinds the same exact Gate proof after Web persisted the scheduled report", async () => {
    const db = database(registration, false, "completed")
    const result = await readScheduledAuditInvocationProof(db, { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never)
    expect(result).toMatchObject({ owner, snapshotDigest, attestation, prepareProof: prepare, gateProof,
      scheduledWaitId: "scheduled-wait", auditTaskId: "audit-task", attemptCount: 2, graphRevision: 14 })
    expect(mocks.verifyPrefix).toHaveBeenCalledOnce()
  })

  it("rebinds Gate proof while the execution is paused for its Audit child", async () => {
    const db = database(registration, false, "paused")
    const result = await readScheduledAuditInvocationProof(db, { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never)
    expect(result).toMatchObject({ owner, snapshotDigest, attestation, prepareProof: prepare, gateProof,
      scheduledWaitId: "scheduled-wait", auditTaskId: "audit-task", attemptCount: 2, graphRevision: 14 })
    expect(mocks.verifyPrefix).toHaveBeenCalledOnce()
  })

  it("rejects the unprojected Turn dependency status", async () => {
    await expect(readScheduledAuditInvocationProof(database(registration, false, "waiting_for_dependency"),
      { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never)).resolves.toBeNull()
    expect(mocks.gateRegistration).not.toHaveBeenCalled()
  })

  it("rejects the former legacy Audit disposition", async () => {
    const invalid = { ...loaded, snapshot: { ...loaded.snapshot, nodes: loaded.snapshot.nodes.map(node =>
      node.key === "scheduled_audit" ? { ...node, verificationDisposition: "legacy_unverified" } : node) } }
    mocks.load.mockResolvedValue(invalid as never)
    await expect(readScheduledAuditInvocationProof(database(), { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never))
      .resolves.toBeNull()
  })

  it("rejects an execution waiting for user input before Gate completes", async () => {
    await expect(readScheduledAuditInvocationProof(database(registration, false, "waiting_for_user"),
      { scope, auditTaskId: "audit-task", attemptCount: 2, attestation } as never)).resolves.toBeNull()
    expect(mocks.gateRegistration).not.toHaveBeenCalled()
  })

  it.each([
    ["wrong attempt", { scope, auditTaskId: "audit-task", attemptCount: 3, attestation }],
    ["wrong owner", { scope: { ...scope, rootTaskId: "other-root" }, auditTaskId: "audit-task", attemptCount: 2, attestation }],
    ["wrong snapshot", { scope, auditTaskId: "audit-task", attemptCount: 2, attestation: { ...attestation, snapshotDigest: "sha256:" + "f".repeat(64) } }],
  ])("rejects an invocation with %s", async (_label, input) => {
    await expect(readScheduledAuditInvocationProof(database(), input as never)).resolves.toBeNull()
    expect(mocks.gateRegistration).not.toHaveBeenCalled()
  })

  it("rejects a private registration event that has an outbox projection", async () => {
    await expect(readScheduledAuditRegistration(database(registration, true), { ...scope, parentTaskId: scope.rootTaskId }, "audit-task"))
      .resolves.toBeNull()
  })
})
