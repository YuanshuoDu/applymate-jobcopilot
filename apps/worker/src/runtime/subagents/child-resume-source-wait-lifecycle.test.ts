import { beforeEach, describe, expect, it, vi } from "vitest"

const batch = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], calls: 0 }))
vi.mock("../turns/turn-engine-event-batch.js", () => ({
  appendTurnEngineEventBatch: async (_pool: unknown, values: readonly unknown[]) => {
    batch.calls += 1
    let previous: string | null = null
    const saved: { id: string }[] = []
    for (const value of values) {
      const input = value as Record<string, unknown>, key = String(input.idempotencyKey)
      const existing = batch.events.find(event => event.idempotencyKey === key)
      if (existing) { saved.push({ id: String(existing.id) }); previous = String(existing.id); continue }
      const owner = input.owner as Record<string, unknown>, id = String(input.id)
      batch.events.push({ id, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: input.itemId,
        type: input.type, actor: "subagent", correlationId: input.correlationId, causationId: previous ?? input.causationId,
        sequence: batch.events.length + 1, idempotencyKey: key, payload: input.payload })
      saved.push({ id }); previous = id
    }
    return saved
  },
}))

import { inspectChildWaitSourceLifecycle, reconcileChildWaitSourceLifecycle } from "./child-resume-source-wait-lifecycle.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"

const now = new Date("2026-10-30T10:00:00.000Z")
const lease = { id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "worker-1", attemptCount: 2, leaseExpiresAt: new Date(now.getTime() + 60_000) }
const waitId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const taskId = "+353 87 123 4568"
const secretKey = "+353 87 123 4567"
const callId = "provider-call-1"
const callItemId = "task:parent-1:item:tool-call:provider-call-1"

