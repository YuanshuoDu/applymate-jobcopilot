import { describe, expect, it } from "vitest"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"
import { CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL } from "./pg-store-expiry-step-completion-proof.js"
import { readCanonicalWaitStepToolChain, STEP_TOOL_CHAIN_MODEL_START_WHERE_SQL } from "./pg-store-expiry-step-tool-chain-proof.js"

const task = { id: "task-1", sessionId: "session-1", turnId: "turn-1" }
const stepId = "task:task-1:step:2:attempt:3"
const claimCallId = "claim-call"
const claimItemId = `task:${task.id}:item:tool-call:${claimCallId}:attempt:3`
const claimResultId = `task:${task.id}:item:tool-result:${claimCallId}:attempt:3`
const unparenthesizedJsonExtractionAfterConcat = /\|\|\s*(?:[a-z_][\w]*\.)?(?:"[^"]+"|[a-z_][\w]*)(?:\s*->>?\s*(?:'[^']+'|"[^"]+"))+/i
type Event = Record<string, unknown> & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown }
type Item = Record<string, unknown> & { id: string; sessionId: string; turnId: string; taskId: string; stepId: string;
  type: string; status: string; revision: number; phase: string | null; content: unknown }

function fixture(withCommentary = true, commentaryText = "private commentary") {
  let seq = 0
  let previous: string | null = "prior-event"
  const events: Event[] = []
  const add = (type: string, key: string, corr: string, itemId: string | null, payload: unknown): Event => {
    const id = `event-${++seq}`
    const row: Event = { id, sequence: String(seq), type, actor: "subagent", itemId, correlationId: corr,
      causationId: previous, idempotencyKey: `task:${task.id}:event:${key}`, payload }
    events.push(row); previous = id; return row
  }
  const stepStart = add("step.started", `step-started:${stepId}`, stepId, null, { stepId, ordinal: 1, taskId: task.id })
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: task.sessionId, turnId: task.turnId, stepId,
    inputThroughSequence: 1n, consumedInputIds: [], blocks: [], canonicalJson: "{}" }
  const agendaReceipt = buildCognitiveAgendaReceipt({ sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId,
    agenda: buildCognitiveActionAgenda(context) })
  if (!agendaReceipt) throw new Error("fixture_agenda_invalid")
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  if (!agendaKey) throw new Error("fixture_agenda_key_invalid")
  const agendaEvent = add(COGNITIVE_AGENDA_EVENT_TYPE, agendaKey, stepId, null, agendaReceipt)
  const start = add("model.started", `model-started:${stepId}`, stepId, null,
    { taskId: task.id, provider: "fixture", model: "model-a" })
  add("model.completed", `model-completed:${stepId}`, stepId, null,
    { taskId: task.id, provider: "fixture", model: "model-a", toolCallCount: 3 })
  add("model.usage", `model-usage:${stepId}`, stepId, null,
    { taskId: task.id, provider: "fixture", model: "model-a", usage: { inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.01 } })
  const items: Item[] = []
  if (withCommentary) {
    const id = "commentary-item", content = { text: commentaryText }
    items.push({ id, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "agent_message",
      status: "completed", revision: 2, phase: "commentary", content })
    add("item.started", `item-started:${id}`, stepId, id, { itemId: id, type: "agent_message", phase: "commentary" })
    add("item.delta", `commentary-delta:${id}:1`, id, id, { itemId: id, status: "streaming", content })
    add("item.completed", `commentary-completed:${id}:2`, id, id, { itemId: id, status: "completed", content })
  }
  const calls = [
    { id: "normal-before", name: "agent.inspect", input: { query: "one" }, output: { ok: true } },
    { id: claimCallId, name: "wait_subagents", input: { idempotencyKey: "secret-key", taskIds: ["child-1"], mode: "all", timeoutMs: 500 }, output: { waitId: "wait-1", status: "ready" } },
    { id: "normal-after", name: "agent.inspect", input: { query: "two" }, output: { ok: true } },
  ]
  for (const call of calls) {
    const callItemId = call.id === claimCallId ? claimItemId : `item-${call.id}`
    const resultItemId = call.id === claimCallId ? claimResultId : `result-${call.id}`
    const content = { toolCallId: call.id, toolName: call.name, toolVersion: "1", input: call.input, status: "completed", errorCode: null }
    const resultContent = { toolCallId: call.id, output: call.output, errorCode: null }
    items.push({ id: callItemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "tool_call",
      status: "completed", revision: 1, phase: null, content })
    items.push({ id: resultItemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId, type: "tool_result",
      status: "completed", revision: 1, phase: null, content: resultContent })
    const itemStarted = add("item.started", `item-started:${callItemId}`, stepId, callItemId,
      { itemId: callItemId, type: "tool_call", phase: null })
    const callStarted = add("tool_call.started", call.id === claimCallId ? `child-wait-claim:3:${stepId}` : `tool-started:${call.id}`,
      call.id, callItemId, { toolCallId: call.id, toolName: call.name, taskId: task.id })
    add("item.completed", `tool-call-completed:${call.id}:${callItemId}:1`, callItemId, callItemId,
      projectWaitCallCompletionPayload({ itemId: callItemId, status: "completed", content }, callItemId))
    const terminal = add("tool_call.completed", `tool-finished:${call.id}`, call.id, callItemId,
      { toolCallId: call.id, toolName: call.name, status: "completed", errorCode: null, taskId: task.id })
    const resultStarted = add("item.started", `item-started:${resultItemId}`, stepId, resultItemId,
      { itemId: resultItemId, type: "tool_result", phase: null })
    add("item.completed", `tool-result-completed:${call.id}:${resultItemId}:1`, resultItemId, resultItemId,
      { itemId: resultItemId, status: "completed", content: resultContent })
    if (call.id === claimCallId) {
      expect(itemStarted.id).toBeTruthy(); expect(callStarted.id).toBeTruthy(); expect(terminal.id).toBeTruthy(); expect(resultStarted.id).toBeTruthy()
    }
  }
  const completed = add("step.completed", `step-completed:${stepId}`, stepId, null,
    { stepId, status: "completed", toolCallCount: 3, taskId: task.id })
  const anchorRows = [stepStart, agendaEvent, start, events.find(event => event.type === "model.completed")!, events.find(event => event.type === "model.usage")!, completed]
  return { events, items, anchorRows }
}

