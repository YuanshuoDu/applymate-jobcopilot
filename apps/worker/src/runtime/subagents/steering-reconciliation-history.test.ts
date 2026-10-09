import { describe, expect, it, vi } from "vitest"
import { executeToolWithItems, TurnExecutionEventWriter } from "../turns/turn-execution-events.js"
import type { TurnExecutionOptions } from "../turns/turn-execution-types.js"
import { executionKey } from "../turns/turn-execution-types.js"
import type pg from "pg"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_SCHEMA_VERSION, validSteeringReconciliationToolCall } from "./steering-reconciliation-contract.js"
import { assertSteeringReconciliationCall, readSteeringReconciliationHistory, type SteeringReconciliationHistoryEntry } from "./steering-reconciliation-history.js"

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
  agenda?: Record<string, unknown>; noReceipt?: boolean }> = {}) {
  const receipt = { ...baseReceipt, ...(change.event?.payload && typeof change.event.payload === "object" ? { ...baseReceipt, ...(change.event.payload as Record<string, unknown>) } : {}) }
  const receiptKey = steeringReconciliationIdempotencyKey({ ...scope, stepId: decisionStepId }, callId)
  const storedEvent = { id: "receipt-event", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: decisionStepId, sequence: "30", idempotencyKey: receiptKey, payload: receipt, hasOutbox: false, ...change.event }
  const toolName = "agent.reconcile"
  const toolEvent = { eventId: "tool-event", eventSequence: "20", type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item", correlationId: callId,
    idempotencyKey: toolStartKey(callId), payload: { toolCallId: callId, toolName, taskId: scope.rootTaskId }, callItemId: "call-item", stepId: decisionStepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName, toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } }, ...change.tool }
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
  return { client, calls, storedEvent }
}
async function historyEntries(client: Pick<pg.PoolClient, "query">): Promise<SteeringReconciliationHistoryEntry[]> {
  const history: SteeringReconciliationHistoryEntry[] = []
  for await (const entry of readSteeringReconciliationHistory(client, scope, 1)) history.push(entry)
  return history
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
