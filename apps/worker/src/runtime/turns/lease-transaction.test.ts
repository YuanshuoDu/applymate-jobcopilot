import { isDeepStrictEqual } from "node:util"
import { describe, expect, it, vi } from "vitest"

import { hasPersistedNoProgressTerminalReceipt, transaction, withOpenLease } from "./lease-transaction.js"
import type { LeasePool, TurnLease } from "./lease.js"

type LeaseClient = Parameters<typeof hasPersistedNoProgressTerminalReceipt>[0]

function fixture(sessionRows: unknown[] = [{ id: "session-1" }]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return { rows: sessionRows, rowCount: sessionRows.length }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as unknown as LeasePool, client, calls }
}

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-10-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-10-01T00:01:00.000Z"),
}

type ReceiptEvent = {
  id: string
  sessionId: string
  turnId: string
  taskId: string
  type: string
  actor: string
  correlationId: string
  itemId: string | null
  idempotencyKey: string
  payload: Record<string, unknown>
  causationId: string | null
  sequence: number
}

type ReceiptSnapshot = {
  turn: {
    id: string; sessionId: string; userId: string; leaseVersion: number
    status: string; error: string; finalResponse: Record<string, unknown> | null; completedAt: string | null
    leaseOwnerId: string | null; leaseExpiresAt: string | null; leaseStartedAt: string | null
  }
  root: {
    id: string; sessionId: string; turnId: string; rootTaskId: string
    status: string; failureReason: string; leaseOwner: string | null; leaseExpiresAt: string | null
    completedAt: string | null; attemptCount: number
    result: { status: string; stepCount: number | string; toolCallCount: number | string; finalItemId: string; waitId: string | null }
  }
  step: {
    id: string; sessionId: string; turnId: string; taskId: string; attempt: number; status: string
    errorCode: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number; ordinal: number
  }
  finalItem: {
    id: string; sessionId: string; turnId: string; taskId: string; stepId: string; type: string
    status: string; phase: string; revision: number; content: { text: string; final: Record<string, unknown> }
  }
  events: {
    stepStarted: ReceiptEvent; stepFailed: ReceiptEvent; noProgress: ReceiptEvent
    finalStarted: ReceiptEvent; finalCompleted: ReceiptEvent; turnFailed: ReceiptEvent
  }
}

const finalResponse = {
  schemaVersion: "agent-harness.v2.final",
  terminalReason: "no_progress",
  completed: false,
  response: "No progress was made.",
}

