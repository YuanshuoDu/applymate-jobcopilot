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
  cursor?: string; rootHint?: string | null; badItem?: boolean; badCorrelation?: boolean; laterDecision?: boolean; freshSteer?: boolean } = {}) {
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
  const historicCall = { type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "historic-call-item",
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
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: { goal: "Find jobs", clientMessageId: "root-client-message" } }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) return { rows: [root, steer, ...(options.freshSteer ? [freshSteer] : [])], rowCount: options.freshSteer ? 3 : 2 }
    if (sql.includes('FROM "agent_inputs" AS input')) return { rows: [originalEvent, event, ...(options.freshSteer ? [freshEvent] : [])], rowCount: options.freshSteer ? 3 : 2 }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ANY($4::text[])')) {
      if (!sql.includes('"consumedInputIds"') && (values?.[3] as string[] | undefined)?.includes(historicStep.id)) return { rows: [historicStep], rowCount: 1 }
      return { rows: [sourceStep], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_steps"') && values?.[0] === currentScope.stepId) return { rows: [decisionStep], rowCount: 1 }
    if (sql.includes("tool_call.started")) return { rows: [historicCall], rowCount: 1 }
    if (sql.includes("cognitive.agenda")) {
      if (sql.includes("ANY($4::text[])")) return { rows: [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: historicStep.id, payload: historicAgenda }], rowCount: 1 }
      return { rows: [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: currentScope.stepId, payload: agendaPayload(currentScope.stepId) }], rowCount: 1 }
    }
    if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") return { rows: options.laterDecision ? [historicEvent] : [], rowCount: options.laterDecision ? 1 : 0 }
    if (sql.includes('FROM "agent_items"')) return { rows: [{ revision: 1 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, rootHint: options.rootHint }
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
    expect(state.resolvedInputIds).toEqual(["steer-1"])
    expect(state.unresolvedInputs).toEqual([{ id: "steer-2", acceptedSequence: 15n, status: "consumed", consumedByStepId: "origin-step", consumingOrdinal: 0 }])
    await expect(assertNoUnresolvedSteering(f.client, laterScope)).rejects.toThrow("steering_reconciliation_pending")
  })
})
