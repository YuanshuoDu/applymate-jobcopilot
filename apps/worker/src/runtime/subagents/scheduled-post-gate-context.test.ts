import { afterEach, describe, expect, it, vi } from "vitest"
import { SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
  SCHEDULED_POST_GATE_HANDOFF_SCHEMA, scheduledPostGateDigest } from "./scheduled-post-gate-contract.js"
import { readScheduledPostGateChildContext } from "./scheduled-post-gate-context.js"
import type { SubagentLease } from "./types.js"

const mocks = vi.hoisted(() => ({ checkpoint: vi.fn(), parseSnapshot: vi.fn(), current: vi.fn(), loadGraph: vi.fn(),
  readReceipt: vi.fn(), validateHandoff: vi.fn(), buildAttestation: vi.fn(), verifyEvidence: vi.fn(), snapshotMatches: vi.fn() }))
vi.mock("./scheduled-audit-invocation.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-audit-invocation.js")>(), scheduledAuditGateCheckpointEvidence: mocks.checkpoint,
}))
vi.mock("./scheduled-automation-snapshot.js", () => ({ parseScheduledAutomationSnapshot: mocks.parseSnapshot }))
vi.mock("./task-graph-pg-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-state.js")>(), currentTaskGraph: mocks.current, loadTaskGraph: mocks.loadGraph,
}))
vi.mock("./scheduled-post-gate-handoff.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-post-gate-handoff.js")>(),
  readScheduledPostGateReceipt: mocks.readReceipt, validateScheduledPostGateHandoff: mocks.validateHandoff,
}))
vi.mock("./scheduled-pipeline-current-attestation.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-pipeline-current-attestation.js")>(),
  buildScheduledPipelineGraphAttestation: mocks.buildAttestation,
}))
vi.mock("./task-graph-pg-verification.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-pg-verification.js")>(), verifyCompletedTaskGraphNodeEvidence: mocks.verifyEvidence,
}))
vi.mock("./scheduled-taskgraph-continuation-receipt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-taskgraph-continuation-receipt.js")>(), scheduledSnapshotMatches: mocks.snapshotMatches,
}))

const digest = `sha256:${"a".repeat(64)}`
const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "root-lease-original", turnLeaseVersion: 7, executionId: "execution-1", executionAttemptCount: 3 }
const bridgeOwner = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
const continuationKey = `scheduled-taskgraph:sha256:${"b".repeat(64)}`
const gateTaskId = "gate-task"
const gateProof = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-completion.v1", graphRevision: 4,
  prepareProof: { receipt: { owner, snapshotDigest: digest, continuationKey, checkpointDigest: digest,
    evidenceDigest: "c".repeat(64), analyzeGraphRevision: 2 } },
  gate: { taskId: gateTaskId, attemptCount: 1, resultDigest: digest, completedEventRevision: 4 } }
const attestation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", owner: bridgeOwner,
  snapshotDigest: digest, graphRevision: 2, evidenceDigest: "c".repeat(64), scout: {}, analyst: {} }
const checkpoint = { owner, continuationKey, snapshotDigest: digest,
  checkpointDigest: digest, evidenceDigest: "c".repeat(64), analyzeGraphRevision: 2 }
const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Engineer"],
  targetLocations: ["Dublin"], minScore: 70, dailyCap: 2, requireApproval: true, autoApply: false }

function lease(kind: "execute" | "audit", overrides: Partial<SubagentLease> = {}): SubagentLease {
  const execute = kind === "execute"
  return { id: execute ? "execute-task" : "audit-task", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, path: "/root/child", depth: execute ? 5 : 6,
    role: execute ? SCHEDULED_POST_GATE_EXECUTE_ROLE : SCHEDULED_POST_GATE_AUDIT_ROLE,
    taskType: execute ? SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE : SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
    status: "running", goal: "fixed", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: execute ? SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA : SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
    modelProfileSnapshot: null, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "child-lease",
    leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
    ownerId: "child-lease", signal: new AbortController().signal, ...overrides }
}

