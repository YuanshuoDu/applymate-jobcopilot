import { beforeEach, describe, expect, it, vi } from "vitest"

const sourceLifecycle = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock("./child-resume-source-wait-lifecycle.js", () => ({ inspectChildWaitSourceLifecycle: sourceLifecycle.inspect }))

import { loadChildConsumedWaitResume } from "./child-resume-consumed-wait.js"
import { loadChildWaitCallRecovery } from "./child-resume-wait-call-recovery.js"
import { childWaitClaimEventKey } from "./child-durable-wait-replay.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const now = new Date("2026-10-22T10:00:00.000Z")
const phoneId = "subagent-00000000-0000-4000-8000-000000000001"
const child = { id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/parent-1", depth: 1, role: "scout", taskType: "research", status: "running", goal: "", constraints: [], successCriteria: [],
  allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, modelProfileSnapshot: {}, result: null, failureReason: null,
  attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal } as SubagentLease

function fixture(options: { ids?: string[]; targetIds?: unknown; inputIds?: unknown; requestIds?: unknown; outcomeIds?: unknown;
  outcomeTaskId?: unknown; outcomeTaskIds?: string[]; receiptIds?: unknown; receiptWaitId?: unknown; receiptTaskIds?: unknown; targetParentId?: string;
  mode?: unknown; inputMode?: unknown; requestMode?: unknown; status?: unknown; outcomeStatus?: unknown; sourceAttempt?: number;
  matchedIds?: unknown; outcomeMatchedIds?: unknown; taskStatuses?: unknown[]; inputTimeoutMs?: unknown; requestTimeoutMs?: unknown;
  deadlineAt?: string | Date; receiptDeadlineAt?: string; missingReceipt?: boolean; sourceLifecycleMarker?: boolean; note?: string } = {}) {
  const ids = options.ids ?? [phoneId], targetIds = options.targetIds ?? ids
  const deadlineAt = options.deadlineAt ?? "2026-10-22T10:05:00.000Z"
  const deadlineIso = deadlineAt instanceof Date ? deadlineAt.toISOString() : deadlineAt
  const mode = options.mode ?? "any", status = options.status ?? "ready", matchedIds = options.matchedIds ?? [ids[0]]
  const taskStatuses = options.taskStatuses ?? ids.map((_, index) => index === 0 ? "completed" : "running")
  const outcomeTaskIds = options.outcomeTaskIds ?? ids
  const outcomeTasks = outcomeTaskIds.map((taskId, index) => ({ taskId: index === 0 ? options.outcomeTaskId ?? taskId : taskId,
    status: taskStatuses[ids.indexOf(taskId)], role: "writer", result: { answer: 42, ...(taskId === ids[0] && options.note ? { note: options.note } : {}) }, failureReason: null }))
  const outcome = { waitId: "wait-1", status: options.outcomeStatus ?? status, taskIds: options.outcomeIds ?? ids, deadlineAt: deadlineIso,
    matchedTaskIds: options.outcomeMatchedIds ?? matchedIds, tasks: outcomeTasks }
  const input = { idempotencyKey: "wait-key", taskIds: options.inputIds ?? ids, mode: options.inputMode ?? mode, timeoutMs: options.inputTimeoutMs ?? 5_000 }
  const row: Row = {
    waitId: "wait-1", stepId: "step-1", targetTaskIds: targetIds, idempotencyKey: "wait-key", mode, status, deadlineAt,
    matchedTaskIds: matchedIds, waitResult: { request: { targetTaskIds: options.requestIds ?? ids, mode: options.requestMode ?? mode,
      timeoutMs: options.requestTimeoutMs ?? 5_000 }, outcome, ...(options.sourceLifecycleMarker ? { sourceLifecycleRecovery: { ownerId: "private-marker" } } : {}) },
    attempt: options.sourceAttempt ?? 1, ordinal: 0, continuationStepId: "step-2", continuationOrdinal: 1, continuationLatestOrdinal: 1,
    callContent: { toolCallId: "call-1", toolName: "wait_subagents", input }, callStatus: options.missingReceipt ? "started" : "completed",
    sourceItemId: options.missingReceipt ? null : "item-result-1", resultContent: options.missingReceipt ? null : {
      toolCallId: "call-1", output: { waitId: options.receiptWaitId ?? "wait-1", status: "waiting", taskIds: options.receiptIds ?? ids,
        deadlineAt: options.receiptDeadlineAt ?? deadlineIso, matchedTaskIds: [], tasks: options.receiptTaskIds ?? [] }, errorCode: null,
    }, resultStatus: options.missingReceipt ? null : "completed",
  }
  const targets = ids.map((id, index) => ({ id, parentTaskId: index === 0 ? options.targetParentId ?? child.id : child.id,
    rootTaskId: child.rootTaskId, sessionId: child.sessionId, turnId: child.turnId, userId: child.userId }))
  const queries: string[] = []
  const client = { async query(sql: string) {
    queries.push(sql)
    if (sql.includes("WITH latest_wait AS")) return { rows: [row], rowCount: 1 }
    if (sql.includes('task."id" = ANY($1::text[])')) return { rows: targets, rowCount: targets.length }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, row, queries }
}

function claimFixture(options: { orphan?: boolean; resultWithoutStart?: boolean } = {}) {
  const stepId = `task:${child.id}:step:1:attempt:${child.attemptCount}`, callId = "fresh-wait-call"
  const sourceStepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
  const callItemId = `task:${child.id}:item:tool-call:${callId}:attempt:${child.attemptCount}`
  const resultItemId = `task:${child.id}:item:tool-result:${callId}:attempt:${child.attemptCount}`
  const claimKey = `task:${child.id}:event:${childWaitClaimEventKey(child.attemptCount, stepId)}`
  const wait: DurableWaitResume = {
    waitId: "wait-1", stepId: sourceStepId, attempt: child.attemptCount, ordinal: 0, toolCallId: "call-1", sourceItemId: "item-result-1",
    input: { idempotencyKey: "wait-key", taskIds: [phoneId], mode: "any", timeoutMs: 5_000 },
    output: { waitId: "wait-1", status: "ready", taskIds: [phoneId], matchedTaskIds: [phoneId] },
    continuationStepId: stepId, continuationOrdinal: 1,
  }
  const callContent = { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: wait.input,
    ...(options.resultWithoutStart ? { status: "completed", errorCode: null } : {}) }
  const modelStarted = { id: "model-started", sequence: "1", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "model.started", itemId: null, correlationId: stepId, causationId: null,
    idempotencyKey: `task:${child.id}:event:model-started:${stepId}`, payload: { taskId: child.id, provider: "fixture", model: "fixture-model" } }
  const modelCompleted = { id: "model-completed", sequence: "2", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "model.completed", itemId: null, correlationId: stepId, causationId: modelStarted.id,
    idempotencyKey: `task:${child.id}:event:model-completed:${stepId}`,
    payload: { taskId: child.id, provider: "fixture", model: "fixture-model", toolCallCount: 1 } }
  const modelUsage = { id: "model-usage", sequence: "3", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "model.usage", itemId: null, correlationId: stepId, causationId: modelCompleted.id,
    idempotencyKey: `task:${child.id}:event:model-usage:${stepId}`,
    payload: { taskId: child.id, provider: "fixture", model: "fixture-model", usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 } } }
  const step = { id: stepId, status: "streaming", attempt: child.attemptCount, ordinal: 1,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const itemStarted = { id: "call-item-started", sequence: "4", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "item.started", itemId: callItemId, correlationId: stepId, causationId: modelUsage.id,
    idempotencyKey: `task:${child.id}:event:item-started:${callItemId}`, payload: { itemId: callItemId, type: "tool_call", phase: null } }
  const claim = { id: "claim-event", sequence: "5", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
    type: "tool_call.started", itemId: callItemId, correlationId: callId, causationId: itemStarted.id,
    idempotencyKey: claimKey, payload: { toolCallId: callId, toolName: "wait_subagents", taskId: child.id } }
  const events: Row[] = [modelStarted, modelCompleted, modelUsage, itemStarted, ...(!options.orphan ? [claim] : [])]
  const callRows: Row[] = [{ id: callItemId, status: options.resultWithoutStart ? "completed" : "started", revision: options.resultWithoutStart ? 1 : 0,
    content: callContent, stepId, attempt: child.attemptCount, ordinal: 1 }]
  const resultRows: Row[] = options.resultWithoutStart ? [{ id: resultItemId, status: "started", revision: 0, stepId,
    content: { toolCallId: callId, output: wait.output, errorCode: null } }] : []
  if (options.resultWithoutStart) {
    const itemCompleted = { id: "call-item-completed", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
      type: "item.completed", itemId: callItemId, correlationId: callItemId, causationId: claim.id,
      idempotencyKey: `task:${child.id}:event:tool-call-completed:${callId}:${callItemId}:1`,
      payload: { itemId: callItemId, status: "completed", content: callContent } }
    events.push(itemCompleted, { id: "call-tool-completed", sessionId: child.sessionId, turnId: child.turnId, taskId: child.id, actor: "subagent",
      type: "tool_call.completed", itemId: callItemId, correlationId: callId, causationId: itemCompleted.id,
      idempotencyKey: `task:${child.id}:event:tool-finished:${callId}`,
      payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: child.id } })
  }
  const client = { async query(sql: string) {
    if (sql.includes('FROM "agent_steps" AS step WHERE step."id"')) return { rows: [step], rowCount: 1 }
    if (sql.includes('JOIN "agent_steps" AS step')) return { rows: callRows, rowCount: callRows.length }
    if (sql.includes("item.\"type\" = 'tool_result'")) return { rows: resultRows, rowCount: resultRows.length }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events, rowCount: events.length }
    throw new Error(`unexpected query: ${sql}`)
  } }
  return { client, wait, callItemId, claimKey, events, resultItemId, stepId }
}

