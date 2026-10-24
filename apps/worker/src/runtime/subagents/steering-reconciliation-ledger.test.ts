import { describe, expect, it, vi } from "vitest"
import { executionKey } from "../turns/turn-execution-types.js"
import type pg from "pg"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { steeringReconciliationIdempotencyKey } from "./steering-reconciliation-contract.js"
import type { TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { taskGraphSupersessionFingerprint, taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import { TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, taskGraphFailedBranchRepairFingerprint } from "./task-graph-pg-failed-branch-relation.js"
import { STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION } from "./steering-reconciliation-contract.js"
import { taskGraphProposalKey } from "./task-graph-snapshot.js"
import { prepareSteeringReconciliation, findSteeringReconciliationReplay, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"

const failedBranchHistory = vi.hoisted(() => ({ assert: vi.fn(async () => ({ status: "accepted" as const, revision: 2,
  nodes: [{ key: "fresh-scout", taskId: "fresh-scout-task", status: "queued" as const }], readyTaskIds: ["fresh-scout-task"] })) }))
vi.mock("./steering-reconciliation-failed-branch-history.js", () => ({
  assertTaskGraphFailedBranchRepairHistory: failedBranchHistory.assert,
}))

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "decision-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1 }
const date = new Date("2026-10-01T00:00:00.000Z")
const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: scope.sessionId, turnId: scope.turnId, stepId: scope.stepId,
  inputThroughSequence: 20n, consumedInputIds: [], canonicalJson: "{}", blocks: [] }
function agenda() {
  const receipt = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId: scope.stepId,
    agenda: { ...buildCognitiveActionAgenda(context), planRevision: 1 } })
  if (!receipt) throw new Error("agenda fixture should be valid")
  return receipt
}
function input(id: string, sequence: string, status: string, consumer: string | null) {
  return { id, clientMessageId: `${id}-message`, delivery: "steer", status, acceptedSequence: sequence,
    consumedByStepId: consumer, consumedAt: consumer ? date : null, cancelledAt: null }
}
function accepted(row: ReturnType<typeof input>) {
  return { ...row, acceptedType: "input.accepted", acceptedActor: "user", acceptedTaskId: null, acceptedCorrelationId: scope.turnId,
    acceptedItemId: `${row.id}-item`, acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemContent: { parts: [{ type: "text", text: "steer" }], clientMessageId: row.clientMessageId, source: "user", disposition: "steered" },
    acceptedEventSequence: row.acceptedSequence,
    acceptedPayload: { inputId: row.id, clientMessageId: row.clientMessageId, delivery: row.delivery, source: "user", disposition: "steered" } }
}
function clientFixture(options: { pending?: boolean; unconsumed?: boolean; decision?: "keep" | "revise"; replaceUnstartedNodeKey?: string; replaceBranch?: TaskGraphBranchReplacement } = {}) {
  const original = input("original-input", "1", "consumed", "origin-step")
  original.clientMessageId = "root-client-message"
  const steer = input("steer-1", "10", options.unconsumed ? "accepted" : "consumed", options.unconsumed ? null : "origin-step")
  const originStep = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed", inputThroughSequence: "10", consumedInputIds: ["original-input", "steer-1"] }
  const decisionStep = { id: scope.stepId, taskId: scope.rootTaskId, ordinal: 2, attempt: 1, status: "streaming", inputThroughSequence: "20", consumedInputIds: [] }
  let graphRevision = 1
  let nextSequence = 22
  const events: Array<Record<string, unknown>> = []
  const toolName = options.decision === "revise" ? "agent.plan" : "agent.reconcile"
  const planNodes = options.replaceBranch ? options.replaceBranch.sources.map(source => ({ key: source.replacementKey }))
    : [{ key: "next", templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: [] }]
  const executionIdentity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  const toolCall = { eventId: "tool-event", eventSequence: "20", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item",
    correlationId: "call-1", idempotencyKey: `${executionKey(executionIdentity)}:event:tool-started:call-1`,
    payload: { toolCallId: "call-1", toolName, taskId: scope.rootTaskId }, callItemId: "call-item", stepId: scope.stepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: "call-1", toolName,
      toolVersion: "1", input: options.decision === "revise" ? { expectedRevision: 1, nodes: planNodes,
        ...(options.replaceBranch ? { replaceBranch: options.replaceBranch } : {}),
        ...(options.replaceUnstartedNodeKey ? { replaceUnstarted: { nodeKey: options.replaceUnstartedNodeKey } } : {}) } : { decision: "keep", expectedRevision: 1 } } }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let supersessionEvents: Array<Record<string, unknown>> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT session."id"') && sql.includes("pause_request")) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FOR UPDATE') && sql.includes('FROM "agent_sessions"')) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: scope.turnId }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: scope.rootTaskId }], rowCount: 1 }
    if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: { goal: "Find jobs", clientMessageId: "root-client-message" } }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('"clientMessageId" = $4')) return { rows: [original], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) {
      const inputs = [original, ...(options.pending === false ? [] : [steer])].filter(row => values?.[3] == null
        || BigInt(row.acceptedSequence) > BigInt(String(values[3])) || BigInt(row.acceptedSequence) === BigInt(String(values[3])) && row.id > String(values?.[4]))
      return { rows: inputs.slice(0, 64), rowCount: Math.min(inputs.length, 64) }
    }
    if (sql.includes('FROM "agent_inputs" AS input')) {
      const ids = values?.[3] as string[]
      const rows = options.pending === false || !ids.includes(steer.id) ? [] : [accepted(steer)]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ANY($4::text[])')) {
      const rows = (values?.[3] as string[] | undefined)?.includes(scope.stepId) ? [decisionStep] : [originStep]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps"') && values?.[0] === scope.stepId) return { rows: [decisionStep], rowCount: 1 }
    if (sql.includes("tool_call.started")) {
      const isHistoryPage = Array.isArray(values?.[3]), rows = isHistoryPage && values?.[4] != null ? [] : [toolCall]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_events"') && sql.includes('"id" = ANY($3::text[])')) {
      const ids = values?.[2] as string[]
      const rows = supersessionEvents.filter(event => ids.includes(String(event.id)))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes("cognitive.agenda")) return { rows: [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: scope.stepId, payload: agenda() }], rowCount: 1 }
    if (sql.includes('event."idempotencyKey" = $2')) {
      const found = events.filter(event => event.idempotencyKey === values?.[1])
      return { rows: found.map(event => ({ ...event, hasOutbox: false })), rowCount: found.length }
    }
    if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") {
      const afterSequence = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      const page = events.filter(event => {
        const sequence = BigInt(String(event.sequence))
        return afterSequence === null || sequence > afterSequence || sequence === afterSequence && String(event.id) > afterId
      }).slice(0, 64).map(event => ({ ...event, hasOutbox: false }))
      return { rows: page, rowCount: page.length }
    }
    if (sql.includes('FROM "agent_items"')) return { rows: [{ revision: graphRevision }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: String(++nextSequence) }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      const row = { id: `receipt-${events.length}`, turnId: scope.turnId, itemId: values?.[3] ?? null, taskId: values?.[4] ?? null, type: values?.[6], actor: values?.[7], correlationId: scope.turnId,
        causationId: values?.[8] ?? null, idempotencyKey: values?.[9], payload: JSON.parse(String(values?.[10])), sequence: values?.[5] }
      events.push(row)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, events, setGraphRevision(value: number) { graphRevision = value }, setSupersessionEvents(value: Array<Record<string, unknown>>) { supersessionEvents = value } }
}
function operation(decision: "keep" | "revise" = "keep", replaceUnstartedNodeKey?: string, replaceBranch?: TaskGraphBranchReplacement) {
  return { scope, decision, expectedRevision: 1, callId: "call-1", rootInputId: null,
    ...(replaceUnstartedNodeKey ? { replaceUnstartedNodeKey } : {}), ...(replaceBranch ? { replaceBranch } : {}) }
}
function supersessionRelation() {
  const request = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "next", templateId: "scout",
    goal: "new goal", successCriteria: ["new criterion"], dependsOn: [] }] }
  const operationKey = steeringReconciliationIdempotencyKey(scope, "call-1")
  if (!operationKey) throw new Error("expected valid operation key")
  return {
    schemaVersion: "agent-harness.v2.task-graph-supersession.v2" as const, operationKey,
    observedRevision: 1, cancellationRevision: 2, resultingRevision: 3,
    source: { nodeKey: "stale-scout", taskId: "source-task" }, replacement: { nodeKey: "next", taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "21" },
    planEvent: { id: "plan-event", sequence: "22", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, 1) },
    replacementFingerprint: taskGraphSupersessionFingerprint({ nodeKey: "stale-scout", taskId: "source-task" }, {
      expectedRevision: 1, replaceUnstartedNodeKey: "stale-scout", nodes: request.nodes,
    }),
    agentPlanCall: { callId: "call-1", stepId: scope.stepId, expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" } },
  }
}
function supersessionEvents(relation = supersessionRelation()) {
  const graphItemId = taskGraphItemId(scope.rootTaskId), cancellationKey = taskGraphLifecycleKey(scope.rootTaskId, relation.source.nodeKey, 0, "task.cancelled")
  const sourceNode = { key: relation.source.nodeKey, taskId: relation.source.taskId, templateId: "scout", goal: "old goal",
    successCriteria: ["old criterion"], dependsOn: [], depth: 1 }
  const replacementNode = { ...sourceNode, key: relation.replacement.nodeKey, taskId: relation.replacement.taskId,
    goal: "new goal", successCriteria: ["new criterion"] }
  const unrelatedNode = { key: "unrelated", taskId: "unrelated-task", templateId: "scout", goal: "unchanged goal",
    successCriteria: ["unchanged criterion"], dependsOn: [], depth: 1 }
  const cancelledContent = { schemaVersion: "agent-harness.v2.task-graph", nodes: [sourceNode, unrelatedNode] }
  const plannedContent = { schemaVersion: "agent-harness.v2.task-graph", nodes: [replacementNode, unrelatedNode] }
  return [
    { id: relation.cancellationEvent.id, itemId: graphItemId, taskId: relation.source.taskId, type: "item.delta", actor: "system",
      correlationId: scope.turnId, causationId: scope.stepId, sequence: relation.cancellationEvent.sequence, idempotencyKey: cancellationKey, hasOutbox: true,
      payload: { kind: "lifecycle", revision: relation.cancellationRevision,
        event: { type: "task.cancelled", nodeKey: relation.source.nodeKey, expectedRevision: relation.observedRevision, idempotencyKey: cancellationKey },
        item: { id: graphItemId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, type: "task_graph",
          revision: relation.cancellationRevision, content: cancelledContent } } },
    { id: relation.planEvent.id, itemId: graphItemId, taskId: scope.rootTaskId, type: "item.delta", actor: "orchestrator",
      correlationId: scope.turnId, causationId: scope.stepId, sequence: relation.planEvent.sequence, hasOutbox: true,
      idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, relation.observedRevision),
      payload: { kind: "proposal", observedRevision: relation.observedRevision, operationKey: relation.operationKey,
        fingerprint: relation.replacementFingerprint, revision: relation.resultingRevision,
        receipt: { status: "accepted", revision: relation.resultingRevision,
          nodes: [{ key: relation.replacement.nodeKey, taskId: relation.replacement.taskId, status: "queued" }],
          readyTaskIds: [relation.replacement.taskId] }, content: plannedContent, item: { id: graphItemId, sessionId: scope.sessionId, turnId: scope.turnId,
          taskId: scope.rootTaskId, type: "task_graph", revision: relation.resultingRevision, content: plannedContent } } },
  ]
}

