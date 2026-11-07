import { describe, expect, it } from "vitest"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"
import { record } from "./pg-store-expiry-step-tool-chain-proof.js"
import { HISTORICAL_SOURCE_STEP_PREFIX_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"
import { readCanonicalHistoricalSourceStepPrefix } from "./pg-store-expiry-historical-source-step-prefix.js"

const task = { id: "task-1", sessionId: "session-1", turnId: "turn-1" }
const stepId = "task:task-1:step:0:attempt:1"
const waitCallId = "wait-call"
const waitItemId = `task:${task.id}:item:tool-call:${waitCallId}:attempt:1`
const waitResultId = `task:${task.id}:item:tool-result:${waitCallId}:attempt:1`
type Event = Record<string, unknown> & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown; payloadDigest: string }
type Item = Record<string, unknown> & { id: string; sessionId: string; turnId: string; taskId: string; stepId: string; type: string;
  status: string; revision: number; phase: string | null; content: unknown; contentDigest: string }

function fixture(priorTool: { name?: string; status?: "completed" | "failed" | "cancelled" | "started"; errorCode?: string | null;
  omitPriorTool?: boolean; omitCommentary?: boolean; handoff?: boolean; toolCallCount?: number; extraAfterWait?: boolean;
  orphanStarted?: boolean; stepStatus?: string } = {}) {
  let sequence = 0
  let previous: string | null = null
  const events: Event[] = [], items: Item[] = []
  const add = (type: string, key: string, correlationId: string, itemId: string | null, payload: unknown): Event => {
    const id = `event-${++sequence}`
    const event: Event = { id, sequence: String(sequence), type, actor: "subagent", itemId, correlationId,
      causationId: previous, idempotencyKey: `task:${task.id}:event:${key}`, payload, payloadDigest: "a".repeat(64) }
    events.push(event); previous = id; return event
  }
  add("step.started", `step-started:${stepId}`, stepId, null, { stepId, ordinal: 0, taskId: task.id })
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: task.sessionId, turnId: task.turnId, stepId,
    inputThroughSequence: 1n, consumedInputIds: [], blocks: [], canonicalJson: "{}" }
  const agenda = buildCognitiveAgendaReceipt({ sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId,
    agenda: buildCognitiveActionAgenda(context) })
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  if (!agenda || !agendaKey) throw new Error("fixture_agenda_invalid")
  add(COGNITIVE_AGENDA_EVENT_TYPE, agendaKey, stepId, null, agenda)
  add("model.started", `model-started:${stepId}`, stepId, null, { taskId: task.id, provider: "fixture", model: "test-model" })
  const calls = [
    ...priorTool.omitPriorTool ? [] : [{ id: "noop-call", itemId: "noop-item", resultId: "noop-result", name: priorTool.name ?? "fixture_noop",
      status: priorTool.status ?? "completed", errorCode: priorTool.errorCode ?? null,
      input: { privateInput: "do-not-copy" }, output: { ok: true, privateOutput: "do-not-copy-output" } }],
    { id: waitCallId, itemId: waitItemId, resultId: waitResultId, name: "wait_subagents",
      input: { idempotencyKey: "api_key=private-source-key", taskIds: ["child-1"], mode: "any", timeoutMs: 30_000 },
      output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], deadlineAt: "2026-11-06T00:00:00.001Z", matchedTaskIds: [],
        tasks: [{ taskId: "child-1", status: "running", role: "analyst", result: null, failureReason: null }] } },
    ...priorTool.extraAfterWait ? [{ id: "extra-call", itemId: "extra-item", resultId: "extra-result", name: "fixture_extra",
      input: { privateInput: "do-not-copy" }, output: { ok: true } }] : [],
  ]
  add("model.completed", `model-completed:${stepId}`, stepId, null,
    { taskId: task.id, provider: "fixture", model: "test-model", toolCallCount: priorTool.toolCallCount ?? calls.length })
  add("model.usage", `model-usage:${stepId}`, stepId, null,
    { taskId: task.id, provider: "fixture", model: "test-model", usage: { inputTokens: 3, outputTokens: 2, estimatedCostUsd: 0.01 } })
  if (priorTool.orphanStarted) add("tool_call.started", "tool-started:orphan-call", "orphan-call", "orphan-item",
    { toolCallId: "orphan-call", toolName: "fixture_unbound", taskId: task.id })
  const commentaryId = "private-commentary-item", commentary = { text: "private source commentary" }
  if (!priorTool.omitCommentary) {
    items.push({ id: commentaryId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "agent_message",
      status: "completed", revision: 2, phase: "commentary", content: commentary, contentDigest: "b".repeat(64) })
    add("item.started", `item-started:${commentaryId}`, stepId, commentaryId,
      { itemId: commentaryId, type: "agent_message", phase: "commentary" })
    add("item.delta", `commentary-delta:${commentaryId}:1`, commentaryId, commentaryId,
      { itemId: commentaryId, status: "streaming", content: commentary })
    add("item.completed", `commentary-completed:${commentaryId}:2`, commentaryId, commentaryId,
      { itemId: commentaryId, status: "completed", content: commentary })
  }
  for (const call of calls) {
    const status = call.status ?? "completed", errorCode = call.errorCode ?? null
    const callContent = { toolCallId: call.id, toolName: call.name, toolVersion: "1", input: call.input, status, errorCode }
    const resultContent = { toolCallId: call.id, output: call.output, errorCode }
    items.push({ id: call.itemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "tool_call",
      status: "completed", revision: 1, phase: null, content: callContent, contentDigest: "c".repeat(64) })
    items.push({ id: call.resultId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "tool_result",
      status: "completed", revision: 1, phase: null, content: resultContent, contentDigest: "d".repeat(64) })
    add("item.started", `item-started:${call.itemId}`, stepId, call.itemId, { itemId: call.itemId, type: "tool_call", phase: null })
    const callStarted = add("tool_call.started", `tool-started:${call.id}`, call.id, call.itemId,
      { toolCallId: call.id, toolName: call.name, taskId: task.id })
    const completedCallItem = add("item.completed", `tool-call-completed:${call.id}:${call.itemId}:1`, call.itemId, call.itemId,
      projectWaitCallCompletionPayload({ itemId: call.itemId, status: "completed", content: callContent }, call.itemId))
    completedCallItem.causationId = callStarted.id
    add(status === "completed" ? "tool_call.completed" : "tool_call.failed", `tool-finished:${call.id}`, call.id, call.itemId,
      { toolCallId: call.id, toolName: call.name, status, errorCode, taskId: task.id })
    add("item.started", `item-started:${call.resultId}`, stepId, call.resultId, { itemId: call.resultId, type: "tool_result", phase: null })
    add("item.completed", `tool-result-completed:${call.id}:${call.resultId}:1`, call.resultId, call.resultId,
      { itemId: call.resultId, status: "completed", content: resultContent })
  }
  if (!priorTool.handoff) add("step.completed", `step-completed:${stepId}`, stepId, null,
    { stepId, status: "waiting_for_dependency", toolCallCount: calls.length, taskId: task.id })
  const anchorKeys = new Set([`task:${task.id}:event:step-started:${stepId}`, `task:${task.id}:event:model-started:${stepId}`,
    `task:${task.id}:event:model-completed:${stepId}`, `task:${task.id}:event:model-usage:${stepId}`,
    priorTool.handoff ? `task:${task.id}:event:tool-result-completed:${waitCallId}:${waitResultId}:1` : `task:${task.id}:event:step-completed:${stepId}`,
    `task:${task.id}:event:${agendaKey}`])
  return { events, items, anchors: events.filter(event => anchorKeys.has(event.idempotencyKey)),
    stepStatus: priorTool.stepStatus ?? (priorTool.handoff ? "waiting_for_tool" : "completed") }
}