function setup(executeCount = 1) {
  const prefix = [
    { key: "scout", templateId: "scout", taskId: "scout-task" },
    { key: "analyst", templateId: "analyst", taskId: "analyst-task" },
    { key: "prepare", templateId: "prepare", taskId: "prepare-task" },
    { key: "gate", templateId: "gate", taskId: gateTaskId },
  ]
  const executeNodes = Array.from({ length: executeCount }, (_, index) => ({ key: `execute-${index + 1}`,
    taskId: `execute-task-${index + 1}`, packageRefs: [`pkg-${index + 1}`] }))
  const packageRefs = executeNodes.flatMap(node => node.packageRefs)
  const planned = { schemaVersion: SCHEDULED_POST_GATE_HANDOFF_SCHEMA, owner, snapshotDigest: digest, continuationKey,
    gateTaskId, gateAttemptCount: 1, gateCompletedEventRevision: 4,
    gateProofDigest: scheduledPostGateDigest(gateProof), gateProof, gateResultDigest: gateProof.gate.resultDigest,
    packageRefs, packageDigest: scheduledPostGateDigest(packageRefs),
    proposalDigest: scheduledPostGateDigest({ expectedRevision: 4, nodes: [] }), gateGraphRevision: 4, graphRevision: 5,
    executeNodes, auditTaskId: "audit-task" }
  const nodes = [...prefix, ...executeNodes.map(node => ({ key: node.key, templateId: "scheduled.application.execute", taskId: node.taskId })),
    { key: "scheduled.post_gate_audit", templateId: "scheduled.post_gate_audit", taskId: planned.auditTaskId }]
  const currentNodes = nodes.map(node => ({ ...node, status: "completed", failureReason: null }))
  const taskMap = new Map(nodes.map(node => [node.taskId, { id: node.taskId } as never]))
  const live = { id: "execute-task-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, role: SCHEDULED_POST_GATE_EXECUTE_ROLE,
    taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, status: "running", attemptCount: 1, leaseOwner: "child-lease",
    leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null, rootAttemptCount: owner.rootAttemptCount,
    rootTaskType: "root", rootStatus: "waiting_for_dependency", rootLeaseOwner: "current-root-lease",
    turnSource: "automation", executionMode: "canonical_task_graph", turnInput: { automationRunMode: "scheduled",
      scheduledAutomationSnapshot: scheduledSnapshot }, turnStatus: "in_progress", turnRootTaskId: owner.rootTaskId,
    sessionStatus: "active", executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount,
    executionStatus: "paused", executionState: {} }
  const client = { query: vi.fn(async (sql: string) => sql.includes("FROM \"sub_agent_tasks\" AS child")
    ? { rows: [live] } : { rows: [] }) }
  mocks.checkpoint.mockReturnValue(checkpoint)
  mocks.parseSnapshot.mockReturnValue(scheduledSnapshot)
  mocks.current.mockReturnValue({ revision: 12, nodes: currentNodes })
  mocks.loadGraph.mockResolvedValue({ snapshot: { schemaVersion: "agent-harness.v2.task-graph.v2", nodes },
    state: { revision: 12, nodes: currentNodes }, item: { id: "item", revision: 12 }, tasks: taskMap })
  mocks.readReceipt.mockResolvedValue(planned)
  mocks.validateHandoff.mockResolvedValue(true)
  mocks.buildAttestation.mockResolvedValue({ status: "ready", attestation })
  mocks.snapshotMatches.mockReturnValue(true)
  return { client, live, handoff: planned }
}

afterEach(() => vi.resetAllMocks())

describe("scheduled post-Gate child context", () => {
  it.each([1, 2, 3])("reconstructs the Gate evidence prefix with %i planned Execute task(s)", async executeCount => {
    const fixture = setup(executeCount), executeTaskId = `execute-task-1`
    const result = await readScheduledPostGateChildContext(fixture.client as never, lease("execute", { id: executeTaskId }))
    expect(result).toMatchObject({ kind: "execute", owner, actor: { taskId: executeTaskId, attemptCount: 1, leaseOwner: "child-lease" },
      packageRefs: ["pkg-1"] })
    const attestationInput = mocks.buildAttestation.mock.calls[0]?.[0] as { snapshot: { nodes: unknown[] }; current: { nodes: unknown[] }; tasks: ReadonlyMap<string, unknown> }
    expect(attestationInput.snapshot.nodes).toHaveLength(4)
    expect(attestationInput.current.nodes).toHaveLength(4)
    expect(attestationInput.tasks.size).toBe(4)
    expect(mocks.snapshotMatches).toHaveBeenCalledWith({ source: "automation", executionMode: "canonical_task_graph",
      input: fixture.live.turnInput }, digest)
    expect(mocks.buildAttestation).toHaveBeenCalledOnce()
  })

  it("binds Audit only to its server-owned task id", async () => {
    const fixture = setup(3), client = { query: vi.fn(async (sql: string) => sql.includes("FROM \"sub_agent_tasks\" AS child")
      ? { rows: [{ ...fixture.live, id: "audit-task", role: SCHEDULED_POST_GATE_AUDIT_ROLE,
        taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE }] } : { rows: [] }) }
    await expect(readScheduledPostGateChildContext(client as never, lease("audit")))
      .resolves.toMatchObject({ kind: "audit", owner, handoff: fixture.handoff, attestation })
  })

  it("rejects stale or mismatched child leases before reading persisted proof", async () => {
    const fixture = setup()
    await expect(readScheduledPostGateChildContext(fixture.client as never, lease("execute", { parentTaskId: "other-root" })))
      .resolves.toBeNull()
    expect(fixture.client.query).not.toHaveBeenCalled()
  })

  it("rejects a lease from an older child attempt against the current task row", async () => {
    const fixture = setup()
    await expect(readScheduledPostGateChildContext(fixture.client as never, lease("execute", { attemptCount: 2 })))
      .resolves.toBeNull()
    expect(fixture.client.query).toHaveBeenCalledTimes(2)
    expect(mocks.readReceipt).not.toHaveBeenCalled()
    expect(mocks.buildAttestation).not.toHaveBeenCalled()
  })

  it("rejects a Gate proof whose persisted checkpoint no longer matches the handoff", async () => {
    const fixture = setup()
    mocks.checkpoint.mockReturnValue({ ...checkpoint, checkpointDigest: "different" })
    await expect(readScheduledPostGateChildContext(fixture.client as never, lease("execute"))).resolves.toBeNull()
  })
})
