import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { taskGraphItemId, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import { taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { scheduleTaskGraphOperationalFailureReplacement } from "./task-graph-pg-operational-failure-replacement.js"
import { assertSteeringReconciliationCall } from "./steering-reconciliation-history.js"
import { findSteeringReconciliationReplay, prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { lockTaskGraphBranchSources } from "./task-graph-pg-branch-repair.js"
import { proveTaskGraphOperationalFailureEvidence } from "./task-graph-pg-operational-failure-evidence.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { writePlanReceiptWithIdentity } from "./task-graph-pg-events.js"
import type { Queryable } from "./pg-store-persistence.js"

const mocks = vi.hoisted(() => ({
  findReplay: vi.fn(), assertCall: vi.fn(), prepare: vi.fn(), writeReceipt: vi.fn(), load: vi.fn(), lockSources: vi.fn(),
  proveFailure: vi.fn(), observeGraph: vi.fn(), proveCancellations: vi.fn(), create: vi.fn(), writePlan: vi.fn(),
}))
vi.mock("./steering-reconciliation-history.js", () => ({ assertSteeringReconciliationCall: mocks.assertCall }))
vi.mock("./steering-reconciliation-ledger.js", () => ({ findSteeringReconciliationReplay: mocks.findReplay,
  prepareSteeringReconciliation: mocks.prepare, writeSteeringReconciliationReceipt: mocks.writeReceipt }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: mocks.load }))
vi.mock("./task-graph-pg-branch-repair.js", () => ({ lockTaskGraphBranchSources: mocks.lockSources,
  assertReplacementSnapshot: vi.fn() }))
vi.mock("./task-graph-pg-operational-failure-evidence.js", () => ({ proveTaskGraphOperationalFailureEvidence: mocks.proveFailure }))
vi.mock("./task-graph-pg-operational-failure-observation.js", () => ({ proveTaskGraphOperationalObservedGraph: mocks.observeGraph }))
vi.mock("./task-graph-pg-operational-failure-cancellations.js", () => ({ proveTaskGraphOperationalFailureCancellations: mocks.proveCancellations }))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: mocks.create }))
vi.mock("./task-graph-pg-events.js", async importOriginal => ({ ...await importOriginal<typeof import("./task-graph-pg-events.js")>(),
  writePlanReceiptWithIdentity: mocks.writePlan }))
vi.mock("./task-graph-pg-supersession.js", async importOriginal => ({ ...await importOriginal<typeof import("./task-graph-pg-supersession.js")>(),
  taskGraphSupersessionTemplateMatches: () => true, stampCreatedScoutEnvelopes: (_snapshot: unknown, _created: unknown) => _snapshot }))

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "parent-owner", parentAttemptCount: 2 } as const
const mode = { root: { nodeKey: "failed-scout", taskId: "failed-task" },
  sources: [{ nodeKey: "failed-scout", taskId: "failed-task", replacementKey: "fresh-scout" }] } as const
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] }
const source = { key: "failed-scout", templateId: "scout", taskId: "failed-task", goal: "Find candidates",
  successCriteria: ["Find candidates"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification }
const replacementNode = { key: "fresh-scout", templateId: "scout", goal: "Refresh candidates", successCriteria: ["Find candidates"],
  dependsOn: [], verification }
const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [source] as never }
const input: TaskGraphScheduleInput = { scope, proposal: { expectedRevision: 1, nodes: [replacementNode] }, replaceOperationalFailure: mode,
  templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } } }
const operation: SteeringReconciliationOperation = { scope, decision: "revise", expectedRevision: 1, callId: "plan-call",
  replaceOperationalFailure: mode }
type MockRow = Readonly<Record<string, unknown>>
const client = { query: vi.fn(async () => ({ rows: [] as MockRow[], rowCount: 0, command: "SELECT", oid: 0, fields: [] })) }
const dbClient = client as unknown as Queryable
const parent = { id: "root-1", role: "orchestrator", taskType: "root", allowedActions: ["agent.plan"] }
const operationKey = steeringReconciliationIdempotencyKey(scope, operation.callId)!