const exactNoProgressReceipt: ReceiptSnapshot = {
  turn: {
    id: "turn-1", sessionId: "session-1", userId: "user-1", leaseVersion: 2,
    status: "failed", error: "no_progress", finalResponse, completedAt: "2026-10-01T00:00:05.000Z",
    leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null,
  },
  root: {
    id: "task-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1",
    status: "failed", failureReason: "no_progress", leaseOwner: null, leaseExpiresAt: null,
    completedAt: "2026-10-01T00:00:05.000Z", attemptCount: 1,
    result: { status: "failed", stepCount: 1, toolCallCount: 0, finalItemId: "item-1", waitId: null },
  },
  step: {
    id: "step-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1", attempt: 1,
    status: "failed", errorCode: "no_progress", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, ordinal: 2,
  },
  finalItem: {
    id: "item-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1", stepId: "step-1",
    type: "agent_message", status: "completed", phase: "final_answer", revision: 1,
    content: { text: "No progress was made.", final: finalResponse },
  },
  events: {
    stepStarted: {
      id: "event-step-started", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "step.started", actor: "orchestrator", correlationId: "step-1", itemId: null,
      idempotencyKey: "turn:turn-1:event:step-started:step-1",
      payload: { stepId: "step-1", ordinal: 2, taskId: "task-1" }, causationId: null, sequence: 10,
    },
    stepFailed: {
      id: "event-step-failed", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "step.completed", actor: "orchestrator", correlationId: "step-1", itemId: null,
      idempotencyKey: "turn:turn-1:event:step-failed:step-1",
      payload: { stepId: "step-1", status: "failed", errorCode: "no_progress", taskId: "task-1" },
      causationId: "event-step-started", sequence: 11,
    },
    noProgress: {
      id: "event-no-progress", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "turn.no_progress", actor: "orchestrator", correlationId: "turn-1", itemId: null,
      idempotencyKey: "turn:turn-1:event:turn-no-progress",
      payload: {
        reasonCode: "repeated_signature", signature: "task_graph_terminal_denial",
        stateFingerprint: "task_graph_terminal_denial", taskId: "task-1",
      },
      causationId: "event-step-failed", sequence: 12,
    },
    finalStarted: {
      id: "event-final-started", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "item.started", actor: "orchestrator", correlationId: "step-1", itemId: "item-1",
      idempotencyKey: "turn:turn-1:event:item-started:item-1",
      payload: { itemId: "item-1", type: "agent_message", phase: "final_answer" },
      causationId: "event-no-progress", sequence: 13,
    },
    finalCompleted: {
      id: "event-final-completed", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "item.completed", actor: "orchestrator", correlationId: "item-1", itemId: "item-1",
      idempotencyKey: "turn:turn-1:event:final-completed:item-1:1",
      payload: { itemId: "item-1", status: "completed", content: { text: "No progress was made.", final: finalResponse } },
      causationId: "event-final-started", sequence: 14,
    },
    turnFailed: {
      id: "event-turn-failed", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      type: "turn.failed", actor: "orchestrator", correlationId: "turn-1", itemId: "item-1",
      idempotencyKey: "turn:turn-1:event:turn-failed:no_progress",
      payload: { turnId: "turn-1", taskId: "task-1", errorCode: "no_progress", finalItemId: "item-1", final: finalResponse },
      causationId: "event-final-completed", sequence: 15,
    },
  },
}