function failedBranchReplayFixture() {
  const replaceBranch: TaskGraphBranchReplacement = { root: { nodeKey: "failed-scout", taskId: "failed-scout-task" }, sources: [
    { nodeKey: "failed-scout", taskId: "failed-scout-task", replacementKey: "fresh-scout" },
    { nodeKey: "cancelled-analyst", taskId: "cancelled-analyst-task", replacementKey: "fresh-analyst" },
  ] }
  const nodes = [{ key: "fresh-scout" }, { key: "fresh-analyst" }]
  const call = { expectedRevision: 1, replaceBranch, nodes }
  const operationKey = steeringReconciliationIdempotencyKey(scope, "call-1")!
  const relation = {
    schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, operationKey, graphRootTaskId: scope.rootTaskId,
    observedRevision: 1, resultingRevision: 2, branchRoot: replaceBranch.root,
    sources: replaceBranch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
    failedSource: { source: replaceBranch.root, attemptCount: 1, resultDigest: "a".repeat(64), reportDigest: "b".repeat(64),
      event: { id: "failed-event", sequence: "21", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "failed-scout", 1, "task.failed") } },
    cancellations: [{ source: { nodeKey: "cancelled-analyst", taskId: "cancelled-analyst-task" },
      event: { id: "cancelled-event", sequence: "22", idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "cancelled-analyst", 0, "task.cancelled") } }],
    verifiedExternalDependencies: [],
    planEvent: { id: "plan-event", sequence: "23", idempotencyKey: taskGraphProposalKey(scope.rootTaskId, 1) },
    requestFingerprint: taskGraphFailedBranchRepairFingerprint(call),
    agentPlanCall: { callId: "call-1", stepId: scope.stepId, expectedRevision: 1, replaceBranch },
  }
  const payload = { schemaVersion: STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
    sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "revise",
    observedRevision: 1, resultingRevision: 2, steerInputIds: [], inputCheckpoint: { throughSequence: "20" }, failedBranch: relation }
  return { replaceBranch, relation, payload, fingerprint: relation.requestFingerprint, operation: operation("revise", undefined, replaceBranch) }
}

