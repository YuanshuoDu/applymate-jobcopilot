import { describe, expect, it, vi } from "vitest"
import {
  parseTaskGraphSupersessionRelation,
  scheduleTaskGraphSupersession,
  taskGraphSupersessionFingerprint,
  taskGraphSupersessionProposalKey,
  taskGraphWaitConditionEvidenceSql,
  type TaskGraphSupersessionRelation,
} from "./task-graph-pg-supersession.js"
import { TaskGraphCommandError, type TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import { parseTaskGraphSnapshot, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { validateTaskGraphProposal } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"

const runtimeMocks = vi.hoisted(() => ({ prepare: vi.fn() }))
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
vi.mock("./steering-reconciliation-ledger.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./steering-reconciliation-ledger.js")>()
  return { ...actual, prepareSteeringReconciliation: runtimeMocks.prepare }
})

const validRelation = {
  schemaVersion: "agent-harness.v2.task-graph-supersession.v2",
  operationKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
  observedRevision: 12,
  cancellationRevision: 13,
  resultingRevision: 14,
  source: { nodeKey: "scout-old", taskId: "task-old" },
  replacement: { nodeKey: "scout-new", taskId: "task-new" },
  cancellationEvent: { id: "cancel-event", sequence: "9007199254740993" },
  planEvent: { id: "plan-event", sequence: "9007199254740994", idempotencyKey: taskGraphSupersessionProposalKey("root-1", 12) },
  replacementFingerprint: "b".repeat(64),
  agentPlanCall: {
    callId: "call-replan",
    stepId: "step-replan",
    expectedRevision: 12,
    replaceUnstarted: { nodeKey: "scout-old" },
  },
} satisfies TaskGraphSupersessionRelation

function changed(path: readonly string[], next: unknown): unknown {
  const copy = structuredClone(validRelation) as unknown as Record<string, unknown>
  let current = copy
  for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>
  current[path.at(-1)!] = next
  return copy
}