// Keep this list aligned with the SQL contract: removing any scope, terminal,
// receipt-content, causal-link, or ordering predicate must fail the test.
const requiredReceiptPredicates = [
  `SELECT turn."id"`,
  `root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"`,
  `root."turnId" = turn."id" AND root."rootTaskId" = root."id"`,
  `step."sessionId" = turn."sessionId" AND step."turnId" = turn."id" AND step."taskId" = root."id"`,
  `step."attempt" = 1 AND step."status" = 'failed' AND step."errorCode" = 'no_progress'`,
  `step."inputTokens" = 0 AND step."outputTokens" = 0 AND step."estimatedCostUsd" = 0`,
  `step_start."sessionId" = turn."sessionId" AND step_start."turnId" = turn."id"`,
  `step_start."taskId" = root."id" AND step_start."type" = 'step.started' AND step_start."actor" = 'orchestrator'`,
  `step_start."correlationId" = step."id" AND step_start."itemId" IS NULL`,
  `step_start."idempotencyKey" = 'turn:' || turn."id" || ':event:step-started:' || step."id"`,
  `step_start."payload" = jsonb_build_object('stepId', step."id", 'ordinal', step."ordinal", 'taskId', root."id")`,
  `step_failed."sessionId" = turn."sessionId" AND step_failed."turnId" = turn."id"`,
  `step_failed."taskId" = root."id" AND step_failed."type" = 'step.completed' AND step_failed."actor" = 'orchestrator'`,
  `step_failed."correlationId" = step."id" AND step_failed."itemId" IS NULL`,
  `step_failed."idempotencyKey" = 'turn:' || turn."id" || ':event:step-failed:' || step."id"`,
  `step_failed."payload" = jsonb_build_object('stepId', step."id", 'status', 'failed', 'errorCode', 'no_progress', 'taskId', root."id")`,
  `step_failed."causationId" = step_start."id"`,
  `no_progress."sessionId" = turn."sessionId" AND no_progress."turnId" = turn."id"`,
  `no_progress."taskId" = root."id" AND no_progress."type" = 'turn.no_progress' AND no_progress."actor" = 'orchestrator'`,
  `no_progress."correlationId" = turn."id" AND no_progress."itemId" IS NULL`,
  `no_progress."idempotencyKey" = 'turn:' || turn."id" || ':event:turn-no-progress'`,
  `'reasonCode', 'repeated_signature', 'signature', 'task_graph_terminal_denial'`,
  `'stateFingerprint', 'task_graph_terminal_denial', 'taskId', root."id"`,
  `no_progress."payload" = jsonb_build_object(`,
  `no_progress."causationId" = step_failed."id"`,
  `final_item."sessionId" = turn."sessionId" AND final_item."turnId" = turn."id"`,
  `final_item."taskId" = root."id" AND final_item."stepId" = step."id" AND final_item."type" = 'agent_message'`,
  `final_item."status" = 'completed' AND final_item."phase" = 'final_answer' AND final_item."revision" = 1`,
  `final_started."sessionId" = turn."sessionId" AND final_started."turnId" = turn."id"`,
  `final_started."taskId" = root."id" AND final_started."type" = 'item.started' AND final_started."actor" = 'orchestrator'`,
  `final_started."itemId" = final_item."id" AND final_started."correlationId" = step."id"`,
  `final_started."idempotencyKey" = 'turn:' || turn."id" || ':event:item-started:' || final_item."id"`,
  `'itemId', final_item."id", 'type', 'agent_message', 'phase', 'final_answer'`,
  `final_started."payload" = jsonb_build_object(`,
  `final_started."causationId" = no_progress."id"`,
  `final_completed."sessionId" = turn."sessionId" AND final_completed."turnId" = turn."id"`,
  `final_completed."taskId" = root."id" AND final_completed."type" = 'item.completed' AND final_completed."actor" = 'orchestrator'`,
  `final_completed."itemId" = final_item."id" AND final_completed."correlationId" = final_item."id"`,
  `final_completed."idempotencyKey" = 'turn:' || turn."id" || ':event:final-completed:' || final_item."id" || ':1'`,
  `'itemId', final_item."id", 'status', 'completed', 'content', final_item."content"`,
  `final_completed."payload" = jsonb_build_object(`,
  `final_completed."causationId" = final_started."id"`,
  `turn_failed."sessionId" = turn."sessionId" AND turn_failed."turnId" = turn."id"`,
  `turn_failed."taskId" = root."id" AND turn_failed."type" = 'turn.failed' AND turn_failed."actor" = 'orchestrator'`,
  `turn_failed."itemId" = final_item."id" AND turn_failed."correlationId" = turn."id"`,
  `turn_failed."idempotencyKey" = 'turn:' || turn."id" || ':event:turn-failed:no_progress'`,
  `turn_failed."causationId" = final_completed."id"`,
  `'turnId', turn."id", 'taskId', root."id", 'errorCode', 'no_progress'`,
  `'finalItemId', final_item."id", 'final', turn_failed."payload"->'final'`,
  `turn_failed."payload" = jsonb_build_object(`,
  `turn_failed."payload"->'final'->>'schemaVersion' = 'agent-harness.v2.final'`,
  `turn_failed."payload"->'final'->>'terminalReason' = 'no_progress'`,
  `turn_failed."payload"->'final'->'completed' = 'false'::jsonb`,
  `WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."leaseVersion" = $4`,
  `turn."status" = 'failed' AND turn."error" = 'no_progress' AND turn."finalResponse" IS NOT NULL AND turn."completedAt" IS NOT NULL`,
  `turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL AND turn."leaseStartedAt" IS NULL`,
  `root."status" = 'failed' AND root."failureReason" = 'no_progress' AND root."leaseOwner" IS NULL`,
  `root."leaseExpiresAt" IS NULL AND root."completedAt" IS NOT NULL AND root."attemptCount" = 1`,
  `jsonb_typeof(root."result") = 'object' AND jsonb_typeof(root."result"->'stepCount') = 'number'`,
  `jsonb_typeof(root."result"->'toolCallCount') = 'number' AND root."result"->'waitId' = 'null'::jsonb`,
  `root."result" = jsonb_build_object('status', 'failed', 'stepCount', root."result"->'stepCount'`,
  `'toolCallCount', root."result"->'toolCallCount', 'finalItemId', final_item."id", 'waitId', 'null'::jsonb`,
  `final_item."content" = jsonb_build_object('text', turn_failed."payload"->'final'->'response', 'final', turn_failed."payload"->'final')`,
  `turn_failed."payload"->'final' = turn."finalResponse"::jsonb`,
  `step_start."sequence" < step_failed."sequence" AND step_failed."sequence" < no_progress."sequence"`,
  `no_progress."sequence" < final_started."sequence" AND final_started."sequence" < final_completed."sequence"`,
  `final_completed."sequence" < turn_failed."sequence"`,
] as const

