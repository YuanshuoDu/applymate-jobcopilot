import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appendScheduledAudit, verifyScheduledAuditCompletion,
  verifyScheduledGateCompletionWithAuditReplay } from "./pg-scheduled-task-graph-audit-command.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_COMPLETION_SCHEMA,
  SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, scheduledPrepareResultDigest } from "./scheduled-prepare-task-graph-verification.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA, type ScheduledGateCompletionProof } from "./scheduled-gate-contract.js"
import { SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID,
  SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, parseScheduledAuditRegistrationReceipt } from "./scheduled-audit-contract.js"

const writes = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), current: vi.fn(), appendGraph: vi.fn(), snapshot: vi.fn(),
  contract: vi.fn(), freshGate: vi.fn(), registeredGate: vi.fn(), registration: vi.fn(), create: vi.fn(), policy: vi.fn(),
  inherit: vi.fn(), plan: vi.fn(), enqueue: vi.fn(), event: vi.fn() }))

vi.mock("../planning/task-graph.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../planning/task-graph.js")>()
  return { ...actual, appendTaskGraphProposal: writes.appendGraph }
})
vi.mock("./task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-state.js")>()
  return { ...actual, lockTaskGraphScope: writes.lock, loadTaskGraph: writes.load, currentTaskGraph: writes.current }
})
vi.mock("./task-graph-snapshot.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-snapshot.js")>()
  return { ...actual, taskGraphSnapshot: writes.snapshot }
})
vi.mock("./task-graph-pg-events.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-events.js")>()
  return { ...actual, appendTaskGraphReceipt: writes.event, writePlanReceipt: writes.plan }
})
vi.mock("./pg-store-create.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-create.js")>()
  return { ...actual, createSubagentTask: writes.create }
})
vi.mock("./manager-task-scope.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./manager-task-scope.js")>()
  return { ...actual, policyFromTask: writes.policy }
})
vi.mock("./types.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./types.js")>()
  return { ...actual, inheritSubagentPolicy: writes.inherit }
})
vi.mock("./task-graph-pg-create.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-create.js")>()
  return { ...actual, enqueueGraphTask: writes.enqueue }
})
vi.mock("./pg-scheduled-task-graph-gate-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-scheduled-task-graph-gate-verification.js")>()
  return { ...actual, verifyScheduledGateCompletion: writes.freshGate }
})
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>()
  return { ...actual, createScheduledTaskGraphContinuationContract: writes.contract, scheduledSnapshotMatches: vi.fn(() => true) }
})
vi.mock("./scheduled-audit-invocation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-audit-invocation.js")>()
  return { ...actual, readScheduledAuditRegistration: writes.registration,
    verifyRegisteredScheduledAuditGate: writes.registeredGate }
})

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  executionId: "execution-1", executionAttemptCount: 3 }
const scope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  parentTaskId: owner.rootTaskId, stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 5,
  parentLeaseOwner: "root-owner", parentAttemptCount: 2 }
const snapshotDigest = `sha256:${"b".repeat(64)}`
const evidenceDigest = "c".repeat(64), checkpointDigest = "d".repeat(64), analyzeGraphRevision = 7
const attestation = {
  schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1" as const,
  owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion },
  snapshotDigest, graphRevision: analyzeGraphRevision,
  scout: { taskId: "scout-task", attemptCount: 1, status: "completed" as const, verification: "passed" as const,
    resultDigest: `sha256:${"1".repeat(64)}`, candidateJobIds: ["job-1"], discoveryReceipt: { status: "complete" as const,
      taskId: "scout-task", attemptCount: 1, completedCalls: 1, candidateCount: 1, providerFailures: 0 as const,
      materializationFailures: 0 as const, hasMore: false as const, receiptDigest: `sha256:${"2".repeat(64)}` } },
  analyst: { taskId: "analyst-task", attemptCount: 1, status: "completed" as const, verification: "passed" as const,
    resultDigest: `sha256:${"3".repeat(64)}`, dependsOnTaskIds: ["scout-task"], jobIds: ["job-1"] },
  evidenceDigest,
}
const handoffContinuationKey = scheduledTaskGraphContinuationKey(attestation.owner, attestation, owner.executionId, owner.executionAttemptCount)
const binding = { owner: { ...attestation.owner, executionId: owner.executionId,
    executionAttemptCount: owner.executionAttemptCount }, continuationKey: handoffContinuationKey,
  snapshotDigest, evidenceDigest, checkpointDigest, analyzeGraphRevision, prepareScheduleRevision: analyzeGraphRevision + 1 }
