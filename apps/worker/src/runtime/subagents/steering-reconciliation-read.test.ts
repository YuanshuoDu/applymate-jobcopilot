import { describe, expect, it, vi } from "vitest"
import { executionKey } from "../turns/turn-execution-types.js"
import type pg from "pg"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_SCHEMA_VERSION } from "./steering-reconciliation-contract.js"
import { assertNoUnresolvedSteering, readSteeringReconciliationState } from "./steering-reconciliation-read.js"

const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "decision-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1 }
const date = new Date("2026-10-01T00:00:00.000Z")
const agendaContext: StepContext = { schemaVersion: "agent-harness.v2", sessionId: scope.sessionId, turnId: scope.turnId, stepId: scope.stepId,
  inputThroughSequence: 20n, consumedInputIds: [], canonicalJson: "{}", blocks: [] }
function agendaPayload(stepId = scope.stepId) {
  const receipt = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId,
    agenda: { ...buildCognitiveActionAgenda({ ...agendaContext, stepId }), planRevision: 1 } })
  if (!receipt) throw new Error("agenda fixture should be valid")
  return receipt
}
function input(id: string, delivery: string, status: string, sequence: string, consumedByStepId: string | null) {
  return { id, clientMessageId: `${id}-message`, delivery, status, acceptedSequence: sequence, consumedByStepId,
    consumedAt: consumedByStepId ? date : null, cancelledAt: null }
}
function accepted(row: ReturnType<typeof input>, patch: Record<string, unknown> = {}) {
  return { ...row, acceptedType: "input.accepted", acceptedActor: "user", acceptedTaskId: null, acceptedCorrelationId: scope.turnId,
    acceptedItemId: `${row.id}-item`, acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemContent: { parts: [{ type: "text", text: "steer" }], clientMessageId: row.clientMessageId, source: "user", disposition: "steered" },
    acceptedEventSequence: row.acceptedSequence,
    acceptedPayload: { inputId: row.id, clientMessageId: row.clientMessageId, delivery: row.delivery, source: "user", disposition: "steered" }, ...patch }
}
function fixture(options: { steerStatus?: string; steerConsumer?: string | null; source?: string; actor?: string; checkpointIds?: string[];
  cursor?: string; rootHint?: string | null; badItem?: boolean; badCorrelation?: boolean; laterDecision?: boolean; freshSteer?: boolean;
  goalOnlyWithoutOriginal?: boolean } = {}) {
  const currentScope = options.laterDecision ? { ...scope, stepId: "later-step" } : scope
  const root = input("original-input", "steer", "consumed", "1", "origin-step")
  root.clientMessageId = "root-client-message"
  const steer = input("steer-1", "steer", options.steerStatus ?? "consumed", "10", options.steerConsumer === undefined ? "origin-step" : options.steerConsumer)
  const event = accepted(steer, { acceptedActor: options.actor ?? "user", acceptedCorrelationId: options.badCorrelation ? "other-turn" : scope.turnId,
    acceptedItemContent: options.badItem ? { parts: [], clientMessageId: "other-message", source: "user", disposition: "steered" }
      : { parts: [{ type: "text", text: "steer" }], clientMessageId: steer.clientMessageId, source: options.source ?? "user", disposition: "steered" },
    acceptedPayload: { inputId: steer.id, clientMessageId: steer.clientMessageId, delivery: "steer", source: options.source ?? "user", disposition: "steered" } })
  const originalEvent = accepted(root)
  const freshSteer = input("steer-2", "steer", "consumed", "15", "origin-step")
  const freshEvent = accepted(freshSteer)
  const sourceStep = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: options.cursor ?? (options.freshSteer ? "15" : "10"), consumedInputIds: options.checkpointIds ?? ["original-input", "steer-1", ...(options.freshSteer ? ["steer-2"] : [])] }
  const decisionStep = { id: currentScope.stepId, taskId: scope.rootTaskId, ordinal: options.laterDecision ? 3 : 2, attempt: 1, status: "streaming",
    inputThroughSequence: "20", consumedInputIds: options.laterDecision ? [] : ["new-step-only"] }
  const historicStep = { id: "decision-step", taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed", inputThroughSequence: "10" }
  const historicScope = { ...scope, stepId: historicStep.id }
  const historicCallId = "historic-reconcile-call"
  const historicKey = steeringReconciliationIdempotencyKey(historicScope, historicCallId)
  const historicStartKey = `${executionKey({ kind: "turn", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) })}:event:tool-started:${historicCallId}`
  const historicReceipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, stepId: historicStep.id, decision: "keep", observedRevision: 1, resultingRevision: 1,
    steerInputIds: ["steer-1"], inputCheckpoint: { throughSequence: "10" } }
  const historicEvent = { id: "historic-receipt", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: historicStep.id, sequence: "30", idempotencyKey: historicKey, payload: historicReceipt, hasOutbox: false }
  const historicCall = { eventId: "historic-tool-event", eventSequence: "20", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "historic-call-item",
    correlationId: historicCallId, idempotencyKey: historicStartKey, payload: { toolCallId: historicCallId, toolName: "agent.reconcile", taskId: scope.rootTaskId },
    callItemId: "historic-call-item", stepId: historicStep.id, itemTaskId: scope.rootTaskId, itemType: "tool_call",
    itemContent: { toolCallId: historicCallId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } } }
  const historicContext: StepContext = { ...agendaContext, stepId: historicStep.id, inputThroughSequence: 10n, consumedInputIds: ["steer-1"] }
  const historicAgenda = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    stepId: historicStep.id, agenda: { ...buildCognitiveActionAgenda(historicContext), planRevision: 1 } })
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT session."id"') && sql.includes("pause_request")) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes("FOR UPDATE") && sql.includes('FROM "agent_sessions"')) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: scope.turnId }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: scope.rootTaskId }], rowCount: 1 }
    if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: options.goalOnlyWithoutOriginal ? { goal: "Find jobs" } : { goal: "Find jobs", clientMessageId: "root-client-message" } }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('"clientMessageId" = $4')) {
      const inputs = options.goalOnlyWithoutOriginal ? [] : [root]
      return { rows: inputs, rowCount: inputs.length }
    }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) {
      const inputs = options.goalOnlyWithoutOriginal ? [steer] : [root, steer]
      const page = [...inputs, ...(options.freshSteer ? [freshSteer] : [])]
        .filter(row => values?.[3] == null || BigInt(row.acceptedSequence) > BigInt(String(values[3]))
          || BigInt(row.acceptedSequence) === BigInt(String(values[3])) && row.id > String(values?.[4]))
      return { rows: page.slice(0, 64), rowCount: Math.min(page.length, 64) }
    }
    if (sql.includes('FROM "agent_inputs" AS input')) {
      const events = options.goalOnlyWithoutOriginal ? [event] : [originalEvent, event]
      const acceptedIds = values?.[3] as string[]
      const rows = [...events, ...(options.freshSteer ? [freshEvent] : [])].filter(row => acceptedIds.includes(row.id))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ANY($4::text[])')) {
      if (!sql.includes('"consumedInputIds"') && (values?.[3] as string[] | undefined)?.includes(historicStep.id)) return { rows: [historicStep], rowCount: 1 }
      return { rows: [sourceStep], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_steps"') && values?.[0] === currentScope.stepId) return { rows: [decisionStep], rowCount: 1 }
    if (sql.includes("tool_call.started")) return values?.[4] == null ? { rows: [historicCall], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes("cognitive.agenda")) {
      if (sql.includes("ANY($4::text[])")) return { rows: [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: historicStep.id, payload: historicAgenda }], rowCount: 1 }
      return { rows: [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: currentScope.stepId, payload: agendaPayload(currentScope.stepId) }], rowCount: 1 }
    }
    if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") {
      const rows = options.laterDecision && values?.[3] == null ? [historicEvent] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_items"')) return { rows: [{ revision: 1 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, rootHint: options.rootHint }
}
function longReadFixture(count: number, malformedIndex = -1) {
  const root = input("original-input", "steer", "accepted", "1", null)
  root.clientMessageId = "root-client-message"
  const steers = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, "0"), sequence = String(index * 4 + 2)
    return input(`steer-${suffix}`, "steer", "consumed", sequence, `consumer-step-${suffix}`)
  })
  const acceptedRows = steers.map(row => accepted(row))
  const consumers = steers.map((row, index) => ({ id: row.consumedByStepId!, taskId: scope.rootTaskId, ordinal: index, attempt: 1,
    status: "completed", inputThroughSequence: row.acceptedSequence, consumedInputIds: [row.id] }))
  const decisionSteps = steers.map((row, index) => ({ id: `decision-step-${String(index).padStart(4, "0")}`, taskId: scope.rootTaskId,
    ordinal: index + 1, attempt: 1, status: "completed", inputThroughSequence: row.acceptedSequence }))
  const receiptEvents: Array<Record<string, unknown>> = [], toolEvents: Array<Record<string, unknown>> = [], historicAgendas: Array<Record<string, unknown>> = []
  const executionIdentity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(4, "0"), stepId = decisionSteps[index]!.id, callId = `history-call-${suffix}`, steer = steers[index]!
    const receipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, stepId, decision: "keep", observedRevision: 1, resultingRevision: 1,
      steerInputIds: [steer.id], inputCheckpoint: { throughSequence: steer.acceptedSequence } }
    const receiptKey = steeringReconciliationIdempotencyKey({ ...scope, stepId }, callId)
    receiptEvents.push({ id: `receipt-event-${suffix}`, itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation",
      actor: index === malformedIndex ? "user" : "orchestrator", correlationId: scope.turnId, causationId: stepId,
      sequence: String(index * 4 + 5), idempotencyKey: receiptKey, payload: receipt, hasOutbox: false })
    toolEvents.push({ eventId: `tool-event-${suffix}`, eventSequence: String(index * 4 + 4), type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
      eventItemId: `call-item-${suffix}`, correlationId: callId, idempotencyKey: `${executionKey(executionIdentity)}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "agent.reconcile", taskId: scope.rootTaskId }, callItemId: `call-item-${suffix}`, stepId,
      itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } } })
    const context: StepContext = { ...agendaContext, stepId, inputThroughSequence: BigInt(steer.acceptedSequence), consumedInputIds: [steer.id] }
    const payload = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
      stepId, agenda: { ...buildCognitiveActionAgenda(context), planRevision: 1 } })
    if (!payload) throw new Error("agenda fixture should be valid")
    historicAgendas.push({ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: stepId, payload })
  }
  const currentStep = { id: scope.stepId, taskId: scope.rootTaskId, ordinal: count + 1, attempt: 1, status: "streaming",
    inputThroughSequence: String(count * 4 + 10), consumedInputIds: [] }
  const currentAgenda = agendaPayload(scope.stepId)
  const calls: Array<{ sql: string; values?: unknown[]; rows: number }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    let rows: Array<Record<string, unknown>> = []
    if (sql.startsWith('SELECT session."id"') && sql.includes("pause_request")) rows = [{ id: scope.sessionId }]
    else if (sql.includes('FOR UPDATE') && sql.includes('FROM "agent_sessions"')) rows = [{ id: scope.sessionId }]
    else if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) rows = [{ id: scope.turnId }]
    else if (sql.includes('FROM "sub_agent_tasks" AS task')) rows = [{ id: scope.rootTaskId }]
    else if (sql.includes("WITH wall_clock")) rows = [{ turnLeaseValid: true, parentLeaseValid: true }]
    else if (sql.includes('SELECT turn."input"')) rows = [{ input: { goal: "Find jobs", clientMessageId: "root-client-message" } }]
    else if (sql.includes('FROM "agent_inputs"') && sql.includes('"clientMessageId" = $4')) rows = [root]
    else if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) {
      const after = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      rows = [root, ...steers].filter(row => after === null || BigInt(row.acceptedSequence) > after
        || BigInt(row.acceptedSequence) === after && row.id > afterId).slice(0, 64)
    } else if (sql.includes('FROM "agent_inputs" AS input')) {
      const acceptedIds = values?.[3] as string[]
      rows = acceptedRows.filter(row => acceptedIds.includes(String(row.id)))
    } else if (sql.includes('FROM "agent_steps"') && sql.includes("ANY($4::text[])")) {
      const stepIds = values?.[3] as string[]
      rows = sql.includes('"consumedInputIds"') ? consumers.filter(row => stepIds.includes(row.id)) : decisionSteps.filter(row => stepIds.includes(row.id))
    } else if (sql.includes('FROM "agent_steps"') && values?.[0] === scope.stepId) rows = [currentStep]
    else if (sql.includes("tool_call.started")) {
      const stepIds = values?.[3] as string[], afterId = String(values?.[4] ?? "")
      rows = toolEvents.filter(row => stepIds.includes(String(row.stepId)) && String(row.eventId) > afterId).slice(0, 64)
    } else if (sql.includes("cognitive.agenda") && sql.includes("ANY($4::text[])")) {
      const stepIds = values?.[3] as string[]
      rows = historicAgendas.filter(row => stepIds.includes(String(row.correlationId)))
    } else if (sql.includes("cognitive.agenda")) rows = [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: scope.stepId, payload: currentAgenda }]
    else if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") {
      const after = values[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      rows = receiptEvents.filter(row => after === null || BigInt(String(row.sequence)) > after
        || BigInt(String(row.sequence)) === after && String(row.id) > afterId).slice(0, 64)
    } else if (sql.includes('FROM "agent_items"')) rows = [{ revision: 1 }]
    calls.push({ sql, values, rows: rows.length })
    return { rows, rowCount: rows.length }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls }
}

function capacityReadFixture(pendingCount: number, consumedCount = 0) {
  const consumed = Array.from({ length: consumedCount }, (_, index) => {
    const suffix = String(index).padStart(4, "0"), sequence = String(index + 2)
    return input(`steer-${suffix}`, "steer", "consumed", sequence, "origin-step")
  })
  const checkpoint = consumed.at(-1)?.acceptedSequence ?? "0"
  const afterCheckpoint = consumedCount ? BigInt(checkpoint) + 4n : 2n
  const pending = Array.from({ length: pendingCount }, (_, index) => {
    const suffix = String(consumedCount + index).padStart(4, "0")
    const sequence = String(afterCheckpoint + BigInt(index))
    return input(`steer-${suffix}`, "steer", index % 2 === 0 ? "accepted" : "queued", sequence, null)
  })
  const allInputs = [...consumed, ...pending]
  const acceptedRows = allInputs.map(row => accepted(row))
  const consumer = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: checkpoint, consumedInputIds: consumed.map(row => row.id) }
  const historyStep = { id: scope.stepId, taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed", inputThroughSequence: checkpoint }
  const currentScope = consumedCount ? { ...scope, stepId: "later-step" } : scope
  const decisionCursor = allInputs.at(-1)?.acceptedSequence ?? checkpoint
  const currentStep = { id: currentScope.stepId, taskId: scope.rootTaskId, ordinal: consumedCount ? 2 : 1, attempt: 1, status: "streaming",
    inputThroughSequence: decisionCursor, consumedInputIds: [] }
  const context: StepContext = { ...agendaContext, stepId: currentScope.stepId, inputThroughSequence: BigInt(decisionCursor), consumedInputIds: [] }
  const currentAgenda = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    stepId: currentScope.stepId, agenda: { ...buildCognitiveActionAgenda(context), planRevision: 1 } })
  if (!currentAgenda) throw new Error("capacity agenda fixture should be valid")

  const executionIdentity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  const callId = "capacity-reconcile-call"
  const receipt = { schemaVersion: STEERING_RECONCILIATION_SCHEMA_VERSION, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, stepId: scope.stepId, decision: "keep", observedRevision: 1, resultingRevision: 1,
    steerInputIds: consumed.map(row => row.id).sort(), inputCheckpoint: { throughSequence: checkpoint } }
  const historyContext: StepContext = { ...agendaContext, stepId: scope.stepId, inputThroughSequence: BigInt(checkpoint), consumedInputIds: consumed.map(row => row.id) }
  const historyAgendaPayload = consumedCount ? buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    stepId: scope.stepId, agenda: { ...buildCognitiveActionAgenda(historyContext), planRevision: 1 } }) : null
  if (consumedCount && !historyAgendaPayload) throw new Error("history agenda fixture should be valid")
  const receiptEvent = consumedCount ? { id: "capacity-receipt-event", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation",
    actor: "orchestrator", correlationId: scope.turnId, causationId: scope.stepId, sequence: String(BigInt(checkpoint) + 3n),
    idempotencyKey: steeringReconciliationIdempotencyKey(scope, callId), payload: receipt, hasOutbox: false } : null
  const toolEvent = consumedCount ? { eventId: "capacity-tool-event", eventSequence: String(BigInt(checkpoint) + 2n), type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId,
    eventItemId: "capacity-call-item", correlationId: callId, idempotencyKey: `${executionKey(executionIdentity)}:event:tool-started:${callId}`,
    payload: { toolCallId: callId, toolName: "agent.reconcile", taskId: scope.rootTaskId }, callItemId: "capacity-call-item", stepId: scope.stepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1",
      input: { decision: "keep", expectedRevision: 1 } } } : null
  const historicalAgenda = consumedCount ? { actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: scope.stepId,
    sequence: String(BigInt(checkpoint) + 1n), payload: historyAgendaPayload } : null
  const calls: Array<{ sql: string; values?: unknown[]; rows: number }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    let rows: Array<Record<string, unknown>> = []
    if (sql.startsWith('SELECT session."id"') && sql.includes("pause_request")) rows = [{ id: scope.sessionId }]
    else if (sql.includes('FOR UPDATE') && sql.includes('FROM "agent_sessions"')) rows = [{ id: scope.sessionId }]
    else if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) rows = [{ id: scope.turnId }]
    else if (sql.includes('FROM "sub_agent_tasks" AS task')) rows = [{ id: scope.rootTaskId }]
    else if (sql.includes("WITH wall_clock")) rows = [{ turnLeaseValid: true, parentLeaseValid: true }]
    else if (sql.includes('SELECT turn."input"')) rows = [{ input: { goal: "Find jobs" } }]
    else if (sql.includes('FROM "agent_inputs"') && sql.includes('"clientMessageId" = $4')) rows = []
    else if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) {
      const after = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      rows = allInputs.filter(row => after === null || BigInt(row.acceptedSequence) > after
        || BigInt(row.acceptedSequence) === after && row.id > afterId).slice(0, 64)
    } else if (sql.includes('FROM "agent_inputs" AS input')) {
      const inputIds = values?.[3] as string[]
      rows = acceptedRows.filter(row => inputIds.includes(String(row.id)))
    } else if (sql.includes('FROM "agent_steps"') && sql.includes("ANY($4::text[])")) {
      const stepIds = values?.[3] as string[]
      if (sql.includes('"consumedInputIds"')) rows = consumedCount && stepIds.includes(consumer.id) ? [consumer] : []
      else rows = consumedCount && stepIds.includes(historyStep.id) ? [historyStep] : []
    } else if (sql.includes('FROM "agent_steps"') && values?.[0] === currentScope.stepId) rows = [currentStep]
    else if (sql.includes("tool_call.started")) rows = toolEvent && values?.[3] && (values[3] as string[]).includes(scope.stepId)
      && (values[4] == null || toolEvent.eventId > String(values[4])) ? [toolEvent] : []
    else if (sql.includes("cognitive.agenda") && sql.includes("ANY($4::text[])")) rows = historicalAgenda ? [historicalAgenda] : []
    else if (sql.includes("cognitive.agenda")) rows = [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: currentScope.stepId,
      sequence: String(BigInt(decisionCursor) + 1n), payload: currentAgenda }]
    else if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") {
      const after = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
      rows = receiptEvent && (after === null || BigInt(String(receiptEvent.sequence)) > after
        || BigInt(String(receiptEvent.sequence)) === after && String(receiptEvent.id) > afterId) ? [receiptEvent] : []
    }
    else if (sql.includes('FROM "agent_items"')) rows = [{ revision: 1 }]
    calls.push({ sql, values, rows: rows.length })
    return { rows, rowCount: rows.length }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, scope: currentScope }
}

describe("durable steering reconciliation reader", () => {
  it("excludes the Turn-bound original regardless of delivery and validates historical consumption", async () => {
    const f = fixture({ rootHint: null })
    const state = await readSteeringReconciliationState(f.client, { ...scope, rootInputId: f.rootHint })
    expect(state.originalInputId).toBe("original-input")
    expect(state.unresolvedInputs).toEqual([{ id: "steer-1", acceptedSequence: 10n, status: "consumed", consumedByStepId: "origin-step", consumingOrdinal: 0 }])
    expect(state.decisionInputThroughSequence).toBe(20n)
    expect(state.agendaPlanRevision).toBe(1)
    expect(f.calls.some(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("keeps the first steer pending when a goal-only Turn has no original input and the caller hint points at that steer", async () => {
    const pending = fixture({ goalOnlyWithoutOriginal: true, rootHint: "steer-1", steerStatus: "accepted", steerConsumer: null })
    const unboundScope = { ...scope, rootInputId: pending.rootHint }
    const state = await readSteeringReconciliationState(pending.client, unboundScope)
    expect(state.originalInputId).toBeNull()
    expect(state.unresolvedInputs).toEqual([{ id: "steer-1", acceptedSequence: 10n, status: "accepted", consumedByStepId: null, consumingOrdinal: null }])
    await expect(assertNoUnresolvedSteering(pending.client, unboundScope)).rejects.toThrow("steering_reconciliation_pending")
  })

  it("does not treat queued follow-ups or correctly attributed non-user steering as obligations", async () => {
    const f = fixture({ source: "automation", actor: "system" })
    const state = await readSteeringReconciliationState(f.client, scope)
    expect(state.unresolvedInputs).toEqual([])
  })

  it("fails closed for actor/source mismatch and forged original identity hints", async () => {
    const mismatch = fixture({ source: "user", actor: "system" })
    await expect(readSteeringReconciliationState(mismatch.client, scope)).rejects.toThrow("steering_reconciliation_acceptance_invalid")
    const wrongItem = fixture({ badItem: true })
    await expect(readSteeringReconciliationState(wrongItem.client, scope)).rejects.toThrow("steering_reconciliation_acceptance_invalid")
    const wrongCorrelation = fixture({ badCorrelation: true })
    await expect(readSteeringReconciliationState(wrongCorrelation.client, scope)).rejects.toThrow("steering_reconciliation_acceptance_invalid")
    const wrongHint = fixture({ rootHint: "steer-1" })
    await expect(readSteeringReconciliationState(wrongHint.client, { ...scope, rootInputId: wrongHint.rootHint })).rejects.toThrow("steering_reconciliation_original_input_mismatch")
  })

  it("requires the actual consuming Root Step checkpoint and rejects unconsumed steers at the gate", async () => {
    const missing = fixture({ checkpointIds: ["original-input"] })
    await expect(readSteeringReconciliationState(missing.client, scope)).rejects.toThrow("steering_reconciliation_consumption_invalid")
    const pending = fixture({ steerStatus: "accepted", steerConsumer: null })
    const state = await readSteeringReconciliationState(pending.client, scope)
    expect(state.unresolvedInputs[0]?.status).toBe("accepted")
    await expect(assertNoUnresolvedSteering(pending.client, scope)).rejects.toThrow("steering_reconciliation_pending")
  })

  it("replays an earlier keep after restart while a newly accepted steer remains pending on an empty later-Step checkpoint", async () => {
    const f = fixture({ laterDecision: true, freshSteer: true })
    const laterScope = { ...scope, stepId: "later-step" }
    const state = await readSteeringReconciliationState(f.client, laterScope)
    expect(state.unresolvedInputs).toEqual([{ id: "steer-2", acceptedSequence: 15n, status: "consumed", consumedByStepId: "origin-step", consumingOrdinal: 0 }])
    await expect(assertNoUnresolvedSteering(f.client, laterScope)).rejects.toThrow("steering_reconciliation_pending")
  })

  it("streams more than 256 valid accepted steers and receipts while retaining only current unresolved inputs", async () => {
    const f = longReadFixture(270)
    const state = await readSteeringReconciliationState(f.client, scope)
    const inputPages = f.calls.filter(call => call.sql.includes('FROM "agent_inputs"') && call.sql.includes('ORDER BY "acceptedSequence", "id"'))
    const receiptPages = f.calls.filter(call => call.sql.includes('event."type" = $3') && call.values?.[2] === "agent.plan.reconciliation")
    expect(state.unresolvedInputs).toEqual([])
    expect(state).not.toHaveProperty("resolvedInputIds")
    expect(inputPages.length).toBeGreaterThan(4)
    expect(inputPages.every(call => call.sql.includes("LIMIT 64") && call.sql.includes('"acceptedSequence" > $4::bigint'))).toBe(true)
    expect(receiptPages.length).toBeGreaterThan(4)
    expect(receiptPages.every(call => call.sql.includes("LIMIT 64") && call.sql.includes('event."sequence" > $4::bigint'))).toBe(true)
    expect(Math.max(...f.calls.map(call => call.rows))).toBeLessThanOrEqual(64)
  })

  it("returns exactly 128 accepted or queued steers when none has a consumer", async () => {
    const f = capacityReadFixture(128)
    const state = await readSteeringReconciliationState(f.client, scope)
    expect(state.unresolvedInputs).toHaveLength(128)
    expect(state.unresolvedInputs.every(row => row.consumedByStepId === null && ["accepted", "queued"].includes(row.status))).toBe(true)
  })

  it("fails closed on the 129th unresolved accepted or queued steer", async () => {
    const f = capacityReadFixture(129)
    await expect(readSteeringReconciliationState(f.client, scope)).rejects.toThrow("steering_reconciliation_unresolved_overflow")
  })

  it("reclaims capacity after one provenance-valid receipt covers 128 consumed steers", async () => {
    const f = capacityReadFixture(128, 128)
    const state = await readSteeringReconciliationState(f.client, f.scope)
    expect(state.unresolvedInputs).toHaveLength(128)
    expect(state.unresolvedInputs.map(row => row.id)).toEqual(Array.from({ length: 128 }, (_, index) => `steer-${String(index + 128).padStart(4, "0")}`))
    expect(state.unresolvedInputs.every(row => ["accepted", "queued"].includes(row.status) && row.consumedByStepId === null)).toBe(true)
  })

  it("fails closed when a malformed receipt appears after earlier history pages", async () => {
    const f = longReadFixture(270, 269)
    await expect(readSteeringReconciliationState(f.client, scope)).rejects.toThrow("steering_reconciliation_receipt_invalid")
    expect(f.calls.filter(call => call.sql.includes('event."type" = $3')).length).toBeGreaterThan(4)
  })
})