function mockClient(value: ReturnType<typeof fixture>) {
  return { query: async (sql: string, parameters?: readonly unknown[]) => sql.includes('FROM "agent_items"') ? { rows: value.items }
    : sql.includes('FROM "agent_steps"') ? { rows: [{ status: value.stepStatus }] }
      : sql.includes(`"type" = 'step.completed'`) ? { rows: value.events.filter(event => event.type === "step.completed"
        && (event.correlationId === parameters?.[3] || event.idempotencyKey === parameters?.[4])) }
        : sql.includes('"sequence" BETWEEN') ? { rows: value.events } : { rows: value.anchors } } as never
}
function sqlBalance(sql: string): number {
  let depth = 0, quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) { if (char === quote) { if (sql[index + 1] === quote) { index += 1; continue } quote = null } continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return depth
  }
  return quote ? Number.NaN : depth
}

describe("historical source wait step prefix", () => {
  it("accepts the minimum writer shape with only the wait call and result items", async () => {
    const value = fixture({ omitPriorTool: true, omitCommentary: true })
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "normal_waiting",
    })
    expect(proof?.items).toHaveLength(2)
    expect(proof?.events).toHaveLength(12)
  })

  it("proves agenda, model lineage, and ordered completed tools through a non-first wait", async () => {
    const value = fixture()
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "normal_waiting",
    })
    expect(proof).toMatchObject({ stepId, sourceCallItemId: waitItemId, sourceCallId: waitCallId, sourceResultItemId: waitResultId,
      waitKind: "normal_waiting", events: expect.arrayContaining([expect.objectContaining({ type: "cognitive.agenda" })]) })
    expect(proof?.events.at(-2)?.type).toBe("item.completed")
    expect(JSON.stringify(proof)).not.toContain("private source commentary")
    expect(JSON.stringify(proof)).not.toContain("api_key=private-source-key")
    expect(JSON.stringify(proof)).not.toContain("do-not-copy")
  })

  it("proves a bounded recovered handoff after a fully persisted prior tool", async () => {
    const value = fixture({ handoff: true, omitCommentary: true })
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })
    expect(proof).toMatchObject({ stepId, sourceCallItemId: waitItemId, sourceCallId: waitCallId,
      sourceResultItemId: waitResultId, waitKind: "recovered", terminalMode: "recovered_handoff",
      stepStartedEventId: "event-1", stepCompletedEventId: null })
    expect(proof?.items).toHaveLength(4)
    expect(proof?.events).toHaveLength(17)
    expect(proof?.events.at(-1)?.type).toBe("item.completed")
    expect(JSON.stringify(proof)).not.toContain("privateInput")
    expect(JSON.stringify(proof)).not.toContain("privateOutput")
    expect(JSON.stringify(proof)).not.toContain("private-source-key")
  })

  it("allows requested calls after wait to remain unexecuted and unpersisted", async () => {
    const value = fixture({ handoff: true, omitPriorTool: true, omitCommentary: true, toolCallCount: 2 })
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })
    expect(proof?.items).toHaveLength(2)
    expect(proof?.events.at(-1)?.type).toBe("item.completed")
  })

  it.each([
    ["wait is not the final persisted call", { handoff: true, omitCommentary: true, extraAfterWait: true }],
    ["source step is not waiting for the recovered handoff", { handoff: true, omitCommentary: true, stepStatus: "completed" }],
    ["recovered handoff also has a step completion", { handoff: true, omitCommentary: true, extraAfterWait: false, stepStatus: "waiting_for_tool" }],
    ["a pending prior tool is not terminal", { handoff: true, omitCommentary: true, status: "started" as const }],
    ["an orphan started event has no persisted call item", { handoff: true, omitCommentary: true, orphanStarted: true }],
  ])("rejects recovered handoff when %s", async (_label, options) => {
    const value = fixture(options)
    if (_label === "recovered handoff also has a step completion") {
      const stepComplete = { ...value.events.at(-1)!, id: "extra-step-complete", sequence: String(value.events.length + 1),
        type: "step.completed", itemId: null, correlationId: stepId, idempotencyKey: `task:${task.id}:event:step-completed:${stepId}` }
      value.events.push(stepComplete)
    }
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })).resolves.toBeNull()
  })

  it("requires a unique started-event chain for every persisted call in a recovered handoff", async () => {
    const value = fixture({ handoff: true, omitCommentary: true })
    value.events.splice(value.events.findIndex(event => event.idempotencyKey.endsWith("tool-started:noop-call")), 1)
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })).resolves.toBeNull()
  })

  it("rejects a persisted call whose result item is missing", async () => {
    const value = fixture({ handoff: true, omitCommentary: true })
    value.items.splice(value.items.findIndex(item => item.id === "noop-result"), 1)
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })).resolves.toBeNull()
  })

  it("rejects a recovered handoff with a canonical completion key and mismatched correlation", async () => {
    const value = fixture({ handoff: true, omitCommentary: true })
    value.events.push({ ...value.events.at(-1)!, id: "contradictory-step-close", sequence: String(value.events.length + 1),
      type: "step.completed", itemId: null, correlationId: "unrelated-step", idempotencyKey: `task:${task.id}:event:step-completed:${stepId}` })
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })).resolves.toBeNull()
  })

  it.each([
    ["failed", "tool_execution_failed"],
    ["cancelled", "timeout"],
  ] as const)("keeps the writer-validated %s prior-tool terminal chain", async (status, errorCode) => {
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(fixture({ handoff: true, omitCommentary: true, status, errorCode })), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId,
      waitKind: "recovered", terminalMode: "recovered_handoff",
    })
    expect(proof?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_call.failed", status, errorCode })]))
  })

  it.each([
    ["generic executor exception", "failed" as const, "tool_execution_failed"],
    ["provider failure", "failed" as const, "provider_unavailable"],
    ["schema rejection", "failed" as const, "schema_error"],
    ["ordinary policy denial", "failed" as const, "policy_denied"],
    ["nullable ordinary failure", "failed" as const, null],
    ["router timeout cancellation", "cancelled" as const, "timeout"],
    ["router cancellation", "cancelled" as const, "cancelled"],
  ])("proves a fully settled %s before the wait without returning its payload", async (_label, status, errorCode) => {
    const value = fixture({ status, errorCode })
    const proof = await readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "recovered",
    })
    expect(proof?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_call.failed", status, errorCode })]))
    expect(JSON.stringify(proof)).not.toContain("privateInput")
    expect(JSON.stringify(proof)).not.toContain("privateOutput")
    expect(JSON.stringify(proof)).not.toContain("do-not-copy")
  })

  it.each([
    ["early approval return", { status: "failed" as const, errorCode: "policy_requires_approval" }],
    ["early user-input return", { status: "failed" as const, errorCode: "policy_requires_user_input" }],
    ["early Gmail reauthorization return", { status: "failed" as const, errorCode: "gmail_oauth_required" }],
    ["pause propagation", { status: "failed" as const, errorCode: "session_pause_requested" }],
    ["cancelled pause propagation", { status: "cancelled" as const, errorCode: "session_pause_requested" }],
    ["malformed failed-tool error code", { status: "failed" as const, errorCode: "not a safe code" }],
    ["failed native question", { name: "agent.ask_user", status: "failed" as const, errorCode: "tool_execution_failed" }],
    ["failed wait before target wait", { name: "wait_subagents", status: "failed" as const, errorCode: "tool_execution_failed" }],
  ])("rejects %s even with a forged trailing wait", async (_label, priorTool) => {
    const value = fixture(priorTool)
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "normal_waiting",
    })).resolves.toBeNull()
  })

  it.each([
    ["missing terminal failure event", (value: ReturnType<typeof fixture>) => {
      value.events.splice(value.events.findIndex(event => event.type === "tool_call.failed"), 1)
    }],
    ["completion event where failure is required", (value: ReturnType<typeof fixture>) => {
      value.events.find(event => event.type === "tool_call.failed")!.type = "tool_call.completed"
    }],
    ["result error code mismatch", (value: ReturnType<typeof fixture>) => {
      const result = value.items.find(item => item.type === "tool_result" && item.id === "noop-result")!
      result.content = { ...record(result.content), errorCode: "other_error" }
    }],
    ["failure event error code mismatch", (value: ReturnType<typeof fixture>) => {
      const event = value.events.find(item => item.type === "tool_call.failed")!
      event.payload = { ...record(event.payload), errorCode: "other_error" }
    }],
    ["unfinished failed call", (value: ReturnType<typeof fixture>) => {
      value.items.find(item => item.type === "tool_call" && item.id === "noop-item")!.status = "started"
    }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture({ status: "failed", errorCode: "tool_execution_failed" })
    corrupt(value)
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "normal_waiting",
    })).resolves.toBeNull()
  })

  it.each([
    ["model start without agenda causality", (value: ReturnType<typeof fixture>) => { value.events.find(event => event.type === "model.started")!.causationId = "detached" }],
    ["wait before a later executed tool", (value: ReturnType<typeof fixture>) => { value.events.find(event => event.idempotencyKey.endsWith("tool-started:noop-call"))!.sequence = "99" }],
    ["unrelated event in the bounded prefix", (value: ReturnType<typeof fixture>) => { value.events.splice(6, 0, { ...value.events[5]!, id: "extra-event", sequence: "7", type: "tool_call.failed" }) }],
    ["cross-task item", (value: ReturnType<typeof fixture>) => { value.items[0]!.taskId = "other-task" }],
    ["duplicate anchor", (value: ReturnType<typeof fixture>) => { value.anchors.push({ ...value.anchors[0]! }) }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture()
    corrupt(value)
    await expect(readCanonicalHistoricalSourceStepPrefix(mockClient(value), task, {
      stepId, attempt: 1, callItemId: waitItemId, callId: waitCallId, resultItemId: waitResultId, waitKind: "normal_waiting",
    })).resolves.toBeNull()
  })

  it("rebinds digest-only event and item signatures within the exact ordered sequence range", () => {
    expect(sqlBalance(HISTORICAL_SOURCE_STEP_PREFIX_SQL)).toBe(0)
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("exactEvent.\"sessionId\" = boundSource.\"sessionId\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("exactItem.\"taskId\" = boundSource.\"taskId\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('ordered."sequence" BETWEEN')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("CASE WHEN jsonb_typeof(expected.value) = 'object'")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("BETWEEN 2 AND")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('exactEvent."payload"->>\'status\' = expected.value->>\'status\'')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('exactEvent."payload"->\'errorCode\' = expected.value->\'errorCode\'')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("expected.value->>'status' IN ('failed','cancelled')")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("NOT IN ('policy_requires_approval','policy_requires_user_input','gmail_oauth_required','session_pause_requested')")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('resultCompleted."causationId" = resultStarted."id"')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('sourceStart."itemId" = boundSourceCall."id"')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain('sourceStart."idempotencyKey" = ')
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("WITH ORDINALITY AS expected(value, ordinality)")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("LAG(expected.value->>'id') OVER (ORDER BY expected.ordinality)")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("chain.value->>'causationId' = chain.\"previousId\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("chain.value->>'causationId'")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("parent.\"sequence\" < chain.\"actualSequence\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("parent.\"type\" = 'task.started'")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("priorStep.\"attempt\" = boundSource.\"attempt\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("candidate.\"ordinal\" < boundSource.\"ordinal\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("parent.\"idempotencyKey\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("'ordinal', boundSource.\"ordinal\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("modelDone.\"payload\"->>'toolCallCount'")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("BETWEEN (SELECT anchor.\"sequence\"")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("COUNT(DISTINCT callItem.\"content\"->>'toolCallId')")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).toContain("COUNT(DISTINCT started.\"correlationId\")")
    expect(HISTORICAL_SOURCE_STEP_PREFIX_SQL).not.toContain("jsonb_object_length")
  })
})