function output() {
  return { waitId, status: "ready", taskIds: [taskId], deadlineAt: new Date(now.getTime() + 5_000).toISOString(),
    matchedTaskIds: [taskId], tasks: [{ taskId, status: "completed", role: "writer", result: { note: "Contact +353 87 555 0199" }, failureReason: null }] }
}
function fixture(options: { wrongCause?: boolean; wrongItemStartCause?: boolean; extraResult?: boolean; sourceAttempt?: number } = {}) {
  batch.events = []; batch.calls = 0
  const result = output(), callContent = { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1",
    input: { idempotencyKey: secretKey, taskIds: [taskId], mode: "any", timeoutMs: 1_000 } }
  const wait: Record<string, unknown> = { id: waitId, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    parentTaskId: lease.id, stepId: "step-1", idempotencyKey: secretKey, targetTaskIds: [taskId], mode: "any", status: "ready",
    deadlineAt: new Date(result.deadlineAt), matchedTaskIds: [taskId],
    result: { request: { targetTaskIds: [taskId], mode: "any", timeoutMs: 1_000 }, outcome: result }, consumedAt: null }
  const items: Record<string, unknown>[] = [{ id: callItemId, revision: 0, stepId: "step-1", taskId: lease.id, type: "tool_call",
    phase: null, status: "started", content: callContent }]
  items.push({ id: "activity-item", revision: 0, stepId: "step-1", taskId: lease.id, type: "subagent_activity",
    phase: "commentary", status: "completed", content: { operation: "list_subagents", data: { count: 1 } } })
  if (options.extraResult) items.push({ id: "conflicting-result", revision: 0, stepId: "step-1", taskId: lease.id,
    type: "tool_result", phase: null, status: "started", content: { toolCallId: callId } })
  const priorStepUsage = { id: "event-previous-step-usage", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null,
    type: "model.usage", actor: "subagent", correlationId: "step-0", causationId: "event-previous-step-completed", sequence: 1,
    idempotencyKey: "task:parent-1:event:model-usage:step-0", payload: { taskId: lease.id } }
  const modelUsage = { id: "event-model-usage", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: null,
    type: "model.usage", actor: "subagent", correlationId: "step-1", causationId: "event-model-completed", sequence: 2,
    idempotencyKey: "task:parent-1:event:model-usage:step-1", payload: { taskId: lease.id } }
  const interleaved = { id: "event-interleaved", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: "activity-item",
    type: "item.completed", actor: "tool", correlationId: lease.turnId, causationId: null, sequence: 3,
    idempotencyKey: "coordination-activity:" + lease.sessionId + ":activity-1", payload: { type: "subagent_activity", operation: "list_subagents", status: "completed" } }
  const itemStart = { id: "event-item-start", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: callItemId,
    type: "item.started", actor: "subagent", correlationId: "step-1", causationId: options.wrongItemStartCause ? priorStepUsage.id : modelUsage.id, sequence: 4,
    idempotencyKey: "task:" + lease.id + ":event:item-started:" + callItemId, payload: { itemId: callItemId, type: "tool_call", phase: null } }
  const callStart = { id: "event-call-start", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, itemId: callItemId,
    type: "tool_call.started", actor: "subagent", correlationId: callId,
    causationId: options.wrongCause ? "foreign-event" : itemStart.id, sequence: 5,
    idempotencyKey: "task:" + lease.id + ":event:tool-started:" + callId,
    payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } }
  batch.events.push(priorStepUsage, modelUsage, interleaved, itemStart, callStart)
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM "agent_steps"') && sql.includes('"attempt"')) {
      return { rows: [{ attempt: options.sourceAttempt ?? lease.attemptCount }], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('"content"->>\'toolName\' = \'wait_subagents\'')) {
      return { rows: items.filter(item => item.type === "tool_call" && (item.content as Record<string, unknown>).toolName === "wait_subagents"), rowCount: 1 }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('"content"->>\'toolCallId\' = $4')) {
      return { rows: items.filter(item => (item.content as Record<string, unknown>).toolCallId === params[3]), rowCount: items.length }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('WHERE "id" = $1')) {
      const item = items.find(value => value.id === params[0]); return { rows: item ? [{ content: item.content }] : [], rowCount: item ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_events" AS event') && sql.includes('event."id" = $4')) {
      return { rows: batch.events.filter(event => event.id === params[3] && event.sessionId === params[0]
        && event.turnId === params[1] && event.taskId === params[2] && event.actor === "subagent"
        && (event.correlationId === params[4] || items.some(item => item.id === event.itemId && item.stepId === params[4]))), rowCount: 1 }
    }
    if (sql.includes('FROM "agent_events"') && sql.includes('"causationId" = ANY')) {
      const causes = params[3] as string[]; return { rows: batch.events.filter(event => causes.includes(String(event.causationId))), rowCount: 0 }
    }
    if (sql.includes('FROM "agent_events"') && sql.includes('"type" = \'tool_call.started\'')) {
      return { rows: batch.events.filter(event => event.itemId === params[3] && event.correlationId === params[4]), rowCount: 1 }
    }
    if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = ANY($7::text[])')) {
      const keys = params[6] as string[]
      return { rows: batch.events.filter(event => event.itemId === params[3] || event.correlationId === params[4]
        || event.itemId === params[5] || event.correlationId === params[5] || keys.includes(String(event.idempotencyKey))), rowCount: batch.events.length }
    }
    if (sql.startsWith('UPDATE "agent_items"')) {
      const item = items.find(value => value.id === params[2])
      if (item) { item.status = "completed"; item.content = JSON.parse(String(params[0])); item.revision = 1 }
      return { rows: [], rowCount: item ? 1 : 0 }
    }
    if (sql.startsWith('INSERT INTO "agent_items"')) {
      const item = { id: params[0], sessionId: params[1], turnId: params[2], stepId: params[3], taskId: params[4], type: "tool_result",
        status: "started", phase: null, revision: 0, content: JSON.parse(String(params[5])) }
      items.push(item); return { rows: [{ id: item.id }], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "agent_wait_conditions"')) { wait.result = JSON.parse(String(params[0])); return { rows: [], rowCount: 1 } }
    return { rows: [], rowCount: 1 }
  }
  return { wait, items, client: { query }, pool: { connect: async () => ({ query, release() {} }) }, result }
}
function waitingFixture(eventProjection: "legacy" | "safe" | "malformed") {
  const fake = fixture(), call = fake.items.find(item => item.id === callItemId)!
  const callContent: Record<string, unknown> = { ...(call.content as Record<string, unknown>), status: "completed", errorCode: null }
  call.status = "completed"; call.revision = 1; call.content = callContent
  const waitingOutput = { ...fake.result, status: "waiting", matchedTaskIds: [] }
  const resultId = "task:parent-1:item:tool-result:legacy-wait"
  const resultContent = { toolCallId: callId, output: waitingOutput, errorCode: null }
  fake.items.push({ id: resultId, revision: 1, stepId: "step-1", taskId: lease.id, type: "tool_result", phase: null,
    status: "completed", content: resultContent })
  const callStart = batch.events.find(event => event.type === "tool_call.started")!
  const safeContent = projectWaitCallEventContent(callContent) as Record<string, unknown>
  const content = eventProjection === "legacy" ? callContent : safeContent
  if (eventProjection === "malformed") {
    const input = { ...(content.input as Record<string, unknown>), timeoutMs: 2_000 }
    content.input = input
  }
  const callComplete = { id: "event-call-completed", itemId: callItemId, type: "item.completed", actor: "subagent",
    correlationId: callItemId, causationId: callStart.id, sequence: 6,
    idempotencyKey: `task:${lease.id}:event:tool-call-completed:${callId}:${callItemId}:1`,
    payload: { itemId: callItemId, status: "completed", content } }
  const toolComplete = { id: "event-tool-finished", itemId: callItemId, type: "tool_call.completed", actor: "subagent",
    correlationId: callId, causationId: callComplete.id, sequence: 7,
    idempotencyKey: `task:${lease.id}:event:tool-finished:${callId}`,
    payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } }
  const resultStart = { id: "event-result-start", itemId: resultId, type: "item.started", actor: "subagent",
    correlationId: "step-1", causationId: toolComplete.id, sequence: 8,
    idempotencyKey: `task:${lease.id}:event:item-started:${resultId}`,
    payload: { itemId: resultId, type: "tool_result", phase: null } }
  const resultComplete = { id: "event-result-completed", itemId: resultId, type: "item.completed", actor: "subagent",
    correlationId: resultId, causationId: resultStart.id, sequence: 9,
    idempotencyKey: `task:${lease.id}:event:tool-result-completed:${callId}:${resultId}:1`,
    payload: { itemId: resultId, status: "completed", content: resultContent } }
  batch.events.push(callComplete, toolComplete, resultStart, resultComplete)
  return fake
}

