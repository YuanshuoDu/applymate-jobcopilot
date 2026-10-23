import { describe, expect, it, vi } from "vitest"
import { executeToolWithItems, TurnExecutionEventWriter } from "../turns/turn-execution-events.js"
import type { TurnExecutionOptions } from "../turns/turn-execution-types.js"
import { executionKey } from "../turns/turn-execution-types.js"
import type pg from "pg"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_SCHEMA_VERSION, STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION, validSteeringReconciliationToolCall } from "./steering-reconciliation-contract.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { taskGraphSupersessionFingerprint, taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { assertSteeringReconciliationCall, readSteeringReconciliationHistory, type SteeringReconciliationHistoryEntry } from "./steering-reconciliation-history.js"
import { resolveRootPlanCriteria } from "./root-plan-criteria.js"

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "later-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1 }
const decisionStepId = "decision-step"
const callId = "reconcile-call"
const baseReceipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
  rootTaskId: scope.rootTaskId, stepId: decisionStepId, decision: "keep", observedRevision: 1, resultingRevision: 1,
  steerInputIds: ["steer-1"], inputCheckpoint: { throughSequence: "10" } }
const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: scope.sessionId, turnId: scope.turnId, stepId: decisionStepId,
  inputThroughSequence: 10n, consumedInputIds: ["steer-1"], canonicalJson: "{}", blocks: [] }
