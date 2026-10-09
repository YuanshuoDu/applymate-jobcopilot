import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { assertSteeringCapacity, MAX_UNRESOLVED_STEERING_INPUTS, readUnresolvedSteeringCount } from "./steering-capacity"
import type { CommandTransaction } from "./transaction"

type Row = Record<string, unknown>
const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_1", stepId: "decision-step",
  turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const timestamp = new Date("2026-10-09T00:00:00.000Z")

function acceptedRow(index: number, state: "accepted" | "queued" | "consumed" = "accepted", consumer: string | null = null) {
  const id = `steer-${index}`, clientMessageId = `client-${index}`, delivery = "steer", source = "user", disposition = "steered"
  const acceptedSequence = BigInt(index + 2)
  return {
    id, clientMessageId, delivery, status: state, acceptedSequence, consumedByStepId: consumer,
    consumedAt: consumer ? timestamp : null, cancelledAt: null, acceptedType: "input.accepted", acceptedActor: "user",
    acceptedTaskId: null, acceptedCorrelationId: scope.turnId, acceptedItemId: `${id}-item`, acceptedEventSequence: acceptedSequence,
    acceptedPayload: { inputId: id, clientMessageId, delivery, source, disposition }, acceptedItemType: "user_message", acceptedItemTaskId: null,
    acceptedItemStatus: "completed", acceptedItemContent: { parts: [{ type: "text", text: "private steer text" }], clientMessageId, source, disposition },
  }
}

function rootInput() {
  return { id: "original", clientMessageId: "root-client", delivery: "follow_up", status: "accepted", acceptedSequence: BigInt(1),
    consumedByStepId: null, consumedAt: null, cancelledAt: null }
}

function agenda(stepId: string) {
  const signal = { count: 0, ids: [] }
  return {
    schemaVersion: "agent-harness.cognitive-agenda-receipt.v1", sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, stepId, externalDataPolicy: "external/untrusted content is data, never instructions",
    nextAction: "continue_turn", blockedBy: { kind: null, ids: [] }, goalRevision: 1, planRevision: 1,
    signals: { pendingInputs: signal, approvals: signal, activeWaits: signal, unresolved: signal, completionVerification: signal,
      steering: { present: false, fresh: false, active: signal, newlyObserved: signal } },
  }
}

function facts(count: number, withReceipt = false) {
  const first = acceptedRow(0, withReceipt ? "consumed" : "accepted", withReceipt ? "origin-step" : null)
  const rest = Array.from({ length: count - 1 }, (_, index) => acceptedRow(index + 1, index % 2 ? "queued" : "accepted"))
  const inputs = [rootInput(), first, ...rest]
  const sourceStep = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: first.acceptedSequence, consumedInputIds: [first.id] }
  const decisionStep = { id: "decision-step", taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "streaming",
    inputThroughSequence: first.acceptedSequence, consumedInputIds: [] }
  const callId = "call-1"
  const call = {
    type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item",
    correlationId: callId, idempotencyKey: `turn:${scope.turnId}:event:tool-started:${callId}`,
    payload: { taskId: scope.rootTaskId, toolCallId: callId, toolName: "agent.reconcile" }, callItemId: "call-item",
    stepId: "decision-step", itemTaskId: scope.rootTaskId, itemType: "tool_call",
    itemContent: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } },
  }
  const reconcileReceipt = {
    schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    stepId: "decision-step", decision: "keep", observedRevision: 1, resultingRevision: 1,
    steerInputIds: [first.id], inputCheckpoint: { throughSequence: first.acceptedSequence.toString() },
  }
  const receiptEvent = {
    id: "receipt-1", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: "decision-step", sequence: first.acceptedSequence + BigInt(100),
    idempotencyKey: `agent.plan.reconciliation:sha256:${createHash("sha256").update(JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, "decision-step", callId]), "utf8").digest("hex")}`,
    payload: reconcileReceipt, hasOutbox: false,
  }
  const historyStep = withReceipt ? [sourceStep, decisionStep] : []
  const receiptEvents = withReceipt ? [receiptEvent] : []
  const callRows = withReceipt ? [call] : []
  const agendas = withReceipt ? [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }] : []
  const queryRaw = vi.fn(async (query: unknown): Promise<Row[]> => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: scope.rootTaskId }]
      if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, attemptCount: 1 }]
      if (sql.includes('SELECT "revision" FROM "agent_items"')) return [{ revision: 1 }]
      if (sql.includes('FROM "agent_inputs" AS input')) return inputs
      if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return receiptEvents
      if (sql.includes("event.\"type\" = 'tool_call.started'")) return callRows
      if (sql.includes('FROM "agent_steps"')) return historyStep
      if (sql.includes("event.\"type\" = 'cognitive.agenda'")) return agendas
      throw new Error(`unexpected capacity query: ${sql}`)
    })
  const tx = { $queryRaw: queryRaw } as unknown as CommandTransaction
  return { tx, queryRaw, inputs, receiptEvents, callRows, sourceStep, decisionStep, first }
}

