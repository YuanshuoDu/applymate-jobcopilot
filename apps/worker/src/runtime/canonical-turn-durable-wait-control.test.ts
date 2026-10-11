import { describe, expect, it, vi } from "vitest"

import { projectDurableWaitOutcome } from "./subagents/durable-wait-dependency-revalidation.js"
import type { DurableWaitControlReader } from "./tools/coordination-types.js"
import { toRepositoryJson } from "./turns/turn-engine-types.js"
import type { TurnExecutionIdentity } from "./turns/turn-execution-types.js"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { recoverCanonicalArchivedWaitControl } from "./canonical-turn-durable-wait-control.js"

const waitId = "wait-00000000-0000-4000-8000-000000000001"
const turnId = "turn-1"
const rootTaskId = "root-1"
const stepId = "step-1"
const callId = "call-1"
const reference = { $ref: "tool-result-00000000-0000-4000-8000-000000000002", sizeBytes: 9_000, sha256: "a".repeat(64) }
const input = { idempotencyKey: "wait-key", taskIds: ["child-1"], mode: "all", timeoutMs: 10_000 }
const identity: TurnExecutionIdentity = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId, taskId: rootTaskId, rootTaskId,
  ownerId: "worker-1", leaseVersion: 7, leaseExpiresAt: new Date("2026-10-11T12:01:00.000Z"),
}

function state(options: { status?: string; stepTaskId?: string | null; modelToolCallCount?: number | null; stepUsage?: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } } = {}) {
  const step = {
    id: stepId, taskId: options.stepTaskId === undefined ? rootTaskId : options.stepTaskId, ordinal: 0, status: options.status ?? "running", finishReason: "tool_calls", errorCode: null,
    inputTokens: options.stepUsage?.inputTokens ?? 0, outputTokens: options.stepUsage?.outputTokens ?? 0,
    estimatedCostUsd: options.stepUsage?.estimatedCostUsd ?? 0,
  }
  const callItem = { id: "call-item", type: "tool_call", status: "completed", stepId, taskId: rootTaskId,
    content: { toolCallId: callId, toolName: "agent.wait", input, status: "completed" } }
  const resultItem = { id: "result-item", type: "tool_result", status: "completed", stepId, taskId: rootTaskId,
    content: { toolCallId: callId, output: reference, errorCode: null } }
  const events: Array<Record<string, unknown>> = [
    { id: "model-start", type: "model.started", actor: "orchestrator", userId: identity.userId, sessionId: identity.sessionId,
      turnId, taskId: rootTaskId, itemId: null, correlationId: stepId, causationId: null,
      idempotencyKey: `turn:${turnId}:event:model-started:${stepId}`, sequence: "1", payload: { taskId: rootTaskId, provider: "fixture", model: "fixture" } },
    { id: "model-done", type: "model.completed", actor: "orchestrator", userId: identity.userId, sessionId: identity.sessionId,
      turnId, taskId: rootTaskId, itemId: null, correlationId: stepId, causationId: "model-start",
      idempotencyKey: `turn:${turnId}:event:model-completed:${stepId}`, sequence: "2", payload: {
        taskId: rootTaskId, provider: "fixture", model: "fixture", ...(options.modelToolCallCount === null ? {} : { toolCallCount: options.modelToolCallCount ?? 1 }),
      } },
    { id: "model-usage", type: "model.usage", actor: "orchestrator", userId: identity.userId, sessionId: identity.sessionId,
      turnId, taskId: rootTaskId, itemId: null, correlationId: stepId, causationId: "model-done",
      idempotencyKey: `turn:${turnId}:event:model-usage:${stepId}`, sequence: "3",
      payload: { taskId: rootTaskId, provider: "fixture", model: "fixture", usage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } } },
    { id: "tool-done", type: "tool_call.completed", actor: "orchestrator", userId: identity.userId, sessionId: identity.sessionId,
      turnId, taskId: rootTaskId, itemId: "call-item", correlationId: callId, causationId: "model-usage",
      idempotencyKey: `turn:${turnId}:event:tool-finished:${callId}`, sequence: "4",
      payload: { toolCallId: callId, toolName: "agent.wait", status: "completed", errorCode: null, taskId: rootTaskId } },
  ]
  const observations = [{ id: `tool-result:${callId}`, content: { toolCallId: callId, toolName: "agent.wait", input, status: "completed", output: reference, errorCode: null } }]
  return { step, callItem, resultItem, items: [callItem, resultItem], events, observations }
}