const continuationKey = scheduledTaskGraphStableContinuationKey(binding)
if (!continuationKey) throw new Error("Invalid scheduled TaskGraph continuation fixture")
const prepareReceipt = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey })
if (!prepareReceipt) throw new Error("Invalid scheduled TaskGraph continuation receipt fixture")
const prepareResult: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed",
  taskId: "prepare-task", attemptCount: 1, snapshotDigest, checkpointDigest, jobs: [], materials: [] }
const prepareCompletion = { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: analyzeGraphRevision + 2,
  nodes: [
    { taskId: "scout-task", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
      status: "completed", verification: "passed", dependsOnTaskIds: [] },
    { taskId: "analyst-task", attemptCount: 1, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType,
      status: "completed", verification: "passed", dependsOnTaskIds: ["scout-task"] },
    { taskId: prepareResult.taskId, attemptCount: prepareResult.attemptCount, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType,
      status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-task"], tool: "scheduled.application.prepare@1",
      resultDigest: scheduledPrepareResultDigest(prepareResult) },
  ],
}
const prepareProof = buildScheduledPrepareTaskGraphProof({ schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
  receipt: prepareReceipt, completion: prepareCompletion, result: prepareResult }, { waitId: "prepare-wait", status: "ready",
  mode: "all", targetTaskIds: [prepareResult.taskId], matchedTaskIds: [prepareResult.taskId] })
if (!prepareProof) throw new Error("Invalid scheduled Prepare proof fixture")
const proof: ScheduledGateCompletionProof = { schemaVersion: SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA, graphRevision: 12,
  prepareProof,
  gate: { taskId: "gate-task", attemptCount: 1, resultDigest: `sha256:${"e".repeat(64)}`, completedEventRevision: 12 } }
const proofDigest = `sha256:${createHash("sha256").update(canonicalTaskGraphJson(proof), "utf8").digest("hex")}`
const registration = parseScheduledAuditRegistrationReceipt({ schemaVersion: SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  owner, continuationKey, snapshotDigest, evidenceDigest: binding.evidenceDigest, checkpointDigest: binding.checkpointDigest,
  analyzeGraphRevision: 7, prepareScheduleRevision: 8, prepareWaitId: "prepare-wait", gateTaskId: "gate-task",
  gateAttemptCount: 1, gateResultDigest: proof.gate.resultDigest, gateCompletedEventRevision: 12, gateProofDigest: proofDigest,
  scheduledWaitId: "scheduled-wait", auditTaskId: "audit-task", gateGraphRevision: 12, auditAppendRevision: 13,
  expectedAttemptCount: 1 })!
const contract = { binding, receipt: prepareReceipt }
const handoff = { status: "analyze_checkpointed" as const, continuationKey: handoffContinuationKey, checkpointDigest: binding.checkpointDigest,
  claimTokenDigest: `sha256:${"f".repeat(64)}`, executionId: owner.executionId,
  executionAttemptCount: owner.executionAttemptCount }