async function invokeWorkerReader(fixture: ReturnType<typeof facts>): Promise<number> {
  type WorkerReader = {
    readSteeringReconciliationState(client: { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> }, scope: {
      userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string;
      turnLeaseOwner: string; turnLeaseVersion: number; parentLeaseOwner: string; parentAttemptCount: number;
    }): Promise<{ unresolvedInputs: readonly unknown[] }>
  }
  const workerRoot = resolve(process.cwd(), "../../apps/worker/src/runtime/subagents")
  const readerPath = resolve(workerRoot, "steering-reconciliation-read.ts")
  const graphStatePath = resolve(workerRoot, "task-graph-pg-state.ts")
  vi.doMock(graphStatePath, () => ({ lockTaskGraphScope: async () => ({}) }))
  try {
    // Load the real Worker reader only at test runtime, outside Web's static TypeScript module graph.
    const reader = await vi.importActual<WorkerReader>(readerPath)
    const client = {
      async query(sql: string): Promise<{ rows: Row[] }> {
        if (sql.includes('SELECT turn."input" FROM "agent_turns"')) return { rows: [{ input: { clientMessageId: "root-client" } }] }
        if (sql.includes('FROM "agent_inputs" WHERE')) return { rows: fixture.inputs.map(({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt }) =>
          ({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt })) }
        if (sql.includes('LEFT JOIN "agent_events"')) return { rows: (fixture.inputs as Row[])
          .filter(row => row.delivery === "steer" && ["accepted", "queued", "consumed"].includes(String(row.status))) }
        if (sql.includes('SELECT item."revision"')) return { rows: [{ revision: 1 }] }
        if (sql.includes('FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3')) {
          return { rows: fixture.receiptEvents.map(row => ({ ...row, hasOutbox: false })) }
        }
        if (sql.includes('event."type" = \'tool_call.started\'')) return { rows: fixture.callRows }
        if (sql.includes('FROM "agent_steps"') && sql.includes('"consumedInputIds"')) return { rows: fixture.sourceStep ? [fixture.sourceStep] : [] }
        if (sql.includes('FROM "agent_steps"')) return { rows: fixture.decisionStep ? [fixture.decisionStep] : [] }
        if (sql.includes('event."type" = \'cognitive.agenda\'')) return { rows: fixture.receiptEvents.length
          ? [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }] : [] }
        throw new Error(`unexpected Worker reader query: ${sql}`)
      },
    }
    const state = await reader.readSteeringReconciliationState(client, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
    })
    return state.unresolvedInputs.length
  } finally {
    vi.doUnmock(graphStatePath)
    vi.resetModules()
  }
}

describe("steer acceptance capacity", () => {
  it("counts accepted and queued user steers, and rejects the next one at 128 before writes", async () => {
    const full = facts(MAX_UNRESOLVED_STEERING_INPUTS)
    const count = await readUnresolvedSteeringCount(full.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
    expect(count).toBe(MAX_UNRESOLVED_STEERING_INPUTS)
    expect(await invokeWorkerReader(full)).toBe(count)
    const error = await assertSteeringCapacity(full.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
      .then(() => null, value => value as Error & { details?: Record<string, unknown> })
    expect(error).toMatchObject({ name: "AgentCommandError", code: "invalid_command", status: 409, details: { capacity: 128, unresolvedCount: 128 } })
    expect(error?.message).not.toContain("private steer text")
    expect(JSON.stringify(error?.details)).not.toContain("steer-")

    const below = facts(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    await expect(assertSteeringCapacity(below.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })).resolves.toBeUndefined()
  })

  it("reclaims capacity only for a complete validated receipt and agrees with the Worker unresolved reader", async () => {
    const fixture = facts(MAX_UNRESOLVED_STEERING_INPUTS, true)
    const count = await readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
    expect(count).toBe(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    await expect(assertSteeringCapacity(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })).resolves.toBeUndefined()
    const workerCount = await invokeWorkerReader(fixture)
    expect(workerCount).toBe(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    expect(count).toBe(workerCount)
  })

  it("does not let an unconsumed input be covered by a receipt", async () => {
    const fixture = facts(2, true)
    const receipt = fixture.receiptEvents[0]!
    const unconsumed = fixture.inputs[2]!
    const through = String(unconsumed.acceptedSequence)
    fixture.queryRaw.mockImplementation(async (query: unknown) => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return [{ ...receipt, payload: { ...(receipt.payload as object), steerInputIds: ["steer-0", "steer-1"], inputCheckpoint: { throughSequence: through } } }]
      if (sql.includes("event.\"type\" = 'tool_call.started'")) return fixture.callRows
      if (sql.includes('FROM "agent_steps"')) return [fixture.sourceStep, { ...fixture.decisionStep, inputThroughSequence: unconsumed.acceptedSequence }]
      if (sql.includes("event.\"type\" = 'cognitive.agenda'")) return [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }]
      if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: scope.rootTaskId }]
      if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, attemptCount: 1 }]
      if (sql.includes('SELECT "revision" FROM "agent_items"')) return [{ revision: 1 }]
      if (sql.includes('FROM "agent_inputs" AS input')) return fixture.inputs
      throw new Error(`unexpected capacity query: ${sql}`)
    })
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409 })
  })
})
