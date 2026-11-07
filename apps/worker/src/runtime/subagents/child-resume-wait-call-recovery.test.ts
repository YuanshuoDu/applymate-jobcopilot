import { beforeEach, describe, expect, it, vi } from "vitest"

import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"
import { childWaitClaimEventKey } from "./child-durable-wait-replay.js"
import { loadChildWaitCallRecovery } from "./child-resume-wait-call-recovery.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const runtimeMocks = vi.hoisted(() => ({ readTerminalChain: vi.fn() }))
vi.mock("./pg-store-expiry-step-tool-chain-proof.js", async importOriginal => ({
  ...await importOriginal<typeof import("./pg-store-expiry-step-tool-chain-proof.js")>(),
  readCanonicalWaitStepToolChain: runtimeMocks.readTerminalChain,
}))

const lease: SubagentLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 2, role: "scout", taskType: "research", status: "running", goal: "", constraints: [], successCriteria: [],
  allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3,
  leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
}
const wait: DurableWaitResume = {
  waitId: "wait-1", stepId: `task:child-1:step:4:attempt:2`, attempt: 2, ordinal: 4, toolCallId: "old-provider-call", sourceItemId: "old-result",
  input: { idempotencyKey: "wait-key", taskIds: ["leaf-a", "leaf-b"], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: ["leaf-a", "leaf-b"], matchedTaskIds: ["leaf-a", "leaf-b"] },
  continuationStepId: `task:child-1:step:5:attempt:2`, continuationOrdinal: 9,
}