const report = { processed: 2, applied: 0, queued: 1, pending: 1, skipped: 0, failed: 0, durationMs: 10 }
const auditResult = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: report }
const baseNodes = [
  { key: "scout", templateId: "scout", taskId: "scout-task", goal: "Find", successCriteria: ["Found"], dependsOn: [], depth: 1, verificationDisposition: "typed" },
  { key: "analyst", templateId: "analyst", taskId: "analyst-task", goal: "Review", successCriteria: ["Reviewed"], dependsOn: ["scout"], depth: 2, verificationDisposition: "typed" },
  { key: "prepare", templateId: "prepare", taskId: "prepare-task", goal: "Prepare", successCriteria: ["Prepared"], dependsOn: ["analyst"], depth: 3, verificationDisposition: "specialized" },
  { key: "gate", templateId: "gate", taskId: "gate-task", goal: "Gate", successCriteria: ["Gated"], dependsOn: ["prepare"], depth: 4, verificationDisposition: "specialized" },
]
const currentNodes = [...baseNodes.map(node => ({ key: node.key, taskId: node.taskId, status: "completed", failureReason: null })),
  { key: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: "audit-task", status: "queued", failureReason: null }]
const oldLoaded = { rootTaskId: owner.rootTaskId, item: { id: "graph", revision: 12, content: {} },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", rootSuccessCriteria: [], nodes: baseNodes },
  state: { revision: 12, nodes: currentNodes.slice(0, 4), appliedEvents: [] }, tasks: new Map() }
const auditNode = { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, taskId: "audit-task",
  goal: SCHEDULED_AUDIT_NODE_GOAL, successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ["gate"], depth: 5,
  verificationDisposition: "legacy_unverified" }
const task = (status: string, attemptCount: number) => ({ id: "audit-task", status, attemptCount, role: SCHEDULED_AUDIT_ROLE,
  taskType: SCHEDULED_AUDIT_TASK_TYPE, expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA, allowedActions: [],
  contextIsEmpty: true, failureReason: null, result: status === "completed" ? auditResult : null })
const startedLoaded = { ...oldLoaded, item: { id: "graph", revision: 13, content: {} },
  snapshot: { ...oldLoaded.snapshot, nodes: [...baseNodes, auditNode] },
  state: { revision: 13, nodes: currentNodes, appliedEvents: [] }, tasks: new Map([["audit-task", task("retrying", 1)]]) }

function db(rows: (sql: string) => unknown[] = () => []) {
  const calls: string[] = []
  const query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: rows(sql), rowCount: 1 } })
  return { client: { query }, calls }
}
function input(gateProof = proof) { return { scope, executionOwner: { executionId: owner.executionId,
  executionAttemptCount: owner.executionAttemptCount }, handoff, attestation, gateProof, scheduledWaitId: "scheduled-wait" } }
function gateInput() { return { scope: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
  rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, turnLeaseOwner: scope.turnLeaseOwner,
  turnLeaseVersion: scope.turnLeaseVersion, parentLeaseOwner: scope.parentLeaseOwner, parentAttemptCount: scope.parentAttemptCount },
  executionOwner: input().executionOwner, prepareProof: proof.prepareProof } }

