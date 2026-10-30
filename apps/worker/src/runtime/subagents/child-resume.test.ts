import { describe, expect, it, vi } from "vitest"

import { loadChildAttemptResume } from "./child-resume.js"
import { childWaitClaimEventKey } from "./child-durable-wait-replay.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>

const future = new Date("2099-09-14T12:00:00.000Z")
const WAIT_ID = "00000000-0000-4000-8000-000000000001"

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
    role: "scout", taskType: "research", status: "running", goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: future,
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal, ...overrides,
  }
}

function currentRow(child: SubagentLease): Row {
  return { id: child.id, userId: child.userId, sessionId: child.sessionId, turnId: child.turnId, rootTaskId: child.rootTaskId,
    status: "running", leaseOwner: child.ownerId, attemptCount: child.attemptCount, leaseExpiresAt: future, interruptRequestedAt: null,
    turnStatus: "in_progress", rootStatus: "running" }
}

function step(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "step-1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: "4", consumedInputIds: ["input-1"], inputTokens: 10, outputTokens: 5, estimatedCostUsd: "0.25", ...overrides }
}

function item(child: SubagentLease, overrides: Row = {}): Row {
  return { id: "item-call", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, stepId: "step-1", type: "tool_call", status: "completed",
    content: { toolCallId: "call-1", toolName: "jobs.search", input: { query: "Dublin" } }, attempt: 1, ordinal: 0, ...overrides }
}

function consumedWait(child: SubagentLease, targetId = "grandchild-1", note?: string): Row {
  const output = { waitId: WAIT_ID, status: "ready", taskIds: [targetId], deadlineAt: "2099-09-14T11:30:00.000Z",
    matchedTaskIds: [targetId], tasks: [{ taskId: targetId, status: "completed", role: "scout", result: { jobs: [], ...(note ? { note } : {}) }, failureReason: null }] }
  const input = { idempotencyKey: "wait-key", taskIds: [targetId], mode: "all", timeoutMs: 5_000 }
  return { waitId: WAIT_ID, stepId: `task:${child.id}:step:0:attempt:${child.attemptCount}`, targetTaskIds: [targetId], idempotencyKey: "wait-key", mode: "all", status: "ready",
    deadlineAt: output.deadlineAt, matchedTaskIds: [targetId], waitResult: { request: { targetTaskIds: [targetId], mode: "all", timeoutMs: 5_000 }, outcome: output }, attempt: child.attemptCount,
    ordinal: 0, continuationStepId: `task:${child.id}:step:1:attempt:${child.attemptCount}`, continuationOrdinal: 1, continuationLatestOrdinal: 1,
    callContent: { toolCallId: "wait-call", toolName: "wait_subagents", toolVersion: "1", input }, callStatus: "completed",
    resultContent: { toolCallId: "wait-call", output: { ...output, status: "waiting", matchedTaskIds: [] }, errorCode: null }, resultStatus: "completed",
    sourceItemId: "wait-result-id", consumedAt: future, suspendedAt: future }
}

function reissuedWaitCall(child: SubagentLease, wait: Row, callId: string, claimed: boolean) {
  const stepId = String(wait.continuationStepId), input = (wait.callContent as Row).input
  const id = `task:${child.id}:item:tool-call:${callId}:attempt:${child.attemptCount}`
  const itemRow = { id, sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, rootTaskId: child.rootTaskId, stepId,
    type: "tool_call", status: "started", content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input },
    attempt: child.attemptCount, ordinal: wait.continuationOrdinal }
  const callRow = { id, status: "started", revision: 0, content: itemRow.content, stepId,
    attempt: child.attemptCount, ordinal: wait.continuationOrdinal }
  const started = { id: `event-${callId}-item-started`, sequence: "4", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "item.started", itemId: id, correlationId: stepId, causationId: `model-usage:${stepId}`,
    idempotencyKey: `task:${child.id}:event:item-started:${id}`, payload: { itemId: id, type: "tool_call", phase: null } }
  const claim = { id: `event-${callId}-claim`, sequence: "5", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "tool_call.started", itemId: id, correlationId: callId, causationId: started.id,
    idempotencyKey: `task:${child.id}:event:${childWaitClaimEventKey(child.attemptCount, stepId)}`,
    payload: { toolCallId: callId, toolName: "wait_subagents", taskId: child.id } }
  return { itemRow, callRow, started, ...(claimed ? { claim } : {}) }
}