async function actualRootToolCall(): Promise<{ event: Record<string, unknown>; item: Record<string, unknown> | undefined }> {
  const items = new Map<string, Record<string, unknown>>(), events: Array<Record<string, unknown>> = []
  const identity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  const options = { identity, scope: { userId: scope.userId }, idFactory: (prefix: string) => prefix,
    store: {
      createItem: async ({ itemId, stepId, type, content }: { itemId: string; stepId: string | null; type: string; content: unknown }) => {
        items.set(itemId, { id: itemId, stepId, taskId: scope.rootTaskId, type, content }); return { id: itemId, revision: 0 }
      },
      updateItem: async ({ itemId, expectedRevision, content }: { itemId: string; expectedRevision: number; content: unknown }) => {
        const item = items.get(itemId)
        if (!item) throw new Error("tool_item_missing")
        items.set(itemId, { ...item, content }); return { id: itemId, revision: expectedRevision + 1 }
      },
      appendEvent: async (event: Record<string, unknown>) => { events.push(event); return { id: String(event.id) } },
    },
    executeTool: async ({ call }: { call: { id: string; toolName: string; toolVersion: string } }) => ({
      id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed" as const,
    }),
  } as unknown as TurnExecutionOptions
  const writer = new TurnExecutionEventWriter(options)
  await executeToolWithItems(options, writer, { id: decisionStepId, ordinal: 1 },
    { id: callId, name: "agent.reconcile", arguments: { decision: "keep", expectedRevision: 1 } }, () => new Date())
  const started = events.find(event => event.type === "tool_call.started")
  if (!started || typeof started.itemId !== "string") throw new Error("root tool call event missing item")
  const itemId = started.itemId
  const event: Record<string, unknown> = { ...started, actor: "orchestrator", taskId: scope.rootTaskId }
  return { event, item: items.get(itemId) }
}
function toolStartKey(callId: string): string {
  const identity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  return `${executionKey(identity)}:event:tool-started:${callId}`
}
function agenda(stepId = decisionStepId) {
  const payload = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId,
    agenda: { ...buildCognitiveActionAgenda({ ...context, stepId }), planRevision: 1 } })
  if (!payload) throw new Error("agenda fixture should be valid")
  return payload
}
function fixture(change: Readonly<{ event?: Record<string, unknown>; tool?: Record<string, unknown>; step?: Record<string, unknown>;
  agenda?: Record<string, unknown>; noReceipt?: boolean; planInput?: Readonly<Record<string, unknown>> }> = {}) {
  const decision = change.planInput ? "revise" : "keep"
  const defaultReceipt = decision === "revise" ? { ...baseReceipt, decision, resultingRevision: 2 } : baseReceipt
  const receipt = { ...defaultReceipt, ...(change.event?.payload && typeof change.event.payload === "object" ? change.event.payload as Record<string, unknown> : {}) }
  const receiptKey = steeringReconciliationIdempotencyKey({ ...scope, stepId: decisionStepId }, callId)
  const storedEvent = { id: "receipt-event", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: decisionStepId, sequence: "30", idempotencyKey: receiptKey, payload: receipt, hasOutbox: false, ...change.event }
  const toolName = decision === "keep" ? "agent.reconcile" : "agent.plan"
  const input = decision === "keep" ? { decision: "keep", expectedRevision: 1 }
    : { expectedRevision: 1, nodes: [{ key: "research" }], ...change.planInput }
  const toolEvent = { eventId: "tool-event", eventSequence: "20", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item", correlationId: callId,
    idempotencyKey: toolStartKey(callId), payload: { toolCallId: callId, toolName, taskId: scope.rootTaskId }, callItemId: "call-item", stepId: decisionStepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName, toolVersion: "1", input }, ...change.tool }
  const step = { id: decisionStepId, taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed", inputThroughSequence: "10", ...change.step }
  const agendaRow = { actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: decisionStepId, payload: agenda(), ...change.agenda }
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push(sql)
    if (sql.includes('event."type" = $3')) {
      const rows = change.noReceipt || values?.[3] != null ? [] : [storedEvent]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes("tool_call.started")) {
      const rows = values?.[4] == null ? [toolEvent] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps"')) return { rows: [step], rowCount: 1 }
    if (sql.includes("cognitive.agenda")) return { rows: [agendaRow], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, storedEvent, toolEvent }
}
async function historyEntries(client: Pick<pg.PoolClient, "query">, currentRevision = 1): Promise<SteeringReconciliationHistoryEntry[]> {
  const history: SteeringReconciliationHistoryEntry[] = []
  for await (const entry of readSteeringReconciliationHistory(client, scope, currentRevision)) history.push(entry)
  return history
}
function normalizedCallNodes(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return []
  return value.map(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate
    const node = candidate as Record<string, unknown>, repair = node.repairOf
    if (!repair || typeof repair !== "object" || Array.isArray(repair)) return node
    const relation = repair as Record<string, unknown>
    return relation.graphRootTaskId === undefined
      ? { ...node, repairOf: { ...relation, graphRootTaskId: scope.rootTaskId } }
      : node
  })
}
function supersessionFixture(change: Readonly<{ relation?: Record<string, unknown>; tool?: Record<string, unknown>; events?: Array<Record<string, unknown>>;
  receipt?: Record<string, unknown>; receiptKey?: string; callInput?: Record<string, unknown>;
  sourceNode?: Record<string, unknown>; replacementNode?: Record<string, unknown>; relatedNodes?: Array<Record<string, unknown>> }> = {}) {
  const callScope = { ...scope, stepId: decisionStepId }
  const callInput = change.callInput ?? { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "fresh-scout",
    templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: [] }] }
  const operationKey = steeringReconciliationIdempotencyKey(callScope, callId)!
  const relation = change.relation ?? {
    schemaVersion: "agent-harness.v2.task-graph-supersession.v2", operationKey,
    observedRevision: 1, cancellationRevision: 2, resultingRevision: 3,
    source: { nodeKey: "stale-scout", taskId: "source-task" }, replacement: { nodeKey: "fresh-scout", taskId: "replacement-task" },
    cancellationEvent: { id: "cancel-event", sequence: "41" },
    planEvent: { id: "plan-event", sequence: "42", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, 1) },
    replacementFingerprint: taskGraphSupersessionFingerprint({ nodeKey: "stale-scout", taskId: "source-task" }, {
      expectedRevision: 1, replaceUnstartedNodeKey: "stale-scout", nodes: normalizedCallNodes(callInput.nodes),
      rootSuccessCriteria: callInput.rootSuccessCriteria as readonly string[] | undefined,
    }),
    agentPlanCall: { callId, stepId: decisionStepId, expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" } },
  }
  const receipt = change.receipt ?? { ...baseReceipt, schemaVersion: STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
    decision: "revise", resultingRevision: 3, supersession: relation }
  const graphItemId = taskGraphItemId(scope.rootTaskId), cancellationKey = taskGraphLifecycleKey(scope.rootTaskId, "stale-scout", 0, "task.cancelled")
  const sourceNode = change.sourceNode ?? { key: "stale-scout", taskId: "source-task", templateId: "scout", goal: "old goal",
    successCriteria: ["old criterion"], dependsOn: [], depth: 1 }
  const replacementNode = change.replacementNode ?? { ...sourceNode, key: "fresh-scout", taskId: "replacement-task", goal: "new goal", successCriteria: ["new criterion"] }
  const unrelatedNode = { key: "unrelated", taskId: "unrelated-task", templateId: "scout", goal: "unchanged goal",
    successCriteria: ["unchanged criterion"], dependsOn: [], depth: 1 }
  const relatedNodes = change.relatedNodes ?? []
  const cancelledContent = { schemaVersion: "agent-harness.v2.task-graph", nodes: [...relatedNodes, sourceNode, unrelatedNode] }
  const plannedContent = { schemaVersion: "agent-harness.v2.task-graph", nodes: [...relatedNodes, replacementNode, unrelatedNode] }
  const events = change.events ?? [
    { id: "cancel-event", itemId: graphItemId, taskId: "source-task", type: "item.delta", actor: "system", correlationId: scope.turnId, hasOutbox: true,
      causationId: decisionStepId, sequence: "41", idempotencyKey: cancellationKey,
      payload: { kind: "lifecycle", revision: 2, event: { type: "task.cancelled", nodeKey: "stale-scout", expectedRevision: 1, idempotencyKey: cancellationKey },
        item: { id: graphItemId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, type: "task_graph", revision: 2,
          content: cancelledContent } } },
    { id: "plan-event", itemId: graphItemId, taskId: scope.rootTaskId, type: "item.delta", actor: "orchestrator", correlationId: scope.turnId, hasOutbox: true,
      causationId: decisionStepId, sequence: "42", idempotencyKey: taskGraphSupersessionProposalKey(scope.rootTaskId, 1),
      payload: { kind: "proposal", observedRevision: 1, operationKey, fingerprint: relation.replacementFingerprint, revision: 3,
        receipt: { status: "accepted", revision: 3, nodes: [{ key: "fresh-scout", taskId: "replacement-task", status: "queued" }], readyTaskIds: ["replacement-task"] }, content: plannedContent,
        item: { id: graphItemId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, type: "task_graph", revision: 3,
          content: plannedContent } } },
  ]
  const storedEvent = { id: "receipt-event", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: decisionStepId, sequence: "43", idempotencyKey: change.receiptKey ?? operationKey,
    payload: receipt, hasOutbox: false }
  const toolEvent = { eventId: "tool-event", eventSequence: "40", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
    eventItemId: "call-item", correlationId: callId, idempotencyKey: toolStartKey(callId),
    payload: { toolCallId: callId, toolName: "agent.plan", taskId: scope.rootTaskId }, callItemId: "call-item", stepId: decisionStepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input: callInput }, ...change.tool }
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "agent_events"') && sql.includes('"id" = ANY($3::text[])')) {
      const ids = values?.[2] as string[], rows = events.filter(event => ids.includes(String(event.id)))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('event."type" = $3')) {
      const rows = values?.[3] == null ? [storedEvent] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes("tool_call.started")) return { rows: values?.[4] == null ? [toolEvent] : [], rowCount: values?.[4] == null ? 1 : 0 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: decisionStepId, taskId: scope.rootTaskId, ordinal: 1, attempt: 1,
      status: "completed", inputThroughSequence: "10" }], rowCount: 1 }
    if (sql.includes("cognitive.agenda")) return { rows: [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId,
      correlationId: decisionStepId, payload: agenda() }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, relation, receipt, storedEvent, events, callInput }
}
function longHistoryFixture(count: number, malformedIndex = -1) {
  const receipts: Array<Record<string, unknown>> = [], toolEvents: Array<Record<string, unknown>> = []
  const steps: Array<Record<string, unknown>> = [], agendas: Array<Record<string, unknown>> = []
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(4, "0"), stepId = `decision-step-${suffix}`, toolCallId = `reconcile-call-${suffix}`
    const receipt = { ...baseReceipt, stepId, steerInputIds: [`steer-${suffix}`], inputCheckpoint: { throughSequence: String(index + 10) } }
    const key = steeringReconciliationIdempotencyKey({ ...scope, stepId }, toolCallId)
    receipts.push({ id: `receipt-event-${suffix}`, itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation",
      actor: index === malformedIndex ? "user" : "orchestrator", correlationId: scope.turnId, causationId: stepId,
      sequence: String(index * 4 + 103), idempotencyKey: key, payload: receipt, hasOutbox: false })
    toolEvents.push({ eventId: `tool-event-${suffix}`, eventSequence: String(index * 4 + 102), type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
      eventItemId: `call-item-${suffix}`, correlationId: toolCallId, idempotencyKey: toolStartKey(toolCallId),
      payload: { toolCallId, toolName: "agent.reconcile", taskId: scope.rootTaskId }, callItemId: `call-item-${suffix}`, stepId,
      itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } } })
    steps.push({ id: stepId, taskId: scope.rootTaskId, ordinal: index + 1, attempt: 1, status: "completed", inputThroughSequence: String(index + 10) })
    agendas.push({ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: stepId, payload: agenda(stepId) })
  }
  const calls: Array<{ sql: string; values?: unknown[]; rows: number }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    let rows: Array<Record<string, unknown>> = []
    if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") {
      const after = values[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      rows = receipts.filter(row => after === null || BigInt(String(row.sequence)) > after
        || BigInt(String(row.sequence)) === after && String(row.id) > afterId).slice(0, 64)
    } else if (sql.includes("tool_call.started")) {
      const stepIds = values?.[3] as string[], afterId = String(values?.[4] ?? "")
      rows = toolEvents.filter(row => stepIds.includes(String(row.stepId)) && String(row.eventId) > afterId).slice(0, 64)
    } else if (sql.includes('FROM "agent_steps"') && sql.includes("ANY($4::text[])")) {
      const stepIds = values?.[3] as string[]
      rows = steps.filter(row => stepIds.includes(String(row.id)))
    } else if (sql.includes("cognitive.agenda") && sql.includes("ANY($4::text[])")) {
      const stepIds = values?.[3] as string[]
      rows = agendas.filter(row => stepIds.includes(String(row.correlationId)))
    }
    calls.push({ sql, values, rows: rows.length })
    return { rows, rowCount: rows.length }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls }
}