describe("child source wait lifecycle recovery", () => {
  beforeEach(() => { batch.events = []; batch.calls = 0 })

  it("repairs the exact started call with a sanitized result and private provenance", async () => {
    const fake = fixture()
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "unreconciled", toolCallId: callId, callItemId })
    await expect(reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now))
      .resolves.toMatchObject({ state: "recovered", toolCallId: callId, resultItemId: expect.any(String) })
    const call = fake.items.find(item => item.id === callItemId)!, result = fake.items.find(item => item.type === "tool_result")!
    const completion = batch.events.find(event => String(event.idempotencyKey).includes("tool-call-completed:"))!
    const content = (completion.payload as Record<string, unknown>).content as Record<string, unknown>
    const eventInput = content.input as Record<string, unknown>, storedInput = (call.content as Record<string, unknown>).input as Record<string, unknown>
    expect(call.status).toBe("completed")
    expect(storedInput.idempotencyKey).toBe(secretKey)
    expect(eventInput.taskIds).toEqual(["[REDACTED]"])
    expect(JSON.stringify(completion.payload)).not.toContain(taskId)
    expect(eventInput.idempotencyKey).not.toBe(secretKey)
    expect(JSON.stringify(completion.payload)).not.toContain(secretKey)
    expect(JSON.stringify((result.content as Record<string, unknown>).output)).not.toContain("+353 87 555 0199")
    expect(JSON.stringify(fake.wait.result)).toContain("sourceLifecycleRecovery")
    expect(JSON.stringify(fake.wait.result)).not.toContain(secretKey)
  })

  it("recognizes exact reentry without duplicating result items or events", async () => {
    const fake = fixture()
    await reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now)
    fake.wait.consumedAt = now
    const eventCount = batch.events.length
    await expect(reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now))
      .resolves.toMatchObject({ state: "recovered", toolCallId: callId })
    expect(fake.items.filter(item => item.type === "tool_result")).toHaveLength(1)
    expect(batch.events).toHaveLength(eventCount)
    expect(batch.calls).toBe(2)
  })

  it.each(["legacy", "safe"] as const)("accepts the exact %s waiting completion event", async projection => {
    const fake = waitingFixture(projection)
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "waiting", toolCallId: callId, callItemId })
    const eventCount = batch.events.length, callContent = fake.items.find(item => item.id === callItemId)!.content
    await expect(reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now))
      .resolves.toMatchObject({ state: "waiting", toolCallId: callId })
    expect(batch.events).toHaveLength(eventCount)
    expect(fake.items.find(item => item.id === callItemId)!.content).toEqual(callContent)
    expect(fake.wait.result).not.toHaveProperty("sourceLifecycleRecovery")
  })

  it("rejects a waiting completion event that differs from both raw and safe projections", async () => {
    const fake = waitingFixture("malformed")
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("accepts reentry under a new owner or later lease attempt but rejects malformed provenance", async () => {
    const fake = fixture()
    await reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now)
    fake.wait.consumedAt = now
    const reissued = { ...lease, ownerId: "expired-child-wait-worker-2", leaseExpiresAt: new Date(now.getTime() + 120_000) }
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, reissued, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "recovered", toolCallId: callId })
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, { ...reissued, attemptCount: lease.attemptCount + 1 }, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "recovered", sourceAttempt: lease.attemptCount, toolCallId: callId })
    const result = fake.wait.result as Record<string, unknown>
    fake.wait.result = { ...result, sourceLifecycleRecovery: { ...(result.sourceLifecycleRecovery as Record<string, unknown>), ownerId: "" } }
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, reissued, fake.wait, "step-1", fake.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("binds provenance to the persisted source attempt across a later lease attempt", async () => {
    const fake = fixture({ sourceAttempt: 1 })
    const firstLease = { ...lease, attemptCount: 1 }
    await reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, firstLease, fake.wait, "step-1", fake.result as never, now)
    fake.wait.consumedAt = now
    expect((fake.wait.result as Record<string, unknown>).sourceLifecycleRecovery).toMatchObject({ attempt: 1 })
    const retryLease = { ...lease, attemptCount: 2, ownerId: "retry-worker-2" }
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, retryLease, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "recovered", sourceAttempt: 1, toolCallId: callId })

    const futureSource = fixture({ sourceAttempt: 3 })
    await expect(inspectChildWaitSourceLifecycle(futureSource.client as never, retryLease, futureSource.wait, "step-1", futureSource.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
    const wrongMarker = fake.wait.result as Record<string, unknown>
    fake.wait.result = { ...wrongMarker, sourceLifecycleRecovery: { ...(wrongMarker.sourceLifecycleRecovery as Record<string, unknown>), attempt: 2 } }
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, retryLease, fake.wait, "step-1", fake.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, { ...retryLease, ownerId: "" }, fake.wait, "step-1", fake.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("rejects a scoped extra event correlated only to the recovered result item", async () => {
    const fake = fixture()
    await reconcileChildWaitSourceLifecycle(fake.pool as never, fake.client as never, lease, fake.wait, "step-1", fake.result as never, now)
    const result = fake.items.find(item => item.type === "tool_result")!
    batch.events.push({ id: "unrelated-item-result-correlation", sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
      itemId: "unrelated-item", type: "custom.event", actor: "model", correlationId: result.id, causationId: "foreign-event",
      sequence: batch.events.length + 1, idempotencyKey: "unrelated-key", payload: { marker: "malformed" } })
    fake.wait.consumedAt = now
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
      .rejects.toMatchObject({ code: "wait_scope_error" })
  })

  it("allows unrelated same-task event interleaving while requiring exact scoped causes", async () => {
    const fake = fixture()
    await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
      .resolves.toMatchObject({ state: "unreconciled" })
    for (const options of [{ wrongCause: true }, { wrongItemStartCause: true }, { extraResult: true }]) {
      const fake = fixture(options)
      await expect(inspectChildWaitSourceLifecycle(fake.client as never, lease, fake.wait, "step-1", fake.result as never))
        .rejects.toMatchObject({ code: "wait_scope_error" })
    }
  })
})