describe("parseTaskGraphSupersessionRelation", () => {
  it("parses the closed v2 relation and returns detached nested values", () => {
    const parsed = parseTaskGraphSupersessionRelation(validRelation)
    expect(parsed).toEqual(validRelation)
    expect(parsed).not.toBe(validRelation)
    expect(parsed?.source).not.toBe(validRelation.source)
    expect(parsed?.agentPlanCall.replaceUnstarted).not.toBe(validRelation.agentPlanCall.replaceUnstarted)
  })

  it("binds the R, R+1, and R+2 revisions and call to the source at R", () => {
    expect(parseTaskGraphSupersessionRelation(validRelation)?.resultingRevision).toBe(14)
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationRevision"], 12))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationRevision"], 14))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["resultingRevision"], 13))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["resultingRevision"], 15))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "expectedRevision"], 11))).toBeNull()
  })

  it("rejects extra, missing, inherited, and accessor fields at every level", () => {
    const malformed: unknown[] = [
      changed(["extra"], true),
      changed(["source", "extra"], true),
      changed(["replacement", "extra"], true),
      changed(["cancellationEvent", "extra"], true),
      changed(["planEvent", "extra"], true),
      changed(["agentPlanCall", "extra"], true),
      changed(["agentPlanCall", "replaceUnstarted", "extra"], true),
      changed(["schemaVersion"], "agent-harness.v2.task-graph-supersession.v1"),
      Object.assign(Object.create({ unexpected: true }) as object, validRelation),
    ]
    const accessor = structuredClone(validRelation) as unknown as Record<string, unknown>
    Object.defineProperty(accessor, "operationKey", { enumerable: true, get: () => validRelation.operationKey })
    malformed.push(accessor)
    expect(malformed.every(value => parseTaskGraphSupersessionRelation(value) === null)).toBe(true)
  })

  it("requires distinct task and node identities and ordered event identities", () => {
    expect(parseTaskGraphSupersessionRelation(changed(["replacement", "nodeKey"], "scout-old"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["replacement", "taskId"], "task-old"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["planEvent", "id"], "cancel-event"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["planEvent", "sequence"], "9007199254740993"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationEvent", "sequence"], "9007199254740995"))).toBeNull()
  })

  it("requires canonical bounded IDs, positive decimal sequences, and lower-case fingerprints", () => {
    const invalid: unknown[] = [
      changed(["operationKey"], `agent.plan.reconciliation:sha256:${"A".repeat(64)}`),
      changed(["replacementFingerprint"], "c".repeat(63)),
      changed(["replacementFingerprint"], "C".repeat(64)),
      changed(["source", "nodeKey"], "x".repeat(129)),
      changed(["agentPlanCall", "callId"], " "),
      changed(["cancellationEvent", "sequence"], "0"),
      changed(["cancellationEvent", "sequence"], "01"),
      changed(["cancellationEvent", "sequence"], "1.0"),
      changed(["cancellationEvent", "sequence"], 900),
      changed(["planEvent", "sequence"], "9223372036854775808"),
    ]
    expect(invalid.every(value => parseTaskGraphSupersessionRelation(value) === null)).toBe(true)
  })

  it("derives a distinct root-and-revision supersession event key", () => {
    const key = taskGraphSupersessionProposalKey("root-1", 12)
    expect(key).toBe(taskGraphSupersessionProposalKey("root-1", 12))
    expect(key).not.toBe(taskGraphProposalKey("root-1", 12))
    expect(key).not.toBe(taskGraphSupersessionProposalKey("root-1", 13))
    expect(key).not.toBe(taskGraphSupersessionProposalKey("root-2", 12))
  })

  it("fingerprints the locked source identity and canonical normalized replacement proposal", () => {
    const source = { nodeKey: "scout-old", taskId: "task-old" }
    const proposal = { expectedRevision: 12, replaceUnstartedNodeKey: "scout-old", nodes: [
      { key: "scout-new", templateId: "scout", goal: "Find roles", successCriteria: ["Report"], dependsOn: [] },
    ] }
    const fingerprint = taskGraphSupersessionFingerprint(source, proposal)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(taskGraphSupersessionFingerprint(source, { ...proposal, nodes: [{ ...proposal.nodes[0] }] })).toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint({ ...source, taskId: "different-task" }, proposal)).not.toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint({ ...source, nodeKey: "different-node" }, proposal)).not.toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint(source, { ...proposal, nodes: [{ ...proposal.nodes[0], goal: "Changed" }] })).not.toBe(fingerprint)
    const rootSuccessCriteria = ["Include evidence for each role"]
    const checklistFingerprint = taskGraphSupersessionFingerprint(source, { ...proposal, rootSuccessCriteria })
    expect(checklistFingerprint).toBe(taskGraphSupersessionFingerprint(source, { ...proposal, rootSuccessCriteria: [...rootSuccessCriteria] }))
    expect(checklistFingerprint).not.toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint(source, { ...proposal, rootSuccessCriteria: ["Changed checklist"] })).not.toBe(checklistFingerprint)
  })

  it("binds changed old and new dependency sets while preserving the legacy digest for unchanged edges", () => {
    const base = { expectedRevision: 12, replaceUnstartedNodeKey: "scout-old", nodes: [
      { key: "scout-new", templateId: "scout", goal: "Find roles", successCriteria: ["Report"], dependsOn: ["new-prerequisite"] },
    ] }
    const oldEdges = { nodeKey: "scout-old", taskId: "task-old", dependsOn: ["old-prerequisite"] }
    const rewired = taskGraphSupersessionFingerprint(oldEdges, base)
    expect(rewired).not.toBe(taskGraphSupersessionFingerprint({ ...oldEdges, dependsOn: ["other-old"] }, base))
    expect(rewired).not.toBe(taskGraphSupersessionFingerprint(oldEdges, { ...base, nodes: [{ ...base.nodes[0]!, dependsOn: ["other-new"] }] }))

    const legacyProposal = { ...base, nodes: [{ ...base.nodes[0]!, dependsOn: [] }] }
    const legacyDigest = taskGraphSupersessionFingerprint({ nodeKey: "scout-old", taskId: "task-old" }, legacyProposal)
    expect(taskGraphSupersessionFingerprint({ nodeKey: "scout-old", taskId: "task-old", dependsOn: [] }, legacyProposal)).toBe(legacyDigest)
  })

  it("rejects a persisted call that does not describe the superseded source request", () => {
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "replaceUnstarted", "nodeKey"], "scout-new"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "replaceUnstarted"], { nodeKey: "scout-old", taskId: "task-old" }))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "stepId"], "\u0000step"))).toBeNull()
  })
})