describe("durable steering reconciliation history", () => {
  it("validates an earlier Step's private keep against its actual tool call and agenda", async () => {
    const f = fixture()
    const history = await historyEntries(f.client)
    expect(history).toEqual([{ receipt: baseReceipt, stepOrdinal: 1, stepAttempt: 1 }])
    expect(f.calls.some(sql => sql.includes('item."stepId" = ANY($4::text[])'))).toBe(true)
  })

  it("accepts reconciled agent.plan history with a pinned checklist and keeps omission compatible", async () => {
    const criteria = ["  Include evidence for each role  ", "Include evidence for each role", "Keep the full search scope"]
    const revised = fixture({ planInput: { rootSuccessCriteria: criteria } })
    const history = await historyEntries(revised.client, 2)
    expect(history).toEqual([{ receipt: { ...baseReceipt, decision: "revise", resultingRevision: 2 }, stepOrdinal: 1, stepAttempt: 1 }])
    expect(revised.toolEvent.itemContent).toMatchObject({ toolName: "agent.plan", input: { expectedRevision: 1, rootSuccessCriteria: criteria } })

    const omitted = fixture({ planInput: {} })
    await expect(historyEntries(omitted.client, 2)).resolves.toHaveLength(1)
    expect(omitted.toolEvent.itemContent).toMatchObject({ toolName: "agent.plan", input: { expectedRevision: 1, nodes: [{ key: "research" }] } })
    expect(omitted.toolEvent.itemContent.input).not.toHaveProperty("rootSuccessCriteria")
  })

  it.each([
    { rootSuccessCriteria: [] },
    { rootSuccessCriteria: Array.from({ length: 5 }, () => "criterion") },
    { rootSuccessCriteria: ["  "] },
    { rootSuccessCriteria: ["x".repeat(513)] },
    { rootSuccessCriteria: ["💼".repeat(129)] },
  ])("rejects reconciled agent.plan history with invalid root criteria $rootSuccessCriteria", async ({ rootSuccessCriteria }) => {
      await expect(historyEntries(fixture({ planInput: { rootSuccessCriteria } }).client, 2))
        .rejects.toThrow("steering_reconciliation_receipt_call_invalid")
    })

  it("uses the pinned checklist in durable plan replay fingerprints and preserves it when omitted", () => {
    const proposal = { expectedRevision: 1, nodes: [{ key: "research" }] }
    const identity = taskGraphProposalKey(scope.rootTaskId, proposal.expectedRevision)
    const pinned = ["Find EU software roles", "Include evidence for each role"]
    const fingerprint = taskGraphFingerprint({ proposal, rootSuccessCriteria: pinned.slice(1) })
    const omittedRootSuccessCriteria: readonly string[] | undefined = undefined

    expect(taskGraphProposalKey(scope.rootTaskId, proposal.expectedRevision)).toBe(identity)
    expect(taskGraphFingerprint({ proposal, rootSuccessCriteria: pinned.slice(1) })).toBe(fingerprint)
    expect(taskGraphFingerprint({ proposal, rootSuccessCriteria: ["Keep the full search scope"] })).not.toBe(fingerprint)
    expect(resolveRootPlanCriteria(pinned[0], pinned, omittedRootSuccessCriteria ?? pinned.slice(1), []))
      .toEqual({ status: "unchanged", criteria: pinned })
  })

  it("binds the v2 supersession replay fingerprint to its optional root checklist", async () => {
    const callInput = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "fresh-scout",
      templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: [] }],
      rootSuccessCriteria: ["Include evidence for each role"] }
    const accepted = supersessionFixture({ callInput })
    await expect(historyEntries(accepted.client, 3)).resolves.toHaveLength(1)

    const changed = supersessionFixture({ relation: accepted.relation as Record<string, unknown>, receipt: accepted.receipt as Record<string, unknown>,
      events: accepted.events, callInput: { ...callInput, rootSuccessCriteria: ["Changed checklist"] } })
    await expect(historyEntries(changed.client, 3)).rejects.toThrow()
  })

  it("keeps a v2 supersession replay fingerprint stable for the same checklist", async () => {
    const callInput = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "fresh-scout",
      templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: [] }],
      rootSuccessCriteria: ["Include evidence for each role"] }
    const first = supersessionFixture({ callInput }), replay = supersessionFixture({ callInput })
    expect(first.relation).toMatchObject({ replacementFingerprint: replay.relation?.replacementFingerprint })
    await expect(historyEntries(replay.client, 3)).resolves.toHaveLength(1)
  })

  it("reconstructs a v2 supersession only when the persisted call and both ordered events match", async () => {
    const f = supersessionFixture()
    const history = await historyEntries(f.client, 3)
    expect(history).toEqual([{ receipt: f.receipt, stepOrdinal: 1, stepAttempt: 1 }])
  })

  it("accepts a rewired dependency edge only when the cancellation snapshot binds the old edge", async () => {
    const callInput = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "fresh-scout",
      templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: ["new-prerequisite"] }] }
    const sourceNode = { key: "stale-scout", taskId: "source-task", templateId: "scout", goal: "old goal",
      successCriteria: ["old criterion"], dependsOn: ["old-prerequisite"], depth: 1 }
    const replacementNode = { ...sourceNode, key: "fresh-scout", taskId: "replacement-task", goal: "new goal",
      successCriteria: ["new criterion"], dependsOn: ["new-prerequisite"], depth: 2 }
    const relatedNodes = ["old-prerequisite", "new-prerequisite"].map((key, index) => ({ key, taskId: `${key}-task`, templateId: "analyst",
      goal: `${key} goal`, successCriteria: [`${key} report`], dependsOn: [], depth: 1 }))
    const seed = supersessionFixture({ callInput, sourceNode, replacementNode, relatedNodes })
    const fingerprint = taskGraphSupersessionFingerprint({ nodeKey: "stale-scout", taskId: "source-task", dependsOn: sourceNode.dependsOn }, {
      expectedRevision: 1, replaceUnstartedNodeKey: "stale-scout", nodes: normalizedCallNodes(callInput.nodes),
    })
    const relation = { ...(seed.relation as Record<string, unknown>), replacementFingerprint: fingerprint }
    const accepted = supersessionFixture({ callInput, sourceNode, replacementNode, relatedNodes, relation })
    await expect(historyEntries(accepted.client, 3)).resolves.toHaveLength(1)

    const cancellation = accepted.events[0]!, payload = cancellation.payload as Record<string, unknown>
    const item = payload.item as Record<string, unknown>, content = item.content as { schemaVersion: string; nodes: Array<Record<string, unknown>> }
    const changedContent = { ...content, nodes: content.nodes.map(node => node.key === "stale-scout" ? { ...node, dependsOn: [] } : node) }
    const events = accepted.events.map((event, index) => index === 0 ? { ...event, payload: { ...payload,
      item: { ...item, content: changedContent } } } : event)
    const tampered = supersessionFixture({ callInput, sourceNode, replacementNode, relatedNodes, relation, events })
    await expect(historyEntries(tampered.client, 3)).rejects.toThrow()

    const forgedDepth = supersessionFixture({ callInput, sourceNode, replacementNode: { ...replacementNode, depth: 3 }, relatedNodes, relation })
    await expect(historyEntries(forgedDepth.client, 3)).rejects.toThrow("steering_reconciliation_supersession_event_invalid")
  })

  it.each([
    ["multiple replacement nodes", (receipt: Record<string, unknown>) => ({ ...receipt, nodes: [...receipt.nodes as unknown[], ...receipt.nodes as unknown[]] })],
    ["a foreign replacement identity", (receipt: Record<string, unknown>) => ({ ...receipt, nodes: [{ ...(receipt.nodes as Record<string, unknown>[])[0]!, taskId: "foreign-task" }] })],
    ["extra replacement node fields", (receipt: Record<string, unknown>) => ({ ...receipt, nodes: [{ ...(receipt.nodes as Record<string, unknown>[])[0]!, extra: true }] })],
    ["a missing queued readiness ID", (receipt: Record<string, unknown>) => ({ ...receipt, readyTaskIds: [] })],
    ["foreign queued readiness IDs", (receipt: Record<string, unknown>) => ({ ...receipt, readyTaskIds: ["foreign-task"] })],
    ["readiness attached to a waiting replacement", (receipt: Record<string, unknown>) => ({ ...receipt,
      nodes: [{ ...(receipt.nodes as Record<string, unknown>[])[0]!, status: "waiting" }] })],
  ] as const)("rejects a v2 plan receipt with %s", async (_name, mutate) => {
    const original = supersessionFixture(), planPayload = original.events[1]!.payload as Record<string, unknown>
    const events = original.events.map((event, index) => index === 1 ? { ...event,
      payload: { ...planPayload, receipt: mutate(planPayload.receipt as Record<string, unknown>) } } : event)
    const fixtureWithReceipt = supersessionFixture({ relation: original.relation as Record<string, unknown>, receipt: original.receipt as Record<string, unknown>, events })
    await expect(historyEntries(fixtureWithReceipt.client, 3)).rejects.toThrow("steering_reconciliation_supersession_event_invalid")
  })

  it("accepts the createGraphTasks waiting result only with an empty ready list", async () => {
    const original = supersessionFixture(), planPayload = original.events[1]!.payload as Record<string, unknown>
    const receipt = planPayload.receipt as Record<string, unknown>, node = (receipt.nodes as Record<string, unknown>[])[0]!
    const events = original.events.map((event, index) => index === 1 ? { ...event,
      payload: { ...planPayload, receipt: { ...receipt, nodes: [{ ...node, status: "waiting" }], readyTaskIds: [] } } } : event)
    const fixtureWithReceipt = supersessionFixture({ relation: original.relation as Record<string, unknown>, receipt: original.receipt as Record<string, unknown>, events })
    await expect(historyEntries(fixtureWithReceipt.client, 3)).resolves.toEqual([{ receipt: fixtureWithReceipt.receipt, stepOrdinal: 1, stepAttempt: 1 }])
  })

  it("binds an omitted repair graph root to the stored source and replacement before fingerprinting", async () => {
    const repair = { graphRootTaskId: scope.rootTaskId, nodeKey: "prior-scout", taskId: "prior-task", criterionIds: ["candidate-count"] }
    const rawRepair = { nodeKey: repair.nodeKey, taskId: repair.taskId, criterionIds: repair.criterionIds }
    const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }
    const callInput = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "fresh-scout",
      templateId: "scout", goal: "new goal", successCriteria: ["new criterion"], dependsOn: [], repairOf: rawRepair, verification }] }
    const priorNode = { key: "prior-scout", taskId: "prior-task", templateId: "scout", goal: "prior goal",
      successCriteria: ["prior criterion"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification }
    const sourceNode = { key: "stale-scout", taskId: "source-task", templateId: "scout", goal: "old goal",
      successCriteria: ["old criterion"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification, repairOf: repair }
    const replacementNode = { ...sourceNode, key: "fresh-scout", taskId: "replacement-task", goal: "new goal",
      successCriteria: ["new criterion"] }
    const f = supersessionFixture({ callInput, sourceNode, replacementNode, relatedNodes: [priorNode] })
    const history = await historyEntries(f.client, 3)
    expect(history).toEqual([{ receipt: f.receipt, stepOrdinal: 1, stepAttempt: 1 }])
    const cancellationNodes = (f.events[0]?.payload as { item: { content: { nodes: Array<Record<string, unknown>> } } }).item.content.nodes
    const planNodes = (f.events[1]?.payload as { item: { content: { nodes: Array<Record<string, unknown>> } } }).item.content.nodes
    expect(cancellationNodes.find(node => node.key === "stale-scout")?.repairOf).toEqual(repair)
    expect(planNodes.find(node => node.key === "fresh-scout")?.repairOf).toEqual(repair)

    const rawFingerprint = taskGraphSupersessionFingerprint({ nodeKey: "stale-scout", taskId: "source-task" }, {
      expectedRevision: 1, replaceUnstartedNodeKey: "stale-scout", nodes: callInput.nodes,
    })
    const relation = { ...(f.relation as object), replacementFingerprint: rawFingerprint }
    const receipt = { ...(f.receipt as object), supersession: relation }
    const events = f.events.map((event, index) => index === 1 ? { ...event,
      payload: { ...(event.payload as object), fingerprint: rawFingerprint } } : event)
    const rawDigestFixture = supersessionFixture({ callInput, sourceNode, replacementNode, relatedNodes: [priorNode], relation, receipt, events })
    await expect(historyEntries(rawDigestFixture.client, 3)).rejects.toThrow("steering_reconciliation_receipt_call_invalid")
  })

  it("rejects a v2 plan event that is sequenced after its reconciliation receipt", async () => {
    const original = supersessionFixture(), relation = { ...(original.relation as object),
      planEvent: { ...((original.relation as Record<string, unknown>).planEvent as object), sequence: "44" } }
    const receipt = { ...(original.receipt as object), supersession: relation }
    const events = original.events.map((event, index) => index === 1 ? { ...event, sequence: "44" } : event)
    const f = supersessionFixture({ relation, receipt, events })
    await expect(historyEntries(f.client, 3)).rejects.toThrow("steering_reconciliation_supersession_event_invalid")
  })

  it.each([
    ["goal", (node: Record<string, unknown>) => ({ ...node, goal: "different goal" })],
    ["successCriteria", (node: Record<string, unknown>) => ({ ...node, successCriteria: ["different criterion"] })],
    ["key", (node: Record<string, unknown>) => ({ ...node, key: "different-node" })],
    ["templateId", (node: Record<string, unknown>) => ({ ...node, templateId: "analyst" })],
    ["dependsOn", (node: Record<string, unknown>) => ({ ...node, dependsOn: ["unrelated"] })],
    ["unknown node fields", (node: Record<string, unknown>) => ({ ...node, unexpected: true })],
  ] as const)("rejects a persisted proposal whose %s differs from the final replacement", async (_field, tamper) => {
    const original = supersessionFixture().callInput as { expectedRevision: number; replaceUnstarted: { nodeKey: string }; nodes: Array<Record<string, unknown>> }
    const callInput = { ...original, nodes: [tamper(original.nodes[0]!)] }
    // The relation and plan receipt fingerprint both match this changed call; the node-to-node binding must still reject it.
    const f = supersessionFixture({ callInput })
    await expect(historyEntries(f.client, 3)).rejects.toThrow()
  })

  it.each([["cancellation", 0], ["plan", 1]] as const)("rejects a supersession %s event without its transactional outbox row", async (_event, index) => {
    const f = supersessionFixture(), events = f.events.map((event, eventIndex) => eventIndex === index ? { ...event, hasOutbox: false } : event)
    await expect(historyEntries(supersessionFixture({ relation: f.relation, receipt: f.receipt, events }).client, 3)).rejects.toThrow()
  })

  it.each([
    ["a wrong source cancellation", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => index === 0 ? { ...event, payload: {
        ...(event.payload as object), event: { type: "task.cancelled", nodeKey: "other", expectedRevision: 1,
          idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "stale-scout", 0, "task.cancelled") },
      } } : event)
      return supersessionFixture({ relation: f.relation, receipt: f.receipt, events })
    }],
    ["a changed persisted proposal", () => {
      const f = supersessionFixture()
      const input = { expectedRevision: 1, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{ key: "other" }] }
      return supersessionFixture({ relation: f.relation, receipt: f.receipt, tool: {
        itemContent: { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input },
      } })
    }],
    ["a mismatched operation key", () => {
      const f = supersessionFixture()
      return supersessionFixture({ relation: { ...(f.relation as object), operationKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` } })
    }],
    ["a cancellation after the plan event", () => {
      const f = supersessionFixture(), relation = f.relation as Record<string, unknown>
      return supersessionFixture({ relation: { ...relation, cancellationEvent: { id: "cancel-event", sequence: "43" } } })
    }],
    ["an R+1 resulting revision", () => {
      const f = supersessionFixture(), relation = f.relation as Record<string, unknown>
      return supersessionFixture({ relation: { ...relation, resultingRevision: 2 } })
    }],
    ["wrong cancellation source identity", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => index === 0 ? { ...event, payload: {
        ...(event.payload as object), event: { type: "task.cancelled", nodeKey: "other", expectedRevision: 1,
          idempotencyKey: taskGraphLifecycleKey(scope.rootTaskId, "stale-scout", 0, "task.cancelled") },
      } } : event)
      return supersessionFixture({ relation: f.relation, events })
    }],
    ["an event sequence claim that does not match storage", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => index === 0 ? { ...event, sequence: "44" } : event)
      return supersessionFixture({ relation: f.relation, events })
    }],
    ["a wrong plan event fingerprint", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => index === 1 ? { ...event, payload: {
        ...(event.payload as object), fingerprint: "b".repeat(64),
      } } : event)
      return supersessionFixture({ relation: f.relation, events })
    }],
    ["a wrong plan observed revision", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => index === 1 ? { ...event, payload: {
        ...(event.payload as object), observedRevision: 0,
      } } : event)
      return supersessionFixture({ relation: f.relation, receipt: f.receipt, events })
    }],
    ["an unrelated plan node changed after cancellation", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => {
        if (index !== 1) return event
        const payload = event.payload as Record<string, unknown>, item = payload.item as Record<string, unknown>
        const content = item.content as { schemaVersion: string; nodes: Array<Record<string, unknown>> }
        const changed = { ...content, nodes: content.nodes.map(node => node.key === "unrelated" ? { ...node, goal: "changed goal" } : node) }
        return { ...event, payload: { ...payload, content: changed, item: { ...item, content: changed } } }
      })
      return supersessionFixture({ relation: f.relation, receipt: f.receipt, events })
    }],
    ["the replacement immutable envelope changed", () => {
      const f = supersessionFixture(), events = f.events.map((event, index) => {
        if (index !== 1) return event
        const payload = event.payload as Record<string, unknown>, item = payload.item as Record<string, unknown>
        const content = item.content as { schemaVersion: string; nodes: Array<Record<string, unknown>> }
        const changed = { ...content, nodes: content.nodes.map(node => node.key === "fresh-scout" ? { ...node, templateId: "researcher" } : node) }
        return { ...event, payload: { ...payload, content: changed, item: { ...item, content: changed } } }
      })
      return supersessionFixture({ relation: f.relation, receipt: f.receipt, events })
    }],
    ["a receipt key not bound to the plan call", () => supersessionFixture({ receiptKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` })],
  ] as const)("rejects v2 history with %s", async (_name, create) => {
    await expect(historyEntries(create().client, 3)).rejects.toThrow()
  })

  it("accepts the exact normal root payload emitted by executeToolWithItems and rejects child replay metadata", async () => {
    const actual = await actualRootToolCall()
    expect(actual.item).toMatchObject({ stepId: decisionStepId, taskId: scope.rootTaskId, type: "tool_call", content: {
      toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 },
    } })
    expect(actual.event?.payload).toEqual({ toolCallId: callId, toolName: "agent.reconcile", taskId: scope.rootTaskId })
    expect(actual.event?.idempotencyKey).toBe(toolStartKey(callId))
    expect(actual.event && actual.item && validSteeringReconciliationToolCall(actual.event, actual.item, scope, decisionStepId, "keep", 1)).toBe(true)
    expect(actual.event && actual.item && validSteeringReconciliationToolCall({ ...actual.event, payload: {
      ...(actual.event.payload as object), toolVersion: "1", replaySource: { toolCallId: "source-call", resultItemId: "source-result" },
    } }, actual.item, scope, decisionStepId, "keep", 1)).toBe(false)
  })

  it.each([
    ["foreign actor", { event: { actor: "user" } }],
    ["public item binding", { event: { itemId: "public-item" } }],
    ["foreign owner", { event: { taskId: "other-root" } }],
    ["outbox copy", { event: { hasOutbox: true } }],
    ["hash receipt key not bound to the persisted call", { event: { idempotencyKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` } }],
    ["forged tool actor", { tool: { actor: "subagent" } }],
    ["tool call starts at the receipt sequence", { tool: { eventSequence: "30" } }],
    ["tool call starts after the receipt", { tool: { eventSequence: "31" } }],
    ["wrong tool name", { tool: { payload: { toolCallId: callId, toolName: "agent.wait", taskId: scope.rootTaskId } } }],
    ["hash without a matching call", { tool: { idempotencyKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` } }],
    ["foreign Turn writer key", { tool: { idempotencyKey: toolStartKey(callId).replace(scope.turnId, "other-turn") } }],
    ["different call writer key", { tool: { idempotencyKey: toolStartKey("different-call") } }],
    ["agenda revision mismatch", { agenda: { payload: { ...agenda(), planRevision: 2 } } }],
    ["step cursor mismatch", { step: { inputThroughSequence: "9" } }],
    ["stale resulting revision", { event: { payload: { ...baseReceipt, resultingRevision: 2 } } }],
  ] as const)("rejects %s history instead of clearing an obligation", async (_name, change) => {
    await expect(historyEntries(fixture(change).client)).rejects.toThrow()
  })

  it("does not query or invent a decision when no receipt exists", async () => {
    const f = fixture({ noReceipt: true })
    await expect(historyEntries(f.client)).resolves.toEqual([])
    expect(f.calls.some(sql => sql.includes("tool_call.started"))).toBe(false)
  })

  it("checks a current call by its exact ID with a bounded duplicate probe", async () => {
    const actual = await actualRootToolCall()
    const currentScope = { ...scope, stepId: decisionStepId }
    const query = vi.fn(async () => ({ rows: [actual.event && {
      type: actual.event.type, actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: actual.event.itemId,
      correlationId: callId, idempotencyKey: toolStartKey(callId), payload: actual.event.payload,
      callItemId: actual.item?.id, stepId: decisionStepId, itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: actual.item?.content,
    }].filter(Boolean), rowCount: 1 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    await assertSteeringReconciliationCall(client, currentScope, callId, "keep", 1)
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('event."correlationId" = $4')
    expect(sql).toContain("LIMIT 2")
    expect(values).toEqual([scope.sessionId, scope.turnId, scope.rootTaskId, callId, decisionStepId])
  })

  it("reads more than 256 valid receipts through bounded keyset pages", async () => {
    const f = longHistoryFixture(270)
    let count = 0
    for await (const _entry of readSteeringReconciliationHistory(f.client, scope, 1)) count++

    const receiptPages = f.calls.filter(call => call.sql.includes('event."type" = $3') && call.values?.[2] === "agent.plan.reconciliation")
    const callPages = f.calls.filter(call => call.sql.includes("tool_call.started"))
    expect(count).toBe(270)
    expect(receiptPages.length).toBeGreaterThan(4)
    expect(receiptPages.every(call => call.sql.includes("LIMIT 64") && call.sql.includes('event."sequence" > $4::bigint'))).toBe(true)
    expect(callPages.every(call => call.sql.includes("LIMIT 64") && call.sql.includes('event."id" > $5::text'))).toBe(true)
    expect(Math.max(...f.calls.map(call => call.rows))).toBeLessThanOrEqual(64)
  })

  it("fails closed on a malformed receipt after the first history pages", async () => {
    const f = longHistoryFixture(270, 269)
    let count = 0
    await expect(async () => {
      for await (const _entry of readSteeringReconciliationHistory(f.client, scope, 1)) count++
    }).rejects.toThrow("steering_reconciliation_receipt_invalid")
    expect(count).toBe(256)
    expect(f.calls.filter(call => call.sql.includes('event."type" = $3')).length).toBeGreaterThan(4)
  })
})
