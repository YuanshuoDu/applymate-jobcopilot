import { describe, expect, it, vi } from "vitest"
import { executionKey } from "../turns/turn-execution-types.js"
import type pg from "pg"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { prepareSteeringReconciliation, writeSteeringReconciliationReceipt } from "./steering-reconciliation-ledger.js"

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
function clientFixture(options: { pending?: boolean; unconsumed?: boolean; decision?: "keep" | "revise" } = {}) {
  const original = input("original-input", "1", "consumed", "origin-step")
  original.clientMessageId = "root-client-message"
  const steer = input("steer-1", "10", options.unconsumed ? "accepted" : "consumed", options.unconsumed ? null : "origin-step")
  const originStep = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed", inputThroughSequence: "10", consumedInputIds: ["original-input", "steer-1"] }
  const decisionStep = { id: scope.stepId, taskId: scope.rootTaskId, ordinal: 2, attempt: 1, status: "streaming", inputThroughSequence: "20", consumedInputIds: [] }
  let graphRevision = 1
  let nextSequence = 20
  const events: Array<Record<string, unknown>> = []
  const toolName = options.decision === "revise" ? "agent.plan" : "agent.reconcile"
  const executionIdentity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  const toolCall = { type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item",
    correlationId: "call-1", idempotencyKey: `${executionKey(executionIdentity)}:event:tool-started:call-1`,
    payload: { toolCallId: "call-1", toolName, taskId: scope.rootTaskId }, callItemId: "call-item", stepId: scope.stepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: "call-1", toolName,
      toolVersion: "1", input: options.decision === "revise" ? { expectedRevision: 1, nodes: [{ key: "next" }] } : { decision: "keep", expectedRevision: 1 } } }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT session."id"') && sql.includes("pause_request")) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FOR UPDATE') && sql.includes('FROM "agent_sessions"')) return { rows: [{ id: scope.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: scope.turnId }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: [{ id: scope.rootTaskId }], rowCount: 1 }
    if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
    if (sql.includes('SELECT turn."input"')) return { rows: [{ input: { goal: "Find jobs", clientMessageId: "root-client-message" } }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('ORDER BY "acceptedSequence", "id"')) return { rows: [original, ...(options.pending === false ? [] : [steer])], rowCount: options.pending === false ? 1 : 2 }
    if (sql.includes('FROM "agent_inputs" AS input')) return { rows: options.pending === false ? [] : [accepted(steer)], rowCount: options.pending === false ? 0 : 1 }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ANY($4::text[])')) {
      const rows = (values?.[3] as string[] | undefined)?.includes(scope.stepId) ? [decisionStep] : [originStep]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps"') && values?.[0] === scope.stepId) return { rows: [decisionStep], rowCount: 1 }
    if (sql.includes("tool_call.started")) return { rows: [toolCall], rowCount: 1 }
    if (sql.includes("cognitive.agenda")) return { rows: [{ actor: "subagent", itemId: null, taskId: scope.rootTaskId, correlationId: scope.stepId, payload: agenda() }], rowCount: 1 }
    if (sql.includes('event."idempotencyKey" = $2')) {
      const found = events.filter(event => event.idempotencyKey === values?.[1])
      return { rows: found.map(event => ({ ...event, hasOutbox: false })), rowCount: found.length }
    }
    if (sql.includes('event."type" = $3') && values?.[2] === "agent.plan.reconciliation") return { rows: events.map(event => ({ ...event, hasOutbox: false })), rowCount: events.length }
    if (sql.includes('FROM "agent_items"')) return { rows: [{ revision: graphRevision }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: String(++nextSequence) }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      const row = { itemId: values?.[3] ?? null, taskId: values?.[4] ?? null, type: values?.[6], actor: values?.[7], correlationId: scope.turnId,
        causationId: values?.[8] ?? null, idempotencyKey: values?.[9], payload: JSON.parse(String(values?.[10])), sequence: values?.[5] }
      events.push(row)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, events, setGraphRevision(value: number) { graphRevision = value } }
}
function operation(decision: "keep" | "revise" = "keep") {
  return { scope, decision, expectedRevision: 1, callId: "call-1", rootInputId: null }
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
    expect(fixture.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    await writeSteeringReconciliationReceipt(fixture.client, prepared, 2)
    expect(fixture.events).toHaveLength(1)
  })

  it("returns no synthetic decision when there is no pending steering", async () => {
    const fixture = clientFixture({ pending: false })
    await expect(prepareSteeringReconciliation(fixture.client, operation())).resolves.toBeNull()
    expect(fixture.events).toHaveLength(0)
  })
})