describe("PostgreSQL scheduled Audit command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writes.lock.mockResolvedValue({ budgetSnapshot: {} })
    writes.load.mockResolvedValue(oldLoaded)
    writes.current.mockReturnValue({ nodes: oldLoaded.state.nodes })
    writes.contract.mockReturnValue(contract)
    writes.freshGate.mockResolvedValue(proof)
    writes.registeredGate.mockResolvedValue(proof)
    writes.registration.mockResolvedValue(registration)
    writes.policy.mockReturnValue({})
    writes.inherit.mockReturnValue({})
    writes.create.mockResolvedValue({ id: "audit-task" })
    writes.appendGraph.mockImplementation((state, proposal) => {
      const node = proposal.nodes[0]
      return { ok: true, state: { revision: state.revision + 1, nodes: [...state.nodes, { ...node, depth: 5, taskId: "audit-task", status: "queued" }], appliedEvents: [] },
        addedNodes: [{ ...node, key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, depth: 5, status: "queued" }] }
    })
    writes.snapshot.mockReturnValue({ schemaVersion: "agent-harness.v2.task-graph.v1", nodes: [] })
    writes.plan.mockImplementation(async () => undefined)
    writes.enqueue.mockImplementation(async () => undefined)
    writes.event.mockImplementation(async () => undefined)
  })

  it("keeps the canonical verifier for a four-node graph", async () => {
    writes.load.mockResolvedValue(oldLoaded)
    const client = db().client, request = gateInput()
    await expect(verifyScheduledGateCompletionWithAuditReplay(client as never, request as never)).resolves.toEqual(proof)
    expect(writes.freshGate).toHaveBeenCalledWith(client, request)
    expect(writes.registration).not.toHaveBeenCalled()
  })

  it("replays the exact persisted Gate proof for a privately registered fixed Audit child", async () => {
    const loaded = { ...startedLoaded, state: { ...startedLoaded.state, nodes: currentNodes.map(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID
      ? { ...node, status: "retrying" } : node) }, tasks: new Map([["audit-task", task("retrying", 1)]]) }
    writes.load.mockResolvedValue(loaded)
    writes.current.mockReturnValue({ nodes: loaded.state.nodes })
    const client = db().client, request = gateInput()
    await expect(verifyScheduledGateCompletionWithAuditReplay(client as never, request as never)).resolves.toEqual(proof)
    expect(writes.registration).toHaveBeenCalledWith(client, expect.anything(), "audit-task", owner)
    expect(writes.registeredGate).toHaveBeenCalledWith(client, expect.anything(), loaded, registration, {
      schemaVersion: proof.schemaVersion, graphRevision: registration.gateGraphRevision, prepareProof: proof.prepareProof,
      gate: { taskId: registration.gateTaskId, attemptCount: registration.gateAttemptCount,
        resultDigest: registration.gateResultDigest, completedEventRevision: registration.gateCompletedEventRevision },
    })
    expect(writes.freshGate).not.toHaveBeenCalled()
  })

  it.each([
    ["generic extra node", { ...auditNode, key: "review", templateId: "review" }],
    ["legacy Audit content", { ...auditNode, goal: "Legacy Audit" }],
  ] as const)("does not accept a %s as registered Audit replay", async (_label, extraNode) => {
    const loaded = { ...startedLoaded, snapshot: { ...startedLoaded.snapshot, nodes: [...baseNodes, extraNode] } }
    writes.load.mockResolvedValue(loaded)
    writes.current.mockReturnValue({ nodes: loaded.state.nodes })
    await expect(verifyScheduledGateCompletionWithAuditReplay(db().client as never, gateInput() as never)).resolves.toBeNull()
    expect(writes.registration).not.toHaveBeenCalled()
    expect(writes.registeredGate).not.toHaveBeenCalled()
  })

  it("verifies fresh Gate proof before atomically appending and registering exactly one Audit child", async () => {
    const order: string[] = []
    writes.freshGate.mockImplementation(async () => { order.push("gate-proof"); return proof })
    writes.plan.mockImplementation(async () => { order.push("plan-and-outbox") })
    writes.enqueue.mockImplementation(async () => { order.push("dispatch") })
    writes.event.mockImplementation(async () => { order.push("private-binding") })
    const client = db(sql => sql.includes('FROM "agent_turns"') ? [{ source: "automation", executionMode: "canonical_task_graph", input: {} }] : []).client
    const result = await appendScheduledAudit(client as never, input())
    expect(result).toMatchObject({ status: "accepted", revision: 13, auditTaskId: "audit-task", expectedAttemptCount: 1 })
    expect(writes.freshGate).toHaveBeenCalledWith(client, { scope, executionOwner: input().executionOwner, prepareProof: proof.prepareProof })
    expect(order).toEqual(["gate-proof", "plan-and-outbox", "dispatch", "private-binding"])
    expect(writes.create).toHaveBeenCalledWith(client, expect.objectContaining({ role: SCHEDULED_AUDIT_ROLE,
      taskType: SCHEDULED_AUDIT_TASK_TYPE, allowedActions: [], expectedOutputSchema: SCHEDULED_AUDIT_OUTPUT_SCHEMA }),
      true, { preserveEmptyAllowedActions: true })
  })

  it("does not create or write an Audit child when fresh Gate proof differs", async () => {
    writes.freshGate.mockResolvedValue({ ...proof, graphRevision: 11 })
    const client = db(sql => sql.includes('FROM "agent_turns"') ? [{ source: "automation", executionMode: "canonical_task_graph", input: {} }] : []).client
    await expect(appendScheduledAudit(client as never, input())).rejects.toMatchObject({ code: "scheduled_audit_gate_proof" })
    expect(writes.create).not.toHaveBeenCalled()
    expect(writes.plan).not.toHaveBeenCalled()
    expect(writes.enqueue).not.toHaveBeenCalled()
    expect(writes.event).not.toHaveBeenCalled()
  })

  it.each([["queued", 0, 1], ["retrying", 1, 2], ["running", 2, 2], ["completed", 2, 2]] as const)(
    "replays the same child and returns the live expected attempt for %s", async (status, rowAttempt, expectedAttemptCount) => {
      const loaded = { ...startedLoaded, state: { ...startedLoaded.state, nodes: startedLoaded.state.nodes.map(node =>
        node.key === SCHEDULED_AUDIT_TEMPLATE_ID ? { ...node, status } : node) },
        tasks: new Map([["audit-task", task(status, rowAttempt)]]) }
      writes.load.mockResolvedValue(loaded)
      writes.current.mockReturnValue({ nodes: loaded.state.nodes })
      const row = { ...task(status, rowAttempt), id: "audit-task", leaseOwner: status === "running" ? "lease" : null,
        leaseExpiresAt: status === "running" ? new Date("2026-10-25T12:00:00.000Z") : null, context: {} }
      const client = db(sql => sql.includes('FROM "sub_agent_tasks"') ? [row]
        : sql.includes('FROM "agent_turns"') ? [{ source: "automation", executionMode: "canonical_task_graph", input: {} }] : []).client
      const result = await appendScheduledAudit(client as never, input())
      expect(result).toMatchObject({ status: "duplicate", revision: 13, auditTaskId: "audit-task", expectedAttemptCount })
      expect(writes.create).not.toHaveBeenCalled()
      expect(writes.plan).not.toHaveBeenCalled()
      expect(writes.enqueue).not.toHaveBeenCalled()
      expect(writes.event).not.toHaveBeenCalled()
    })

  it("accepts the exact completion event revision even when later graph events advanced the graph", async () => {
    const completedTask = task("completed", 2), eventRevision = 14, graphRevision = 15
    const loaded = { ...startedLoaded, item: { ...startedLoaded.item, revision: graphRevision },
      state: { revision: graphRevision, nodes: currentNodes.map(node => node.key === SCHEDULED_AUDIT_TEMPLATE_ID
        ? { ...node, status: "completed" } : node), appliedEvents: [
        { nodeKey: SCHEDULED_AUDIT_TEMPLATE_ID, type: "task.completed",
          idempotencyKey: taskGraphLifecycleKey(owner.rootTaskId, SCHEDULED_AUDIT_TEMPLATE_ID, 2, "task.completed"),
          expectedRevision: eventRevision - 1 },
        { nodeKey: "gate", type: "task.note", idempotencyKey: "later-graph-event", expectedRevision: eventRevision },
      ] }, tasks: new Map([["audit-task", completedTask]]) }
    writes.load.mockResolvedValue(loaded)
    writes.current.mockReturnValue({ revision: graphRevision, nodes: loaded.state.nodes })
    const row = { ...completedTask, context: {}, leaseOwner: null, leaseExpiresAt: null }
    const client = db(sql => sql.includes('FROM "sub_agent_tasks"') ? [row] : []).client
    const proofResult = await verifyScheduledAuditCompletion(client as never, { scope: { ...scope, stepId: undefined,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 5, parentLeaseOwner: "root-owner" },
      executionOwner: input().executionOwner, gateProof: proof, auditTaskId: "audit-task", attemptCount: 2 } as never)
    expect(proofResult).toMatchObject({ graphRevision, audit: { taskId: "audit-task", attemptCount: 2,
      completedEventRevision: eventRevision }, report })
  })
})