describe("consumed child wait resume", () => {
  beforeEach(() => {
    sourceLifecycle.inspect.mockImplementation(async (_client: unknown, _lease: unknown, wait: unknown) => {
      const value = wait as Row, hasMarker = Object.hasOwn(value.result as object, "sourceLifecycleRecovery")
      return { state: hasMarker ? "recovered" : "waiting", toolCallId: "call-1", callItemId: "source-call-1", resultItemId: "item-result-1" }
    })
  })
  it("preserves validated phone-shaped IDs through the consumed loader and keeps free text redacted", async () => {
    const fake = fixture({ note: "Contact +353 87 123 4567" })
    const resumed = await loadChildConsumedWaitResume(fake.client as never, child)

    expect(resumed).toMatchObject({ input: { taskIds: [phoneId] }, output: { taskIds: [phoneId], tasks: [{ taskId: phoneId }] } })
    expect(JSON.stringify(resumed)).toContain(phoneId)
    expect(JSON.stringify(resumed)).not.toContain("+353 87 123 4567")
  })

  it("compares a PostgreSQL Date deadline at millisecond precision", async () => {
    const fake = fixture({ deadlineAt: new Date("2026-10-22T10:05:00.789Z") })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({ waitId: "wait-1" })
  })

  it("rejects receipt deadlines with a different millisecond or invalid timestamp", async () => {
    const mismatch = fixture({ deadlineAt: new Date("2026-10-22T10:05:00.789Z"), receiptDeadlineAt: "2026-10-22T10:05:00.788Z" })
    await expect(loadChildConsumedWaitResume(mismatch.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const invalid = fixture({ receiptDeadlineAt: "not-a-deadline" })
    await expect(loadChildConsumedWaitResume(invalid.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("preserves allowed input and receipt reordering without changing canonical output order", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, inputIds: ["child-2", phoneId], requestIds: ["child-2", phoneId], receiptIds: ["child-2", phoneId],
      outcomeIds: ["child-2", phoneId], outcomeTaskIds: ["child-2", phoneId] })
    const resumed = await loadChildConsumedWaitResume(fake.client as never, child)

    expect(resumed?.input).toMatchObject({ taskIds: ["child-2", phoneId] })
    expect(resumed?.output).toMatchObject({ taskIds: ids, tasks: [{ taskId: phoneId }, { taskId: "child-2" }] })
  })

  it("retains the consumed wait anchor after later same-attempt steps exist", async () => {
    const fake = fixture()
    fake.row.continuationLatestOrdinal = 4
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      waitId: "wait-1", continuationStepId: "step-2", continuationOrdinal: 1,
    })
    const lineage = fake.queries[0] ?? ""
    expect(lineage).not.toContain("continuationLatestOrdinal")
    expect(lineage).toContain('next."ordinal" = (SELECT MIN(later."ordinal")')
  })

  it("accepts a source wait from an earlier attempt and rejects a future source attempt", async () => {
    const currentLease = { ...child, attemptCount: 2 }
    const earlier = fixture({ sourceAttempt: 1 })
    await expect(loadChildConsumedWaitResume(earlier.client as never, currentLease)).resolves.toMatchObject({
      waitId: "wait-1", attempt: 1, stepId: "step-1",
    })
    expect(sourceLifecycle.inspect).toHaveBeenCalledWith(earlier.client, currentLease, expect.objectContaining({ stepId: "step-1" }), "step-1", expect.any(Object))

    const future = fixture({ sourceAttempt: 3 })
    await expect(loadChildConsumedWaitResume(future.client as never, currentLease)).rejects.toThrow("child_resume_wait_lineage")
    expect(sourceLifecycle.inspect).not.toHaveBeenCalledWith(future.client, currentLease, expect.anything(), expect.anything(), expect.anything())
  })

  it("rejects a consumed wait whose source result is still missing", async () => {
    const fake = fixture({ missingReceipt: true })
    sourceLifecycle.inspect.mockResolvedValue({ state: "unreconciled", toolCallId: "call-1", callItemId: "source-call-1" })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("keeps the internal lifecycle marker out of the model-facing resume", async () => {
    const fake = fixture({ sourceLifecycleMarker: true })
    const resumed = await loadChildConsumedWaitResume(fake.client as never, child)
    expect(resumed).toMatchObject({ waitId: "wait-1", output: { status: "ready" } })
    expect(JSON.stringify(resumed)).not.toContain("sourceLifecycleRecovery")
    expect(JSON.stringify(resumed)).not.toContain("private-marker")
  })

  it("accepts any-ready with a terminal match while another target is still running", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, mode: "any", matchedIds: [phoneId], taskStatuses: ["completed", "running"] })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      output: { status: "ready", matchedTaskIds: [phoneId], tasks: [{ taskId: phoneId }, { taskId: "child-2" }] },
    })
  })

  it("accepts all-ready when failed and cancelled targets are terminal", async () => {
    const ids = [phoneId, "child-2"]
    const fake = fixture({ ids, mode: "all", matchedIds: ids, taskStatuses: ["failed", "cancelled"] })
    await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({
      output: { status: "ready", matchedTaskIds: ids },
    })
  })

  it("accepts timed-out waits with empty, partial, or full terminal matches", async () => {
    const cases = [
      { ids: [phoneId, "child-2"], mode: "any", matchedIds: [], taskStatuses: ["running", "queued"] },
      { ids: [phoneId, "child-2", "child-3"], mode: "all", matchedIds: [phoneId, "child-3"], taskStatuses: ["failed", "running", "cancelled"] },
      { ids: [phoneId, "child-2"], mode: "all", matchedIds: [phoneId, "child-2"], taskStatuses: ["completed", "failed"] },
    ]
    for (const value of cases) {
      const fake = fixture({ ...value, status: "timed_out", deadlineAt: "2000-01-01T00:00:00.000Z" })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).resolves.toMatchObject({ output: { status: "timed_out" } })
    }
  })

  it("rejects inconsistent readiness, mode, timeout, and premature timeout snapshots", async () => {
    const anyRunning = fixture({ taskStatuses: ["running"] })
    await expect(loadChildConsumedWaitResume(anyRunning.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const allPartial = fixture({ ids: [phoneId, "child-2"], mode: "all", matchedIds: [phoneId], taskStatuses: ["completed", "running"] })
    await expect(loadChildConsumedWaitResume(allPartial.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const invalidMode = fixture({ mode: "either", inputMode: "either", requestMode: "either" })
    await expect(loadChildConsumedWaitResume(invalidMode.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    for (const timeout of [0, 30_001, 1.5]) {
      const invalidTimeout = fixture({ inputTimeoutMs: timeout, requestTimeoutMs: timeout })
      await expect(loadChildConsumedWaitResume(invalidTimeout.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    const mismatchedTimeout = fixture({ requestTimeoutMs: 4_000 })
    await expect(loadChildConsumedWaitResume(mismatchedTimeout.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const prematureTimeout = fixture({ status: "timed_out", matchedIds: [], taskStatuses: ["running"], deadlineAt: "2099-10-22T10:05:00.000Z" })
    await expect(loadChildConsumedWaitResume(prematureTimeout.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
  })

  it("rejects malformed, duplicated, foreign, and misbound target IDs", async () => {
    for (const targetIds of [[], [phoneId, phoneId], [phoneId, 9], ["foreign-child"], JSON.stringify([phoneId])]) {
      const fake = fixture({ targetIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_lineage")
    }
    for (const inputIds of [[], [phoneId, phoneId], [phoneId, false], ["foreign-child"]]) {
      const fake = fixture({ inputIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    for (const outcomeIds of [[], [phoneId, phoneId], [phoneId, null], ["foreign-child"]]) {
      const fake = fixture({ outcomeIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    }
    const forgedTask = fixture({ outcomeTaskId: "foreign-child" })
    await expect(loadChildConsumedWaitResume(forgedTask.client as never, child)).rejects.toThrow("child_resume_invalid_wait_result")
    const misbound = fixture({ targetParentId: "other-parent" })
    await expect(loadChildConsumedWaitResume(misbound.client as never, child)).rejects.toThrow("child_resume_wait_lineage")
  })

  it("rejects malformed or foreign IDs in an existing receipt while allowing the empty tasks projection", async () => {
    for (const receiptIds of [[], [phoneId, phoneId], [phoneId, "foreign-child"], [phoneId, 1]]) {
      const fake = fixture({ receiptIds })
      await expect(loadChildConsumedWaitResume(fake.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    }
    const foreignReceipt = fixture({ receiptWaitId: "wait-other" })
    await expect(loadChildConsumedWaitResume(foreignReceipt.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const forgedReceiptTask = fixture({ receiptTaskIds: [{ taskId: "foreign-child" }] })
    await expect(loadChildConsumedWaitResume(forgedReceiptTask.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
    const partialReceiptTasks = fixture({ ids: [phoneId, "child-2"], receiptTaskIds: [{ taskId: phoneId }] })
    await expect(loadChildConsumedWaitResume(partialReceiptTasks.client as never, child)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })
})

describe("claimed child wait recovery loader", () => {
  it("loads only a fixed-key claimed call tied to the acknowledged continuation", async () => {
    const fake = claimFixture()

    await expect(loadChildWaitCallRecovery(fake.client as never, child, fake.wait)).resolves.toMatchObject({
      claim: {
      owner: { id: child.id, ownerId: child.ownerId, attemptCount: child.attemptCount },
      stepId: fake.stepId, sourceWaitCallId: "call-1", call: { id: "fresh-wait-call", name: "wait_subagents" },
      callItem: { id: fake.callItemId, status: "started", revision: 0 }, claimEventId: "claim-event", output: fake.wait.output,
      }, orphanCallIds: [],
    })
    expect(fake.events[4]).toMatchObject({ idempotencyKey: fake.claimKey, causationId: fake.events[3]!.id })
  })

  it("recognizes one complete preclaim orphan without treating it as a claim", async () => {
    const fake = claimFixture({ orphan: true })
    await expect(loadChildWaitCallRecovery(fake.client as never, child, fake.wait)).resolves.toMatchObject({
      orphanCallIds: ["fresh-wait-call"], orphan: { call: { id: "fresh-wait-call", name: "wait_subagents" } },
    })
  })

  it("rejects an orphan with a result item", async () => {
    const fake = claimFixture({ orphan: true, resultWithoutStart: true })
    await expect(loadChildWaitCallRecovery(fake.client as never, child, fake.wait)).rejects.toThrow("child_resume_wait_tool_call_conflict")
  })

  it("recognizes a persisted result item whose start event needs idempotent repair", async () => {
    const fake = claimFixture({ resultWithoutStart: true })
    await expect(loadChildWaitCallRecovery(fake.client as never, child, fake.wait)).resolves.toMatchObject({
      claim: { callItem: { status: "completed", revision: 1 }, resultItem: { id: fake.resultItemId, status: "started", revision: 0 } },
      orphanCallIds: [],
    })
  })
})