function twoCallPrefixState() {
  const value = state({ status: "streaming", modelToolCallCount: 3 })
  const createdAt = new Date("2026-10-11T12:00:00.000Z")
  const priorId = "prior-call"
  const waitCall = { ...value.callItem, id: "a-wait-call-item", createdAt }
  const waitResult = { ...value.resultItem, id: "b-wait-result-item", createdAt }
  const priorCall = { ...value.callItem, id: "y-prior-call-item", createdAt,
    content: { toolCallId: priorId, toolName: "agent.plan", input: {}, status: "completed" } }
  const priorResult = { ...value.resultItem, id: "z-prior-result-item", createdAt,
    content: { toolCallId: priorId, output: { planned: true }, errorCode: null } }
  const waitFinished = value.events.find(event => event.id === "tool-done")!
  const priorFinished = { ...waitFinished, id: "prior-finished", itemId: priorCall.id, correlationId: priorId,
    idempotencyKey: `turn:${turnId}:event:tool-finished:${priorId}`, sequence: "4",
    payload: { toolCallId: priorId, toolName: "agent.plan", status: "completed", taskId: rootTaskId } }
  const finishedWait = { ...waitFinished, itemId: waitCall.id, sequence: "5" }
  const observations = [
    { id: `tool-result:${priorId}`, content: { toolCallId: priorId, toolName: "agent.plan", input: {}, status: "completed", output: { planned: true }, errorCode: null } },
    ...value.observations,
  ]
  return { ...value, callItem: waitCall, resultItem: waitResult,
    // Equal item timestamps and lexical IDs put the wait before its earlier executed call.
    items: [waitCall, waitResult, priorCall, priorResult],
    events: [...value.events.filter(event => event.type !== "tool_call.completed" && event.type !== "tool_call.failed"), priorFinished, finishedWait],
    observations }
}

function snapshot(toolObservations: StepContextSnapshot["toolObservations"]): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations }
}

function reader(status: "waiting" | "ready" | "timed_out" | "interrupted" = "waiting") {
  const readByInvocation = vi.fn(async () => ({ waitId, status }))
  return { value: { readByInvocation } satisfies DurableWaitControlReader, readByInvocation }
}

function recover(value: ReturnType<typeof state>, options: {
  status?: "waiting" | "ready" | "timed_out" | "interrupted"; observations?: StepContextSnapshot["toolObservations"]
  step?: ReturnType<typeof state>["step"]; events?: ReturnType<typeof state>["events"]; reader?: DurableWaitControlReader
} = {}) {
  const observations = options.observations ?? value.observations
  return recoverCanonicalArchivedWaitControl({ identity, steps: [options.step ?? value.step], items: value.items,
    events: options.events ?? value.events, observations, snapshot: snapshot(observations),
    reader: options.reader ?? reader(options.status).value, now: new Date("2026-10-11T12:00:30.000Z") })
}

