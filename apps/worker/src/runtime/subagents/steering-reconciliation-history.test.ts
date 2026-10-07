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
import { readSteeringReconciliationHistory } from "./steering-reconciliation-history.js"

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
function agenda() {
  const payload = buildCognitiveAgendaReceipt({ sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId: decisionStepId,
    agenda: { ...buildCognitiveActionAgenda(context), planRevision: 1 } })
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
  const toolEvent = { type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item", correlationId: callId,
    idempotencyKey: toolStartKey(callId), payload: { toolCallId: callId, toolName, taskId: scope.rootTaskId }, callItemId: "call-item", stepId: decisionStepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName, toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } }, ...change.tool }
  const step = { id: decisionStepId, taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed", inputThroughSequence: "10", ...change.step }
  const agendaRow = { actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: decisionStepId, payload: agenda(), ...change.agenda }
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('event."type" = $3')) return { rows: change.noReceipt ? [] : [storedEvent], rowCount: change.noReceipt ? 0 : 1 }
    if (sql.includes("tool_call.started")) return { rows: [toolEvent], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [step], rowCount: 1 }
    if (sql.includes("cognitive.agenda")) return { rows: [agendaRow], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, storedEvent }
}

describe("durable steering reconciliation history", () => {
  it("validates an earlier Step's private keep against its actual tool call and agenda", async () => {
    const f = fixture()
    const history = await readSteeringReconciliationHistory(f.client, scope, 1)
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
    ["wrong tool name", { tool: { payload: { toolCallId: callId, toolName: "agent.wait", taskId: scope.rootTaskId } } }],
    ["hash without a matching call", { tool: { idempotencyKey: `agent.plan.reconciliation:sha256:${"0".repeat(64)}` } }],
    ["foreign Turn writer key", { tool: { idempotencyKey: toolStartKey(callId).replace(scope.turnId, "other-turn") } }],
    ["different call writer key", { tool: { idempotencyKey: toolStartKey("different-call") } }],
    ["agenda revision mismatch", { agenda: { payload: { ...agenda(), planRevision: 2 } } }],
    ["step cursor mismatch", { step: { inputThroughSequence: "9" } }],
    ["stale resulting revision", { event: { payload: { ...baseReceipt, resultingRevision: 2 } } }],
  ] as const)("rejects %s history instead of clearing an obligation", async (_name, change) => {
    await expect(readSteeringReconciliationHistory(fixture(change).client, scope, 1)).rejects.toThrow()
  })

  it("does not query or invent a decision when no receipt exists", async () => {
    const f = fixture({ noReceipt: true })
    await expect(readSteeringReconciliationHistory(f.client, scope, 1)).resolves.toEqual([])
    expect(f.calls.some(sql => sql.includes("tool_call.started"))).toBe(false)
  })
})