function longWriterFixture() {
  const value = fixture(), taskId = "subagent-12345678-1234-4234-9234-123456789abc"
  const attempt = 2_147_483_647, callId = "c".repeat(256)
  const nextTask = { ...task, id: taskId }
  const nextStepId = `task:${taskId}:step:2:attempt:${attempt}`
  const callItemId = `task:${taskId}:item:tool-call:${callId}:attempt:${attempt}`
  const resultItemId = `task:${taskId}:item:tool-result:${callId}:attempt:${attempt}`
  const replacements = [
    [`child-wait-claim:3:${stepId}`, `child-wait-claim:${attempt}:${nextStepId}`],
    [claimItemId, callItemId], [claimResultId, resultItemId], [stepId, nextStepId], [claimCallId, callId], [task.id, taskId],
  ] as const
  const rewrite = (input: unknown): unknown => {
    if (typeof input === "string") return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), input)
    if (Array.isArray(input)) return input.map(rewrite)
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, rewrite(item)]))
    return input
  }
  for (const item of value.items) Object.assign(item, rewrite(item) as Record<string, unknown>)
  for (const event of value.events) Object.assign(event, rewrite(event) as Record<string, unknown>)
  const firstCause = value.events[0]?.causationId ?? null
  value.events.forEach((event, index) => {
    event.id = `${event.idempotencyKey}:attempt:${attempt}`
    event.causationId = index === 0 ? firstCause : value.events[index - 1]!.id
  })
  return { value, task: nextTask, stepId: nextStepId, callId, callItemId, resultItemId, attempt }
}