function noProgressReceiptClient(receipt: ReceiptSnapshot, selectedTurnId = receipt.turn.id) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      const hasFullSqlContract = requiredReceiptPredicates.every(predicate => sql.includes(predicate))
      return hasFullSqlContract && isDeepStrictEqual(receipt, exactNoProgressReceipt)
        ? { rows: [{ id: selectedTurnId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }),
  }
  return { client, calls }
}

type ReceiptMismatch = readonly [string, (receipt: ReceiptSnapshot) => void]

const receiptMismatches: ReceiptMismatch[] = [
  ["turn id", receipt => { receipt.turn.id = "turn-other" }],
  ["turn session", receipt => { receipt.turn.sessionId = "session-other" }],
  ["turn user", receipt => { receipt.turn.userId = "user-other" }],
  ["turn lease version", receipt => { receipt.turn.leaseVersion++ }],
  ["root id", receipt => { receipt.root.id = "task-other" }],
  ["root session", receipt => { receipt.root.sessionId = "session-other" }],
  ["root turn identity", receipt => { receipt.root.turnId = "turn-other" }],
  ["root task identity", receipt => { receipt.root.rootTaskId = "task-other" }],
  ["step id", receipt => { receipt.step.id = "step-other" }],
  ["step session", receipt => { receipt.step.sessionId = "session-other" }],
  ["step turn", receipt => { receipt.step.turnId = "turn-other" }],
  ["step task", receipt => { receipt.step.taskId = "task-other" }],
  ["step ordinal", receipt => { receipt.step.ordinal++ }],
  ["step attempt", receipt => { receipt.step.attempt++ }],
  ["step terminal status", receipt => { receipt.step.status = "completed" }],
  ["step failure code", receipt => { receipt.step.errorCode = "timeout" }],
  ["step token or cost usage", receipt => { receipt.step.outputTokens = 1 }],
  ["turn terminal status", receipt => { receipt.turn.status = "completed" }],
  ["turn failure code", receipt => { receipt.turn.error = "other_error" }],
  ["turn final response", receipt => { receipt.turn.finalResponse = null }],
  ["turn completed timestamp", receipt => { receipt.turn.completedAt = null }],
  ["turn lease owner cleanup", receipt => { receipt.turn.leaseOwnerId = "worker-1" }],
  ["turn lease expiry cleanup", receipt => { receipt.turn.leaseExpiresAt = "2026-10-01T00:01:00.000Z" }],
  ["turn lease start cleanup", receipt => { receipt.turn.leaseStartedAt = "2026-10-01T00:00:00.000Z" }],
  ["root terminal status", receipt => { receipt.root.status = "completed" }],
  ["root failure code", receipt => { receipt.root.failureReason = "other_error" }],
  ["root lease owner cleanup", receipt => { receipt.root.leaseOwner = "worker-1" }],
  ["root lease expiry cleanup", receipt => { receipt.root.leaseExpiresAt = "2026-10-01T00:01:00.000Z" }],
  ["root completed timestamp", receipt => { receipt.root.completedAt = null }],
  ["root attempt count", receipt => { receipt.root.attemptCount++ }],
  ["root result status", receipt => { receipt.root.result.status = "completed" }],
  ["root result step count type", receipt => { receipt.root.result.stepCount = "1" }],
  ["root result tool count type", receipt => { receipt.root.result.toolCallCount = "0" }],
  ["root result final item id", receipt => { receipt.root.result.finalItemId = "item-other" }],
  ["root result wait id", receipt => { receipt.root.result.waitId = "wait-1" }],
  ["step-start identity", receipt => { receipt.events.stepStarted.correlationId = "step-other" }],
  ["step-start item scope", receipt => { receipt.events.stepStarted.itemId = "item-other" }],
  ["step-start idempotency key", receipt => { receipt.events.stepStarted.idempotencyKey = "key-other" }],
  ["step-start payload", receipt => { receipt.events.stepStarted.payload.ordinal = 3 }],
  ["step-failed event identity", receipt => { receipt.events.stepFailed.type = "turn.failed" }],
  ["step-failed idempotency key", receipt => { receipt.events.stepFailed.idempotencyKey = "key-other" }],
  ["step-failed payload", receipt => { receipt.events.stepFailed.payload.errorCode = "timeout" }],
  ["step-failed causation", receipt => { receipt.events.stepFailed.causationId = "event-other" }],
  ["no-progress event identity", receipt => { receipt.events.noProgress.correlationId = "turn-other" }],
  ["no-progress idempotency key", receipt => { receipt.events.noProgress.idempotencyKey = "key-other" }],
  ["no-progress payload", receipt => { receipt.events.noProgress.payload.signature = "other" }],
  ["no-progress causation", receipt => { receipt.events.noProgress.causationId = "event-other" }],
  ["final item session", receipt => { receipt.finalItem.sessionId = "session-other" }],
  ["final item turn", receipt => { receipt.finalItem.turnId = "turn-other" }],
  ["final item task", receipt => { receipt.finalItem.taskId = "task-other" }],
  ["final item step", receipt => { receipt.finalItem.stepId = "step-other" }],
  ["final item type", receipt => { receipt.finalItem.type = "tool_call" }],
  ["final item status", receipt => { receipt.finalItem.status = "failed" }],
  ["final item phase", receipt => { receipt.finalItem.phase = "analysis" }],
  ["final item revision", receipt => { receipt.finalItem.revision++ }],
  ["final-start event identity", receipt => { receipt.events.finalStarted.itemId = "item-other" }],
  ["final-start idempotency key", receipt => { receipt.events.finalStarted.idempotencyKey = "key-other" }],
  ["final-start payload", receipt => { receipt.events.finalStarted.payload.phase = "analysis" }],
  ["final-start causation", receipt => { receipt.events.finalStarted.causationId = "event-other" }],
  ["final-completed event identity", receipt => { receipt.events.finalCompleted.correlationId = "item-other" }],
  ["final-completed idempotency key", receipt => { receipt.events.finalCompleted.idempotencyKey = "key-other" }],
  ["final-completed payload", receipt => { receipt.events.finalCompleted.payload.status = "failed" }],
  ["final-completed causation", receipt => { receipt.events.finalCompleted.causationId = "event-other" }],
  ["turn-failed event identity", receipt => { receipt.events.turnFailed.taskId = "task-other" }],
  ["turn-failed idempotency key", receipt => { receipt.events.turnFailed.idempotencyKey = "key-other" }],
  ["turn-failed payload", receipt => { receipt.events.turnFailed.payload.errorCode = "timeout" }],
  ["turn-failed causation", receipt => { receipt.events.turnFailed.causationId = "event-other" }],
  ["final schema version", receipt => { receipt.turn.finalResponse!.schemaVersion = "agent-harness.v1.final" }],
  ["final terminal reason", receipt => { receipt.turn.finalResponse!.terminalReason = "completed" }],
  ["final completed flag", receipt => { receipt.turn.finalResponse!.completed = true }],
  ["final response content", receipt => { receipt.finalItem.content.text = "Different response" }],
  ["final payload equals turn response", receipt => { receipt.events.turnFailed.payload.final = { ...finalResponse, response: "Different response" } }],
  ["step start precedes step failure", receipt => { receipt.events.stepStarted.sequence = receipt.events.stepFailed.sequence }],
  ["step failure precedes no-progress", receipt => { receipt.events.stepFailed.sequence = receipt.events.noProgress.sequence }],
  ["no-progress precedes final start", receipt => { receipt.events.noProgress.sequence = receipt.events.finalStarted.sequence }],
  ["final start precedes final completion", receipt => { receipt.events.finalStarted.sequence = receipt.events.finalCompleted.sequence }],
  ["final completion precedes turn failure", receipt => { receipt.events.finalCompleted.sequence = receipt.events.turnFailed.sequence }],
]