describe("durable steering reconciliation ledger", () => {
  it("prepares the complete server-derived set and blocks an unconsumed steer", async () => {
    const fixture = clientFixture()
    const prepared = await prepareSteeringReconciliation(fixture.client, operation())
    expect(prepared).toMatchObject({ decision: "keep", expectedRevision: 1, resultingRevision: 1, steerInputIds: ["steer-1"] })
    const unconsumed = clientFixture({ unconsumed: true })
    await expect(prepareSteeringReconciliation(unconsumed.client, operation())).rejects.toThrow("steering_reconciliation_unconsumed_input")
  })

  it("requires the actual graph revision after CAS and writes one private, itemless, no-outbox receipt", async () => {
    const fixture = clientFixture({ decision: "revise" })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise"))
    if (!prepared) throw new Error("expected pending steering")
    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, 1)).rejects.toThrow("steering_reconciliation_prepared_invalid")
    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, 2)).rejects.toThrow("steering_reconciliation_graph_result_conflict")
    expect(fixture.events).toHaveLength(0)
    fixture.setGraphRevision(2)
    await writeSteeringReconciliationReceipt(fixture.client, prepared, 2)
    expect(fixture.events).toHaveLength(1)
    expect(fixture.events[0]).toMatchObject({ itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
      causationId: scope.stepId, payload: { decision: "revise", observedRevision: 1, resultingRevision: 2, steerInputIds: ["steer-1"] } })
    expect(fixture.events[0]?.idempotencyKey).toBe(prepared.idempotencyKey)
    expect(fixture.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    await writeSteeringReconciliationReceipt(fixture.client, prepared, 2)
    expect(fixture.events).toHaveLength(1)
  })

  it("writes and replays a v2 supersession receipt only after the R+1 cancellation and R+2 plan events persist", async () => {
    const fixture = clientFixture({ decision: "revise", replaceUnstartedNodeKey: "stale-scout" })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise", "stale-scout"))
    if (!prepared) throw new Error("expected pending steering")
    const relation = supersessionRelation()
    fixture.setGraphRevision(3)
    fixture.setSupersessionEvents(supersessionEvents(relation))
    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, 3, relation)).resolves.toBeUndefined()
    expect(fixture.events).toHaveLength(1)
    expect(fixture.events[0]).toMatchObject({ itemId: null, taskId: scope.rootTaskId, idempotencyKey: relation.operationKey,
      payload: { schemaVersion: "agent-harness.v2.plan-reconciliation.v2", decision: "revise", observedRevision: 1, resultingRevision: 3, supersession: relation } })
    await writeSteeringReconciliationReceipt(fixture.client, prepared, 3, relation)
    expect(fixture.events).toHaveLength(1)
  })

  it("rejects exact replay when the linked plan event follows the stored receipt", async () => {
    const fixture = clientFixture({ decision: "revise", replaceUnstartedNodeKey: "stale-scout" })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise", "stale-scout"))
    if (!prepared) throw new Error("expected pending steering")
    const relation = supersessionRelation()
    fixture.setGraphRevision(3)
    fixture.setSupersessionEvents(supersessionEvents(relation))
    await writeSteeringReconciliationReceipt(fixture.client, prepared, 3, relation)
    const laterRelation = { ...relation, planEvent: { ...relation.planEvent, sequence: "24" } }
    fixture.events[0]!.payload = { ...(fixture.events[0]!.payload as object), supersession: laterRelation }
    fixture.setSupersessionEvents(supersessionEvents(laterRelation))
    await expect(prepareSteeringReconciliation(fixture.client, operation("revise", "stale-scout")))
      .rejects.toThrow("steering_reconciliation_supersession_event_invalid")
  })

  it.each([
    ["R+1 instead of R+2", (relation: ReturnType<typeof supersessionRelation>) => relation, 2, supersessionEvents()],
    ["wrong source event", (relation: ReturnType<typeof supersessionRelation>) => relation, 3,
      supersessionEvents().map((event, index) => index === 0 ? { ...event, payload: { ...(event.payload as object), event: { type: "task.cancelled", nodeKey: "other", expectedRevision: 1,
        idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "stale-scout", 0, "task.cancelled") } } } : event)],
    ["changed proposal fingerprint", (relation: ReturnType<typeof supersessionRelation>) => ({ ...relation, replacementFingerprint: "b".repeat(64) }), 3, supersessionEvents()],
    ["changed operation key", (relation: ReturnType<typeof supersessionRelation>) => ({ ...relation, operationKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` }), 3, supersessionEvents()],
  ] as const)("rejects v2 receipt with %s", async (_name, change, resultingRevision, rows) => {
    const fixture = clientFixture({ decision: "revise", replaceUnstartedNodeKey: "stale-scout" })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise", "stale-scout"))
    if (!prepared) throw new Error("expected pending steering")
    fixture.setGraphRevision(3)
    fixture.setSupersessionEvents(rows)
    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, resultingRevision, change(supersessionRelation())))
      .rejects.toThrow()
    expect(fixture.events).toHaveLength(0)
  })

  it("rejects a supersession retry when the persisted proposal changes under the same call identity", async () => {
    const fixture = clientFixture({ decision: "revise", replaceUnstartedNodeKey: "stale-scout" })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise", "stale-scout"))
    if (!prepared) throw new Error("expected pending steering")
    const relation = { ...supersessionRelation(), replacementFingerprint: "c".repeat(64) }
    fixture.setGraphRevision(3)
    fixture.setSupersessionEvents(supersessionEvents(relation))
    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, 3, relation))
      .rejects.toThrow("steering_reconciliation_call_invalid")
    expect(fixture.events).toHaveLength(0)
  })

  it("returns no synthetic decision when there is no pending steering", async () => {
    const fixture = clientFixture({ pending: false })
    await expect(prepareSteeringReconciliation(fixture.client, operation())).resolves.toBeNull()
    expect(fixture.events).toHaveLength(0)
  })

  it("prepares a no-steer branch receipt from the persisted decision Step cursor", async () => {
    const replaceBranch: TaskGraphBranchReplacement = { root: { nodeKey: "scout-old", taskId: "scout-task" }, sources: [
      { nodeKey: "scout-old", taskId: "scout-task", replacementKey: "scout-new" },
      { nodeKey: "analyst-old", taskId: "analyst-task", replacementKey: "analyst-new" },
    ] }
    const fixture = clientFixture({ pending: false, decision: "revise", replaceBranch })
    const prepared = await prepareSteeringReconciliation(fixture.client, operation("revise", undefined, replaceBranch))

    expect(prepared).toMatchObject({ decision: "revise", expectedRevision: 1, steerInputIds: [], inputThroughSequence: 20n,
      receipt: { steerInputIds: [], inputCheckpoint: { throughSequence: "20" } } })
  })

  it("replays a full-fingerprint v4 receipt before current-graph reads and conflicts on changed calls", async () => {
    failedBranchHistory.assert.mockClear()
    const data = failedBranchReplayFixture()
    const fixture = clientFixture({ pending: false, decision: "revise", replaceBranch: data.replaceBranch })
    const key = steeringReconciliationIdempotencyKey(scope, "call-1")!
    fixture.events.push({ id: "reconciliation-event", sequence: "30", turnId: scope.turnId, itemId: null,
      taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator", correlationId: scope.turnId,
      causationId: scope.stepId, idempotencyKey: key, payload: data.payload })

    await expect(findSteeringReconciliationReplay(fixture.client, data.operation, "c".repeat(64)))
      .rejects.toThrow("steering_reconciliation_idempotency_conflict")
    expect(failedBranchHistory.assert).not.toHaveBeenCalled()

    await expect(findSteeringReconciliationReplay(fixture.client, data.operation, data.fingerprint)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "fresh-scout", taskId: "fresh-scout-task", status: "queued" }],
      readyTaskIds: ["fresh-scout-task"],
    })
    expect(failedBranchHistory.assert).toHaveBeenCalledWith(fixture.client, scope, data.relation,
      { id: "reconciliation-event", sequence: 30n, stepId: scope.stepId, idempotencyKey: key })
    expect(fixture.calls).toHaveLength(2)
    expect(fixture.calls.every(call => call.sql.includes('event."idempotencyKey" = $2'))).toBe(true)
  })

  it("writes a v4 receipt only after the full failed-branch plan revision is present", async () => {
    failedBranchHistory.assert.mockClear()
    const data = failedBranchReplayFixture()
    const fixture = clientFixture({ pending: false, decision: "revise", replaceBranch: data.replaceBranch })
    const prepared = await prepareSteeringReconciliation(fixture.client, data.operation)
    if (!prepared) throw new Error("expected an empty-input branch decision")
    fixture.setGraphRevision(2)

    await expect(writeSteeringReconciliationReceipt(fixture.client, prepared, 2, undefined, undefined, data.relation)).resolves.toBeUndefined()
    expect(fixture.events).toHaveLength(1)
    expect(fixture.events[0]).toMatchObject({ itemId: null, taskId: scope.rootTaskId,
      type: "agent.plan.reconciliation", actor: "orchestrator", idempotencyKey: prepared.idempotencyKey,
      payload: { schemaVersion: STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
        observedRevision: 1, resultingRevision: 2, steerInputIds: [], failedBranch: data.relation } })
    expect(failedBranchHistory.assert).toHaveBeenCalledOnce()
    expect(failedBranchHistory.assert.mock.calls[0]?.[2]).toEqual(data.relation)
  })
})