function modelUsageEvents(child: SubagentLease, stepId: string): Row[] {
  const startId = `model-started:${stepId}`, completeId = `model-completed:${stepId}`, usageId = `model-usage:${stepId}`
  return [
    { id: startId, sequence: "1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, itemId: null, actor: "subagent",
      type: "model.started", correlationId: stepId, causationId: null, idempotencyKey: `task:${child.id}:event:model-started:${stepId}`,
      payload: { taskId: child.id, provider: "fixture", model: "fixture-model" } },
    { id: completeId, sequence: "2", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, itemId: null, actor: "subagent",
      type: "model.completed", correlationId: stepId, causationId: startId, idempotencyKey: `task:${child.id}:event:model-completed:${stepId}`,
      payload: { taskId: child.id, provider: "fixture", model: "fixture-model", toolCallCount: 1 } },
    { id: usageId, sequence: "3", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, itemId: null, actor: "subagent",
      type: "model.usage", correlationId: stepId, causationId: completeId, idempotencyKey: `task:${child.id}:event:model-usage:${stepId}`,
      payload: { taskId: child.id, provider: "fixture", model: "fixture-model", usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 } } },
  ]
}

function sourceWaitEvidence(child: SubagentLease, wait: Row | undefined, items: Row[]): { items: Row[]; events: Row[] } {
  if (!wait) return { items, events: [] }
  const stepId = String(wait.stepId), call = wait.callContent as Row, callId = String(call.toolCallId)
  const attempt = Number(wait.attempt ?? child.attemptCount), isInitial = wait.callStatus === "started"
  const callItem = items.find(row => row.type === "tool_call" && (row.content as Row | undefined)?.toolCallId === callId)
  const callItemId = String(callItem?.id ?? "wait-call-item")
  const callContent = { ...call, toolVersion: "1", ...(isInitial ? {} : { status: "completed", errorCode: null }) }
  const sourceCall: Row = { ...item(child), ...callItem, id: callItemId, stepId, taskId: child.id, attempt, type: "tool_call", phase: null,
    status: isInitial ? "started" : "completed", revision: isInitial ? 0 : 1, content: callContent }
  const resultItems = items.filter(row => row.type === "tool_result" && (row.content as Row | undefined)?.toolCallId === callId)
  const sourceResultId = String(wait.sourceItemId ?? resultItems[0]?.id ?? "wait-result-id")
  const waitingResult = wait.resultContent as Row | null
  const sourceResult: Row = { ...item(child), ...resultItems[0], id: sourceResultId, stepId, taskId: child.id, attempt, type: "tool_result", phase: null,
    status: "completed", revision: 1, content: waitingResult }
  const nextItems = items.filter(row => !((row.content as Row | undefined)?.toolCallId === callId && ["tool_call", "tool_result"].includes(String(row.type))))
  nextItems.push(sourceCall)
  if (!isInitial) nextItems.push(sourceResult)
  const prior = modelUsageEvents(child, stepId).at(-1)!
  const itemStarted = { id: `source-${callId}-item-started`, sequence: "4", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "item.started", itemId: callItemId, correlationId: stepId, causationId: prior.id,
    idempotencyKey: `task:${child.id}:event:item-started:${callItemId}`, payload: { itemId: callItemId, type: "tool_call", phase: null } }
  const toolStarted = { id: `source-${callId}-tool-started`, sequence: "5", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "tool_call.started", itemId: callItemId, correlationId: callId, causationId: itemStarted.id,
    idempotencyKey: `task:${child.id}:event:tool-started:${callId}`, payload: { toolCallId: callId, toolName: "wait_subagents", taskId: child.id } }
  const events: Row[] = [...modelUsageEvents(child, stepId), itemStarted, toolStarted]
  if (isInitial) return { items: nextItems, events }
  const resultPayload = sourceResult.content as Row
  const callCompleted = { id: `source-${callId}-item-completed`, sequence: "6", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "item.completed", itemId: callItemId, correlationId: callItemId, causationId: toolStarted.id,
    idempotencyKey: `task:${child.id}:event:tool-call-completed:${callId}:${callItemId}:1`,
    payload: { itemId: callItemId, status: "completed", content: projectWaitCallEventContent(callContent) } }
  const toolCompleted = { id: `source-${callId}-tool-completed`, sequence: "7", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "tool_call.completed", itemId: callItemId, correlationId: callId, causationId: callCompleted.id,
    idempotencyKey: `task:${child.id}:event:tool-finished:${callId}`,
    payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: child.id } }
  const resultStarted = { id: `source-${callId}-result-started`, sequence: "8", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "item.started", itemId: sourceResultId, correlationId: stepId, causationId: toolCompleted.id,
    idempotencyKey: `task:${child.id}:event:item-started:${sourceResultId}`, payload: { itemId: sourceResultId, type: "tool_result", phase: null } }
  const resultCompleted = { id: `source-${callId}-result-completed`, sequence: "9", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id,
    actor: "subagent", type: "item.completed", itemId: sourceResultId, correlationId: sourceResultId, causationId: resultStarted.id,
    idempotencyKey: `task:${child.id}:event:tool-result-completed:${callId}:${sourceResultId}:1`,
    payload: { itemId: sourceResultId, status: "completed", content: resultPayload } }
  events.push(callCompleted, toolCompleted, resultStarted, resultCompleted)
  return { items: nextItems, events }
}