describe("Turn lease transaction helpers", () => {
  it("sets the tenant scope and commits successful work", async () => {
    const fake = fixture()
    await expect(transaction(fake.pool, "user-1", async () => "saved")).resolves.toBe("saved")
    expect(fake.calls.map(call => call.sql)).toEqual(["BEGIN", "SELECT set_config('app.user_id', $1, true)", "COMMIT"])
    expect(fake.calls[1]?.values).toEqual(["user-1"])
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("rolls back failed work and releases the client", async () => {
    const fake = fixture()
    const failure = new Error("write failed")
    await expect(transaction(fake.pool, "user-1", async () => { throw failure })).rejects.toBe(failure)
    expect(fake.calls.map(call => call.sql)).toEqual(["BEGIN", "SELECT set_config('app.user_id', $1, true)", "ROLLBACK"])
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("runs open-lease work after locking the session and returns fallback when fenced", async () => {
    const fake = fixture()
    await expect(withOpenLease(fake.pool, lease, false, async () => true)).resolves.toBe(true)
    expect(fake.calls.find(call => call.sql.includes('SELECT session."id"'))?.sql).toContain("FOR UPDATE")
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")

    const closed = fixture([])
    await expect(withOpenLease(closed.pool, lease, false, async () => true)).resolves.toBe(false)
    expect(closed.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(closed.client.release).toHaveBeenCalledOnce()
  })

  it("requires the complete persisted no-progress receipt and exact lease identity", async () => {
    const fake = noProgressReceiptClient(exactNoProgressReceipt)

    await expect(hasPersistedNoProgressTerminalReceipt(fake.client as unknown as LeaseClient, lease)).resolves.toBe(true)

    const query = fake.calls[0]
    expect(query?.values).toEqual([lease.turnId, lease.sessionId, lease.userId, lease.leaseVersion])
    for (const predicate of requiredReceiptPredicates) expect(query?.sql).toContain(predicate)
  })

  it("rejects a receipt row whose selected turn id differs from the active lease", async () => {
    const fake = noProgressReceiptClient(exactNoProgressReceipt, "turn-other")
    await expect(hasPersistedNoProgressTerminalReceipt(fake.client as unknown as LeaseClient, lease)).resolves.toBe(false)
  })

  it.each(receiptMismatches)("rejects a receipt with mismatched %s", async (_name, mutate) => {
    const receipt = structuredClone(exactNoProgressReceipt)
    mutate(receipt)
    const fake = noProgressReceiptClient(receipt)

    await expect(hasPersistedNoProgressTerminalReceipt(fake.client as unknown as LeaseClient, lease)).resolves.toBe(false)
  })
})