function fixture(options: { claimed?: boolean; extraCall?: boolean; orphanResult?: boolean; orphanStartedEvent?: boolean;
  modelCallCount?: number; completedCallWithoutEvent?: boolean; missingItemStarted?: boolean; completeLifecycle?: boolean;
  projectedCompletion?: boolean; modelCost?: number; storedCost?: number } = {}) {
  const calls: Row[] = [], results: Row[] = [], events: Row[] = []
  const stepId = wait.continuationStepId!, claimKey = `task:${lease.id}:event:${childWaitClaimEventKey(wait.attempt, stepId)}`
  const step = { id: stepId, status: options.completeLifecycle ? "completed" : "streaming", attempt: wait.attempt, ordinal: wait.continuationOrdinal,
    inputTokens: options.completeLifecycle ? 37 : 0, outputTokens: options.completeLifecycle ? 13 : 0,
    estimatedCostUsd: options.storedCost ?? 0 }
  const start = { id: "model-started", sequence: "1", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.started", actor: "subagent", correlationId: stepId, causationId: null,
    idempotencyKey: `task:${lease.id}:event:model-started:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model" } }
  const complete = { id: "model-completed", sequence: "2", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.completed", actor: "subagent", correlationId: stepId, causationId: start.id,
    idempotencyKey: `task:${lease.id}:event:model-completed:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model", toolCallCount: options.modelCallCount ?? 1 } }
  const usage = { id: "model-usage", sequence: "3", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "model.usage", actor: "subagent", correlationId: stepId, causationId: complete.id,
    idempotencyKey: `task:${lease.id}:event:model-usage:${stepId}`, payload: { taskId: lease.id, provider: "fixture", model: "fixture-model",
      usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: options.modelCost ?? 0.0042 } } }
  events.push(start, complete, usage)
  function addCall(callId: string, isClaimed: boolean): void {
    const id = `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}`
    const started = { id: `event-${callId}-item-started`, sequence: String(events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "item.started", actor: "subagent", correlationId: stepId, causationId: usage.id,
      idempotencyKey: `task:${lease.id}:event:item-started:${id}`, payload: { itemId: id, type: "tool_call", phase: null } }
    const status = options.completedCallWithoutEvent || options.completeLifecycle ? "completed" : "started", revision = status === "completed" ? 1 : 0
    calls.push({ id, status, revision, content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: wait.input,
      ...(status === "completed" ? { status, errorCode: null } : {}) },
      stepId, attempt: wait.attempt, ordinal: wait.continuationOrdinal })
    if (!options.missingItemStarted) events.push(started)
    let claimEvent: Row | undefined
    if (isClaimed) {
      claimEvent = { id: `event-${callId}-claim`, sequence: String(events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId, causationId: started.id, idempotencyKey: claimKey,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } }
      events.push(claimEvent)
    }
    if (options.completeLifecycle) {
      const rawPayload = { itemId: id, status: "completed", content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1",
        input: wait.input, status: "completed", errorCode: null } }
      const payload = options.projectedCompletion ? projectWaitCallCompletionPayload(rawPayload, id) : rawPayload
      const completeItem: Row = { id: `event-${callId}-item-completed`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: id, type: "item.completed", actor: "subagent", correlationId: id,
        causationId: claimEvent!.id, idempotencyKey: `task:${lease.id}:event:tool-call-completed:${callId}:${id}:1`,
        payload }
      events.push(completeItem)
      const finished: Row = { id: `event-${callId}-tool-finished`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: id, type: "tool_call.completed", actor: "subagent", correlationId: callId,
        causationId: completeItem.id, idempotencyKey: `task:${lease.id}:event:tool-finished:${callId}`,
        payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } }
      events.push(finished)
      const resultId = `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`
      results.push({ id: resultId, status: "completed", revision: 1, content: { toolCallId: callId, output: wait.output, errorCode: null }, stepId })
      const resultStart: Row = { id: `event-${callId}-result-started`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: resultId, type: "item.started", actor: "subagent", correlationId: stepId,
        causationId: finished.id, idempotencyKey: `task:${lease.id}:event:item-started:${resultId}`,
        payload: { itemId: resultId, type: "tool_result", phase: null } }
      events.push(resultStart)
      events.push({ id: `event-${callId}-result-completed`, sequence: String(events.length + 1), sessionId: lease.sessionId,
        turnId: lease.turnId, taskId: lease.id, itemId: resultId, type: "item.completed", actor: "subagent", correlationId: resultId,
        causationId: resultStart.id, idempotencyKey: `task:${lease.id}:event:tool-result-completed:${callId}:${resultId}:1`,
        payload: { itemId: resultId, status: "completed", content: { toolCallId: callId, output: wait.output, errorCode: null } } })
    }
    if (options.orphanStartedEvent && !isClaimed) events.push({ id: `event-${callId}-alternate-start`, sequence: String(events.length + 1), sessionId: lease.sessionId,
      turnId: lease.turnId, taskId: lease.id, itemId: id, type: "tool_call.started", actor: "subagent", correlationId: callId,
      causationId: started.id, idempotencyKey: `task:${lease.id}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })
    if (options.orphanResult && !isClaimed) results.push({ id: `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`,
      status: "started", revision: 0, content: { toolCallId: callId, output: wait.output, errorCode: null }, stepId })
  }
  const callId = "provider-call"
  addCall(callId, options.claimed ?? false)
  if (options.extraCall) addCall("second-provider-call", false)
  let eventSql = "", causalSql = "", terminalSql = "", causalIds: string[] = [], nextStep: Row | undefined
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes('SELECT step."id", step."sessionId", step."turnId", step."taskId", step."attempt", step."ordinal"')) {
      const rows = nextStep && nextStep.id === values[0] ? [nextStep] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps" AS step')) return { rows: [step], rowCount: 1 }
    if (sql.includes('JOIN "agent_steps" AS step')) return { rows: calls, rowCount: calls.length }
    if (sql.includes('item."type" = \'tool_result\'')) return { rows: results, rowCount: results.length }
    if (sql.includes('event."causationId" = $3')) {
      terminalSql = sql
      const rows = events.filter(event => event.sessionId === values[0] && event.turnId === values[1]
        && event.causationId === values[2]).slice(0, 2)
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('event."causationId" = ANY($4::text[])')) {
      causalSql = sql
      causalIds = values[3] as string[]
      const rows = events.filter(event => causalIds.includes(String(event.causationId)))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_events" AS event')) {
      eventSql = sql
      const [,, , keys = [], itemIds = [], callIds = [], stepId] = values as [unknown, unknown, unknown, string[], string[], string[], string?]
      const stepItemIds = [...calls, ...results].map(row => String(row.id))
      const anchor = (event: Row) => keys.includes(String(event.idempotencyKey)) || itemIds.includes(String(event.itemId))
        || callIds.includes(String(event.correlationId)) || event.correlationId === stepId
        || stepItemIds.includes(String(event.itemId)) || stepItemIds.includes(String(event.correlationId))
      const rows = events.filter(anchor)
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, calls, results, events, step, claimKey, callId, claimedId: `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}`,
    setNextStep(row: Row | undefined) { nextStep = row }, get eventSql() { return eventSql }, get causalSql() { return causalSql },
    get terminalSql() { return terminalSql }, get causalIds() { return causalIds } }
}

function addSiblingCall(fake: ReturnType<typeof fixture>, complete = true): void {
  const callId = "noop-call", id = `task:${lease.id}:item:tool-call:${callId}:attempt:${wait.attempt}`
  const resultId = `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`
  const status = complete ? "completed" : "started"
  fake.calls.push({ id, status, revision: complete ? 1 : 0, stepId: wait.continuationStepId, attempt: wait.attempt,
    ordinal: wait.continuationOrdinal, content: { toolCallId: callId, toolName: "fixture_noop", toolVersion: "1", input: {},
      ...(complete ? { status, errorCode: null } : {}) } })
  if (complete) {
    fake.results.push({ id: resultId, stepId: wait.continuationStepId, status: "completed", revision: 1,
      content: { toolCallId: callId, output: { ok: true }, errorCode: null } })
    const push = (suffix: string, type: string, itemId: string, correlationId: string, causationId: string | null, key: string) => {
      const id = `event-noop-${suffix}`
      fake.events.push({ id, sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
        itemId, type, actor: "subagent", correlationId, causationId, idempotencyKey: `task:${lease.id}:event:${key}`, payload: {} })
      return id
    }
    const start = push("item-started", "item.started", id, wait.continuationStepId!, String(fake.events.at(-1)!.id), `item-started:${id}`)
    const called = push("call-started", "tool_call.started", id, callId, start, `tool-started:${callId}`)
    const completed = push("call-completed", "item.completed", id, id, called, `tool-call-completed:${callId}:${id}:1`)
    const terminal = push("tool-finished", "tool_call.completed", id, callId, completed, `tool-finished:${callId}`)
    const resultStart = push("result-started", "item.started", resultId, wait.continuationStepId!, terminal, `item-started:${resultId}`)
    push("result-completed", "item.completed", resultId, resultId, resultStart, `tool-result-completed:${callId}:${resultId}:1`)
  }
}

function addStepCompleted(fake: ReturnType<typeof fixture>): string {
  const id = "event-step-completed", stepId = wait.continuationStepId!
  fake.events.push({ id, sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    itemId: null, type: "step.completed", actor: "subagent", correlationId: stepId, causationId: fake.events.at(-1)!.id,
    idempotencyKey: `task:${lease.id}:event:step-completed:${stepId}`,
    payload: { stepId, status: "completed", toolCallCount: fake.calls.length, taskId: lease.id } })
  return id
}

function setNextStepRow(fake: ReturnType<typeof fixture>): string {
  const stepId = `task:${lease.id}:step:6:attempt:${lease.attemptCount}`
  const ordinal = 10
  fake.setNextStep({ id: stepId, sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
    attempt: lease.attemptCount, ordinal, status: "streaming" })
  return stepId
}

function addNextStepStarted(fake: ReturnType<typeof fixture>, terminalId: string): void {
  const stepId = setNextStepRow(fake), ordinal = 10
  fake.events.push({ id: "next-step-started", sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: lease.id, itemId: null, type: "step.started", actor: "subagent", correlationId: stepId, causationId: terminalId,
    idempotencyKey: `task:${lease.id}:event:step-started:${stepId}`, payload: { stepId, ordinal, taskId: lease.id } })
}

function terminalProof(fake: ReturnType<typeof fixture>) {
  const events = fake.events.map(event => ({ id: event.id as string, sequence: event.sequence as string, type: event.type as string,
    actor: event.actor as string, itemId: event.itemId as string | null, correlationId: event.correlationId as string,
    causationId: event.causationId as string | null, idempotencyKey: event.idempotencyKey as string }))
  const calls = fake.calls.map(call => {
    const callId = String((call.content as Row).toolCallId), resultItemId = `task:${lease.id}:item:tool-result:${callId}:attempt:${wait.attempt}`
    const eventId = (type: string, itemId: string) => String(fake.events.find(event => event.type === type && event.itemId === itemId)?.id)
    return { callItemId: String(call.id), toolCallId: callId, resultItemId, itemStartedEventId: eventId("item.started", String(call.id)),
      callStartedEventId: eventId("tool_call.started", String(call.id)), callCompletedEventId: eventId("item.completed", String(call.id)),
      callTerminalEventId: eventId("tool_call.completed", String(call.id)), resultStartedEventId: eventId("item.started", resultItemId),
      resultCompletedEventId: eventId("item.completed", resultItemId) }
  })
  return { calls, events, stepCompletedEventId: String(fake.events.find(event => event.type === "step.completed")?.id) }
}

describe("child resume wait-call recovery", () => {
  beforeEach(() => runtimeMocks.readTerminalChain.mockReset())

  it("classifies a single complete preclaim orphan and carries logical ordinal plus usage", async () => {
    const fake = fixture()
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).resolves.toMatchObject({
      orphanCallIds: [fake.callId], orphan: { call: { id: fake.callId }, stepOrdinal: 5, stepStatus: "streaming",
        modelUsage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 } },
    })
  })

  it("validates the stable claim against its receipt and preserves its original call ID", async () => {
    const fake = fixture({ claimed: true })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({
      call: { id: fake.callId, name: "wait_subagents" }, claimEventId: `event-${fake.callId}-claim`,
      callItem: { status: "started", revision: 0 }, stepOrdinal: 5, modelUsage: { inputTokens: 37, outputTokens: 13 },
    })
    expect(restored?.orphanCallIds).toEqual([])
  })

  it("accepts the exact claim cut where the call row completed before its completion event", async () => {
    const fake = fixture({ claimed: true, completedCallWithoutEvent: true })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({
      call: { id: fake.callId }, claimEventId: `event-${fake.callId}-claim`,
      callItem: { status: "completed", revision: 1 }, stepStatus: "streaming",
    })
    expect(fake.events.some(event => event.type === "item.completed" && event.itemId === fake.claimedId)).toBe(false)
  })

  it("accepts the canonical projected completion payload while keeping private call input exact", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCost: 0.0042, storedCost: 0.0042 })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({ call: { id: fake.callId }, callItem: { status: "completed", revision: 1 } })
    const completion = fake.events.find(event => event.type === "item.completed" && event.itemId === fake.claimedId)!
    expect(completion.payload).toMatchObject({ content: { input: {
      idempotencyKey: "[REDACTED]", taskIds: ["[REDACTED]", "[REDACTED]"], mode: "all", timeoutMs: 5_000,
    } } })
    expect(JSON.stringify(completion.payload)).not.toContain("wait-key")
    expect(JSON.stringify(completion.payload)).not.toContain("leaf-a")
    expect(fake.calls[0]?.content).toMatchObject({ input: wait.input })
  })

  it("accepts a completed claim cut before any event follows its terminal proof", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake), proof = terminalProof(fake)
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({ call: { id: fake.callId }, callItem: { status: "completed", revision: 1 }, stepStatus: "completed" })
    expect(fake.terminalSql).toContain('event."causationId" = $3')
    expect(fake.terminalSql).toContain("LIMIT 2")
    expect(fake.events.find(event => event.id === terminalId)).toBeDefined()
  })

  it("accepts only the row-backed deterministic logical next step after the terminal proof", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake)
    const proof = terminalProof(fake)
    addNextStepStarted(fake, terminalId)
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim).toMatchObject({ call: { id: fake.callId }, callItem: { status: "completed", revision: 1 }, stepStatus: "completed" })
    expect(restored?.orphanCallIds).toEqual([])
    expect(fake.causalSql).toContain('event."causationId" = ANY($4::text[])')
    expect([...fake.causalIds].sort()).toEqual(proof.events.filter(event => event.id !== proof.stepCompletedEventId).map(event => event.id).sort())
    expect(fake.causalIds).not.toContain(terminalId)
    expect(fake.terminalSql).toContain('event."sessionId" = $1 AND event."turnId" = $2')
    expect(runtimeMocks.readTerminalChain).toHaveBeenCalledWith(fake.client, {
      id: lease.id, sessionId: lease.sessionId, turnId: lease.turnId,
    }, { stepId: wait.continuationStepId, attempt: wait.attempt, callItemId: fake.claimedId,
      callId: fake.callId, resultItemId: `task:${lease.id}:item:tool-result:${fake.callId}:attempt:${wait.attempt}` })
  })

  it("rejects a late terminal-rooted event with unrelated correlation despite the real successor row", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake), proof = terminalProof(fake)
    addNextStepStarted(fake, terminalId)
    fake.events.at(-1)!.correlationId = "unrelated-correlation"
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("rejects an extra terminal child beside an otherwise valid next step", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake), proof = terminalProof(fake)
    addNextStepStarted(fake, terminalId)
    fake.events.push({ id: "extra-terminal-child", sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: "other-task", itemId: null, type: "tool_call.started", actor: "subagent", correlationId: "unrelated", causationId: terminalId,
      idempotencyKey: `task:${lease.id}:event:extra-terminal-child`, payload: {} })
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it.each(["task.completed", "task.failed", "task.interrupted"] as const)("rejects terminal child event %s as active continuation proof", async type => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake), proof = terminalProof(fake)
    setNextStepRow(fake)
    const key = type === "task.failed" ? "turn-failed:terminal" : type === "task.interrupted" ? "turn-interrupted" : "turn-completed"
    fake.events.push({ id: `event-${type}`, sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: lease.id, itemId: null, type, actor: "subagent", correlationId: lease.turnId!, causationId: terminalId,
      idempotencyKey: `task:${lease.id}:event:${key}`, payload: { taskId: lease.id, turnId: lease.turnId, errorCode: "terminal" } })
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it.each(["post-terminal sibling item event", "late causal-only child", "two-layer causal descendant"])("rejects %s outside the canonical chain", async kind => {
    const fake = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCallCount: 2, storedCost: 0.0042 })
    addSiblingCall(fake)
    const terminalId = addStepCompleted(fake), proof = terminalProof(fake)
    const sibling = proof.calls[1]!
    const extraId = `extra-${kind}`
    fake.events.push({ id: extraId, sequence: String(fake.events.length + 1), sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: lease.id, itemId: kind === "post-terminal sibling item event" ? sibling.callItemId : null,
      type: "tool_call.started", actor: "subagent", correlationId: "unrelated-correlation",
      causationId: kind === "post-terminal sibling item event" ? terminalId : sibling.callStartedEventId,
      idempotencyKey: `task:${lease.id}:event:unrelated:${kind}`, payload: {} })
    if (kind === "two-layer causal descendant") fake.events.push({ id: "extra-two", sequence: String(fake.events.length + 1),
      sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null, type: "tool_call.completed", actor: "subagent",
      correlationId: "still-unrelated", causationId: extraId, idempotencyKey: `task:${lease.id}:event:unrelated:two`, payload: {} })
    runtimeMocks.readTerminalChain.mockResolvedValue(proof)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it.each([
    ["streaming step", { claimed: true, extraCall: true, modelCallCount: 2 }],
    ["requested calls beyond the executed terminal chain", { claimed: true, completeLifecycle: true, modelCallCount: 3, storedCost: 0.0042 }],
    ["incomplete sibling", { claimed: true, completeLifecycle: true, modelCallCount: 2, storedCost: 0.0042 }],
  ] as const)("rejects a multi-call claim without a complete terminal proof: %s", async (label, options) => {
    const fake = fixture(options)
    if (label !== "streaming step") addSiblingCall(fake, label !== "incomplete sibling")
    else addSiblingCall(fake, false)
    runtimeMocks.readTerminalChain.mockResolvedValue(null)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    expect(runtimeMocks.readTerminalChain).toHaveBeenCalledTimes(label === "streaming step" ? 0 : 1)
  })

  it("rejects a tampered canonical completion payload or misbound completion event", async () => {
    const tampered = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCost: 0.0042, storedCost: 0.0042 })
    const tamperedEvent = tampered.events.find(event => event.type === "item.completed" && event.itemId === tampered.claimedId)!
    const payload = tamperedEvent.payload as Row
    const content = payload.content as Row
    const input = content.input as Row
    content.input = { ...input, mode: "any" }
    await expect(loadChildWaitCallRecovery(tampered.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")

    const misbound = fixture({ claimed: true, completeLifecycle: true, projectedCompletion: true, modelCost: 0.0042, storedCost: 0.0042 })
    const misboundEvent = misbound.events.find(event => event.type === "item.completed" && event.itemId === misbound.claimedId)!
    misboundEvent.causationId = "unrelated-event"
    await expect(loadChildWaitCallRecovery(misbound.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("accepts the exact historical raw completion payload and matches PostgreSQL-rounded receipt cost", async () => {
    const fake = fixture({ claimed: true, completeLifecycle: true, modelCost: 0.123456789, storedCost: 0.12345679 })
    const restored = await loadChildWaitCallRecovery(fake.client as never, lease, wait)
    expect(restored?.claim?.modelUsage.estimatedCostUsd).toBe(0.123456789)
  })

  it("fails closed when completed-step cost differs or receipt cost overflows the database type", async () => {
    const mismatch = fixture({ claimed: true, completeLifecycle: true, modelCost: 0.123456789, storedCost: 0.12345678 })
    await expect(loadChildWaitCallRecovery(mismatch.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const overflow = fixture({ modelCost: 9999.999999995 })
    await expect(loadChildWaitCallRecovery(overflow.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it.each([
    ["multiple provider calls despite a claim", { claimed: true, extraCall: true }],
    ["multiple unclaimed provider calls", { extraCall: true }],
    ["orphan result", { orphanResult: true }],
    ["unkeyed start event", { orphanStartedEvent: true }],
    ["multi-call model receipt", { modelCallCount: 2 }],
    ["completed call without its unique claim", { completedCallWithoutEvent: true }],
    ["preclaim call item without item.started event", { missingItemStarted: true }],
  ] as const)("fails closed for %s", async (_name, options) => {
    const fake = fixture(options)
    await expect(loadChildWaitCallRecovery(fake.client as never, lease, wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })
})