describe("taskGraphWaitConditionEvidenceSql", () => {
  it("rejects same-turn durable waits that reference the source as parent, target, or match", () => {
    const predicate = taskGraphWaitConditionEvidenceSql()
    expect(predicate).toContain('wait."sessionId" = task."sessionId"')
    expect(predicate).toContain('wait."turnId" = task."turnId"')
    expect(predicate).toContain('wait."parentTaskId" = task."id"')
    expect(predicate).toContain('wait."targetTaskIds" @> jsonb_build_array(task."id")')
    expect(predicate).toContain('wait."matchedTaskIds" @> jsonb_build_array(task."id")')
    expect(predicate).not.toMatch(/status|consumedAt/i)
  })
})

function runtimeFixture(revision = 1, replay = false, dependencyNodes: readonly Record<string, unknown>[] = [], replacementDependsOn: readonly string[] = []) {
  const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "parent-owner", parentAttemptCount: 2 }
  const verification = analystVerification
  const sourceNode = { key: "analyst-old", templateId: "analyst", goal: "Earlier query", successCriteria: ["Find evidence"], dependsOn: [],
    depth: 1, taskId: "source-task", verificationDisposition: "typed", verification }
  const replacementNode = { key: "analyst-new", templateId: "analyst", goal: "Updated query", successCriteria: ["Find evidence"], dependsOn: [...replacementDependsOn], verification }
  const input: TaskGraphScheduleInput = { scope, proposal: { expectedRevision: revision, nodes: [replacementNode] },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [], constraints: [], expectedOutputSchema: {} } },
    replaceUnstarted: { nodeKey: sourceNode.key } }
  const operation: SteeringReconciliationOperation = { scope, decision: "revise", expectedRevision: revision,
    callId: "supersession-call", replaceUnstartedNodeKey: sourceNode.key }
  const source = { nodeKey: sourceNode.key, taskId: sourceNode.taskId }
  const fingerprint = taskGraphSupersessionFingerprint(source, { expectedRevision: revision,
    replaceUnstartedNodeKey: sourceNode.key, nodes: [replacementNode] })
  const operationKey = `agent.plan.reconciliation:sha256:${"a".repeat(64)}`
  const relation: TaskGraphSupersessionRelation = { schemaVersion: "agent-harness.v2.task-graph-supersession.v2", operationKey,
    observedRevision: revision, cancellationRevision: revision + 1, resultingRevision: revision + 2, source,
    replacement: { nodeKey: replacementNode.key, taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "11" },
    planEvent: { id: "plan-event", sequence: "12", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, revision) },
    replacementFingerprint: fingerprint,
    agentPlanCall: { callId: operation.callId, stepId: scope.stepId, expectedRevision: revision, replaceUnstarted: { nodeKey: sourceNode.key } } }
  const prepared = { scope, callId: operation.callId, decision: "revise", expectedRevision: revision, resultingRevision: revision + 1,
    steerInputIds: ["steer-1"], inputThroughSequence: 8n, idempotencyKey: operationKey,
    receipt: { ...(replay ? { supersession: relation } : {}) } }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [...dependencyNodes, sourceNode] })
  const loaded = { rootTaskId: scope.rootTaskId,
    state: { revision, nodes: snapshot.nodes.map(node => ({ ...node, status: node.key === sourceNode.key ? "queued" as const : "waiting" as const })), appliedEvents: [] },
    snapshot, item: { id: "graph-item", revision, content: {}, createdAt: new Date() }, tasks: new Map() }
  const sourceEvidence = { id: sourceNode.taskId, status: "queued", role: "analyst", taskType: "research", constraints: [],
    allowedActions: [], expectedOutputSchema: {}, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
    startedAt: null, completedAt: null, closedAt: null, interruptRequestedAt: null, failureReason: null, result: null, confidence: null,
    qualityGateResult: null, outputArtifactIds: [], contextSnapshotId: null, hasExecutionEvidence: false, hasCanonicalDispatch: true }
  return { input, operation, loaded, prepared, relation, sourceEvidence, sourceNode, replacementNode, operationKey, fingerprint }
}

