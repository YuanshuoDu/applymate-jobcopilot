import { beforeEach, describe, expect, it, vi } from "vitest"

const handoffMocks = vi.hoisted(() => ({ read: vi.fn(), validate: vi.fn() }))
const contextMocks = vi.hoisted(() => ({ load: vi.fn(), materialize: vi.fn() }))

vi.mock("./scheduled-post-gate-handoff.js", () => ({
  readScheduledPostGateReceipt: handoffMocks.read,
  validateScheduledPostGateHandoff: handoffMocks.validate,
}))
vi.mock("./task-graph-pg-dependency-context-loader.js", () => ({ loadScopedTaskGraphDependencyContext: contextMocks.load }))
vi.mock("./task-graph-dependency-context.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-dependency-context.js")>()
  return { ...actual, materializeTaskGraphDependencyContext: contextMocks.materialize }
})

import { SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
  SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, type ScheduledPostGateHandoff } from "./scheduled-post-gate-contract.js"
import { readyTaskDependencyContext } from "./task-graph-pg-post-gate-audit-ready.js"
import type { GraphIdentityScope, GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const executeReference = { key: "execute-1", taskId: "execute-task-1", packageRefs: ["job-1"] }
const receipt = {
  schemaVersion: "agent-harness.v2.scheduled-post-gate-handoff.v1",
  owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: 3, turnLeaseOwnerId: "turn-lease", turnLeaseVersion: 8, executionId: "execution-1", executionAttemptCount: 1 },
  snapshotDigest: `sha256:${"a".repeat(64)}`, continuationKey: "continuation-1", gateTaskId: "gate-task", gateAttemptCount: 1,
  gateCompletedEventRevision: 4, gateProofDigest: `sha256:${"b".repeat(64)}`, gateProof: {},
  gateResultDigest: `sha256:${"c".repeat(64)}`, packageRefs: ["job-1"], packageDigest: `sha256:${"d".repeat(64)}`,
  proposalDigest: `sha256:${"e".repeat(64)}`, gateGraphRevision: 4, graphRevision: 5,
  executeNodes: [executeReference], auditTaskId: "audit-task-1",
} as ScheduledPostGateHandoff

function fixture(overrides: Readonly<{ auditNode?: Record<string, unknown>; auditTask?: Partial<GraphTaskRow>;
  executeNode?: Record<string, unknown>; executeTask?: Partial<GraphTaskRow>; receipt?: ScheduledPostGateHandoff | null }> = {}) {
  const executeNode = { key: executeReference.key, taskId: executeReference.taskId, templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
    goal: "Run approved package", successCriteria: ["Return bounded result"], dependsOn: ["gate"], depth: 5,
    verificationDisposition: "specialized", packageRefs: ["job-1"], ...overrides.executeNode }
  const auditNode = { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, taskId: "audit-task-1", templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
    goal: SCHEDULED_POST_GATE_AUDIT_GOAL, successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA,
    dependsOn: [executeNode.key], depth: 6, verificationDisposition: "specialized", ...overrides.auditNode }
  const snapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: [
    { key: "gate", taskId: "gate-task", templateId: "gate", goal: "Gate", successCriteria: ["Complete"], dependsOn: [], depth: 4, verificationDisposition: "specialized" },
    executeNode, auditNode,
  ] } as unknown as TaskGraphSnapshot
  const executeTask: GraphTaskRow = { id: executeReference.taskId, status: "completed", role: SCHEDULED_POST_GATE_EXECUTE_ROLE,
    taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, expectedOutputSchema: SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA,
    allowedActions: [], contextIsEmpty: true, failureReason: null, attemptCount: 1,
    result: { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: { queued: ["job-1"], failed: [] } }, ...overrides.executeTask }
  const auditTask: GraphTaskRow = { id: "audit-task-1", status: "waiting", role: SCHEDULED_POST_GATE_AUDIT_ROLE,
    taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, expectedOutputSchema: SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
    allowedActions: [], contextIsEmpty: true, failureReason: null, attemptCount: 0, result: null, ...overrides.auditTask }
  const loaded = { rootTaskId: scope.rootTaskId, snapshot, item: null, state: null,
    tasks: new Map([[executeTask.id, executeTask], [auditTask.id, auditTask]]), discoveryTurnEligibility: "scheduled" } as unknown as LoadedGraph
  const selectedNode = snapshot.nodes.at(-1)!
  return { loaded, node: selectedNode, task: auditTask, receipt: overrides.receipt === undefined ? receipt : overrides.receipt }
}

