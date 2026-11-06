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
export type HistoricalSourceStepPrefix = Readonly<{ stepId: string; attempt: number; sourceCallItemId: string; sourceCallId: string;
  sourceResultItemId: string; waitKind: "normal_waiting" | "recovered"; stepStartedEventId: string; stepCompletedEventId: string; events: readonly EventBinding[]; items: readonly ItemBinding[] }>

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
    readonly resultItemId: string; readonly waitKind: "normal_waiting" | "recovered" }): Promise<HistoricalSourceStepPrefix | null> {
  if (![task.id, task.sessionId, task.turnId, input.stepId, input.callItemId, input.callId, input.resultItemId].every(validText)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1) return null
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(input.stepId)
  if (!agendaKey) return null
  const prefix = `task:${task.id}:event:`, keys = [prefix + `step-started:${input.stepId}`, prefix + `model-started:${input.stepId}`,
    prefix + `model-completed:${input.stepId}`, prefix + `model-usage:${input.stepId}`, prefix + `step-completed:${input.stepId}`, prefix + agendaKey]
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
  return provePrefix(task, input, eventRows.rows, itemRows.rows, keys)
}
function provePrefix(task: Scope, input: { stepId: string; attempt: number; callItemId: string; callId: string; resultItemId: string;
  waitKind: "normal_waiting" | "recovered" }, events: readonly Event[], items: readonly Item[], keys: readonly string[]): HistoricalSourceStepPrefix | null {
  if (events.length < 12 || events.length > MAX_EVENTS) return null
  const itemMap = new Map(items.map(item => [item.id, item])), byKey = new Map(events.map(event => [event.idempotencyKey, event]))
  if (itemMap.size !== items.length || byKey.size !== events.length || items.some(item => item.sessionId !== task.sessionId
    || item.turnId !== task.turnId || item.taskId !== task.id || item.stepId !== input.stepId)) return null
  const calls = items.filter(item => item.type === "tool_call").sort((a, b) => eventOrder(events, a.id, b.id))
  const results = items.filter(item => item.type === "tool_result"), comments = items.filter(item => item.type === "agent_message" || item.type === "reasoning_summary")
  if (!calls.length || calls.length > MAX_STEP_TOOL_CALLS || results.length !== calls.length || comments.length > 2
    || items.length !== calls.length * 2 + comments.length || items.some(item => !["tool_call", "tool_result", "agent_message", "reasoning_summary"].includes(item.type))) return null
  const start = byKey.get(keys[0]!), agenda = byKey.get(keys[5]!), modelStart = byKey.get(keys[1]!), modelDone = byKey.get(keys[2]!)
  const usage = byKey.get(keys[3]!), stepDone = byKey.get(keys[4]!), startPayload = record(start?.payload)
  const startModel = record(modelStart?.payload), doneModel = record(modelDone?.payload), usagePayload = record(usage?.payload)
  const agendaReceipt = parseCognitiveAgendaReceipt(agenda?.payload, { sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: input.stepId })
  const callCount = doneModel.toolCallCount
  if (!start || !agenda || !modelStart || !modelDone || !usage || !stepDone) return null
  if ([start, agenda, modelStart, modelDone, usage, stepDone].some(event => !event || event.actor !== "subagent" || event.itemId !== null
    || event.correlationId !== input.stepId) || !agendaReceipt || start?.idempotencyKey !== keys[0] || agenda?.idempotencyKey !== keys[5]
    || !exactKeys(startPayload, ["stepId", "ordinal", "taskId"]) || startPayload.stepId !== input.stepId || startPayload.taskId !== task.id
    || typeof startPayload.ordinal !== "number" || !Number.isSafeInteger(startPayload.ordinal) || startPayload.ordinal < 0
    || agenda.causationId !== start.id || modelStart?.causationId !== agenda.id || modelDone?.causationId !== modelStart.id
    || usage?.causationId !== modelDone.id || modelStart.idempotencyKey !== keys[1] || modelDone.idempotencyKey !== keys[2]
    || usage.idempotencyKey !== keys[3] || stepDone.idempotencyKey !== keys[4]
    || !exactKeys(startModel, ["taskId", "provider", "model"]) || startModel.taskId !== task.id
    || !validText(startModel.provider) || !validText(startModel.model)
    || !exactKeys(doneModel, ["taskId", "provider", "model", "toolCallCount"]) || doneModel.taskId !== task.id
    || doneModel.provider !== startModel.provider || doneModel.model !== startModel.model || typeof callCount !== "number"
    || !Number.isSafeInteger(callCount) || callCount < calls.length || callCount > MAX_STEP_TOOL_CALLS
    || !exactKeys(usagePayload, ["taskId", "provider", "model", "usage"]) || usagePayload.taskId !== task.id
    || usagePayload.provider !== startModel.provider || usagePayload.model !== startModel.model || !safeUsage(usagePayload.usage)
    || !same(stepDone.payload, { stepId: input.stepId, status: "waiting_for_dependency", toolCallCount: callCount, taskId: task.id })) return null

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
  if (callProofs.at(-1)?.callItemId !== input.callItemId || !take("step.completed", keys[4]!, input.stepId, null, stepDone.payload)
    || cursor.value !== events.length || proof[proof.length - 2]?.id !== callProofs.at(-1)?.resultCompletedId) return null
  const seq = proof.map(event => BigInt(event.sequence))
  if (seq.some((value, index) => index > 0 && value <= seq[index - 1]!)) return null
  return { stepId: input.stepId, attempt: input.attempt, sourceCallItemId: input.callItemId, sourceCallId: input.callId,
    sourceResultItemId: input.resultItemId, waitKind: input.waitKind, stepStartedEventId: start.id, stepCompletedEventId: stepDone.id,
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
const jsonArray = (path: string) => `CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END`
const prefixEvents = jsonArray("proof.value->'sourceStepPrefix'->'events'")
const prefixItems = jsonArray("proof.value->'sourceStepPrefix'->'items'")
/** Rebinds only safe signatures/digests; source text and tool payloads are never copied into the final query proof. */
export const HISTORICAL_SOURCE_STEP_PREFIX_SQL = `CASE WHEN jsonb_typeof(proof.value->'sourceStepPrefix') = 'object' THEN
  CASE WHEN (SELECT COUNT(*) FROM jsonb_object_keys(proof.value->'sourceStepPrefix')) = 10
    AND proof.value->'sourceStepPrefix' ?& ARRAY['stepId','attempt','sourceCallItemId','sourceCallId','sourceResultItemId','waitKind','stepStartedEventId','stepCompletedEventId','events','items']
    AND proof.value->'sourceStepPrefix'->>'stepId' = boundSource."id"
    AND proof.value->'sourceStepPrefix'->>'attempt' = boundSource."attempt"::text
    AND proof.value->'sourceStepPrefix'->>'sourceCallItemId' = boundSourceCall."id"
    AND proof.value->'sourceStepPrefix'->>'sourceCallId' = boundSourceCall."content"->>'toolCallId'
    AND proof.value->'sourceStepPrefix'->>'sourceResultItemId' = boundSourceResult."id"
    AND proof.value->'sourceStepPrefix'->>'waitKind' = proof.value->'sourceWait'->>'sourceKind'
    AND jsonb_array_length(${prefixEvents}) BETWEEN 12 AND ${MAX_EVENTS}
    AND jsonb_array_length(${prefixItems}) BETWEEN 2 AND ${MAX_STEP_TOOL_CALLS * 2 + 2}
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixEvents}) AS expected(value)
      JOIN "agent_events" AS exactEvent ON exactEvent."id" = expected.value->>'id'
        AND exactEvent."sessionId" = boundSource."sessionId" AND exactEvent."turnId" = boundSource."turnId" AND exactEvent."taskId" = boundSource."taskId"
      WHERE exactEvent."sequence"::text = expected.value->>'sequence' AND exactEvent."type" = expected.value->>'type'
        AND exactEvent."actor" = expected.value->>'actor' AND exactEvent."itemId" IS NOT DISTINCT FROM expected.value->>'itemId'
        AND exactEvent."correlationId" = expected.value->>'correlationId' AND exactEvent."causationId" IS NOT DISTINCT FROM expected.value->>'causationId'
        AND exactEvent."idempotencyKey" = expected.value->>'idempotencyKey'
        AND CASE WHEN exactEvent."type" IN ('tool_call.completed', 'tool_call.failed') THEN exactEvent."payload" ? 'status'
          AND exactEvent."payload"->>'status' = expected.value->>'status' AND exactEvent."payload" ? 'errorCode'
          AND exactEvent."payload"->'errorCode' = expected.value->'errorCode' ELSE NOT (expected.value ? 'status' OR expected.value ? 'errorCode') END
        AND encode(sha256(convert_to(exactEvent."payload"::text, 'UTF8')), 'hex') = expected.value->>'payloadDigest') = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixEvents}) AS expected(value)
      WHERE CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
        CASE WHEN expected.value->>'type' IN ('tool_call.completed', 'tool_call.failed') THEN
          (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 11 AND expected.value ?& ARRAY['id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest','status','errorCode']
          AND ((expected.value->>'type' = 'tool_call.completed' AND expected.value->>'status' = 'completed' AND expected.value->'errorCode' = 'null'::jsonb)
            OR (expected.value->>'type' = 'tool_call.failed' AND expected.value->>'status' IN ('failed','cancelled')
              AND jsonb_typeof(expected.value->'errorCode') IN ('null','string') AND (expected.value->'errorCode' = 'null'::jsonb
                OR expected.value->>'errorCode' ~ '^[A-Za-z0-9_.:-]{1,128}$') AND COALESCE(expected.value->>'errorCode','')
                NOT IN ('policy_requires_approval','policy_requires_user_input','gmail_oauth_required','session_pause_requested')))
        ELSE (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 9
          AND expected.value ?& ARRAY['id','sequence','type','actor','itemId','correlationId','causationId','idempotencyKey','payloadDigest']
          AND NOT (expected.value ? 'status' OR expected.value ? 'errorCode') END
        ELSE FALSE END AND expected.value->>'payloadDigest' ~ '^[0-9a-f]{64}$'
        AND expected.value->>'sequence' ~ '^[1-9][0-9]{0,18}$') = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM "agent_events" AS scoped WHERE scoped."sessionId" = boundSource."sessionId"
      AND scoped."turnId" = boundSource."turnId" AND scoped."taskId" = boundSource."taskId"
      AND (scoped."id" IN (SELECT expected.value->>'id' FROM jsonb_array_elements(${prefixEvents}) AS expected(value))
        OR scoped."causationId" IN (SELECT expected.value->>'id' FROM jsonb_array_elements(${prefixEvents}) AS expected(value)))) = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM "agent_events" AS ordered WHERE ordered."sessionId" = boundSource."sessionId"
      AND ordered."turnId" = boundSource."turnId" AND ordered."taskId" = boundSource."taskId"
      AND ordered."sequence" BETWEEN (proof.value->'sourceStepPrefix'->'events'->0->>'sequence')::bigint
        AND (proof.value->'sourceStepPrefix'->'events'->(jsonb_array_length(${prefixEvents}) - 1)->>'sequence')::bigint) = jsonb_array_length(${prefixEvents})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixItems}) AS expected(value)
      JOIN "agent_items" AS exactItem ON exactItem."id" = expected.value->>'id' AND exactItem."sessionId" = boundSource."sessionId"
        AND exactItem."turnId" = boundSource."turnId" AND exactItem."taskId" = boundSource."taskId" AND exactItem."stepId" = boundSource."id"
      WHERE exactItem."type" = expected.value->>'type' AND exactItem."status" = expected.value->>'status'
        AND exactItem."revision"::text = expected.value->>'revision' AND exactItem."phase" IS NOT DISTINCT FROM expected.value->>'phase'
        AND encode(sha256(convert_to(exactItem."content"::text, 'UTF8')), 'hex') = expected.value->>'contentDigest') = jsonb_array_length(${prefixItems})
    AND (SELECT COUNT(*) FROM jsonb_array_elements(${prefixItems}) AS expected(value)
      WHERE CASE WHEN jsonb_typeof(expected.value) = 'object' THEN
        (SELECT COUNT(*) FROM jsonb_object_keys(expected.value)) = 6 AND expected.value ?& ARRAY['id','type','status','revision','phase','contentDigest']
        ELSE FALSE END AND expected.value->>'contentDigest' ~ '^[0-9a-f]{64}$') = jsonb_array_length(${prefixItems})
    AND jsonb_array_length(${prefixItems}) = (SELECT COUNT(*) FROM "agent_items" AS scopedItem
      WHERE scopedItem."sessionId" = boundSource."sessionId" AND scopedItem."turnId" = boundSource."turnId"
        AND scopedItem."taskId" = boundSource."taskId" AND scopedItem."stepId" = boundSource."id")
  THEN TRUE ELSE FALSE END
ELSE FALSE END`
