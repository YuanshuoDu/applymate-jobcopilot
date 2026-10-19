import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphNativeCommandInput, TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { taskGraphSupersessionFingerprint, taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { DISCOVERY_RECOVERY_SCHEMA_VERSION } from "./task-graph-discovery-recovery-contract.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import type { PgSubagentPool } from "./types.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"

const reconciliationMocks = vi.hoisted(() => ({
  prepare: vi.fn(), write: vi.fn(), create: vi.fn(), writePlan: vi.fn(), writePlanIdentity: vi.fn(), writeLifecycleIdentity: vi.fn(), assertNoUnresolvedSteering: vi.fn(),
}))
vi.mock("./steering-reconciliation-ledger.js", () => ({
  prepareSteeringReconciliation: reconciliationMocks.prepare,
  writeSteeringReconciliationReceipt: reconciliationMocks.write,
  assertNoUnresolvedSteering: reconciliationMocks.assertNoUnresolvedSteering,
}))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: reconciliationMocks.create }))
vi.mock("./task-graph-pg-events.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-events.js")>()
  return { ...actual, appendTaskGraphReceipt: vi.fn(async () => undefined), writeTaskGraphSnapshot: vi.fn(async () => undefined),
    writePlanReceipt: reconciliationMocks.writePlan, writePlanReceiptWithIdentity: reconciliationMocks.writePlanIdentity,
    writeTaskLifecycleReceiptWithIdentity: reconciliationMocks.writeLifecycleIdentity }
})

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryCall = { sql: string; values: readonly unknown[] }
type Fence = "session" | "turn" | "parent"
type FakePoolOptions = {
  failFence?: Fence
  includeReplay?: boolean
  missingGraph?: boolean
  persistedPlanReceipt?: boolean
  budgetSnapshot?: unknown
  usedSteps?: number
  budgetReadError?: Error
  allowedActions?: unknown
  graphContent?: unknown
  graphRevision?: number
  taskRows?: Array<Record<string, unknown>>
  rootGoal?: string
  rootCriteria?: readonly string[]
  turnInput?: unknown
  sourceStepRows?: Array<Record<string, unknown>>
  replayPayload?: unknown
  sourceEvidence?: Record<string, unknown>
  sourceUpdateCount?: number
}

const empty: QueryResult = { rows: [], rowCount: 0 }

function scheduleInput(expectedRevision = 1): TaskGraphScheduleInput {
  return {
    scope: {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
    },
    proposal: {
      expectedRevision,
      nodes: [{ key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"], dependsOn: [] }],
    },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  }
}

function customScoutScheduleInput(expectedRevision = 1): TaskGraphScheduleInput {
  return {
    ...scheduleInput(expectedRevision),
    proposal: {
      expectedRevision,
      nodes: [{
        key: "custom-scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidates", check: { kind: "candidate_count_gte", minimum: 1 } }] },
      }],
    },
    templates: { scout: {
      role: "scout", taskType: "research", allowedActions: ["jobs.search"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    } },
  }
}

function supersessionFixture(goal = "Refresh Dublin roles") {
  const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "findings", check: { kind: "finding_count_gte", minimum: 1 } }] } as const
  const sourceNode = { key: "stale-analyst", templateId: "analyst", goal: "Earlier query", successCriteria: ["Find evidence"], dependsOn: [],
    depth: 1, taskId: "source-task", verificationDisposition: "typed", verification }
  const replacementNode = { key: "replacement-analyst", templateId: "analyst", goal, successCriteria: ["An earlier run reported these findings verified"], dependsOn: [], verification }
  const replaceUnstarted = { nodeKey: sourceNode.key }
  const base = scheduleInput(1)
  const input: TaskGraphScheduleInput = { ...base, proposal: { expectedRevision: 1, nodes: [replacementNode] }, replaceUnstarted,
  }
  const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 1, callId: "supersession-call", replaceUnstartedNodeKey: sourceNode.key }
  const graphContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [sourceNode] }
  const taskRows = [{ id: sourceNode.taskId, status: "queued", role: "analyst", taskType: "research", expectedOutputSchema: {}, attemptCount: 0, failureReason: null, result: null }]
  const sourceEvidence = { id: sourceNode.taskId, status: "queued", role: "analyst", taskType: "research", constraints: [], allowedActions: [], expectedOutputSchema: {}, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null,
    nextAttemptAt: null, startedAt: null, completedAt: null, closedAt: null, interruptRequestedAt: null, failureReason: null, result: null, confidence: null,
    qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null, hasExecutionEvidence: false, hasCanonicalDispatch: true }
  const operationKey = steeringReconciliationIdempotencyKey(input.scope, operation.callId)!
  const prepared = { scope: input.scope, callId: operation.callId, decision: "revise" as const, expectedRevision: 1, resultingRevision: 2,
    steerInputIds: ["steer-1"], inputThroughSequence: 8n, idempotencyKey: operationKey,
    receipt: { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: input.scope.sessionId, turnId: input.scope.turnId,
      rootTaskId: input.scope.rootTaskId, stepId: input.scope.stepId!, decision: "revise" as const, observedRevision: 1, resultingRevision: 2,
      steerInputIds: ["steer-1"], inputCheckpoint: { throughSequence: "8" } } }
  const source = { nodeKey: sourceNode.key, taskId: sourceNode.taskId }
  const fingerprint = taskGraphSupersessionFingerprint(source, { expectedRevision: 1, replaceUnstartedNodeKey: sourceNode.key, nodes: [replacementNode] })
  const relation = { schemaVersion: "agent-harness.v2.task-graph-supersession.v2", operationKey, observedRevision: 1, cancellationRevision: 2, resultingRevision: 3,
    source: { nodeKey: sourceNode.key, taskId: sourceNode.taskId }, replacement: { nodeKey: replacementNode.key, taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "11" }, planEvent: { id: "plan-event", sequence: "12", idempotencyKey: taskGraphSupersessionProposalKey(input.scope.rootTaskId, 1) },
    replacementFingerprint: fingerprint, agentPlanCall: { callId: operation.callId, stepId: input.scope.stepId!, expectedRevision: 1, replaceUnstarted } }
  return { input, operation, graphContent, taskRows, sourceEvidence, prepared, relation, sourceNode, replacementNode, operationKey, fingerprint }
}