describe("canonical archived-wait state recovery", () => {
  it("recovers only the exact current root Step using its persisted model-usage receipt", async () => {
    const value = state()
    const reads = reader()
    const recovered = await recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations: value.observations, snapshot: snapshot(value.observations), reader: reads.value, now: new Date("2026-10-11T12:00:30.000Z") })
    expect(recovered).toMatchObject({ waitId, status: "waiting", stepId, stepStatus: "running", inputTokens: 17, outputTokens: 5,
      estimatedCostUsd: 0.003, toolCallCount: 1, persistedToolCallCount: 1, usageDelta: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 },
      stepCompletionRecorded: false, canonicalOutcomeResolved: false })
    expect(reads.readByInvocation).toHaveBeenCalledOnce()
    expect(reads.readByInvocation).toHaveBeenCalledWith(expect.objectContaining({ userId: identity.userId, sessionId: identity.sessionId,
      turnId, stepId, taskId: rootTaskId, rootTaskId, ownerId: identity.ownerId, leaseVersion: identity.leaseVersion,
      targetTaskIds: ["child-1"], mode: "all", timeoutMs: 10_000, idempotencyKey: "wait-key" }), "restored_inflight_root")
  })

  it("marks an exact ready projection resolved without losing its call or usage accounting", async () => {
    const value = state({ status: "waiting_for_tool", stepUsage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } })
    const result = { waitId, status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed" }] }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(result), taskIds: ["child-1"], mode: "all" })
    const observations = [...value.observations, projection]
    const reads = reader("ready")
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations, snapshot: snapshot(observations), reader: reads.value, now: new Date("2026-10-11T12:00:30.000Z") }))
      .resolves.toMatchObject({ status: "ready", canonicalOutcomeResolved: true, toolCallCount: 1, usageDelta: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })
    expect(reads.readByInvocation).toHaveBeenCalledOnce()
  })

  it("marks an exact consumed interrupted projection resolved without another suspension", async () => {
    const value = state({ status: "waiting_for_tool", stepUsage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } })
    const result = {
      waitId, status: "interrupted", targetTaskIds: ["child-1"], matchedTaskIds: [],
      tasks: [{ taskId: "child-1", status: "running", role: "scout", result: null, failureReason: null }],
    }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(result), taskIds: ["child-1"], mode: "all" })
    const observations = [...value.observations, projection]
    const reads = reader("interrupted")
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations, snapshot: snapshot(observations), reader: reads.value, now: new Date("2026-10-11T12:00:30.000Z") }))
      .resolves.toMatchObject({ status: "interrupted", canonicalOutcomeResolved: true })
    expect(reads.readByInvocation).toHaveBeenCalledOnce()
  })

  it("admits only a receipt-counted streaming Root prefix ending at the exact archived wait", async () => {
    const value = state({ status: "streaming", modelToolCallCount: 3 }), reads = reader()
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations: value.observations, snapshot: snapshot(value.observations), reader: reads.value,
      now: new Date("2026-10-11T12:00:30.000Z") })).resolves.toMatchObject({
      stepStatus: "streaming", toolCallCount: 3, persistedToolCallCount: 1,
      usageDelta: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 },
    })
    expect(reads.readByInvocation).toHaveBeenCalledOnce()

    const noCount = state({ status: "streaming", modelToolCallCount: null }), unread = reader()
    await expect(recover(noCount, { reader: unread.value })).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(unread.readByInvocation).not.toHaveBeenCalled()
    const underCount = state({ status: "streaming", modelToolCallCount: 0 })
    await expect(recover(underCount)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("orders a tied-item two-call prefix by exact finish receipt sequence", async () => {
    const value = twoCallPrefixState(), reads = reader()
    expect(value.items.filter(item => item.type === "tool_call").map(item => item.content.toolCallId)).toEqual([callId, "prior-call"])
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations: value.observations, snapshot: snapshot(value.observations), reader: reads.value,
      now: new Date("2026-10-11T12:00:30.000Z") })).resolves.toMatchObject({
      status: "waiting", toolCallCount: 3, persistedToolCallCount: 2, stepStatus: "streaming",
    })
    expect(reads.readByInvocation).toHaveBeenCalledOnce()
  })

  it.each([
    ["a later executed call after the wait", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "6" } : event)],
    ["duplicate receipt sequence", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "5" } : event)],
    ["a receipt before model usage", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "2" } : event)],
  ])("rejects %s in the persisted prefix", async (_name, reviseEvents) => {
    const value = twoCallPrefixState(), reads = reader()
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: reviseEvents(value.events),
      observations: value.observations, snapshot: snapshot(value.observations), reader: reads.value,
      now: new Date("2026-10-11T12:00:30.000Z") })).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(reads.readByInvocation).not.toHaveBeenCalled()
  })

  it("requires exact Root identities throughout a streaming prefix but retains legacy running Step compatibility", async () => {
    const streaming = state({ status: "streaming", modelToolCallCount: 1 })
    const cases = [
      { rejects: false, step: { ...streaming.step, taskId: null }, items: streaming.items, events: streaming.events },
      { rejects: false, step: { ...streaming.step, taskId: "foreign-root" }, items: streaming.items, events: streaming.events },
      { rejects: true, step: streaming.step, items: streaming.items.map(item => item.type === "tool_call" ? { ...item, taskId: null } : item), events: streaming.events },
      { rejects: false, step: streaming.step, items: streaming.items.map(item => item.type === "tool_call" ? { ...item, taskId: "foreign-root" } : item), events: streaming.events },
      { rejects: true, step: streaming.step, items: streaming.items.map(item => item.type === "tool_result" ? { ...item, taskId: null } : item), events: streaming.events },
      { rejects: false, step: streaming.step, items: streaming.items.map(item => item.type === "tool_result" ? { ...item, taskId: "foreign-root" } : item), events: streaming.events },
      { rejects: true, step: streaming.step, items: streaming.items, events: streaming.events.map(event => event.type === "tool_call.completed" ? { ...event, taskId: null } : event) },
      { rejects: true, step: streaming.step, items: streaming.items, events: streaming.events.map(event => event.type === "tool_call.completed" ? { ...event, taskId: "foreign-root" } : event) },
    ]
    for (const value of cases) {
      const reads = reader()
      const recovered = recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
        observations: streaming.observations, snapshot: snapshot(streaming.observations), reader: reads.value,
        now: new Date("2026-10-11T12:00:30.000Z") })
      if (value.rejects) await expect(recovered).rejects.toMatchObject({ code: "persistence_conflict" })
      else await expect(recovered).resolves.toBeUndefined()
      expect(reads.readByInvocation).not.toHaveBeenCalled()
    }

    const legacyStep = state({ status: "running", stepTaskId: null })
    const legacyItems = legacyStep.items.map(item => ({ ...item, taskId: null }))
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [legacyStep.step], items: legacyItems, events: legacyStep.events,
      observations: legacyStep.observations, snapshot: snapshot(legacyStep.observations), reader: reader().value,
      now: new Date("2026-10-11T12:00:30.000Z") })).resolves.toMatchObject({ stepStatus: "running", waitId })
  })

  it("accepts the server Step completion count for a persisted prefix and rejects a wait not at its end", async () => {
    const value = state({ status: "waiting_for_tool", modelToolCallCount: 3,
      stepUsage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } })
    const completion = { id: "step-completed", type: "step.completed", actor: "orchestrator", userId: identity.userId,
      sessionId: identity.sessionId, turnId, taskId: rootTaskId, itemId: null, correlationId: stepId, causationId: "tool-done",
      idempotencyKey: `turn:${turnId}:event:step-completed:${stepId}`, sequence: "5",
      payload: { stepId, status: "waiting_for_dependency", toolCallCount: 3, taskId: rootTaskId } }
    const completed = await recover(value, { events: [...value.events, completion] })
    expect(completed).toMatchObject({ toolCallCount: 3, persistedToolCallCount: 1, stepCompletionRecorded: true })

    const later = { id: "tail-call-item", type: "tool_call", status: "completed", stepId, taskId: rootTaskId,
      content: { toolCallId: "tail-call", toolName: "agent.plan", input: {}, status: "completed" } }
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: [...value.items, later],
      events: value.events, observations: value.observations, snapshot: snapshot(value.observations), reader: reader().value,
      now: new Date("2026-10-11T12:00:30.000Z") })).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it.each([
    ["missing interrupted projection", (_projection: ReturnType<typeof projectDurableWaitOutcome>, value: ReturnType<typeof state>) => value.observations],
    ["wrong projection ID", (projection: ReturnType<typeof projectDurableWaitOutcome>, value: ReturnType<typeof state>) => [...value.observations, { ...projection, id: "wait-result:foreign" }]],
    ["wrong projected targets", (projection: ReturnType<typeof projectDurableWaitOutcome>, value: ReturnType<typeof state>) => {
      const content = projection.content as Record<string, unknown>
      const output = content.output as Record<string, unknown>
      return [...value.observations, { ...projection, content: { ...content, output: { ...output, targetTaskIds: ["child-other"] } } }]
    }],
    ["resolved rather than interrupted status", (projection: ReturnType<typeof projectDurableWaitOutcome>, value: ReturnType<typeof state>) => {
      const content = projection.content as Record<string, unknown>
      const output = content.output as Record<string, unknown>
      return [...value.observations, { ...projection, content: { ...content, output: { ...output, status: "ready", matchedTaskIds: ["child-1"] } } }]
    }],
    ["interrupted all wait already fully matched", (projection: ReturnType<typeof projectDurableWaitOutcome>, value: ReturnType<typeof state>) => {
      const content = projection.content as Record<string, unknown>
      const output = content.output as Record<string, unknown>
      return [...value.observations, { ...projection, content: { ...content, output: { ...output, matchedTaskIds: ["child-1"] } } }]
    }],
  ])("fails closed for %s", async (_name, buildObservations) => {
    const value = state({ status: "waiting_for_tool", stepUsage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } })
    const result = {
      waitId, status: "interrupted", targetTaskIds: ["child-1"], matchedTaskIds: [],
      tasks: [{ taskId: "child-1", status: "running", role: "scout", result: null, failureReason: null }],
    }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(result), taskIds: ["child-1"], mode: "all" })
    const observations = buildObservations(projection, value)
    await expect(recover(value, { status: "interrupted", observations })).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it.each([
    ["mismatched nonzero Step counters", state({ stepUsage: { inputTokens: 18, outputTokens: 5, estimatedCostUsd: 0.003 } })],
    ["fractional token counters", state({ stepUsage: { inputTokens: 17.5, outputTokens: 5, estimatedCostUsd: 0.003 } })],
  ])("fails closed for %s", async (_name, value) => {
    await expect(recover(value)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("rejects foreign, duplicated, or causally inconsistent usage receipts", async () => {
    const value = state()
    const cases = [
      value.events.map(event => event.id === "model-usage" ? { ...event, userId: "other-user" } : event),
      [...value.events, value.events[0]!],
      value.events.map(event => event.id === "model-usage" ? { ...event, causationId: "foreign-event" } : event),
    ]
    for (const events of cases) await expect(recover(value, { events })).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("requires model usage to precede the archived wait completion event", async () => {
    const value = state()
    const events = value.events.map(event => event.id === "model-usage" ? { ...event, sequence: "5" } : event)
    await expect(recover(value, { events })).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("requires an exact reader before interpreting any matching outcome projection", async () => {
    const value = state()
    const result = { waitId, status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "completed" }] }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(result), taskIds: ["child-1"], mode: "all" })
    const observations = [...value.observations, projection]
    await expect(recoverCanonicalArchivedWaitControl({ identity, steps: [value.step], items: value.items, events: value.events,
      observations, snapshot: snapshot(observations), now: new Date("2026-10-11T12:00:30.000Z") })).rejects.toMatchObject({ code: "persistence_conflict" })
  })
})