function dependencyNode(key: string, taskId: string, dependsOn: readonly string[], disposition: "typed" | "legacy_unverified"): Record<string, unknown> {
  const base = { key, templateId: "analyst", goal: `Work ${key}`, successCriteria: ["Find evidence"], dependsOn: [...dependsOn],
    depth: dependsOn.length ? 2 : 1, taskId, verificationDisposition: disposition }
  return disposition === "typed" ? { ...base, verification: analystVerification } : base
}

function runGuard(fixture: ReturnType<typeof runtimeFixture>) {
  runtimeMocks.prepare.mockResolvedValueOnce(fixture.prepared)
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [fixture.sourceEvidence], rowCount: 1 }))
  const findReplay = vi.fn(async () => null), budgetReached = new Error("budget seam reached")
  const checkBudget = vi.fn(async () => { throw budgetReached })
  const result = scheduleTaskGraphSupersession({ query } as never, fixture.input,
    { taskType: "root", role: "orchestrator", allowedActions: ["agent.plan"] }, fixture.loaded as never,
    fixture.operation, taskGraphSupersessionProposalKey("root-1", fixture.input.proposal.expectedRevision), findReplay, checkBudget)
  return { result, query, findReplay, checkBudget, budgetReached }
}

describe("scheduleTaskGraphSupersession budget seam", () => {
  it("returns an exact persisted replay without consulting a depleted budget", async () => {
    const fixture = runtimeFixture(1, true)
    runtimeMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    const replay = { status: "duplicate" as const, revision: 3, nodes: [{ key: "analyst-new", taskId: "replacement-task", status: "queued" as const }], readyTaskIds: ["replacement-task"] }
    const findReplay = vi.fn(async () => replay)
    const checkBudget = vi.fn(async () => { throw new Error("budget exhausted") })
    const cancellation = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: fixture.sourceNode.key, taskId: fixture.sourceNode.taskId,
      templateId: fixture.sourceNode.templateId, goal: fixture.sourceNode.goal, successCriteria: fixture.sourceNode.successCriteria,
      dependsOn: fixture.sourceNode.dependsOn, depth: fixture.sourceNode.depth }] }
    const client = { query: vi.fn(async () => ({ rows: [{ content: cancellation, hasOutbox: true }], rowCount: 1 })) }

    await expect(scheduleTaskGraphSupersession(client as never, fixture.input, {} as never, fixture.loaded as never,
      fixture.operation, taskGraphSupersessionProposalKey("root-1", 1), findReplay, checkBudget)).resolves.toEqual(replay)

    expect(findReplay).toHaveBeenCalledOnce()
    expect(checkBudget).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledOnce()
  })

  it("runs the shared budget check after validation and before any supersession writes", async () => {
    const fixture = runtimeFixture()
    runtimeMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [fixture.sourceEvidence], rowCount: 1 }))
    const client = { query }
    const refusal = new TaskGraphCommandError("task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise a TaskGraph plan")
    const checkBudget = vi.fn(async () => { throw refusal })
    const findReplay = vi.fn(async () => null)

    await expect(scheduleTaskGraphSupersession(client as never, fixture.input,
      { taskType: "root", role: "orchestrator", allowedActions: ["agent.plan"] }, fixture.loaded as never,
      fixture.operation, taskGraphSupersessionProposalKey("root-1", 1), findReplay, checkBudget)).rejects.toBe(refusal)

    expect(checkBudget).toHaveBeenCalledOnce()
    expect(findReplay).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
    expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF task")
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT\b/i.test(String(sql)))).toBe(true)
  })

  it("rejects a waiting legacy direct ancestor before replay, budget, or writes", async () => {
    const fixture = runtimeFixture(1, false, [dependencyNode("legacy", "legacy-task", [], "legacy_unverified")], ["legacy"])
    const run = runGuard(fixture)

    await expect(run.result).rejects.toMatchObject({ code: "task_graph_dependency_unverified" })

    expect(run.findReplay).not.toHaveBeenCalled()
    expect(run.checkBudget).not.toHaveBeenCalled()
    expect(run.query).toHaveBeenCalledOnce()
    expect(String(run.query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF task")
  })

  it("rejects a waiting legacy transitive ancestor through a waiting typed node", async () => {
    const fixture = runtimeFixture(1, false, [
      dependencyNode("legacy", "legacy-task", [], "legacy_unverified"),
      dependencyNode("typed-waiting", "typed-task", ["legacy"], "typed"),
    ], ["typed-waiting"])
    const run = runGuard(fixture)

    await expect(run.result).rejects.toMatchObject({ code: "task_graph_dependency_unverified" })

    expect(run.findReplay).not.toHaveBeenCalled()
    expect(run.checkBudget).not.toHaveBeenCalled()
    expect(run.query).toHaveBeenCalledOnce()
  })

  it("allows an unrelated waiting legacy node", async () => {
    const fixture = runtimeFixture(1, false, [dependencyNode("legacy-unrelated", "legacy-task", [], "legacy_unverified")])
    const run = runGuard(fixture)

    await expect(run.result).rejects.toBe(run.budgetReached)

    expect(run.findReplay).toHaveBeenCalledOnce()
    expect(run.checkBudget).toHaveBeenCalledOnce()
  })

  it("allows a replacement waiting on a typed dependency", async () => {
    const fixture = runtimeFixture(1, false, [dependencyNode("typed-waiting", "typed-task", [], "typed")], ["typed-waiting"])
    const run = runGuard(fixture)

    await expect(run.result).rejects.toBe(run.budgetReached)

    expect(run.findReplay).toHaveBeenCalledOnce()
    expect(run.checkBudget).toHaveBeenCalledOnce()
  })

  it.each([
    { description: "missing dependency references", dependsOn: ["missing-key"], errorCode: "missing_dependency" },
    { description: "replacement self-cycles", dependsOn: ["analyst-new"], errorCode: "dependency_cycle" },
  ])("leaves $description to existing TaskGraph validation", async ({ dependsOn, errorCode }) => {
    const fixture = runtimeFixture(1, false, [], dependsOn)
    const run = runGuard(fixture)

    await expect(run.result).rejects.toBe(run.budgetReached)
    expect(run.checkBudget).toHaveBeenCalledOnce()
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [fixture.replacementNode] },
      { revision: 1, nodes: [], appliedEvents: [] }, { registeredTemplateIds: new Set(["analyst"]), maxNodes: 8, maxDepth: 8 }))
      .toMatchObject({ ok: false, error: { code: errorCode } })
  })

  it("does not run the budget check for a stale revision", async () => {
    const fixture = runtimeFixture()
    const staleLoaded = { ...fixture.loaded, state: { ...fixture.loaded.state, revision: 2 } }
    runtimeMocks.prepare.mockResolvedValueOnce(fixture.prepared)
    const checkBudget = vi.fn(async () => undefined)

    await expect(scheduleTaskGraphSupersession({ query: vi.fn() } as never, fixture.input,
      { taskType: "root", role: "orchestrator", allowedActions: ["agent.plan"] }, staleLoaded as never,
      fixture.operation, taskGraphSupersessionProposalKey("root-1", 1), vi.fn(async () => null), checkBudget)).rejects.toMatchObject({
        code: "revision_mismatch",
      })

    expect(checkBudget).not.toHaveBeenCalled()
  })
})