function fakePool(input: TaskGraphScheduleInput, options: FakePoolOptions = {}) {
  const calls: QueryCall[] = []
  const itemId = taskGraphItemId(input.scope.parentTaskId)
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: "child-1",
    }],
  }
  const graphContent = options.graphContent ?? snapshot
  const graphRevision = options.graphRevision ?? 2
  const taskRows = options.taskRows ?? [{ id: "child-1", status: "queued", role: "analyst", taskType: "research", failureReason: null, result: null }]
  const replayPayload = options.replayPayload ?? {
    kind: "proposal",
    fingerprint: taskGraphFingerprint(input.proposal),
    receipt: { revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
  }
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return empty
      if (sql.startsWith("SELECT set_config")) return empty
      if (sql.startsWith('SELECT "id" FROM "agent_sessions"')) {
        return options.failFence === "session" ? empty : { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) {
        return { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_turns"')) {
        return options.failFence === "turn" ? empty : { rows: [{ id: input.scope.turnId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "input" FROM "agent_turns"')) {
        return { rows: [{ input: options.turnInput }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) {
        return options.failFence === "parent" ? empty : { rows: [{ id: input.scope.parentTaskId, goal: options.rootGoal,
          role: "orchestrator", taskType: "root", budgetSnapshot: {}, allowedActions: options.allowedActions ?? ["agent.plan"],
          successCriteria: options.rootCriteria ?? [] }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_steps"')) {
        return { rows: [{ id: input.scope.stepId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT root_task."budgetSnapshot"')) {
        if (options.budgetReadError) throw options.budgetReadError
        return { rows: [{ budgetSnapshot: options.budgetSnapshot ?? {} }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT COUNT(*)::bigint AS "used"') && sql.includes('FROM "agent_steps"')) {
        return { rows: [{ used: options.usedSteps ?? 0 }], rowCount: 1 }
      }
      if (sql.startsWith("WITH wall_clock AS MATERIALIZED")) {
        return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
      }
      if (sql.startsWith("WITH current_candidates AS MATERIALIZED")) {
        const rows = options.sourceStepRows ?? []
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT item."id"')) return options.missingGraph
        ? empty
        : { rows: [{ id: itemId, revision: graphRevision, content: graphContent, createdAt: new Date("2026-09-20T12:00:00.000Z") }], rowCount: 1 }
      if (sql.includes('AS "hasExecutionEvidence"')) return options.sourceEvidence ? { rows: [options.sourceEvidence], rowCount: 1 } : empty
      if (sql.startsWith('SELECT task."id", task."status"')) return { rows: taskRows, rowCount: taskRows.length }
      if (sql.startsWith('SELECT event."payload"')) {
        if (values.length === 5 && options.includeReplay !== false) return { rows: [{ payload: replayPayload }], rowCount: 1 }
        return empty
      }
      if (sql.startsWith("SELECT EXISTS (") && sql.includes('FROM "agent_items"')) {
        return { rows: [{ exists: options.missingGraph !== true }], rowCount: 1 }
      }
      if (sql.startsWith("SELECT EXISTS (")) return { rows: [{ exists: options.persistedPlanReceipt === true }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: options.sourceUpdateCount ?? 1 }
      return empty
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as PgSubagentPool
  return { pool, calls, client }
}

function invalidSelectorProposal(kind: "unknown" | "indirect" | "wrong-template" | "native"): { input: TaskGraphScheduleInput; graphContent: unknown; taskRows?: Array<Record<string, unknown>> } {
  const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate_count", check: { kind: "candidate_count_gte", minimum: 1 } }] } as const
  const analystVerification = (dependencyNodeKey: string) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey } }] } as const)
  const unaryAnalyst = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding_count", check: { kind: "finding_count_gte", minimum: 1 } }] } as const
  const scout: TaskGraphNodeProposal = { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], verification: scoutVerification }
  const analyst = (key: string, dependency: string, selector: string): TaskGraphNodeProposal => ({
    key, templateId: "analyst", goal: "Check findings", successCriteria: ["Findings checked"], dependsOn: [dependency], verification: analystVerification(selector),
  })
  let nodes: readonly TaskGraphNodeProposal[]
  let graphContent: unknown = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }
  let taskRows: Array<Record<string, unknown>> = []
  if (kind === "unknown") nodes = [scout, analyst("analyst", "scout", "missing")]
  else if (kind === "indirect") nodes = [scout, { key: "middle", templateId: "analyst", goal: "Intermediate", successCriteria: ["Intermediate"], dependsOn: ["scout"], verification: unaryAnalyst }, analyst("analyst", "middle", "scout")]
  else if (kind === "wrong-template") nodes = [{ key: "other-analyst", templateId: "analyst", goal: "Other analyst", successCriteria: ["Other"], dependsOn: [], verification: unaryAnalyst }, analyst("analyst", "other-analyst", "other-analyst")]
  else {
    const nativeMetadata = { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-operation", requestFingerprint: "a".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "job_discovery", contextDigest: "b".repeat(64), contextBytes: 0 }
    graphContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "native-source", taskId: "native-task", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID,
      goal: "Native child", successCriteria: [], dependsOn: [], depth: 1, verificationDisposition: "legacy_unverified", nativeDelegation: nativeMetadata }] }
    taskRows = [{ id: "native-task", status: "queued", role: "scout", taskType: "job_discovery", failureReason: null, result: null }]
    nodes = [analyst("analyst", "native-source", "native-source")]
  }
  const base = scheduleInput(1)
  return { graphContent, taskRows, input: { ...base, proposal: { expectedRevision: 1, nodes }, templates: {
    scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
    analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.search"] },
  } } }
}

describe("createPgTaskGraphCommandPort", () => {
  beforeEach(() => { vi.clearAllMocks() })
  it("cancels a typed never-started leaf at R+1, writes one replacement at R+2, then reconciles", async () => {
    const fixture = supersessionFixture(), { input, operation, sourceNode, replacementNode, prepared } = fixture
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: fixture.graphContent,
      taskRows: fixture.taskRows, sourceEvidence: fixture.sourceEvidence })
    const finalNode = { ...replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }
    const created = { state: { revision: 3, nodes: [{ ...finalNode, status: "queued" }], appliedEvents: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [finalNode] },
      created: [{ key: replacementNode.key, taskId: "replacement-task", status: "queued" as const }], readyTaskIds: ["replacement-task"] }
    reconciliationMocks.prepare.mockResolvedValueOnce(prepared)
    reconciliationMocks.writeLifecycleIdentity.mockResolvedValueOnce({ id: "cancel-event", sequence: "11", revision: 2 })
    reconciliationMocks.create.mockResolvedValueOnce(created)
    reconciliationMocks.writePlanIdentity.mockResolvedValueOnce({ id: "plan-event", sequence: "12" })

    const receipt = await createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, operation)

    expect(receipt).toMatchObject({ status: "accepted", revision: 3, nodes: [{ key: replacementNode.key, taskId: "replacement-task" }] })
    const createInput = reconciliationMocks.create.mock.calls[0]?.[1] as TaskGraphScheduleInput
    const working = reconciliationMocks.create.mock.calls[0]?.[3] as { revision: number; nodes: Array<{ key: string }> }
    expect(createInput.proposal.expectedRevision).toBe(2)
    expect(working).toMatchObject({ revision: 2, nodes: [] })
    const planInput = reconciliationMocks.writePlanIdentity.mock.calls[0]?.[1] as Record<string, unknown>
    expect(planInput).toMatchObject({ expectedRevision: 2, idempotencyKey: taskGraphSupersessionProposalKey(input.scope.rootTaskId, 1),
      fingerprint: fixture.fingerprint, operationKey: fixture.operationKey, observedRevision: 1 })
    expect(reconciliationMocks.writeLifecycleIdentity.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.create.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.create.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.writePlanIdentity.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.writePlanIdentity.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.write.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.write).toHaveBeenCalledWith(fake.client, prepared, 3, expect.objectContaining({
      observedRevision: 1, cancellationRevision: 2, resultingRevision: 3,
      source: { nodeKey: sourceNode.key, taskId: sourceNode.taskId },
      replacement: { nodeKey: replacementNode.key, taskId: "replacement-task" },
      cancellationEvent: { id: "cancel-event", sequence: "11" }, planEvent: { id: "plan-event", sequence: "12", idempotencyKey: taskGraphSupersessionProposalKey(input.scope.rootTaskId, 1) },
    }))
    const taskUpdates = fake.calls.filter(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(taskUpdates).toHaveLength(1)
    expect(taskUpdates[0]?.values[0]).toBe(sourceNode.taskId)
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it("pins additional root criteria and binds the combined supersession fingerprint", async () => {
    const fixture = supersessionFixture(), goal = "Refresh Dublin roles", rootSuccessCriteria = ["Include evidence for each role"]
    const input = { ...fixture.input, rootSuccessCriteria }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: fixture.graphContent,
      rootGoal: goal, turnInput: { goal, content: goal }, taskRows: fixture.taskRows, sourceEvidence: fixture.sourceEvidence })
    const finalNode = { ...fixture.replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    reconciliationMocks.writeLifecycleIdentity.mockResolvedValueOnce({ id: "cancel-event", sequence: "11", revision: 2 })
    reconciliationMocks.create.mockResolvedValueOnce({ state: { revision: 3, nodes: [{ ...finalNode, status: "queued" }], appliedEvents: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [finalNode] },
      created: [{ key: finalNode.key, taskId: finalNode.taskId, status: "queued" as const }], readyTaskIds: [finalNode.taskId] })
    reconciliationMocks.writePlanIdentity.mockResolvedValueOnce({ id: "plan-event", sequence: "12" })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, fixture.operation)).resolves.toMatchObject({
      status: "accepted", revision: 3,
    })

    const planInput = reconciliationMocks.writePlanIdentity.mock.calls[0]?.[1] as Record<string, unknown>
    const expectedFingerprint = taskGraphSupersessionFingerprint({ nodeKey: fixture.sourceNode.key, taskId: fixture.sourceNode.taskId }, {
      expectedRevision: 1, replaceUnstartedNodeKey: fixture.sourceNode.key, nodes: [fixture.replacementNode], rootSuccessCriteria,
    })
    expect(planInput.fingerprint).toBe(expectedFingerprint)
    expect(planInput.snapshot).toMatchObject({ rootSuccessCriteria: [goal, ...rootSuccessCriteria] })
    expect(expectedFingerprint).not.toBe(taskGraphSupersessionFingerprint({ nodeKey: fixture.sourceNode.key, taskId: fixture.sourceNode.taskId }, {
      expectedRevision: 1, replaceUnstartedNodeKey: fixture.sourceNode.key, nodes: [fixture.replacementNode],
    }))
  })

  it("preserves an existing root checklist when a supersession omits additional criteria", async () => {
    const fixture = supersessionFixture(), goal = "Refresh Dublin roles", pinned = [goal, "Keep verified evidence"]
    const graphContent = { ...fixture.graphContent, rootSuccessCriteria: pinned }
    const fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1, graphContent, rootGoal: goal,
      turnInput: { goal, content: goal }, taskRows: fixture.taskRows, sourceEvidence: fixture.sourceEvidence })
    const finalNode = { ...fixture.replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    reconciliationMocks.writeLifecycleIdentity.mockResolvedValueOnce({ id: "cancel-event", sequence: "11", revision: 2 })
    reconciliationMocks.create.mockResolvedValueOnce({ state: { revision: 3, nodes: [{ ...finalNode, status: "queued" }], appliedEvents: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [finalNode] },
      created: [{ key: finalNode.key, taskId: finalNode.taskId, status: "queued" as const }], readyTaskIds: [finalNode.taskId] })
    reconciliationMocks.writePlanIdentity.mockResolvedValueOnce({ id: "plan-event", sequence: "12" })

    await createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)

    expect(reconciliationMocks.writePlanIdentity.mock.calls[0]?.[1]).toMatchObject({ snapshot: { rootSuccessCriteria: pinned } })
  })

  it("preserves the superseded source's nonempty prerequisites on its replacement", async () => {
    const fixture = supersessionFixture()
    const prerequisite = { key: "prerequisite", templateId: "analyst", goal: "Earlier prerequisite", successCriteria: ["Find evidence"],
      dependsOn: [], depth: 1, taskId: "prerequisite-task", verificationDisposition: "typed", verification: fixture.sourceNode.verification }
    const source = { ...fixture.sourceNode, dependsOn: [prerequisite.key], depth: 2 }
    const replacement = { ...fixture.replacementNode, dependsOn: [prerequisite.key] }
    const input = { ...fixture.input, proposal: { ...fixture.input.proposal, nodes: [replacement] } }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1,
      graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [prerequisite, source] },
      taskRows: [...fixture.taskRows, { id: prerequisite.taskId, status: "queued", role: "analyst", taskType: "research", failureReason: null, result: null }],
      sourceEvidence: fixture.sourceEvidence })
    const finalReplacement = { ...replacement, depth: 2, taskId: "replacement-task", verificationDisposition: "typed" }
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    reconciliationMocks.writeLifecycleIdentity.mockResolvedValueOnce({ id: "cancel-event", sequence: "11", revision: 2 })
    reconciliationMocks.create.mockResolvedValueOnce({
      state: { revision: 3, nodes: [{ ...prerequisite, status: "queued" }, { ...finalReplacement, status: "waiting" }], appliedEvents: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [prerequisite, finalReplacement] },
      created: [{ key: replacement.key, taskId: finalReplacement.taskId, status: "waiting" as const }], readyTaskIds: [],
    })
    reconciliationMocks.writePlanIdentity.mockResolvedValueOnce({ id: "plan-event", sequence: "12" })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, fixture.operation)).resolves.toMatchObject({
      status: "accepted", revision: 3, nodes: [{ key: replacement.key, taskId: "replacement-task", status: "waiting" }],
    })
    const createInput = reconciliationMocks.create.mock.calls[0]?.[1] as TaskGraphScheduleInput
    expect(createInput.proposal.nodes[0]?.dependsOn).toEqual([prerequisite.key])
    const planInput = reconciliationMocks.writePlanIdentity.mock.calls[0]?.[1] as { snapshot: { nodes: Array<{ key: string; dependsOn: string[] }> } }
    expect(planInput.snapshot.nodes.find(node => node.key === replacement.key)?.dependsOn).toEqual([prerequisite.key])
  })

  it.each(["dependsOn", "repairOf"] as const)("rejects a source referenced by another node's %s before writes", async reference => {
    const fixture = supersessionFixture()
    const otherNode = reference === "dependsOn"
      ? { key: "dependent-node", templateId: "analyst", goal: "Dependent task", successCriteria: ["Complete dependent work"],
        dependsOn: [fixture.sourceNode.key], depth: 2, taskId: "dependent-task", verificationDisposition: "typed", verification: fixture.sourceNode.verification }
      : { key: "repair-node", templateId: "analyst", goal: "Repair source findings", successCriteria: ["Return one finding"], dependsOn: [],
        depth: 1, taskId: "repair-task", verificationDisposition: "typed", verification: fixture.sourceNode.verification,
        repairOf: { graphRootTaskId: fixture.input.scope.rootTaskId, nodeKey: fixture.sourceNode.key, taskId: fixture.sourceNode.taskId, criterionIds: ["findings"] } }
    const fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1,
      graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [fixture.sourceNode, otherNode] },
      taskRows: [...fixture.taskRows, { id: otherNode.taskId, status: "queued", role: "analyst", taskType: "research", failureReason: null, result: null }],
      sourceEvidence: fixture.sourceEvidence })
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
      code: "task_graph_supersession_not_eligible",
    })
    expect(fake.calls.some(call => call.sql.includes('AS "hasExecutionEvidence"'))).toBe(false)
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
    expect(reconciliationMocks.writeLifecycleIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
  })

  it("rejects retry-scheduled sources before cancellation or task creation", async () => {
    const fixture = supersessionFixture(), fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1,
      graphContent: fixture.graphContent, taskRows: fixture.taskRows, sourceEvidence: { ...fixture.sourceEvidence, nextAttemptAt: new Date() } })
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
      code: "task_graph_supersession_not_eligible",
    })
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(reconciliationMocks.writeLifecycleIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
  })

  it("rejects a root without native planning authority before source reads or writes", async () => {
    const fixture = supersessionFixture(), fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1,
      graphContent: fixture.graphContent, taskRows: fixture.taskRows, allowedActions: ["jobs.search"] })
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
      code: "task_graph_supersession_not_eligible",
    })
    expect(fake.calls.some(call => call.sql.includes('AS "hasExecutionEvidence"'))).toBe(false)
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it("fails closed for linked execution evidence and requires the canonical creation dispatch", async () => {
    const fixture = supersessionFixture()
    for (const sourceEvidence of [
      { ...fixture.sourceEvidence, hasExecutionEvidence: true },
      { ...fixture.sourceEvidence, hasCanonicalDispatch: false },
      { ...fixture.sourceEvidence, confidence: 0.75 },
      { ...fixture.sourceEvidence, allowedActions: ["application.submit"] },
      { ...fixture.sourceEvidence, expectedOutputSchema: { schemaVersion: "changed" } },
      { ...fixture.sourceEvidence, taskType: "changed" },
    ]) {
      const fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1, graphContent: fixture.graphContent,
        taskRows: fixture.taskRows, sourceEvidence })
      reconciliationMocks.prepare.mockResolvedValue(fixture.prepared)

      await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
        code: "task_graph_supersession_not_eligible",
      })
      expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
      const sourceLock = fake.calls.find(call => call.sql.includes('AS "hasExecutionEvidence"'))
      expect(sourceLock?.sql).toContain("FOR UPDATE OF task")
      for (const table of ["agent_tree_budget_reservations", "agent_native_semantic_rejections", "agent_mailbox_messages",
        "agent_mailbox_hydration_checkpoints", "agent_tool_result_references", "agent_wait_conditions", "agent_transcript_events",
        "agent_approvals", "agent_artifact_version", "agent_artifact_review", "application_tasks", "agent_outbox"]) {
        expect(sourceLock?.sql).toContain(`FROM "${table}"`)
      }
    }
  })

  it("locks the source after the native Session, Turn, Root, and Step fences", async () => {
    const fixture = supersessionFixture(), fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1,
      graphContent: fixture.graphContent, taskRows: fixture.taskRows, sourceEvidence: { ...fixture.sourceEvidence, hasExecutionEvidence: true } })
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
      code: "task_graph_supersession_not_eligible",
    })
    const indexOf = (prefix: string) => fake.calls.findIndex(call => call.sql.startsWith(prefix))
    const session = indexOf('SELECT "id" FROM "agent_sessions"'), turn = indexOf('SELECT "id" FROM "agent_turns"')
    const root = indexOf('SELECT task.*, session."userId" AS "userId"'), step = indexOf('SELECT "id" FROM "agent_steps"')
    const source = fake.calls.findIndex(call => call.sql.includes('AS "hasExecutionEvidence"'))
    expect(session).toBeGreaterThanOrEqual(0)
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(root)
    expect(root).toBeLessThan(step)
    expect(step).toBeLessThan(source)
  })

  it("rejects a replacement whose persisted graph metadata differs from the source", async () => {
    const fixture = supersessionFixture(), fake = fakePool(fixture.input, { includeReplay: false, graphRevision: 1,
      graphContent: fixture.graphContent, taskRows: fixture.taskRows, sourceEvidence: fixture.sourceEvidence })
    const changedNode = { ...fixture.replacementNode, depth: 2, taskId: "replacement-task", verificationDisposition: "typed" }
    reconciliationMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    reconciliationMocks.writeLifecycleIdentity.mockResolvedValueOnce({ id: "cancel-event", sequence: "11", revision: 2 })
    reconciliationMocks.create.mockResolvedValueOnce({ state: { revision: 3, nodes: [], appliedEvents: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [changedNode] },
      created: [{ key: changedNode.key, taskId: changedNode.taskId, status: "queued" as const }], readyTaskIds: [changedNode.taskId] })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).rejects.toMatchObject({
      code: "task_graph_supersession_conflict",
    })
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
  })

  it("returns an exact stale supersession replay before source eligibility or revision rejection", async () => {
    const fixture = supersessionFixture(), goal = "Refresh Dublin roles", rootSuccessCriteria = ["Include evidence for each role"]
    const input = { ...fixture.input, rootSuccessCriteria }
    const fingerprint = taskGraphSupersessionFingerprint({ nodeKey: fixture.sourceNode.key, taskId: fixture.sourceNode.taskId }, {
      expectedRevision: 1, replaceUnstartedNodeKey: fixture.sourceNode.key, nodes: [fixture.replacementNode], rootSuccessCriteria,
    })
    const relation = { ...fixture.relation, replacementFingerprint: fingerprint }
    const finalNode = { ...fixture.replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }
    const prepared = { ...fixture.prepared, resultingRevision: 3, receipt: { ...fixture.prepared.receipt,
      schemaVersion: "agent-harness.v2.plan-reconciliation.v2", resultingRevision: 3, supersession: relation } }
    const replayPayload = { kind: "proposal", fingerprint, operationKey: fixture.operationKey,
      observedRevision: 1, revision: 3, receipt: { revision: 3, nodes: [{ key: finalNode.key, taskId: finalNode.taskId, status: "queued" }], readyTaskIds: [finalNode.taskId] } }
    const fake = fakePool(input, { graphRevision: 3, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, rootSuccessCriteria: [goal, ...rootSuccessCriteria], nodes: [finalNode] },
      rootGoal: goal, turnInput: { goal, content: goal },
      taskRows: [{ id: finalNode.taskId, status: "queued", role: "analyst", taskType: "research", expectedOutputSchema: {}, attemptCount: 0, failureReason: null, result: null }],
      replayPayload })
    reconciliationMocks.prepare.mockResolvedValueOnce(prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, fixture.operation)).resolves.toMatchObject({
      status: "duplicate", revision: 3, nodes: [{ key: finalNode.key, taskId: finalNode.taskId }],
    })
    expect(reconciliationMocks.prepare).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => call.sql.includes('AS "hasChildren"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
  })

  it("replays the stored supersession receipt after the graph advances beyond R+2", async () => {
    const fixture = supersessionFixture(), prepared = { ...fixture.prepared, resultingRevision: 3, receipt: { ...fixture.prepared.receipt,
      schemaVersion: "agent-harness.v2.plan-reconciliation.v2", resultingRevision: 3, supersession: fixture.relation } }
    const replayPayload = { kind: "proposal", fingerprint: fixture.fingerprint, operationKey: fixture.operationKey,
      observedRevision: 1, revision: 3, receipt: { revision: 3, nodes: [{ key: "replacement-analyst", taskId: "replacement-task", status: "queued" }], readyTaskIds: ["replacement-task"] } }
    const fake = fakePool(fixture.input, { graphRevision: 4, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "later-plan", templateId: "analyst", goal: "Later plan", successCriteria: ["Keep the newer plan"], dependsOn: [], depth: 1, taskId: "later-task" }] },
      taskRows: [{ id: "later-task", status: "queued", role: "analyst", taskType: "research", failureReason: null, result: null }],
      replayPayload })
    reconciliationMocks.prepare.mockResolvedValueOnce(prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(fixture.input, fixture.operation)).resolves.toEqual({
      status: "duplicate", revision: 3,
      nodes: [{ key: "replacement-analyst", taskId: "replacement-task", status: "queued" }], readyTaskIds: ["replacement-task"],
    })
    expect(reconciliationMocks.prepare).toHaveBeenCalledOnce()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it("conflicts on a changed replacement request after a committed supersession", async () => {
    const fixture = supersessionFixture(), changedRequest = { expectedRevision: 1, replaceUnstarted: fixture.input.replaceUnstarted,
      nodes: [{ ...fixture.replacementNode, goal: "Changed goal" }] }
    const changedInput = { ...fixture.input, proposal: { ...fixture.input.proposal, nodes: changedRequest.nodes } }
    const prepared = { ...fixture.prepared, resultingRevision: 3, receipt: { ...fixture.prepared.receipt,
      schemaVersion: "agent-harness.v2.plan-reconciliation.v2", resultingRevision: 3, supersession: fixture.relation } }
    const replayPayload = { kind: "proposal", fingerprint: fixture.fingerprint, operationKey: fixture.operationKey,
      observedRevision: 1, revision: 3, receipt: { revision: 3, nodes: [{ key: "replacement-analyst", taskId: "replacement-task", status: "queued" }], readyTaskIds: ["replacement-task"] } }
    const fake = fakePool(changedInput, { graphRevision: 3, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ ...fixture.replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }] },
      taskRows: [{ id: "replacement-task", status: "queued", role: "analyst", taskType: "research", expectedOutputSchema: {}, attemptCount: 0, failureReason: null, result: null }], replayPayload })
    reconciliationMocks.prepare.mockResolvedValueOnce(prepared)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(changedInput, fixture.operation)).rejects.toMatchObject({
      code: "idempotency_conflict",
    })
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
  })

  it("conflicts when a committed supersession retries with a changed pinned checklist", async () => {
    const fixture = supersessionFixture(), goal = "Refresh Dublin roles", pinnedAdditional = ["Include evidence for each role"]
    const input = { ...fixture.input, rootSuccessCriteria: ["Change the checklist"] }
    const finalNode = { ...fixture.replacementNode, depth: 1, taskId: "replacement-task", verificationDisposition: "typed" }
    const fake = fakePool(input, { graphRevision: 3, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      rootSuccessCriteria: [goal, ...pinnedAdditional], nodes: [finalNode] }, rootGoal: goal, turnInput: { goal, content: goal },
      taskRows: [{ id: finalNode.taskId, status: "queued", role: "analyst", taskType: "research", expectedOutputSchema: {}, attemptCount: 0, failureReason: null, result: null }] })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, fixture.operation)).rejects.toMatchObject({
      code: "root_success_criteria_conflict",
    })
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlanIdentity).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
  })

  it("stamps the newly registered Scout envelope into the durable snapshot and preserves older declarations", async () => {
    const input = customScoutScheduleInput(1)
    const priorEnvelope = {
      role: "scout", taskType: "old_research", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: ["jobs.get"],
    }
    const priorNode = {
      key: "prior-scout", templateId: "scout", goal: "Earlier scout", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
      taskId: "prior-scout-task", verificationDisposition: "typed", verification: input.proposal.nodes[0]!.verification,
      registeredScoutEnvelope: priorEnvelope,
    }
    const newNode = {
      key: "custom-scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
      taskId: "new-scout-task", verificationDisposition: "typed", verification: input.proposal.nodes[0]!.verification,
    }
    const fake = fakePool(input, {
      includeReplay: false, graphRevision: 1,
      graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [priorNode] },
      taskRows: [{ id: "prior-scout-task", status: "completed", role: "scout", taskType: "old_research", failureReason: null, result: null }],
    })
    reconciliationMocks.create.mockResolvedValue({
      state: { revision: 2, nodes: [] },
      snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [priorNode, newNode] },
      created: [{ key: "custom-scout", taskId: "new-scout-task", status: "queued" }], readyTaskIds: ["new-scout-task"],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toMatchObject({ status: "accepted", revision: 2 })

    const persisted = reconciliationMocks.writePlan.mock.calls[0]?.[1] as { snapshot?: { nodes?: Array<Record<string, unknown>> } } | undefined
    expect(persisted?.snapshot?.nodes?.find(node => node.key === "custom-scout")?.registeredScoutEnvelope).toEqual(input.templates.scout)
    expect(persisted?.snapshot?.nodes?.find(node => node.key === "prior-scout")?.registeredScoutEnvelope).toEqual(priorEnvelope)
  })

  it("normalizes a canonical JSON-string schema marker into the registered Scout declaration", async () => {
    const base = customScoutScheduleInput(1)
    const schemaMarker = JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" })
    const input = { ...base, templates: { scout: { ...base.templates.scout!, expectedOutputSchema: schemaMarker } } }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, taskRows: [] })
    const newNode = {
      key: "custom-scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
      taskId: "new-scout-task", verificationDisposition: "typed", verification: input.proposal.nodes[0]!.verification,
    }
    reconciliationMocks.create.mockResolvedValue({
      state: { revision: 2, nodes: [] }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [newNode] },
      created: [{ key: "custom-scout", taskId: "new-scout-task", status: "queued" }], readyTaskIds: ["new-scout-task"],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toMatchObject({ status: "accepted", revision: 2 })

    const persisted = reconciliationMocks.writePlan.mock.calls[0]?.[1] as { snapshot?: { nodes?: Array<Record<string, unknown>> } } | undefined
    expect(persisted?.snapshot?.nodes?.[0]?.registeredScoutEnvelope).toEqual({
      role: "scout", taskType: "research", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: ["jobs.search"],
    })
    expect((persisted?.snapshot?.nodes?.[0]?.registeredScoutEnvelope as Record<string, unknown>).expectedOutputSchema).not.toBe(schemaMarker)
  })

  it("binds an empty-action template declaration so inherited grants cannot enter the legacy fallback", async () => {
    const base = customScoutScheduleInput(1)
    const input = { ...base, templates: { scout: { ...base.templates.scout!, allowedActions: [] } } }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, taskRows: [] })
    const newNode = {
      key: "custom-scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
      taskId: "new-scout-task", verificationDisposition: "typed", verification: input.proposal.nodes[0]!.verification,
    }
    reconciliationMocks.create.mockResolvedValue({
      state: { revision: 2, nodes: [] }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [newNode] },
      created: [{ key: "custom-scout", taskId: "new-scout-task", status: "queued" }], readyTaskIds: ["new-scout-task"],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toMatchObject({ status: "accepted", revision: 2 })

    const persisted = reconciliationMocks.writePlan.mock.calls[0]?.[1] as { snapshot?: { nodes?: Array<Record<string, unknown>> } } | undefined
    expect(persisted?.snapshot?.nodes?.[0]?.registeredScoutEnvelope).toEqual({
      role: "scout", taskType: "research", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: [],
    })
  })

  it("rejects a model-proposed registered Scout envelope before any task or receipt write", async () => {
    const base = customScoutScheduleInput(1)
    const forgedProposal = {
      ...base.proposal,
      nodes: [{ ...base.proposal.nodes[0], registeredScoutEnvelope: {
        role: "scout", taskType: "forged", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: ["application.submit"],
      } }],
    } as unknown as TaskGraphScheduleInput["proposal"]
    const input = { ...base, proposal: forgedProposal }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, taskRows: [] })
    const { createGraphTasks } = await vi.importActual<typeof import("./task-graph-pg-create.js")>("./task-graph-pg-create.js")
    reconciliationMocks.create.mockImplementationOnce(createGraphTasks)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({ code: "invalid_shape" })
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it.each([
    ["wrong marker object", { schemaVersion: "other", role: "scout" }],
    ["wrong marker JSON string", JSON.stringify({ schemaVersion: "other", role: "scout" })],
    ["extra-key JSON string", JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", extra: true })],
    ["malformed JSON string", "{broken"],
  ])("fails closed for a new typed Scout with an unrepresentable %s", async (_name, expectedOutputSchema) => {
    const base = customScoutScheduleInput(1)
    const input = { ...base, templates: { scout: {
      ...base.templates.scout!, expectedOutputSchema,
    } } }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, graphContent: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, taskRows: [] })
    const newNode = {
      key: "custom-scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
      taskId: "new-scout-task", verificationDisposition: "typed", verification: input.proposal.nodes[0]!.verification,
    }
    reconciliationMocks.create.mockResolvedValue({
      state: { revision: 2, nodes: [] }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [newNode] },
      created: [{ key: "custom-scout", taskId: "new-scout-task", status: "queued" }], readyTaskIds: ["new-scout-task"],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_registered_scout_envelope_invalid",
    })
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it.each(["unknown", "indirect", "wrong-template", "native"] as const)("rejects a %s cross-node selector before creating tasks or writing receipts", async kind => {
    const invalid = invalidSelectorProposal(kind)
    const fake = fakePool(invalid.input, { includeReplay: false, graphRevision: 1, graphContent: invalid.graphContent, taskRows: invalid.taskRows })
    const { createGraphTasks } = await vi.importActual<typeof import("./task-graph-pg-create.js")>("./task-graph-pg-create.js")
    reconciliationMocks.create.mockImplementationOnce(createGraphTasks)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(invalid.input)).rejects.toThrow("task_graph_snapshot_verification_dependency_invalid")
    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it("keeps a missing graph pristine when no durable proposal receipt exists", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).resolves.toEqual({ revision: 0, nodes: [] })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
  })

  it("keeps generic reads provenance-free and exposes safe source intent only through the planning read", async () => {
    const input = scheduleInput()
    const sourceStep = { id: "root-step", userId: input.scope.userId, turnUserId: input.scope.userId,
      sessionId: input.scope.sessionId, turnId: input.scope.turnId, rootTaskId: input.scope.rootTaskId,
      taskId: input.scope.rootTaskId, status: "streaming", attempt: 1, inputThroughSequence: "7", consumedInputIds: [],
      sessionEventSequence: "7", checkpointInputsValid: true, hasPendingAcceptedInputs: false, isDiscoveredCurrent: true,
      isExplicitCurrent: false, activeCount: 1 }
    const fake = fakePool(input, { includeReplay: false, sourceStepRows: [sourceStep] })
    const port = createPgTaskGraphCommandPort(fake.pool)
    const { stepId: _stepId, ...scope } = input.scope

    const ordinary = await port.readCurrent(scope)
    expect(ordinary).not.toHaveProperty("sourceIntent")
    expect(fake.calls.some(call => call.sql.startsWith("WITH current_candidates AS MATERIALIZED"))).toBe(false)

    const planning = await port.readCurrentForPlanning!(scope)
    expect(planning.current.sourceIntent).toEqual([{ nodeKey: "planned", goal: "Inspect the source",
      successCriteria: ["Evidence captured"], inputRelation: "unknown" }])
    expect(planning.currentInputCheckpoint).toEqual({ inputThroughSequence: 7n })
    expect(JSON.stringify(planning.current)).not.toMatch(/currentInputCheckpoint|inputThroughSequence|source-step|root-step/)
    expect(fake.calls.filter(call => call.sql.startsWith("WITH current_candidates AS MATERIALIZED"))).toHaveLength(1)
  })

  it("reloads graph state through the caller-owned client without opening another transaction", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope)).resolves.toMatchObject({ revision: 2 })
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
    expect(fake.calls.find(call => call.sql.startsWith("SELECT set_config"))?.values).toEqual([input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(true)
  })

  it("derives counts from the same owner-scoped LoadedGraph without another SELECT", async () => {
    const input = scheduleInput()
    const nodes = [
      ["scout-a", "scout", "scout"], ["scout-b", "scout", "scout"],
      ["analyst-a", "analyst", "analyst"], ["analyst-b", "analyst", "analyst"],
    ] as const
    const graphContent = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: nodes.map(([key, role, templateId]) => ({
        key, templateId, goal: `Run ${role}`, successCriteria: ["Persist facts"], dependsOn: [], depth: 1, taskId: key,
      })),
    }
    const envelope = (structuredResult: unknown) => ({ status: "completed", finalText: "PRIVATE_FINAL_TEXT", structuredResult })
    const scout = (jobIds: readonly string[]) => ({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: jobIds.map(jobId => ({ jobId, source: "greenhouse", url: `https://private.example/${jobId}`, evidenceIds: [`evidence:${jobId}`] })),
      evidence: jobIds.map(jobId => ({ id: `evidence:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
      summary: "PRIVATE_SCOUT_SUMMARY",
    })
    const analyst = (findings: readonly Readonly<{ jobId: string; score: number }>[]) => {
      const jobIds = [...new Set(findings.map(finding => finding.jobId))]
      return {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
        findings: findings.map(finding => ({ ...finding, evidenceIds: [`analysis:${finding.jobId}`] })),
        evidence: jobIds.map(jobId => ({ id: `analysis:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
        summary: "PRIVATE_ANALYST_SUMMARY",
      }
    }
    const taskRows = [
      { id: "scout-a", role: "scout", taskType: "job_discovery", candidates: ["job-1", "job-2", "job-3", "job-4", "job-5"] },
      { id: "scout-b", role: "scout", taskType: "job_discovery", candidates: ["job-4", "job-5", "job-6"] },
      { id: "analyst-a", role: "analyst", taskType: "job_analysis", findings: [
        { jobId: "job-1", score: 7 }, { jobId: "job-2", score: 8 }, { jobId: "job-3", score: 6 },
        { jobId: "job-2", score: 8 }, { jobId: "job-4", score: 5 },
      ] },
      { id: "analyst-b", role: "analyst", taskType: "job_analysis", findings: [
        { jobId: "job-2", score: 9 }, { jobId: "job-5", score: 4 }, { jobId: "job-6", score: 3 },
      ] },
    ].map(task => ({
      id: task.id, role: task.role, taskType: task.taskType, status: "completed", failureReason: null,
      result: envelope(task.role === "scout" ? scout(task.candidates!) : analyst(task.findings!)),
    }))
    const fake = fakePool(input, { includeReplay: false, graphContent, graphRevision: 8, taskRows })
    const { stepId: _stepId, ...scope } = input.scope

    const current = await createPgTaskGraphCommandPort(fake.pool).readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope)

    expect(current.revision).toBe(8)
    expect(current.planningFacts).toEqual({
      graphRevision: 8,
      counts: {
        discoveredJobs: { knownCount: 6, coverage: "complete" },
        analyzedJobs: { knownCount: 6, coverage: "complete" },
        artifactReferences: { knownCount: null, coverage: "not_requested" },
        reviewOutcomes: { knownCount: null, coverage: "not_requested" },
      },
    })
    expect(JSON.stringify(current.planningFacts)).not.toContain("job-1")
    expect(JSON.stringify(current.planningFacts)).not.toContain("private.example")
    expect(JSON.stringify(current.planningFacts)).not.toContain("PRIVATE_")
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
    const itemRead = fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))
    const taskRead = fake.calls.filter(call => call.sql.startsWith('SELECT task."id", task."status"'))
    const eventRead = fake.calls.filter(call => call.sql.startsWith('SELECT event."type"'))
    expect(itemRead).toHaveLength(1)
    expect(itemRead[0]?.values).toEqual([taskGraphItemId(input.scope.parentTaskId), input.scope.sessionId,
      input.scope.turnId, input.scope.parentTaskId, input.scope.userId])
    expect(taskRead).toHaveLength(1)
    expect(taskRead[0]?.values).toEqual([nodes.map(([key]) => key), input.scope.sessionId, input.scope.turnId,
      input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
    expect(eventRead).toHaveLength(1)
  })

  it("reads one current typed result page under the existing owner fence and one graph load", async () => {
    const input = scheduleInput()
    const graphContent = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
        dependsOn: [], depth: 1, taskId: "child-1" }],
    }
    const jobId = "00000000-0000-4000-8000-000000000000"
    const taskRows = [{
      id: "child-1", status: "failed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: "worker_stopped",
      result: { status: "completed", finalItemId: "private-final", finalText: "PRIVATE_FINAL_TEXT", stepCount: 1, toolCallCount: 1,
        structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "partial",
          findings: [{ jobId, score: 8, evidenceIds: ["evidence-job"] }],
          evidence: [{ id: "evidence-job", kind: "job", ref: jobId, source: "private-source" }], summary: "PRIVATE_SUMMARY" } },
    }]
    const fake = fakePool(input, { includeReplay: false, graphContent, graphRevision: 8, taskRows })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.readCurrentResultPage!(scope, { nodeKey: "planned", expectedRevision: 8, offset: 0 })).resolves.toEqual({
      schemaVersion: "agent-harness.v2.task-graph.result-page.v1", trust: "untrusted", availability: "available",
      graphRevision: 8, role: "analyst", taskStatus: "failed", resultStatus: "partial", totalCount: 1,
      evidenceCount: 1, offset: 0, nextOffset: null, items: [{ jobId, score: 8, evidenceKinds: ["job"] }],
    })
    expect(fake.calls[0]?.sql).toBe("BEGIN")
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))).toBe(true)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT task."id", task."status"'))).toHaveLength(1)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT event."type"'))).toHaveLength(1)
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
    expect(JSON.stringify(fake.calls.map(call => call.values))).not.toContain("PRIVATE_FINAL_TEXT")
  })

  it("exposes historical discovery paging and rejects invalid requests before database access", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false })
    const port = createPgTaskGraphCommandPort(fake.pool)

    expect(port.readHistoricalDiscoveryPage).toBeTypeOf("function")
    await expect(port.readHistoricalDiscoveryPage!(input.scope, { offset: 1 })).rejects.toThrow("task_graph_historical_discovery_request_invalid")
    expect(fake.calls).toEqual([])
  })

  it("reads a failed Scout recovery page from the same locked graph load without writes or extra queries", async () => {
    const input = scheduleInput()
    const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }
    const registeredScoutEnvelope = {
      role: "scout", taskType: "job_discovery", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
      allowedActions: ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"],
    }
    const graphContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "scout-a", templateId: "scout",
      goal: "Find jobs", successCriteria: ["Persist candidates"], dependsOn: [], depth: 1, taskId: "child-1",
      verificationDisposition: "typed", verification, registeredScoutEnvelope }] }
    const jobIds = Array.from({ length: 4 }, (_, index) => `c${String(index + 1).padStart(24, "0")}`)
    const taskRows = [{ id: "child-1", status: "failed", role: "scout", taskType: "job_discovery", attemptCount: 3,
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
      allowedActions: [...registeredScoutEnvelope.allowedActions], contextIsObject: true, hasPrivateSelectionContext: false,
      failureReason: "private provider error",
      result: { status: "failed", finalItemId: "private-final", taskGraphVerificationReport: {
        verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
        criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null,
      }, discoveryRecovery: { schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: 3, jobIds, truncated: false } },
    }]
    const fake = fakePool(input, { includeReplay: false, graphContent, graphRevision: 8, taskRows })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)
    const request = { mode: "discovery_recovery" as const, nodeKey: "scout-a", expectedRevision: 8, offset: 0, expectedAttemptCount: 3 }
    await expect(port.readCurrentDiscoveryRecoveryPage!(scope, request)).resolves.toMatchObject({
      availability: "available", observation: "partial_discovery", verificationStatus: "unverified",
      graphRevision: 8, attemptCount: 3, taskStatus: "failed", totalCount: 4, nextOffset: 3,
      items: [{ jobId: jobIds[0] }, { jobId: jobIds[1] }, { jobId: jobIds[2] }],
    })
    await expect(port.readCurrentDiscoveryRecoveryPage!(scope, { ...request, offset: 3, expectedAttemptCount: 3 }))
      .resolves.toMatchObject({ availability: "available", offset: 3, nextOffset: null, items: [{ jobId: jobIds[3] }] })
    const firstTransaction = fake.calls.slice(0, fake.calls.findIndex(call => call.sql === "COMMIT") + 1)
    expect(firstTransaction[0]?.sql).toBe("BEGIN")
    expect(firstTransaction.at(-1)?.sql).toBe("COMMIT")
    expect(firstTransaction.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
    expect(firstTransaction.filter(call => call.sql.startsWith('SELECT task."id", task."status"'))).toHaveLength(1)
    expect(firstTransaction.filter(call => call.sql.startsWith('SELECT event."type"'))).toHaveLength(1)
    expect(firstTransaction.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
    expect(JSON.stringify(fake.calls.map(call => call.values))).not.toContain("private provider error")
  })

  it.each([
    ["session", "task_graph_session_fenced"], ["turn", "task_graph_turn_fenced"], ["parent", "task_graph_parent_fenced"],
  ] as const)("does not project recovery IDs after a %s owner-scope fence", async (fence, error) => {
    const input = scheduleInput(), fake = fakePool(input, { includeReplay: false, failFence: fence })
    const { stepId: _stepId, ...scope } = input.scope
    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentDiscoveryRecoveryPage!(scope,
      { mode: "discovery_recovery", nodeKey: "scout-a", expectedRevision: 2, offset: 0 })).rejects.toThrow(error)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it("preserves the durable-receipt error when paging a missing current graph", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 0, offset: 0 })).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing",
    })
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it("preserves existing typed verification and native child-contract errors before returning pages", async () => {
    const input = scheduleInput()
    const { stepId: _stepId, ...scope } = input.scope
    const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] }
    const typedContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "planned", templateId: "analyst",
      goal: "Inspect the source", successCriteria: ["Evidence captured"], dependsOn: [], depth: 1, taskId: "child-1",
      verificationDisposition: "typed", verification }] }
    const typedResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "" }
    const invalidTyped = fakePool(input, { includeReplay: false, graphContent: typedContent, graphRevision: 8, taskRows: [{
      id: "child-1", status: "completed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: null,
      result: { status: "completed", finalItemId: null, finalText: "", stepCount: 1, toolCallCount: 1,
        structuredResult: typedResult, taskGraphVerificationReport: { status: "passed", reasonCode: "criteria_met" } },
    }] })

    await expect(createPgTaskGraphCommandPort(invalidTyped.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 8, offset: 0 })).rejects.toThrow("task_graph_verification_report_invalid")
    expect(invalidTyped.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(invalidTyped.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)

    const nativeContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "planned",
      templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: "child-1", verificationDisposition: "legacy_unverified",
      nativeDelegation: { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-page",
        requestFingerprint: "a".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "job_discovery",
        contextDigest: "b".repeat(64), contextBytes: 1 } }] }
    const invalidNative = fakePool(input, { includeReplay: false, graphContent: nativeContent, graphRevision: 8, taskRows: [{
      id: "child-1", status: "completed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: null, result: null,
    }] })
    await expect(createPgTaskGraphCommandPort(invalidNative.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 8, offset: 0 })).rejects.toThrow("task_graph_native_child_contract_invalid")
    expect(invalidNative.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(invalidNative.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
  })

  it.each([
    ["session", "task_graph_session_fenced"], ["turn", "task_graph_turn_fenced"], ["parent", "task_graph_parent_fenced"],
  ] as const)("does not produce planning facts after a %s owner-scope fence", async (fence, error) => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false, failFence: fence })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope))
      .rejects.toThrow(error)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it.each([
    ["session", "task_graph_session_fenced"], ["turn", "task_graph_turn_fenced"], ["parent", "task_graph_parent_fenced"],
  ] as const)("does not read result pages after a %s owner-scope fence", async (fence, error) => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false, failFence: fence })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 2, offset: 0 })).rejects.toThrow(error)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it("fails closed when the graph item is missing after a durable proposal receipt", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
  })

  it("replays the original duplicate receipt when the graph item is missing", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })
    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("rejects native replay when an owned event outlives its graph item", async () => {
    const input = scheduleInput()
    const native: TaskGraphNativeCommandInput = {
      scope: input.scope,
      request: { kind: "spawn", idempotencyKey: "native-missing", role: "auditor", taskType: "audit", goal: "Review" },
    }
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendNativeCoordination!(native)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const ownedReceiptCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_events"'))
    const graphItemCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_items"'))
    expect(ownedReceiptCheck).toBeGreaterThan(-1)
    expect(graphItemCheck).toBeGreaterThan(ownedReceiptCheck)
    expect(fake.calls.some(call => call.sql.includes('event."idempotencyKey" = $4'))).toBe(false)
  })

  it("rejects a new proposal against a missing graph that has an older receipt", async () => {
    const input = scheduleInput(0)
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("treats a pristine missing graph as revision zero for a first proposal", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { missingGraph: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 0,
    })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("returns the original receipt as a duplicate for an idempotent proposal replay", async () => {
    const input: TaskGraphScheduleInput = {
      ...scheduleInput(),
      // This proposal does not meet the server requirement; persisted replay still wins after revision advance.
      verificationRequirements: { status: "valid", requirements: [
        { id: "canonical-candidates", kind: "candidate_count_gte", minimum: 4 },
      ] },
    }
    const fake = fakePool(input, { budgetSnapshot: { maxSteps: 2 }, usedSteps: 2 })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })

    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT root_task."budgetSnapshot"'))).toBe(false)
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("commits plan revise and private reconciliation through one client, in order", async () => {
    const input = scheduleInput(2), fake = fakePool(input, { includeReplay: false })
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 2, callId: "persisted-plan-call", rootInputId: "original-input" }
    const prepared = { steerInputIds: ["private-steer"], resultingRevision: 3 }
    const created = { state: { revision: 3 }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, created: [], readyTaskIds: [] }
    reconciliationMocks.prepare.mockResolvedValue(prepared)
    reconciliationMocks.create.mockResolvedValue(created)
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndScheduleWithReconciliation!(input, operation)).resolves.toEqual({ status: "accepted", revision: 3, nodes: [], readyTaskIds: [] })
    expect(reconciliationMocks.prepare).toHaveBeenCalledWith(fake.client, operation)
    expect(reconciliationMocks.assertNoUnresolvedSteering).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).toHaveBeenCalledOnce()
    expect(reconciliationMocks.write).toHaveBeenCalledWith(fake.client, prepared, 3)
    expect(reconciliationMocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.create.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.create.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.writePlan.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.writePlan.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.write.mock.invocationCallOrder[0] ?? 0)
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("blocks a raw planning-root proposal while accepted steering remains unresolved", async () => {
    const input = scheduleInput(2), fake = fakePool(input, { includeReplay: false })
    reconciliationMocks.assertNoUnresolvedSteering.mockRejectedValueOnce(new Error("steering_reconciliation_pending"))

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toThrow("steering_reconciliation_pending")
    expect(reconciliationMocks.assertNoUnresolvedSteering).toHaveBeenCalledWith(fake.client, input.scope)
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => call.sql.startsWith('SELECT root_task."budgetSnapshot"'))).toBe(false)
  })

  it("does not apply the planning-root steering gate to non-planning schedules", async () => {
    const input = scheduleInput(), fake = fakePool(input, { allowedActions: ["jobs.search"] })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toMatchObject({ status: "duplicate" })
    expect(reconciliationMocks.assertNoUnresolvedSteering).not.toHaveBeenCalled()
  })

  it("returns an exact plan replay before preparing reconciliation and never writes a receipt", async () => {
    const input = scheduleInput(), fake = fakePool(input)
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 1, callId: "new-step-call", rootInputId: "original-input" }
    reconciliationMocks.prepare.mockRejectedValue(new Error("replay must not prepare a new reconciliation"))

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, operation)).resolves.toMatchObject({ status: "duplicate", revision: 2 })
    expect(reconciliationMocks.prepare).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a stale proposal with the current persisted revision", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { includeReplay: false })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 2,
    })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT root_task."budgetSnapshot"'))).toBe(false)
  })

  it("rejects a pinned requirement that would exceed the 32-item owned verifier set before writes", async () => {
    const goal = "Original goal"
    const rootCriteria = ["shared", ...Array.from({ length: 15 }, (_, index) => `root ${index}`)]
    const turnCriteria = ["shared", ...Array.from({ length: 15 }, (_, index) => `turn ${index}`)]
    const input = { ...scheduleInput(1), rootSuccessCriteria: ["new requirement"] }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, rootGoal: goal, rootCriteria,
      turnInput: { goal, content: goal, successCriteria: turnCriteria } })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "root_success_criteria_invalid",
    })

    expect(fake.calls.some(call => call.sql.startsWith('SELECT "input" FROM "agent_turns"'))).toBe(true)
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
  })

  it("accepts a pinned requirement already present in the 32-item owned verifier set", async () => {
    const goal = "Original goal"
    const rootCriteria = ["shared", ...Array.from({ length: 15 }, (_, index) => `root ${index}`)]
    const turnCriteria = ["shared", ...Array.from({ length: 15 }, (_, index) => `turn ${index}`)]
    const input = { ...scheduleInput(1), rootSuccessCriteria: ["root 14"] }
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, rootGoal: goal, rootCriteria,
      turnInput: { goal, content: goal, successCriteria: turnCriteria } })
    reconciliationMocks.create.mockResolvedValueOnce({
      state: { revision: 2, nodes: [] }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, created: [], readyTaskIds: [],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toEqual({
      status: "accepted", revision: 2, nodes: [], readyTaskIds: [],
    })

    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan.mock.calls[0]?.[1]).toMatchObject({
      snapshot: { rootSuccessCriteria: [goal, "root 14"] },
    })
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it.each([0, 1])("refuses a new plan with only %i shared Turn step(s) remaining and rolls back before writes", async remaining => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, budgetSnapshot: { maxSteps: 2 }, usedSteps: 2 - remaining })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_continuation_budget_required",
      message: "The Turn needs two remaining steps to supervise a TaskGraph plan",
    })

    const lockIndex = fake.calls.findIndex(call => call.sql.startsWith('SELECT "id" FROM "agent_turns"'))
    const snapshotIndex = fake.calls.findIndex(call => call.sql.startsWith('SELECT root_task."budgetSnapshot"'))
    const countIndex = fake.calls.findIndex(call => call.sql.startsWith('SELECT COUNT(*)::bigint AS "used"') && call.sql.includes('FROM "agent_steps"'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(snapshotIndex).toBeGreaterThan(lockIndex)
    expect(countIndex).toBeGreaterThan(snapshotIndex)
    expect(fake.calls[countIndex]?.values).toEqual([input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
  })

  it("admits a new plan at exactly two shared Turn steps and checks immediately before task creation", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, budgetSnapshot: { maxSteps: 4 }, usedSteps: 2 })
    reconciliationMocks.create.mockResolvedValueOnce({
      state: { revision: 2, nodes: [] }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, created: [], readyTaskIds: [],
    })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toEqual({
      status: "accepted", revision: 2, nodes: [], readyTaskIds: [],
    })

    const countIndex = fake.calls.findIndex(call => call.sql.startsWith('SELECT COUNT(*)::bigint AS "used"') && call.sql.includes('FROM "agent_steps"'))
    const countOrder = fake.client.query.mock.invocationCallOrder[countIndex]
    expect(countIndex).toBeGreaterThanOrEqual(0)
    expect(countOrder).toBeLessThan(reconciliationMocks.create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).toHaveBeenCalledOnce()
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
  })

  it("does not publish plan or reconciliation receipts when a revised plan lacks two shared steps", async () => {
    const input = scheduleInput(1), fake = fakePool(input, {
      includeReplay: false, graphRevision: 1, budgetSnapshot: { maxSteps: 2 }, usedSteps: 1,
    })
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 1, callId: "steer-call", rootInputId: "accepted-input" }
    reconciliationMocks.prepare.mockResolvedValueOnce({ steerInputIds: ["accepted-input"], resultingRevision: 2 })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, operation)).rejects.toMatchObject({
      code: "task_graph_continuation_budget_required",
      message: "The Turn needs two remaining steps to supervise a TaskGraph plan",
    })

    expect(reconciliationMocks.prepare).toHaveBeenCalledOnce()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
  })

  it("propagates unexpected shared-budget read failures without creating a generic refusal", async () => {
    const input = scheduleInput(1), queryError = new Error("budget snapshot query failed")
    const fake = fakePool(input, { includeReplay: false, graphRevision: 1, budgetReadError: queryError })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toBe(queryError)
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
  })

  it.each([
    { fence: "session" as const, error: "task_graph_session_fenced", query: 'FROM "agent_sessions"', values: ["session-1", "user-1"] },
    { fence: "turn" as const, error: "task_graph_turn_fenced", query: 'FROM "agent_turns"', values: ["turn-1", "session-1", "user-1", "root-1", "turn-owner", 3] },
    { fence: "parent" as const, error: "task_graph_parent_fenced", query: 'FROM "sub_agent_tasks"', values: ["root-1", "session-1", "turn-1", "root-1", "user-1", "parent-owner", 2] },
  ])("rejects a mismatched $fence identity before reading or mutating the graph", async ({ fence, error, query, values }) => {
    const input = scheduleInput()
    const fake = fakePool(input, { failFence: fence })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toThrow(error)
    const fencedCall = fake.calls.find(call => call.sql.includes(query))
    expect(fencedCall?.values).toEqual(values)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})