function mockClient(value: ReturnType<typeof fixture>, queries: string[] = []) {
  const query = async (sql: string) => {
    queries.push(sql)
    return sql.includes('FROM "agent_items"')
      ? { rows: value.items }
      : sql.includes('"sequence" BETWEEN') ? { rows: value.events }
        : { rows: value.anchorRows }
  }
  return { query } as never
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

describe("ordered wait claim step tool-chain proof", () => {
  it("orders the text-projected event window by its native bigint sequence", async () => {
    const queries: string[] = []
    await readCanonicalWaitStepToolChain(mockClient(fixture(), queries), task, { stepId, attempt: 3,
      callItemId: claimItemId, callId: claimCallId, resultItemId: claimResultId })
    const eventWindowQuery = queries.find(sql => sql.includes('"sequence" BETWEEN'))
    expect(eventWindowQuery).toContain('ORDER BY chainEvent."sequence"')
    expect(eventWindowQuery).not.toContain('ORDER BY "sequence"')
  })

  it("parenthesizes JSON text extraction operands in PostgreSQL concatenation", () => {
    expect(STEP_TOOL_CHAIN_MODEL_START_WHERE_SQL).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
  })

  it("accepts a multi-tool writer chain and keeps commentary/tool payloads out of the proof", async () => {
    const value = fixture()
    const proof = await readCanonicalWaitStepToolChain(mockClient(value), task, { stepId, attempt: 3, callItemId: claimItemId,
      callId: claimCallId, resultItemId: claimResultId })
    expect(proof).toMatchObject({ stepId, waitCallItemId: claimItemId, waitCallId: claimCallId, waitResultItemId: claimResultId,
      calls: [{ toolCallId: "normal-before" }, { toolCallId: claimCallId }, { toolCallId: "normal-after" }] })
    expect(proof?.nextEventId).toBe(proof?.calls[2]?.itemStartedEventId)
    expect(JSON.stringify(proof)).not.toContain("private commentary")
    expect(JSON.stringify(proof)).not.toContain("secret-key")
  })

  it("accepts maximum bounded child-writer item and event IDs", async () => {
    const value = longWriterFixture()
    const proof = await readCanonicalWaitStepToolChain(mockClient(value.value), value.task, { stepId: value.stepId,
      attempt: value.attempt, callItemId: value.callItemId, callId: value.callId, resultItemId: value.resultItemId })
    expect(value.callItemId.length).toBe(341)
    expect(value.resultItemId.length).toBe(343)
    expect(value.value.events.some(event => event.id.length === 700)).toBe(true)
    expect(proof).toMatchObject({ stepId: value.stepId, waitCallItemId: value.callItemId, waitCallId: value.callId,
      waitResultItemId: value.resultItemId })
  })

  it("rejects persisted event and item IDs beyond their separate bounds", async () => {
    const overlongEvent = longWriterFixture()
    const completed = overlongEvent.value.events.find(event => event.idempotencyKey.endsWith(
      `tool-result-completed:${overlongEvent.callId}:${overlongEvent.resultItemId}:1`))!
    completed.id = "e".repeat(1025)
    const next = overlongEvent.value.events[overlongEvent.value.events.indexOf(completed) + 1]
    if (next) next.causationId = completed.id
    await expect(readCanonicalWaitStepToolChain(mockClient(overlongEvent.value), overlongEvent.task, { stepId: overlongEvent.stepId,
      attempt: overlongEvent.attempt, callItemId: overlongEvent.callItemId, callId: overlongEvent.callId,
      resultItemId: overlongEvent.resultItemId })).resolves.toBeNull()

    const overlongItem = longWriterFixture()
    const tooLongItemId = `${overlongItem.resultItemId}${"i".repeat(170)}`
    await expect(readCanonicalWaitStepToolChain(mockClient(overlongItem.value), overlongItem.task, { stepId: overlongItem.stepId,
      attempt: overlongItem.attempt, callItemId: overlongItem.callItemId, callId: overlongItem.callId,
      resultItemId: tooLongItemId })).resolves.toBeNull()
  })

  it("rejects an over-limit item ID returned by the database with canonical input", async () => {
    const value = longWriterFixture(), queries: string[] = []
    value.value.items.find(item => item.id === value.resultItemId)!.id = "i".repeat(513)
    await expect(readCanonicalWaitStepToolChain(mockClient(value.value, queries), value.task, { stepId: value.stepId,
      attempt: value.attempt, callItemId: value.callItemId, callId: value.callId, resultItemId: value.resultItemId })).resolves.toBeNull()
    expect(queries.some(sql => sql.includes('FROM "agent_items"'))).toBe(true)
  })

  it("accepts whitespace commentary because the writer publishes every truthy text value", async () => {
    const value = fixture(true, "   ")
    await expect(readCanonicalWaitStepToolChain(mockClient(value), task, { stepId, attempt: 3, callItemId: claimItemId,
      callId: claimCallId, resultItemId: claimResultId })).resolves.toMatchObject({ stepId })
  })

  it.each([
    ["wrong agenda payload", (value: ReturnType<typeof fixture>) => { value.events[1]!.payload = {} }],
    ["wrong agenda cause", (value: ReturnType<typeof fixture>) => { value.events[1]!.causationId = "other" }],
    ["wrong model start cause", (value: ReturnType<typeof fixture>) => { value.events[2]!.causationId = "other" }],
    ["wrong model cause", (value: ReturnType<typeof fixture>) => { value.events[3]!.causationId = "other" }],
    ["wrong usage cause", (value: ReturnType<typeof fixture>) => { value.events[4]!.causationId = "other" }],
    ["wrong step completion cause", (value: ReturnType<typeof fixture>) => { value.events.at(-1)!.causationId = "other" }],
    ["extra event in the ordered chain", (value: ReturnType<typeof fixture>) => { value.events.splice(6, 0, { ...value.events[5]!, id: "extra", sequence: "7", type: "tool_call.failed" }) }],
    ["missing agenda", (value: ReturnType<typeof fixture>) => { value.events.splice(1, 1); value.anchorRows.splice(1, 1) }],
    ["duplicate agenda anchor", (value: ReturnType<typeof fixture>) => { value.anchorRows.push({ ...value.anchorRows[1]! }) }],
    ["failed later call", (value: ReturnType<typeof fixture>) => { const item = value.items.find(row => row.id === "item-normal-after")!; (item.content as Record<string, unknown>).status = "failed" }],
    ["broken tool causality", (value: ReturnType<typeof fixture>) => { value.events.find(event => event.type === "tool_call.started")!.causationId = "other" }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture(false)
    corrupt(value)
    await expect(readCanonicalWaitStepToolChain(mockClient(value), task, { stepId, attempt: 3, callItemId: claimItemId,
      callId: claimCallId, resultItemId: claimResultId })).resolves.toBeNull()
  })

  it("revalidates scoped ordered rows and claim-result continuation in final SQL", () => {
    expect(sqlBalance(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL)).toBe(0)
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("proof.value->'stepToolChain'->'events'")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain('actual."causationId" IS NOT DISTINCT FROM')
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("modelDone.\"causationId\" = modelStart.\"id\"")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("resultExtra.\"id\" = proof.value->'stepToolChain'->>'nextEventId'")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain('inRange."sequence" BETWEEN')
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).not.toContain("jsonb_object_length")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("jsonb_object_keys")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("agenda.\"causationId\" = stepStarted.\"id\"")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("modelStart.\"causationId\" = agenda.\"id\"")
  })
})