function fakePool(child: SubagentLease, steps: Row[], items: Row[] = [], consumedWait?: Row, targets: Row[] = [],
  waitCalls: Row[] = [], waitResults: Row[] = [], waitEvents: Row[] = []) {
  const source = sourceWaitEvidence(child, consumedWait, items)
  const persistedItems = source.items
  const persistedEvents = [...source.events, ...waitEvents]
  const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE task."id" = $1 AND task."sessionId"')) return { rows: [currentRow(child)], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions" AS wait')) return { rows: consumedWait ? [consumedWait] : [], rowCount: consumedWait ? 1 : 0 }
      if (sql.includes('WHERE task."id" = ANY($1::text[])')) return { rows: targets, rowCount: targets.length }
      if (sql.startsWith('SELECT "attempt" FROM "agent_steps" WHERE')) {
        const rows = steps.filter(row => row.id === values[0] && row.sessionId === values[1] && row.turnId === values[2] && row.taskId === values[3])
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT "id", "revision", "stepId", "taskId", "type", "phase", "content", "status" FROM "agent_items" WHERE')
        && sql.includes('"stepId" = $4') && sql.includes("'wait_subagents'")) {
        const rows = persistedItems.filter(row => row.stepId === values[3] && row.type === "tool_call" && (row.content as Row).toolName === "wait_subagents")
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT "id", "revision", "stepId", "taskId", "type", "phase", "content", "status" FROM "agent_items" WHERE')
        && sql.includes('"content"->>\'toolCallId\' = $4')) {
        const rows = persistedItems.filter(row => (row.content as Row).toolCallId === values[3])
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT "id", "itemId", "type", "actor", "correlationId", "causationId", "sequence",') && sql.includes('FROM "agent_events" WHERE')) {
        const keys = Array.isArray(values[6]) ? values[6] as string[] : []
        const rows = persistedEvents.filter(row => row.itemId === values[3] || row.correlationId === values[4]
          || row.itemId === values[5] || row.correlationId === values[5] || keys.includes(String(row.idempotencyKey)))
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT event."id", event."sequence" FROM "agent_events" AS event')) {
        const rows = persistedEvents.filter(row => row.id === values[3] && row.sessionId === values[0] && row.turnId === values[1] && row.taskId === values[2])
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_events" WHERE') && sql.includes('"causationId" = ANY')) {
        const causes = Array.isArray(values[3]) ? values[3] as string[] : []
        const rows = persistedEvents.filter(row => causes.includes(String(row.causationId))
          && row.sessionId === values[0] && row.turnId === values[1] && row.taskId === values[2])
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM "agent_events" AS event')) {
        const stepId = String(values[6] ?? ""), itemIds = Array.isArray(values[4]) ? values[4] as string[] : [], callIds = Array.isArray(values[5]) ? values[5] as string[] : []
        const visible = waitEvents.filter(row => row.correlationId === stepId || itemIds.includes(String(row.itemId))
          || itemIds.includes(String(row.correlationId)) || callIds.includes(String(row.correlationId)))
        return { rows: visible, rowCount: visible.length }
      }
      if (sql.includes('JOIN "agent_steps" AS step') && sql.includes("item.\"type\" = 'tool_call'")) return { rows: waitCalls, rowCount: waitCalls.length }
      if (sql.includes('item."content"->>\'toolName\' = \'wait_subagents\'')) return { rows: waitCalls, rowCount: waitCalls.length }
      if (sql.includes('item."type" = \'tool_result\'')) return { rows: waitResults, rowCount: waitResults.length }
      if (sql.includes('FROM "agent_steps"')) {
        const visible = sql.includes('WHERE step."id" = $1') ? steps.filter(row => String(row.id) === String(values[0]))
          : sql.includes('step."attempt" = $6') ? steps.filter(row => Number(row.attempt) === Number(values[5]))
          : sql.includes('step."attempt" < $6') ? steps.filter(row => Number(row.attempt) < Number(values[5])) : steps
        return { rows: visible, rowCount: visible.length }
      }
      if (sql.includes('FROM "agent_items"')) {
        const visible = sql.includes('step."attempt" <= $6')
          ? persistedItems.filter(row => Number(row.attempt) <= Number(values[5]))
          : persistedItems.filter(row => Number(row.attempt) < child.attemptCount)
        return { rows: visible, rowCount: visible.length }
      }
      throw new Error(`unexpected query: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool, client, calls }
}

describe("child attempt durable resume", () => {
  it("aggregates prior attempt cursors, usage, ordinals and trusted tool results", async () => {
    const child = lease()
    const db = fakePool(child, [
      step(child),
      step(child, { id: "step-2", ordinal: 1, inputThroughSequence: "7", consumedInputIds: ["input-1", "input-2"], inputTokens: 3, outputTokens: 2, estimatedCostUsd: "0.5" }),
    ], [
      item(child),
      item(child, { id: "item-call-2", stepId: "step-2", content: { toolCallId: "call-2", toolName: "jobs.get", input: { id: "job-1" } } }),
      item(child, { id: "item-result", type: "tool_result", content: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }),
    ])

    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored).toEqual({
      resume: { nextOrdinal: 2, stepCount: 2, toolCallCount: 2, inputThroughSequence: 7n, consumedInputIds: ["input-1", "input-2"], usage: { inputTokens: 13, outputTokens: 7, estimatedCostUsd: 0.75 } },
      observations: [{ id: "child-resume:item-result", content: { toolCallId: "call-1", toolName: "jobs.search", input: { query: "Dublin" }, status: "completed", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }],
    })
    expect(db.calls.find(call => call.sql.includes('step."attempt" < $6'))?.values).toEqual([child.id, child.sessionId, child.turnId, child.userId, child.rootTaskId, child.attemptCount])
    expect(db.calls.find(call => call.sql.includes('FROM "agent_items"'))?.sql).toContain('step."attempt" < $6')
    expect(db.client.query.mock.calls.map(([sql]) => sql)).toContain("SELECT set_config($1, $2, true)")
  })

  it("trusts the live database lease after heartbeat extends beyond the lease snapshot expiry", async () => {
    const now = new Date("2026-10-29T16:00:00.000Z")
    const staleLease = lease({ leaseExpiresAt: new Date("2026-10-29T15:59:00.000Z") })
    const db = fakePool(staleLease, [step(staleLease)])

    await expect(loadChildAttemptResume(db.pool as never, staleLease, now)).resolves.toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 1 },
    })
    expect(db.calls.find(call => call.sql.includes('WHERE task."id" = $1 AND task."sessionId"'))?.sql)
      .toContain('task."leaseExpiresAt" > CURRENT_TIMESTAMP')
  })

  it("checks first attempts for an acknowledged durable wait before returning no resume", async () => {
    const child = lease({ attemptCount: 1 }); const db = fakePool(child, [])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toBeUndefined()
    expect(db.pool.connect).toHaveBeenCalledOnce()
    expect(db.calls.some(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('FROM "agent_items"'))).toBe(false)
  })

  it("rehydrates a consumed wait projection from the wait row without advancing the attempt", async () => {
    const child = lease({ attemptCount: 1 })
    const wait = consumedWait(child)
    const sourceStepId = String(wait.stepId), continuationStepId = String(wait.continuationStepId)
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 1, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 1, ordinal: 1, status: "queued" }),
    ], [
      item(child, { id: "wait-call-item", stepId: sourceStepId, type: "tool_call", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } }),
      item(child, { id: "wait-result-id", stepId: sourceStepId, type: "tool_result", content: { toolCallId: "wait-call", output: { waitId: WAIT_ID, status: "waiting", taskIds: ["grandchild-1"], tasks: [] }, errorCode: null } }),
    ], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 2, toolCallCount: 1 },
      durableWait: { waitId: WAIT_ID, stepId: sourceStepId, attempt: 1, ordinal: 0, toolCallId: "wait-call", sourceItemId: "wait-result-id" },
      observations: [{ id: "child-resume:wait-result-id", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: WAIT_ID, status: "ready" } } }],
    })
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('wait."consumedAt" IS NOT NULL')
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('next."ordinal" = (SELECT MIN(later."ordinal")')
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).not.toContain('MAX(latest."ordinal")')
    expect(db.calls.find(call => call.sql.includes('WHERE task."id" = ANY($1::text[])'))?.values).toEqual([[
      "grandchild-1",
    ], child.sessionId, child.turnId, child.rootTaskId, child.id, child.userId])
  })

  it("resumes a validated resolved wait when no continuation step has been persisted", async () => {
    const child = lease({ attemptCount: 3 })
    const sourceStepId = `task:${child.id}:step:4:attempt:${child.attemptCount}`
    const wait = consumedWait(child)
    const input = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const output = (wait.waitResult as Row).outcome
    const durableWait = { waitId: WAIT_ID, stepId: sourceStepId, attempt: 3, ordinal: 18, toolCallId: "wait-call", sourceItemId: "wait-result-id", input, output }
    const db = fakePool(child, [
      step(child, { id: `task:${child.id}:step:3:attempt:3`, attempt: 3, ordinal: 17, status: "completed" }),
      step(child, { id: sourceStepId, attempt: 3, ordinal: 18, status: "waiting_for_tool" }),
    ], [
      item(child, { id: "wait-call-item", stepId: sourceStepId, attempt: 3, ordinal: 18,
        content: { toolCallId: "wait-call", toolName: "wait_subagents", input } }),
      item(child, { id: "wait-result-id", stepId: sourceStepId, attempt: 3, ordinal: 18, type: "tool_result",
        content: { toolCallId: "wait-call", output: { ...(output as Row), status: "waiting", matchedTaskIds: [] }, errorCode: null } }),
    ])

    const restored = await loadChildAttemptResume(db.pool as never, child, new Date(), durableWait)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 5, stepCount: 2, toolCallCount: 1 },
      durableWait: { waitId: WAIT_ID, stepId: sourceStepId, ordinal: 18, toolCallId: "wait-call" },
      observations: [{ id: "child-resume:wait-result-id", content: { toolCallId: "wait-call", toolName: "wait_subagents", output: { waitId: "[REDACTED_PHONE]", status: "ready" } } }],
    })
    expect(restored?.durableWait).not.toHaveProperty("continuationStepId")
    expect(restored).not.toHaveProperty("childWaitClaimRecovery")
    expect(restored).not.toHaveProperty("childWaitOrphanRecovery")
  })

  it("preserves the validated phone-shaped target through the consumed public resume path", async () => {
    const targetId = "subagent-00000000-0000-4000-8000-000000000001"
    const child = lease({ attemptCount: 1 })
    const wait = consumedWait(child, targetId, "Contact +353 87 123 4567")
    const sourceStepId = String(wait.stepId), continuationStepId = String(wait.continuationStepId)
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 1, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 1, ordinal: 1, status: "queued" }),
    ], [
      item(child, { id: "wait-call-item", stepId: sourceStepId, type: "tool_call", content: { toolCallId: "wait-call", toolName: "wait_subagents",
        input: { idempotencyKey: "wait-key", taskIds: [targetId], mode: "all", timeoutMs: 5_000 } } }),
      item(child, { id: "wait-result-id", stepId: sourceStepId, type: "tool_result", content: { toolCallId: "wait-call", output: { waitId: WAIT_ID, status: "waiting", taskIds: [targetId], tasks: [] }, errorCode: null } }),
    ], wait, [{ id: targetId, parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored?.durableWait).toMatchObject({ input: { taskIds: [targetId] }, output: { taskIds: [targetId], tasks: [{ taskId: targetId }] } })
    expect(JSON.stringify(restored?.durableWait)).toContain(targetId)
    expect(JSON.stringify(restored?.durableWait)).not.toContain("+353 87 123 4567")
    const observation = restored?.observations.find(item => item.id === "child-resume:wait-result-id")
    expect(observation?.content).toMatchObject({ input: { taskIds: [targetId] }, output: { taskIds: [targetId], tasks: [{ taskId: targetId }] } })
    expect(JSON.stringify(observation)).toContain(targetId)
    expect(JSON.stringify(observation)).not.toContain("+353 87 123 4567")
  })

  it("accepts the completed source result without a private marker at max attempt and reuses its persisted continuation", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = consumedWait(child)
    const sourceStepId = String(wait.stepId), continuationStepId = String(wait.continuationStepId)
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 1, status: "queued" }),
    ], [item(child, { id: "wait-call-item", attempt: 3, stepId: sourceStepId, type: "tool_call", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } })],
    wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 2, toolCallCount: 1 },
      durableWait: { waitId: WAIT_ID, attempt: 3, ordinal: 0, toolCallId: "wait-call", sourceItemId: "wait-result-id" },
      observations: [{ id: "child-resume:wait-result-id", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: WAIT_ID, status: "ready" } } }],
    })
    expect(restored?.resume.nextOrdinal).toBe(1)
    expect(db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql).toContain('LEFT JOIN "agent_items" AS result')
  })

  it("uses the first later task ordinal while keeping the deterministic logical resume ordinal", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const continuationStepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`
    const wait: Row = { ...consumedWait(child), stepId: sourceStepId, continuationStepId, continuationOrdinal: 9, continuationLatestOrdinal: 9 }
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool", inputThroughSequence: "7" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 9, status: "streaming", inputThroughSequence: "7", consumedInputIds: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    ], [], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 2, inputThroughSequence: 7n, consumedInputIds: ["input-1"] },
      durableWait: { ordinal: 0, attempt: 3 },
    })
    expect(restored?.durableWait?.continuationStepId).toBe(continuationStepId)
    expect(restored?.durableWait?.continuationOrdinal).toBe(9)
    const currentStepsQuery = db.calls.find(call => call.sql.includes('FROM "agent_steps" AS step') && call.sql.includes('step."attempt" = $6'))
    expect(currentStepsQuery?.values).toHaveLength(6)
    expect(currentStepsQuery?.sql).not.toContain('step."ordinal" <= $7')
    const lineage = db.calls.find(call => call.sql.includes('FROM "agent_wait_conditions" AS wait'))?.sql ?? ""
    expect(lineage).toContain('later."ordinal" > candidateStep."ordinal"')
    expect(lineage).toContain('next."ordinal" = (SELECT MIN(later."ordinal")')
    expect(lineage).not.toContain("continuationLatestOrdinal")
  })

  it("omits a verified preclaim orphan from restored observations and tool-call accounting", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const continuationStepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`
    const wait: Row = { ...consumedWait(child), stepId: sourceStepId, continuationStepId, continuationOrdinal: 9, continuationLatestOrdinal: 9 }
    const orphan = reissuedWaitCall(child, wait, "orphan-provider-call", false)
    const sourceCall = item(child, { id: "source-wait-call", stepId: sourceStepId, attempt: 3, ordinal: 0,
      content: { toolCallId: "wait-call", toolName: "wait_subagents", input: (wait.callContent as Row).input } })
    const sourceResult = item(child, { id: String(wait.sourceItemId), stepId: sourceStepId, attempt: 3, ordinal: 0, type: "tool_result",
      content: { toolCallId: "wait-call", output: { waitId: WAIT_ID, status: "waiting", taskIds: ["grandchild-1"], tasks: [] }, errorCode: null } })
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 9, status: "streaming", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    ], [sourceCall, sourceResult, orphan.itemRow], wait,
    [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }],
    [orphan.callRow], [], [...modelUsageEvents(child, continuationStepId), orphan.started])

    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored).toMatchObject({
      childWaitOrphanCallIds: ["orphan-provider-call"],
      childWaitOrphanRecovery: { call: { id: "orphan-provider-call" }, stepOrdinal: 1, stepStatus: "streaming" },
      resume: { nextOrdinal: 2, stepCount: 2, toolCallCount: 2, usage: { inputTokens: 47, outputTokens: 18, estimatedCostUsd: 0.2542 } },
      observations: [{ content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed" } }],
    })
    expect(restored?.observations.some(observation => (observation.content as Row).toolCallId === "orphan-provider-call")).toBe(false)
    expect(restored).not.toHaveProperty("childWaitClaimRecovery")
  })

  it("rejects an orphan and claimed call sharing a multi-call model receipt", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const continuationStepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`
    const wait: Row = { ...consumedWait(child), stepId: sourceStepId, continuationStepId, continuationOrdinal: 9, continuationLatestOrdinal: 9 }
    const claimed = reissuedWaitCall(child, wait, "claimed-provider-call", true)
    const orphan = reissuedWaitCall(child, wait, "orphan-provider-call", false)
    const sourceCall = item(child, { id: "source-wait-call", stepId: sourceStepId, attempt: 3, ordinal: 0,
      content: { toolCallId: "wait-call", toolName: "wait_subagents", input: (wait.callContent as Row).input } })
    const sourceResult = item(child, { id: String(wait.sourceItemId), stepId: sourceStepId, attempt: 3, ordinal: 0, type: "tool_result",
      content: { toolCallId: "wait-call", output: { waitId: WAIT_ID, status: "waiting", taskIds: ["grandchild-1"], tasks: [] }, errorCode: null } })
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 9, status: "streaming" }),
    ], [sourceCall, sourceResult, claimed.itemRow, orphan.itemRow], wait,
    [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }],
    [claimed.callRow, orphan.callRow], [], [claimed.started, claimed.claim!, orphan.started])

    await expect(loadChildAttemptResume(db.pool as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("retains the consumed wait anchor and cursor after later completed same-attempt steps", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const continuationStepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`
    const laterStepId = `task:${child.id}:step:2:attempt:${child.attemptCount}`
    const wait = { ...consumedWait(child), stepId: sourceStepId, continuationStepId, continuationOrdinal: 1, continuationLatestOrdinal: 2 }
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 1, status: "completed" }),
      step(child, { id: laterStepId, attempt: 3, ordinal: 2, status: "completed" }),
    ], [], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toMatchObject({
      durableWait: { stepId: sourceStepId, continuationStepId }, resume: { nextOrdinal: 3, stepCount: 3 },
    })
  })

  it("fails before loop entry when a later same-attempt step is streaming with a model receipt", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const continuationStepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`
    const laterStepId = `task:${child.id}:step:2:attempt:${child.attemptCount}`
    const wait = { ...consumedWait(child), stepId: sourceStepId, continuationStepId, continuationOrdinal: 1, continuationLatestOrdinal: 2 }
    const db = fakePool(child, [
      step(child, { id: sourceStepId, attempt: 3, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: continuationStepId, attempt: 3, ordinal: 1, status: "completed" }),
      step(child, { id: laterStepId, attempt: 3, ordinal: 2, status: "streaming", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    ], [], wait, [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }],
    [], [], modelUsageEvents(child, laterStepId))

    await expect(loadChildAttemptResume(db.pool as never, child)).rejects.toThrow("child_resume_wait_step_lineage")
    expect(db.calls.some(call => call.sql.includes('event."correlationId" = $7') && call.values[6] === laterStepId)).toBe(false)
  })

  it("replays the exact consumed wait observation after an ordinary attempt rollover", async () => {
    const child = lease({ attemptCount: 3, maxAttempts: 3 })
    const wait = consumedWait(child)
    wait.attempt = 2
    const waitInput = { idempotencyKey: "wait-key", taskIds: ["grandchild-1"], mode: "all", timeoutMs: 5_000 }
    const db = fakePool(child, [
      step(child, { id: "wait-step-attempt-2", attempt: 2, ordinal: 0, status: "waiting_for_tool" }),
      step(child, { id: "continuation-attempt-2", attempt: 2, ordinal: 1, status: "queued" }),
    ], [item(child, { id: "wait-call-item", attempt: 2, stepId: "wait-step-attempt-2", type: "tool_call",
      content: { toolCallId: "wait-call", toolName: "wait_subagents", input: waitInput } })],
    { ...wait, stepId: "wait-step-attempt-2" },
    [{ id: "grandchild-1", parentTaskId: child.id, rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }])

    const restored = await loadChildAttemptResume(db.pool as never, child)

    expect(restored).toMatchObject({
      resume: { nextOrdinal: 1, stepCount: 2, toolCallCount: 1 },
      observations: [{ id: "child-resume:wait-result-id", content: {
        toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: WAIT_ID, status: "ready" },
      } }],
    })
    expect(restored).not.toHaveProperty("durableWait")
    expect(db.calls.some(call => call.sql.includes('step."ordinal" <= $7'))).toBe(false)
    expect(db.calls.find(call => call.sql.includes('step."attempt" < $6'))?.values[5]).toBe(3)
  })

  it("returns no resume when recovery has no prior attempt evidence", async () => {
    const child = lease()
    const db = fakePool(child, [])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toBeUndefined()
    expect(db.client.query.mock.calls.map(([sql]) => sql)).not.toContain(expect.stringContaining('FROM "agent_items"'))
  })

  it("fails closed for a mismatched running lease or cross-lineage persisted row", async () => {
    const child = lease()
    const mismatch = fakePool(child, [step(child, { taskId: "other-task" })])
    mismatch.client.query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      mismatch.calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task."id"')) return { rows: [{ ...currentRow(child), leaseOwner: "other-worker" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [step(child, { taskId: "other-task" })], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await expect(loadChildAttemptResume(mismatch.pool as never, child)).rejects.toThrow("child_resume_owner_mismatch")
    expect(mismatch.client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK")

    const crossItem = fakePool(child, [step(child)], [item(child, { sessionId: "other-session" })])
    await expect(loadChildAttemptResume(crossItem.pool as never, child)).rejects.toThrow("child_resume_item_lineage")
  })

  it("does not restore an item from the current attempt or an unbound result", async () => {
    const child = lease()
    const db = fakePool(child, [step(child)], [
      item(child, { id: "current-call", attempt: child.attemptCount }),
      item(child, { id: "orphan-result", type: "tool_result", content: { toolCallId: "missing", output: { secret: false }, errorCode: null } }),
    ])
    const restored = await loadChildAttemptResume(db.pool as never, child)
    expect(restored?.resume.toolCallCount).toBe(0)
    expect(restored?.observations).toEqual([])
  })

  it("redacts sensitive fields and bounds restored tool output", async () => {
    const child = lease()
    const db = fakePool(child, [step(child)], [
      item(child),
      item(child, { id: "large-result", type: "tool_result", content: { toolCallId: "call-1", output: { apiKey: "secret", text: "x".repeat(20_000) }, errorCode: null } }),
    ])
    const restored = await loadChildAttemptResume(db.pool as never, child, new Date("2099-09-14T11:00:00.000Z"))
    const observation = restored?.observations[0]?.content as { readonly output?: unknown }
    expect(observation.output).toMatchObject({ truncated: true })
    expect(JSON.stringify(observation.output)).not.toContain("apiKey")
    expect(new TextEncoder().encode(JSON.stringify(observation.output)).length).toBeLessThanOrEqual(6 * 1024)
  })

  it.each([
    ["failed", 1], ["streaming", 1], ["interrupted", 1], ["completed", 2], ["waiting_for_tool", 2], ["waiting_for_approval", 2], ["waiting_for_user", 2],
  ] as const)("%s final prior step %s its logical ordinal", async (status, expectedNextOrdinal) => {
    const child = lease()
    const db = fakePool(child, [step(child, { status, ordinal: 1 })])
    await expect(loadChildAttemptResume(db.pool as never, child)).resolves.toMatchObject({ resume: { nextOrdinal: expectedNextOrdinal } })
  })

  it("fails closed when bounded prior history exceeds the step or item limit", async () => {
    const child = lease()
    const tooManySteps = fakePool(child, Array.from({ length: 257 }, (_, index) => step(child, { id: `step-${index}`, ordinal: index, consumedInputIds: [] })))
    await expect(loadChildAttemptResume(tooManySteps.pool as never, child)).rejects.toThrow("child_resume_step_limit")
    const tooManyItems = fakePool(child, [step(child)], Array.from({ length: 1_025 }, (_, index) => item(child, { id: `item-${index}`, content: { toolCallId: `call-${index}`, toolName: "jobs.search" } })))
    await expect(loadChildAttemptResume(tooManyItems.pool as never, child)).rejects.toThrow("child_resume_item_limit")
  })

  it("fails closed when a tool call id crosses steps", async () => {
    const child = lease()
    const db = fakePool(child, [step(child), step(child, { id: "step-2", ordinal: 1 })], [
      item(child), item(child, { id: "item-call-2", stepId: "step-2" }),
    ])
    await expect(loadChildAttemptResume(db.pool as never, child)).rejects.toThrow("child_resume_tool_call_conflict")
  })
})
