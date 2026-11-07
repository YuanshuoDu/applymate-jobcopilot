import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import { cognitiveAgendaReceiptIdempotencyKey, parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"
import { MAX_STEP_TOOL_CALLS, exactKeys, record } from "./pg-store-expiry-step-tool-chain-proof.js"

type Row = Record<string, unknown>
type Scope = Readonly<{ id: string; sessionId: string; turnId: string }>
type Event = Row & { id: string; sequence: string; type: string; actor: string; itemId: string | null; correlationId: string;
  causationId: string | null; idempotencyKey: string; payload: unknown; payloadDigest: string }
type Item = Row & { id: string; sessionId: string; turnId: string; taskId: string; stepId: string; type: string; status: string;
  revision: number; phase: string | null; content: unknown; contentDigest: string }
type EventBinding = Readonly<{ id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payloadDigest: string; status?: "completed" | "failed" | "cancelled"; errorCode?: string | null }>
type ItemBinding = Readonly<{ id: string; type: string; status: string; revision: number; phase: string | null; contentDigest: string }>
type TerminalMode = "step_completed" | "recovered_handoff"
export type HistoricalSourceStepPrefix = Readonly<{ stepId: string; attempt: number; sourceCallItemId: string; sourceCallId: string;
  sourceResultItemId: string; waitKind: "normal_waiting" | "recovered"; terminalMode: TerminalMode; stepStartedEventId: string;
  stepCompletedEventId: string | null; events: readonly EventBinding[]; items: readonly ItemBinding[] }>
const MAX_EVENTS = MAX_STEP_TOOL_CALLS * 9 + 16
const EARLY_STOP_ERROR_CODES = new Set(["policy_requires_approval", "policy_requires_user_input", "gmail_oauth_required", "session_pause_requested"])
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
const validErrorCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const same = (left: unknown, right: unknown): boolean => { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
const sequence = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
const safeUsage = (value: unknown): boolean => {
  const usage = record(value)
  return value === null || exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
    && [usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd].every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)
}
const binding = (event: Event): EventBinding => {
  const base = { id: event.id, sequence: event.sequence, type: event.type, actor: event.actor, itemId: event.itemId,
    correlationId: event.correlationId, causationId: event.causationId, idempotencyKey: event.idempotencyKey, payloadDigest: event.payloadDigest }
  if (event.type !== "tool_call.completed" && event.type !== "tool_call.failed") return base
  const payload = record(event.payload)
  return { ...base, status: payload.status as "completed" | "failed" | "cancelled", errorCode: payload.errorCode as string | null }
}
const itemBinding = (item: Item): ItemBinding => ({ id: item.id, type: item.type, status: item.status, revision: item.revision, phase: item.phase, contentDigest: item.contentDigest })
/** Reads a bounded, same-owner writer prefix through one durable waiting tool result. */
export async function readCanonicalHistoricalSourceStepPrefix(client: pg.PoolClient, task: Scope,
  input: { readonly stepId: string; readonly attempt: number; readonly callItemId: string; readonly callId: string;
    readonly resultItemId: string; readonly waitKind: "normal_waiting" | "recovered"; readonly terminalMode?: TerminalMode }): Promise<HistoricalSourceStepPrefix | null> {
  if (![task.id, task.sessionId, task.turnId, input.stepId, input.callItemId, input.callId, input.resultItemId].every(validText)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1) return null
  const terminalMode = input.terminalMode ?? "step_completed"
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(input.stepId)
  if (!agendaKey) return null
  if (terminalMode === "recovered_handoff") {
    const step = await client.query<{ status: string }>(`SELECT "status" FROM "agent_steps"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
    [input.stepId, task.sessionId, task.turnId, task.id, input.attempt])
    const completed = await client.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
      AND "type" = 'step.completed' AND ("correlationId" = $4 OR "idempotencyKey" = $5) LIMIT 1`,
    [task.sessionId, task.turnId, task.id, input.stepId, `task:${task.id}:event:step-completed:${input.stepId}`])
    if (step.rows.length !== 1 || step.rows[0]?.status !== "waiting_for_tool" || completed.rows.length !== 0) return null
  }
  const prefix = `task:${task.id}:event:`, keys = [prefix + `step-started:${input.stepId}`, prefix + `model-started:${input.stepId}`,
    prefix + `model-completed:${input.stepId}`, prefix + `model-usage:${input.stepId}`,
    terminalMode === "step_completed" ? prefix + `step-completed:${input.stepId}` : prefix + `tool-result-completed:${input.callId}:${input.resultItemId}:1`, prefix + agendaKey]
  const anchors = await client.query<Event>(`SELECT "id", "sequence"::text AS "sequence", "type", "actor", "itemId", "correlationId", "causationId", "idempotencyKey", "payload",
      encode(sha256(convert_to("payload"::text, 'UTF8')), 'hex') AS "payloadDigest"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[]) LIMIT 7`,
  [task.sessionId, task.turnId, task.id, keys])
  if (anchors.rows.length !== 6) return null
  const byKey = new Map(anchors.rows.map(event => [event.idempotencyKey, event]))
  const start = byKey.get(keys[0]!), modelStart = byKey.get(keys[1]!), modelDone = byKey.get(keys[2]!), usage = byKey.get(keys[3]!)
  const stepDone = byKey.get(keys[4]!), agenda = byKey.get(keys[5]!)
  if (!start || !modelStart || !modelDone || !usage || !stepDone || !agenda) return null
  const from = sequence(start.sequence), through = sequence(stepDone.sequence)
  if (!from || !through || from >= through) return null
  const [eventRows, itemRows] = await Promise.all([
    client.query<Event>(`SELECT "id", "sequence"::text AS "sequence", "type", "actor", "itemId", "correlationId", "causationId", "idempotencyKey", "payload",
        encode(sha256(convert_to("payload"::text, 'UTF8')), 'hex') AS "payloadDigest"
      FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "sequence" BETWEEN $4::bigint AND $5::bigint
      ORDER BY "sequence" LIMIT ${MAX_EVENTS + 1}`,
    [task.sessionId, task.turnId, task.id, from.toString(), through.toString()]),
    client.query<Item>(`SELECT "id", "sessionId", "turnId", "taskId", "stepId", "type", "status", "revision", "phase", "content",
        encode(sha256(convert_to("content"::text, 'UTF8')), 'hex') AS "contentDigest"
      FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
      ORDER BY "createdAt", "id" LIMIT ${MAX_STEP_TOOL_CALLS * 2 + 3}`,
    [task.sessionId, task.turnId, task.id, input.stepId]),
  ])
  if (eventRows.rows.length > MAX_EVENTS || itemRows.rows.length > MAX_STEP_TOOL_CALLS * 2 + 2) return null
  return provePrefix(task, { ...input, terminalMode }, eventRows.rows, itemRows.rows, keys)
}
function provePrefix(task: Scope, input: { stepId: string; attempt: number; callItemId: string; callId: string; resultItemId: string;
  waitKind: "normal_waiting" | "recovered"; terminalMode: TerminalMode }, events: readonly Event[], items: readonly Item[], keys: readonly string[]): HistoricalSourceStepPrefix | null {
  if (events.length < (input.terminalMode === "step_completed" ? 12 : 11) || events.length > MAX_EVENTS) return null
  const itemMap = new Map(items.map(item => [item.id, item])), byKey = new Map(events.map(event => [event.idempotencyKey, event]))
  if (itemMap.size !== items.length || byKey.size !== events.length || items.some(item => item.sessionId !== task.sessionId
    || item.turnId !== task.turnId || item.taskId !== task.id || item.stepId !== input.stepId)) return null
  const calls = items.filter(item => item.type === "tool_call").sort((a, b) => eventOrder(events, a.id, b.id))
  const results = items.filter(item => item.type === "tool_result"), comments = items.filter(item => item.type === "agent_message" || item.type === "reasoning_summary")
  if (!calls.length || calls.length > MAX_STEP_TOOL_CALLS || results.length !== calls.length || comments.length > 2
    || items.length !== calls.length * 2 + comments.length || items.some(item => !["tool_call", "tool_result", "agent_message", "reasoning_summary"].includes(item.type))) return null
  const start = byKey.get(keys[0]!), agenda = byKey.get(keys[5]!), modelStart = byKey.get(keys[1]!), modelDone = byKey.get(keys[2]!)
  const usage = byKey.get(keys[3]!), terminalEvent = byKey.get(keys[4]!), startPayload = record(start?.payload)
  const startModel = record(modelStart?.payload), doneModel = record(modelDone?.payload), usagePayload = record(usage?.payload)
  const agendaReceipt = parseCognitiveAgendaReceipt(agenda?.payload, { sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: input.stepId })
  const callCount = doneModel.toolCallCount
  if (!start || !agenda || !modelStart || !modelDone || !usage || !terminalEvent) return null
  if ([start, agenda, modelStart, modelDone, usage].some(event => !event || event.actor !== "subagent" || event.itemId !== null
    || event.correlationId !== input.stepId) || !agendaReceipt || start?.idempotencyKey !== keys[0] || agenda?.idempotencyKey !== keys[5]
    || !exactKeys(startPayload, ["stepId", "ordinal", "taskId"]) || startPayload.stepId !== input.stepId || startPayload.taskId !== task.id
    || typeof startPayload.ordinal !== "number" || !Number.isSafeInteger(startPayload.ordinal) || startPayload.ordinal < 0
    || agenda.causationId !== start.id || modelStart?.causationId !== agenda.id || modelDone?.causationId !== modelStart.id
    || usage?.causationId !== modelDone.id || modelStart.idempotencyKey !== keys[1] || modelDone.idempotencyKey !== keys[2]
    || usage.idempotencyKey !== keys[3] || terminalEvent.idempotencyKey !== keys[4]
    || !exactKeys(startModel, ["taskId", "provider", "model"]) || startModel.taskId !== task.id
    || !validText(startModel.provider) || !validText(startModel.model)
    || !exactKeys(doneModel, ["taskId", "provider", "model", "toolCallCount"]) || doneModel.taskId !== task.id
    || doneModel.provider !== startModel.provider || doneModel.model !== startModel.model || typeof callCount !== "number"
    || !Number.isSafeInteger(callCount) || callCount < calls.length || callCount > MAX_STEP_TOOL_CALLS
    || !exactKeys(usagePayload, ["taskId", "provider", "model", "usage"]) || usagePayload.taskId !== task.id
    || usagePayload.provider !== startModel.provider || usagePayload.model !== startModel.model || !safeUsage(usagePayload.usage)
    || input.terminalMode === "step_completed" && (terminalEvent.type !== "step.completed"
      || !same(terminalEvent.payload, { stepId: input.stepId, status: "waiting_for_dependency", toolCallCount: callCount, taskId: task.id }))) return null
  const cursor = { value: 0 }, proof: Event[] = []
  let previous: Event | undefined
  const take = (type: string, key: string, correlation: string, itemId: string | null, payload?: unknown): Event | null => {
    const event = events[cursor.value++]
    if (!event || event.type !== type || event.actor !== "subagent" || event.idempotencyKey !== key || event.correlationId !== correlation
      || event.itemId !== itemId || !validText(event.id) || !sequence(event.sequence) || previous && event.causationId !== previous.id
      || payload !== undefined && !same(event.payload, payload)) return null
    proof.push(event); previous = event; return event
  }
  if (take("step.started", keys[0]!, input.stepId, null, startPayload)?.id !== start.id
    || take("cognitive.agenda", keys[5]!, input.stepId, null, agendaReceipt)?.id !== agenda.id
    || take("model.started", keys[1]!, input.stepId, null, startModel)?.id !== modelStart.id
    || take("model.completed", keys[2]!, input.stepId, null, doneModel)?.id !== modelDone.id
    || take("model.usage", keys[3]!, input.stepId, null, usagePayload)?.id !== usage.id) return null
  for (const comment of comments.sort((a, b) => eventOrder(events, a.id, b.id))) if (!appendCommentProof(take, task, input.stepId, comment)) return null
  const callProofs: Array<{ callItemId: string; resultItemId: string; resultCompletedId: string }> = []
  for (const call of calls) {
    const content = record(call.content), callId = content.toolCallId, name = content.toolName
    const callStatus = content.status, errorCode = content.errorCode
    const completed = callStatus === "completed" && errorCode === null
    const safelyTerminal = (callStatus === "failed" || callStatus === "cancelled")
      && (errorCode === null || validErrorCode(errorCode))
      && !EARLY_STOP_ERROR_CODES.has(String(errorCode))
    const result = results.filter(item => record(item.content).toolCallId === callId)
    if (result.length !== 1 || !validText(call.id) || !validText(callId) || !validText(name) || !validText(result[0]!.id)
      || !exactKeys(content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
      || content.toolVersion !== "1" || (!completed && !safelyTerminal) || !plain(content.input)
      || !exactKeys(record(result[0]!.content), ["toolCallId", "output", "errorCode"])
      || record(result[0]!.content).toolCallId !== callId || record(result[0]!.content).errorCode !== errorCode
      || call.status !== "completed" || call.revision !== 1 || call.phase !== null || result[0]!.status !== "completed"
      || result[0]!.revision !== 1 || result[0]!.phase !== null || name === "agent.wait" || name === "agent.ask_user"
      || (name === "wait_subagents") !== (call.id === input.callItemId) || call.id === input.callItemId && !completed) return null
    if (call.id === input.callItemId && (callId !== input.callId || result[0]!.id !== input.resultItemId)) return null
    const resultContent = record(result[0]!.content)
    if (!take("item.started", `task:${task.id}:event:item-started:${call.id}`, input.stepId, call.id,
      { itemId: call.id, type: "tool_call", phase: null })) return null
    const callStart = take("tool_call.started", `task:${task.id}:event:tool-started:${callId}`, callId, call.id,
      { toolCallId: callId, toolName: name, taskId: task.id })
    const callDone = take("item.completed", `task:${task.id}:event:tool-call-completed:${callId}:${call.id}:1`, call.id, call.id,
      projectWaitCallCompletionPayload({ itemId: call.id, status: "completed", content }, call.id))
    const terminalType = callStatus === "completed" ? "tool_call.completed" : "tool_call.failed"
    if (!callStart || !callDone || callDone.causationId !== callStart.id
      || !take(terminalType, `task:${task.id}:event:tool-finished:${callId}`, callId, call.id,
        { toolCallId: callId, toolName: name, status: callStatus, errorCode, taskId: task.id })) return null
    const resultStart = take("item.started", `task:${task.id}:event:item-started:${result[0]!.id}`, input.stepId, result[0]!.id,
      { itemId: result[0]!.id, type: "tool_result", phase: null })
    const resultDone = take("item.completed", `task:${task.id}:event:tool-result-completed:${callId}:${result[0]!.id}:1`, result[0]!.id, result[0]!.id,
      { itemId: result[0]!.id, status: "completed", content: resultContent })
    if (!resultStart || !resultDone || resultDone.causationId !== resultStart.id) return null
    callProofs.push({ callItemId: call.id, resultItemId: result[0]!.id, resultCompletedId: resultDone.id })
  }
  const terminalValid = input.terminalMode === "step_completed"
    ? take("step.completed", keys[4]!, input.stepId, null, terminalEvent.payload)?.id === terminalEvent.id
    : terminalEvent.type === "item.completed" && terminalEvent.itemId === input.resultItemId
      && proof.at(-1)?.id === terminalEvent.id
  if (callProofs.at(-1)?.callItemId !== input.callItemId || !terminalValid || cursor.value !== events.length || input.terminalMode === "step_completed" && proof[proof.length - 2]?.id !== callProofs.at(-1)?.resultCompletedId || input.terminalMode === "recovered_handoff" && proof.at(-1)?.id !== callProofs.at(-1)?.resultCompletedId) return null
  const seq = proof.map(event => BigInt(event.sequence))
  if (seq.some((value, index) => index > 0 && value <= seq[index - 1]!)) return null
  return { stepId: input.stepId, attempt: input.attempt, sourceCallItemId: input.callItemId, sourceCallId: input.callId,
    sourceResultItemId: input.resultItemId, waitKind: input.waitKind, terminalMode: input.terminalMode,
    stepStartedEventId: start.id, stepCompletedEventId: input.terminalMode === "step_completed" ? terminalEvent.id : null,
    events: proof.map(binding), items: items.map(itemBinding) }
}
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
function eventOrder(events: readonly Event[], left: string, right: string): number {
  const find = (id: string) => sequence(events.find(event => event.type === "item.started" && event.itemId === id)?.sequence) ?? 0n
  return find(left) < find(right) ? -1 : find(left) > find(right) ? 1 : left.localeCompare(right)
}
function appendCommentProof(take: (type: string, key: string, correlation: string, itemId: string | null, payload?: unknown) => Event | null,
  task: Scope, stepId: string, item: Item): boolean {
  const reasoning = item.type === "reasoning_summary", content = record(item.content), key = `task:${task.id}:event:`
  const text = reasoning ? content.body : content.text, type = item.type
  if (!exactKeys(content, [reasoning ? "body" : "text"]) || typeof text !== "string" || text.length === 0
    || item.status !== "completed" || item.revision !== 2 || item.phase !== "commentary") return false
  const started = take("item.started", `${key}item-started:${item.id}`, stepId, item.id,
    { itemId: item.id, type, phase: "commentary" })
  const updated = take("item.delta", `${key}${reasoning ? "reasoning-delta" : "commentary-delta"}:${item.id}:1`, item.id, item.id,
    { itemId: item.id, status: "streaming", content })
  const completed = take("item.completed", `${key}${reasoning ? "reasoning-completed" : "commentary-completed"}:${item.id}:2`, item.id, item.id,
    { itemId: item.id, status: "completed", content })
  return Boolean(started && updated && completed)
}
export { historicalSourceStepEventChainBinding } from "./pg-store-expiry-historical-source-step-parent-binding.js"
export { historicalSourceStepCallChainBinding } from "./pg-store-expiry-historical-source-step-call-binding.js"
export function historicalSourceStepCallCountBinding(path: string): string {
  const events = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  const scopedCalls = `callItem."sessionId" = boundSource."sessionId" AND callItem."turnId" = boundSource."turnId"
    AND callItem."taskId" = boundSource."taskId" AND callItem."stepId" = boundSource."id" AND callItem."type" = 'tool_call'`
  const calls = `(SELECT COUNT(*) FROM "agent_items" AS callItem WHERE ${scopedCalls})`
  const distinctCalls = `(SELECT COUNT(DISTINCT callItem."content"->>'toolCallId') FROM "agent_items" AS callItem WHERE ${scopedCalls})`
  const firstEvent = `(${events}->0->>'id')`, lastEvent = `(${events}->(jsonb_array_length(${events}) - 1)->>'id')`
  const scopedStarts = `started."sessionId" = boundSource."sessionId" AND started."turnId" = boundSource."turnId"
    AND started."taskId" = boundSource."taskId" AND started."type" = 'tool_call.started'
    AND started."sequence" BETWEEN (SELECT anchor."sequence" FROM "agent_events" AS anchor WHERE anchor."id" = ${firstEvent}
      AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")
      AND (SELECT anchor."sequence" FROM "agent_events" AS anchor WHERE anchor."id" = ${lastEvent}
        AND anchor."sessionId" = boundSource."sessionId" AND anchor."turnId" = boundSource."turnId" AND anchor."taskId" = boundSource."taskId")`
  const started = `(SELECT COUNT(*) FROM "agent_events" AS started WHERE ${scopedStarts})`
  const distinctStarts = `(SELECT COUNT(DISTINCT started."correlationId") FROM "agent_events" AS started WHERE ${scopedStarts})`
  const startedCalls = `(SELECT COUNT(DISTINCT started."correlationId") FROM "agent_events" AS started JOIN "agent_items" AS callItem
    ON callItem."id" = started."itemId" AND ${scopedCalls} WHERE ${scopedStarts}
      AND started."actor" = 'subagent' AND started."correlationId" = callItem."content"->>'toolCallId'
      AND started."idempotencyKey" = 'task:' || owner."id" || ':event:tool-started:' || (callItem."content"->>'toolCallId')
      AND started."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId', 'toolName', callItem."content"->>'toolName', 'taskId', owner."id"))`
  const finalSourceStart = `(SELECT MAX(sourceStart."sequence") FROM "agent_events" AS sourceStart WHERE sourceStart."sessionId" = boundSource."sessionId"
    AND sourceStart."turnId" = boundSource."turnId" AND sourceStart."taskId" = boundSource."taskId" AND sourceStart."type" = 'tool_call.started'
    AND sourceStart."actor" = 'subagent' AND sourceStart."itemId" = boundSourceCall."id"
    AND sourceStart."correlationId" = boundSourceCall."content"->>'toolCallId'
    AND sourceStart."idempotencyKey" = 'task:' || boundSource."taskId" || ':event:tool-started:' || (boundSourceCall."content"->>'toolCallId'))`
  return `(SELECT COUNT(*) FROM jsonb_array_elements(${events}) AS projected(value) JOIN "agent_events" AS modelDone ON modelDone."id" = projected.value->>'id'
    AND modelDone."sessionId" = boundSource."sessionId" AND modelDone."turnId" = boundSource."turnId" AND modelDone."taskId" = boundSource."taskId"
      AND modelDone."type" = 'model.completed' WHERE jsonb_typeof(modelDone."payload"->'toolCallCount') = 'number'
      AND CASE WHEN modelDone."payload"->>'toolCallCount' ~ '^(0|[1-9][0-9]?)$'
        THEN (modelDone."payload"->>'toolCallCount')::integer BETWEEN ${calls} AND ${MAX_STEP_TOOL_CALLS} ELSE FALSE END
      AND ${calls} = ${distinctCalls} AND ${started} = ${calls} AND ${distinctStarts} = ${calls} AND ${startedCalls} = ${calls}
      AND (SELECT MAX(started."sequence") FROM "agent_events" AS started WHERE ${scopedStarts}) = ${finalSourceStart}) = 1`
}