function setup() {
  vi.clearAllMocks()
  mocks.findReplay.mockResolvedValue(null)
  mocks.assertCall.mockResolvedValue(10n)
  mocks.load.mockResolvedValue({ state: { revision: 1, nodes: [{ ...source, status: "failed" }], appliedEvents: [] }, snapshot,
    item: { id: taskGraphItemId(scope.rootTaskId), revision: 1 } })
  mocks.lockSources.mockResolvedValue(new Map([["failed-task", { id: "failed-task", status: "failed", role: "scout", taskType: "job_discovery",
    allowedActions: ["jobs.search"], constraints: [], expectedOutputSchema: {}, attemptCount: 2, leaseOwner: null, leaseExpiresAt: null,
    nextAttemptAt: null, startedAt: new Date(1), completedAt: new Date(2), closedAt: null, interruptRequestedAt: null,
    failureReason: "child_resume_unavailable", result: {}, confidence: null, qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null,
    hasExecutionEvidence: true, hasCanonicalDispatch: false }]]))
  mocks.proveFailure.mockResolvedValue({ failedSource: { source: { nodeKey: source.key, taskId: source.taskId }, attemptCount: 2,
    failureReason: "child_resume_unavailable", resultDigest: "a".repeat(64), event: { id: "failure-event", sequence: "9",
      idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") } }, verifiedExternalDependencies: [],
    failureGraph: snapshot, failureRevision: 0 })
  mocks.observeGraph.mockResolvedValue({ event: { id: "failure-event", sequence: "9",
    idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") }, snapshot })
  mocks.proveCancellations.mockResolvedValue([])
  mocks.prepare.mockResolvedValue({ scope, callId: operation.callId, decision: "revise", expectedRevision: 1, resultingRevision: 2,
    steerInputIds: [], inputThroughSequence: 0n, idempotencyKey: operationKey, receipt: {} })
  mocks.create.mockResolvedValue({ state: { revision: 2, nodes: [{ ...replacementNode, taskId: "new-scout", depth: 1, status: "queued" }], appliedEvents: [] },
    snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ ...replacementNode, taskId: "new-scout", depth: 1, verificationDisposition: "typed" }] },
    created: [{ key: "fresh-scout", taskId: "new-scout", status: "queued" }], readyTaskIds: ["new-scout"] })
  mocks.writePlan.mockResolvedValue({ id: "plan-event", sequence: "11" })
}

describe("scheduleTaskGraphOperationalFailureReplacement", () => {
  beforeEach(setup)

  it("rejects mismatched mode claims before reads or writes", async () => {
    const mismatched = { ...operation, replaceOperationalFailure: { ...mode, root: { ...mode.root, taskId: "other-task" } } }
    await expect(scheduleTaskGraphOperationalFailureReplacement(dbClient, input, parent, mismatched, vi.fn())).rejects.toMatchObject({
      code: "task_graph_operational_failure_replacement_not_eligible",
    })
    expect(mocks.findReplay).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("replaces a proved failed leaf without cancellation and records exact capacity reuse", async () => {
    mocks.writeReceipt.mockResolvedValue(undefined)
    const checkBudget = vi.fn(async () => undefined)
    await expect(scheduleTaskGraphOperationalFailureReplacement(dbClient, input, parent, operation, checkBudget)).resolves.toMatchObject({
      status: "accepted", revision: 2, nodes: [{ key: "fresh-scout", taskId: "new-scout" }],
    })
    expect(mocks.proveFailure).toHaveBeenCalledWith(client, expect.objectContaining({ failedNode: source,
      failedRow: expect.objectContaining({ hasExecutionEvidence: true }) }))
    expect(mocks.create).toHaveBeenCalledWith(client, expect.objectContaining({ proposal: expect.objectContaining({ expectedRevision: 1 }) }),
      parent, expect.objectContaining({ nodes: [] }), expect.any(Map), expect.any(Object), { originalNodeCount: 1, removedNodeCount: 1 })
    expect(mocks.writePlan).toHaveBeenCalledWith(client, expect.objectContaining({ expectedRevision: 1,
      idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 1) }))
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('session."userId" = $5 AND turn."userId" = $5'),
      [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), taskGraphProposalKey(scope.rootTaskId, 1), scope.userId])
    expect(mocks.writeReceipt).toHaveBeenCalledWith(client, expect.any(Object), 2, undefined, undefined, undefined,
      expect.objectContaining({ failedSource: expect.objectContaining({ attemptCount: 2 }), priorCancellations: [], cancellations: [],
        observedGraphEvent: expect.objectContaining({ id: "failure-event" }) }))
    expect(checkBudget).toHaveBeenCalledOnce()
  })

  it("allows a pristine waiting descendant whose only execution evidence is a proved Root wait", async () => {
    const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
      criteria: [{ id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "fresh-scout" } }] }
    const analyst = { key: "analyst", templateId: "analyst", taskId: "waiting-task", goal: "Analyze candidates",
      successCriteria: ["Find one result"], dependsOn: [source.key], depth: 2, verificationDisposition: "typed" as const,
      verification: { ...analystVerification, criteria: [{ ...analystVerification.criteria[0]!, check: {
        ...analystVerification.criteria[0]!.check, dependencyNodeKey: source.key,
      } }] } }
    const analystReplacement = { key: "fresh-analyst", templateId: "analyst", goal: analyst.goal,
      successCriteria: analyst.successCriteria, dependsOn: ["fresh-scout"],
      verification: { ...analystVerification, criteria: [{ ...analystVerification.criteria[0]!, check: {
        ...analystVerification.criteria[0]!.check, dependencyNodeKey: "fresh-scout",
      } }] } }
    const graph: TaskGraphSnapshot = { ...snapshot, nodes: [source, analyst] as never }
    const graphState = { revision: 1, nodes: [{ ...source, status: "failed" }, { ...analyst, status: "waiting" }], appliedEvents: [] }
    const descendantMode = { root: mode.root, sources: [...mode.sources,
      { nodeKey: analyst.key, taskId: analyst.taskId, replacementKey: analystReplacement.key }] }
    const descendantInput: TaskGraphScheduleInput = { ...input, replaceOperationalFailure: descendantMode,
      proposal: { expectedRevision: 1, nodes: [replacementNode, analystReplacement] }, templates: { ...input.templates,
        analyst: { role: "analyst", taskType: "analysis", allowedActions: ["analysis.read"] } } }
    const descendantOperation = { ...operation, replaceOperationalFailure: descendantMode }
    mocks.load.mockResolvedValue({ state: graphState, snapshot: graph, item: { id: taskGraphItemId(scope.rootTaskId), revision: 1 } })
    mocks.lockSources.mockResolvedValue(new Map([
      ["failed-task", { id: "failed-task", status: "failed", role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"],
        constraints: [], expectedOutputSchema: {}, attemptCount: 2, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
        startedAt: new Date(1), completedAt: new Date(2), closedAt: null, interruptRequestedAt: null, failureReason: "child_resume_unavailable",
        result: {}, confidence: null, qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null,
        hasExecutionEvidence: true, hasCanonicalDispatch: false }],
      ["waiting-task", { id: "waiting-task", status: "waiting", role: "analyst", taskType: "analysis", allowedActions: ["analysis.read"],
        constraints: [], expectedOutputSchema: {}, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
        startedAt: null, completedAt: null, closedAt: null, interruptRequestedAt: null, failureReason: null,
        result: null, confidence: null, qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null,
        hasExecutionEvidence: true, hasCanonicalDispatch: false }],
    ]))
    mocks.proveFailure.mockResolvedValue({ failedSource: { source: { nodeKey: source.key, taskId: source.taskId }, attemptCount: 2,
      failureReason: "child_resume_unavailable", resultDigest: "a".repeat(64), event: { id: "failure-event", sequence: "9",
        idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") } }, verifiedExternalDependencies: [],
      failureGraph: graph, failureRevision: 0 })
    mocks.observeGraph.mockResolvedValue({ event: { id: "failure-event", sequence: "9",
      idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") }, snapshot: graph })
    mocks.prepare.mockResolvedValue({ scope, callId: operation.callId, decision: "revise", expectedRevision: 1, resultingRevision: 2,
      steerInputIds: [], inputThroughSequence: 0n, idempotencyKey: operationKey, receipt: {} })
    client.query.mockResolvedValueOnce({ rows: [{ id: "waiting-task", hasNonWaitEvidence: false }], rowCount: 1,
      command: "SELECT", oid: 0, fields: [] })
    const checkBudget = vi.fn(async () => { throw new Error("stop after eligibility proof") })

    await expect(scheduleTaskGraphOperationalFailureReplacement(dbClient, descendantInput, parent, descendantOperation, checkBudget))
      .rejects.toThrow("stop after eligibility proof")
    expect(mocks.proveCancellations).toHaveBeenCalledWith(client, expect.objectContaining({
      sourceNodes: [source, analyst], failedNode: source,
    }))
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('AS "hasNonWaitEvidence"'),
      expect.arrayContaining([["waiting-task"], scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId]))
    expect(checkBudget).toHaveBeenCalledOnce()
  })

  it("rejects a waiting descendant when non-wait execution evidence accompanies the Root wait", async () => {
    const analyst = { key: "analyst", templateId: "analyst", taskId: "waiting-task", goal: "Analyze candidates",
      successCriteria: ["Find one result"], dependsOn: [source.key], depth: 2, verificationDisposition: "typed" as const,
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
        criteria: [{ id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: source.key } }] } }
    const analystReplacement = { key: "fresh-analyst", templateId: "analyst", goal: analyst.goal,
      successCriteria: analyst.successCriteria, dependsOn: ["fresh-scout"],
      verification: { ...analyst.verification, criteria: [{ ...analyst.verification.criteria[0]!, check: {
        ...analyst.verification.criteria[0]!.check, dependencyNodeKey: "fresh-scout",
      } }] } }
    const graph: TaskGraphSnapshot = { ...snapshot, nodes: [source, analyst] as never }
    const descendantMode = { root: mode.root, sources: [...mode.sources,
      { nodeKey: analyst.key, taskId: analyst.taskId, replacementKey: analystReplacement.key }] }
    const descendantInput: TaskGraphScheduleInput = { ...input, replaceOperationalFailure: descendantMode,
      proposal: { expectedRevision: 1, nodes: [replacementNode, analystReplacement] }, templates: { ...input.templates,
        analyst: { role: "analyst", taskType: "analysis", allowedActions: ["analysis.read"] } } }
    const descendantOperation = { ...operation, replaceOperationalFailure: descendantMode }
    mocks.load.mockResolvedValue({ state: { revision: 1, nodes: [{ ...source, status: "failed" }, { ...analyst, status: "waiting" }], appliedEvents: [] },
      snapshot: graph, item: { id: taskGraphItemId(scope.rootTaskId), revision: 1 } })
    mocks.lockSources.mockResolvedValue(new Map([
      ["failed-task", { id: "failed-task", status: "failed", role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"],
        constraints: [], expectedOutputSchema: {}, attemptCount: 2, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
        startedAt: new Date(1), completedAt: new Date(2), closedAt: null, interruptRequestedAt: null, failureReason: "child_resume_unavailable",
        result: {}, confidence: null, qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null,
        hasExecutionEvidence: true, hasCanonicalDispatch: false }],
      ["waiting-task", { id: "waiting-task", status: "waiting", role: "analyst", taskType: "analysis", allowedActions: ["analysis.read"],
        constraints: [], expectedOutputSchema: {}, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
        startedAt: null, completedAt: null, closedAt: null, interruptRequestedAt: null, failureReason: null,
        result: null, confidence: null, qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null,
        hasExecutionEvidence: true, hasCanonicalDispatch: false }],
    ]))
    mocks.proveFailure.mockResolvedValue({ failedSource: { source: { nodeKey: source.key, taskId: source.taskId }, attemptCount: 2,
      failureReason: "child_resume_unavailable", resultDigest: "a".repeat(64), event: { id: "failure-event", sequence: "9",
        idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") } }, verifiedExternalDependencies: [], failureGraph: graph })
    mocks.observeGraph.mockResolvedValue({ event: { id: "failure-event", sequence: "9",
      idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, source.key, 2, "task.failed") }, snapshot: graph })
    client.query.mockResolvedValueOnce({ rows: [{ id: "waiting-task", hasNonWaitEvidence: true }], rowCount: 1,
      command: "SELECT", oid: 0, fields: [] })
    const checkBudget = vi.fn(async () => undefined)

    await expect(scheduleTaskGraphOperationalFailureReplacement(dbClient, descendantInput, parent, descendantOperation, checkBudget))
      .rejects.toMatchObject({ code: "task_graph_operational_failure_replacement_not_eligible" })
    expect(checkBudget).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