function client(overrides: Readonly<{ turnLeaseOwner?: string; turnLeaseVersion?: number }> = {}) {
  return { query: vi.fn(async () => ({ rows: [{ attemptCount: 3, parentLeaseOwner: "parent-lease",
    turnLeaseOwner: overrides.turnLeaseOwner ?? "turn-lease", turnLeaseVersion: overrides.turnLeaseVersion ?? 8 }], rowCount: 1 })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  handoffMocks.read.mockImplementation(async () => receipt)
  handoffMocks.validate.mockImplementation(async () => true)
  contextMocks.load.mockImplementation(async () => ({ childContext: {}, dependencies: [] }))
  contextMocks.materialize.mockImplementation(() => ({ generic: "dependency-context" }))
})

describe("Post-Gate Audit dependency context promotion", () => {
  it("returns empty server-owned Audit context after each handoff-bound Execute envelope is verified", async () => {
    const current = fixture(), db = client()

    await expect(readyTaskDependencyContext(db as never, scope, current.loaded, current.node, current.task)).resolves.toEqual({})

    expect(handoffMocks.read).toHaveBeenCalledWith(db, scope)
    expect(handoffMocks.validate).toHaveBeenCalledTimes(1)
    expect(handoffMocks.validate.mock.calls[0]?.[1]).toMatchObject({ ...scope, parentAttemptCount: 3 })
    expect(contextMocks.load).not.toHaveBeenCalled()
    expect(contextMocks.materialize).not.toHaveBeenCalled()
  })

  it.each([
    ["different Audit key", { auditNode: { key: "model.audit" } }],
    ["different Audit template", { auditNode: { templateId: "analyst" } }],
    ["different Audit role", { auditTask: { role: "reviewer" } }],
    ["different Audit task type", { auditTask: { taskType: "scheduled_audit" } }],
    ["added action authority", { auditTask: { allowedActions: ["agent.plan"] } }],
    ["non-empty context authority", { auditTask: { contextIsEmpty: false } }],
    ["incomplete Execute dependency", { executeTask: { status: "waiting" } }],
    ["malformed Execute envelope", { executeTask: { result: { status: "completed", structuredResult: { queued: ["job-1"], failed: [] } } } }],
    ["handoff reference mismatch", { receipt: { ...receipt, executeNodes: [{ ...executeReference, taskId: "other-task" }] } as ScheduledPostGateHandoff }],
  ] as const)("keeps generic materialization for %s", async (_label, overrides) => {
    const current = fixture(overrides), db = client()
    handoffMocks.read.mockImplementation(async () => current.receipt)

    await expect(readyTaskDependencyContext(db as never, scope, current.loaded, current.node, current.task))
      .resolves.toEqual({ generic: "dependency-context" })

    expect(contextMocks.load).toHaveBeenCalledTimes(1)
    expect(contextMocks.materialize).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["owner ID", { owner: { ...receipt.owner, turnLeaseOwnerId: "different-turn-lease" } }],
    ["lease version", { owner: { ...receipt.owner, turnLeaseVersion: receipt.owner.turnLeaseVersion + 1 } }],
  ] as const)("keeps generic materialization when the current Turn %s differs from the handoff", async (_label, owner) => {
    const mismatchedReceipt = { ...receipt, owner: owner.owner } as ScheduledPostGateHandoff
    const current = fixture({ receipt: mismatchedReceipt }), db = client()
    handoffMocks.read.mockImplementation(async () => current.receipt)

    await expect(readyTaskDependencyContext(db as never, scope, current.loaded, current.node, current.task))
      .resolves.toEqual({ generic: "dependency-context" })

    expect(handoffMocks.validate).not.toHaveBeenCalled()
    expect(contextMocks.load).toHaveBeenCalledTimes(1)
    expect(contextMocks.materialize).toHaveBeenCalledTimes(1)
  })

  it("keeps generic materialization when the persisted handoff fails its full owner and plan validation", async () => {
    handoffMocks.validate.mockImplementation(async () => false)
    const current = fixture(), db = client()

    await expect(readyTaskDependencyContext(db as never, scope, current.loaded, current.node, current.task))
      .resolves.toEqual({ generic: "dependency-context" })

    expect(contextMocks.load).toHaveBeenCalledTimes(1)
    expect(contextMocks.materialize).toHaveBeenCalledTimes(1)
  })
})
