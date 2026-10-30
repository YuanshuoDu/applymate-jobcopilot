import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import type pg from "pg"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import { appendTurnEngineEventBatch } from "../turns/turn-engine-event-batch.js"
import type { TurnEnginePool, TurnEngineQueryClient } from "../turns/turn-engine-owner-sql.js"
import type { TurnEngineEventInput } from "../turns/turn-engine-types.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"
import { toRepositoryJson } from "../turns/turn-engine-types.js"
import { DurableSubagentWaitError, safeSubagentWaitJson, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { markCanonicalSubagentWaitId, markCanonicalSubagentWaitTargetIds } from "./subagent-wait-structural-ids.js"
import type { SubagentLease } from "./types.js"

type QueryClient = Pick<pg.PoolClient, "query">
type Client = TurnEngineQueryClient
type Pool = TurnEnginePool
type Row = Record<string, unknown>
type Lease = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "attemptCount" | "leaseExpiresAt">
type Lifecycle = Readonly<{ state: "unreconciled" | "waiting" | "recovered"; toolCallId: string; callItemId: string; sourceAttempt: number; resultItemId?: string }>
type Provenance = Readonly<{ schemaVersion: "child-wait-source-lifecycle.v1"; userId: string; sessionId: string; turnId: string; rootTaskId: string; taskId: string; ownerId: string; attempt: number; stepId: string; waitId: string; toolCallId: string; callItemId: string; resultItemId: string }>
const LIMIT = 16_384
const VERSION = "child-wait-source-lifecycle.v1"

function obj(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function exact(value: Row, keys: readonly string[]): boolean { const a = Object.keys(value).sort(), b = [...keys].sort(); return a.length === b.length && a.every((key, i) => key === b[i]) }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value === value.trim() && value.length <= 256 }
function strictIds(value: unknown): string[] | undefined { return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(text) && new Set(value).size === value.length ? value as string[] : undefined }
function sameIds(a: readonly string[], b: readonly string[]): boolean { const left = [...a].sort(), right = [...b].sort(); return left.length === right.length && left.every((id, i) => id === right[i]) }
function sameJson(a: unknown, b: unknown): boolean { try { return canonicalJson(a) === canonicalJson(b) } catch { return false } }
function reject(): never { throw new DurableSubagentWaitError("wait_scope_error", "Child wait source lifecycle is inconsistent") }
function required(value: unknown): string { if (!text(value)) return reject(); return value }
function owner(lease: Lease): ExecutionOwnerFence { return { kind: "task", userId: lease.userId, sessionId: lease.sessionId, turnId: required(lease.turnId), taskId: lease.id, rootTaskId: required(lease.rootTaskId), ownerId: required(lease.ownerId), attemptCount: lease.attemptCount, leaseExpiresAt: lease.leaseExpiresAt } }
function resultId(taskId: string, waitId: string, callId: string): string {
  const hash = createHash("sha256").update("child-wait-source-result:v1\0" + waitId + "\0" + callId).digest("hex")
  return "task:" + taskId + ":item:tool-result:source-wait-recovery:" + hash
}
function marker(lease: Lease, sourceAttempt: number, stepId: string, waitId: string, callId: string, callItemId: string, resultItemId: string): Provenance {
  return { schemaVersion: VERSION, userId: lease.userId, sessionId: lease.sessionId, turnId: required(lease.turnId), rootTaskId: required(lease.rootTaskId),
    taskId: lease.id, ownerId: required(lease.ownerId), attempt: sourceAttempt, stepId, waitId, toolCallId: callId, callItemId, resultItemId }
}
function validMarker(value: unknown, expected: Provenance): boolean { const saved = obj(value); return exact(saved, Object.keys(expected)) && text(saved.ownerId) && sameJson({ ...saved, ownerId: expected.ownerId }, expected) }
function validOutcome(value: unknown, wait: Row, ids: readonly string[]): value is DurableSubagentWaitResult {
  const out = obj(value), tasks = Array.isArray(out.tasks) ? out.tasks.map(obj) : [], savedIds = strictIds(out.taskIds)
  if (!exact(out, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"]) || out.waitId !== wait.id
    || out.status !== wait.status || !(out.status === "ready" || out.status === "timed_out") || !savedIds || !sameIds(savedIds, ids)
    || !Array.isArray(out.matchedTaskIds) || out.matchedTaskIds.some(id => typeof id !== "string" || !ids.includes(id))
    || new Set(out.matchedTaskIds).size !== out.matchedTaskIds.length || tasks.length !== ids.length
    || !sameIds(tasks.map(task => required(task.taskId)), ids) || !text(out.deadlineAt)
    || !tasks.every(task => exact(task, ["taskId", "status", "role", "result", "failureReason"])
      && typeof task.status === "string" && typeof task.role === "string" && !!task.role.trim()
      && (task.failureReason === null || typeof task.failureReason === "string"))) return false
  const deadline = wait.deadlineAt instanceof Date ? wait.deadlineAt.getTime() : new Date(String(wait.deadlineAt)).getTime()
  return Number.isFinite(deadline) && new Date(out.deadlineAt).getTime() === deadline
    && markCanonicalSubagentWaitId(out, String(wait.id))
    && markCanonicalSubagentWaitTargetIds({ targetTaskIds: savedIds }, out as DurableSubagentWaitResult, savedIds)
}
function callDetails(call: Row, wait: Row, ids: readonly string[]): { id: string; input: Row } {
  const input = obj(call.input), callIds = strictIds(input.taskIds), request = obj(obj(wait.result).request), requestIds = strictIds(request.targetTaskIds)
  const callId = required(call.toolCallId)
  const started = exact(call, ["toolCallId", "toolName", "toolVersion", "input"])
  const completed = exact(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
  if ((!started && !completed) || completed && (call.status !== "completed" || call.errorCode !== null)
    || call.toolName !== "wait_subagents" || call.toolVersion !== "1"
    || !exact(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"]) || !text(input.idempotencyKey) || input.idempotencyKey !== wait.idempotencyKey
    || !exact(request, ["targetTaskIds", "mode", "timeoutMs"]) || input.mode !== wait.mode || request.mode !== wait.mode || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1
    || input.timeoutMs !== request.timeoutMs || !callIds || !sameIds(callIds, ids) || !requestIds || !sameIds(requestIds, ids)) return reject()
  return { id: callId, input }
}
function safeResultContent(callId: string, output: DurableSubagentWaitResult): RepositoryJsonValue {
  const safe = obj(safeSubagentWaitJson({ toolCallId: callId, output, errorCode: null }, LIMIT))
  const safeOutput = obj(safe.output)
  if (!exact(safe, ["toolCallId", "output", "errorCode"]) || !exact(safeOutput, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    || !sameIds(strictIds(safeOutput.taskIds) ?? [], output.taskIds)) return reject()
  safe.toolCallId = callId
  return toRepositoryJson(safe)
}
function validWaitingReceipt(result: Row | undefined, wait: Row, ids: readonly string[], callId: string): boolean {
  const content = obj(result?.content), output = obj(content.output), outputIds = strictIds(output.taskIds)
  const tasks = Array.isArray(output.tasks) ? output.tasks.map(obj) : [], taskIds = tasks.map(task => task.taskId)
  const matched = output.matchedTaskIds
  return !!result && content.toolCallId === callId && content.errorCode === null && exact(content, ["toolCallId", "output", "errorCode"])
    && exact(output, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    && output.waitId === wait.id && output.status === "waiting" && !!outputIds && sameIds(outputIds, ids)
    && Array.isArray(matched) && matched.length === 0 && tasks.length === ids.length && tasks.every(task => exact(task, ["taskId", "status", "role", "result", "failureReason"]))
    && taskIds.every(id => typeof id === "string") && sameIds(taskIds as string[], ids)
    && text(output.deadlineAt) && new Date(output.deadlineAt).getTime() === new Date(String(wait.deadlineAt)).getTime()
}
function event(ownerFence: ExecutionOwnerFence, key: string, itemId: string, correlationId: string, type: string, payload: unknown): TurnEngineEventInput {
  return { owner: ownerFence, id: "event:" + randomUUID(), itemId, correlationId, causationId: null, type,
    idempotencyKey: "task:" + ownerFence.taskId + ":event:" + key, payload: toRepositoryJson(payload) }
}
function sequence(row: Row): bigint | undefined { try { const value = BigInt(String(row.sequence)); return value > 0n ? value : undefined } catch { return undefined } }
function eventMatches(row: Row, e: { type: string; itemId: string; correlationId: string; cause: string | null; key: string; payload: unknown }): boolean {
  return row.type === e.type && row.itemId === e.itemId && row.correlationId === e.correlationId && row.causationId === e.cause
    && row.actor === "subagent" && row.idempotencyKey === e.key && sameJson(row.payload, e.payload)
}

/** Read-only exact validation used by both pre-ack and already-consumed resume paths. */
export async function inspectChildWaitSourceLifecycle(client: QueryClient, lease: Lease, wait: Row, stepId: string, output: DurableSubagentWaitResult): Promise<Lifecycle> {
  const waitId = required(wait.id), ids = strictIds(wait.targetTaskIds)
  if (!ids || !text(lease.ownerId) || !text(lease.rootTaskId) || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1
    || !validOutcome(output, wait, ids) || wait.stepId !== stepId || wait.parentTaskId !== lease.id
    || wait.sessionId !== lease.sessionId || wait.turnId !== lease.turnId || wait.userId !== lease.userId || !text(stepId)) return reject()
  const sourceStep = (await client.query<Row>("SELECT \"attempt\" FROM \"agent_steps\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"taskId\" = $4 FOR SHARE",
    [stepId, lease.sessionId, lease.turnId, lease.id])).rows[0]
  const sourceAttempt = Number(sourceStep?.attempt)
  if (!sourceStep || !Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1 || sourceAttempt > lease.attemptCount) return reject()
  const calls = (await client.query<Row>("SELECT \"id\", \"revision\", \"stepId\", \"taskId\", \"type\", \"phase\", \"content\", \"status\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"stepId\" = $4 AND \"type\" = 'tool_call' AND \"content\"->>'toolName' = 'wait_subagents' ORDER BY \"createdAt\" DESC, \"id\" DESC LIMIT 2 FOR SHARE", [lease.sessionId, lease.turnId, lease.id, stepId])).rows
  if (calls.length !== 1) return reject()
  const callItem = calls[0]!, callItemId = required(callItem.id), call = obj(callItem.content), callInfo = callDetails(call, wait, ids)
  const items = (await client.query<Row>("SELECT \"id\", \"revision\", \"stepId\", \"taskId\", \"type\", \"phase\", \"content\", \"status\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"content\"->>'toolCallId' = $4 ORDER BY \"createdAt\" DESC, \"id\" DESC LIMIT 3 FOR SHARE", [lease.sessionId, lease.turnId, lease.id, callInfo.id])).rows
  const sourceCall = items.filter(row => row.id === callItemId), results = items.filter(row => row.type === "tool_result")
  if (sourceCall.length !== 1 || items.length !== 1 + results.length || results.length > 1
    || items.some(row => row.stepId !== stepId || row.taskId !== lease.id || !["tool_call", "tool_result"].includes(String(row.type)))) return reject()
  const result = results[0], resultItemId = result ? required(result.id) : resultId(lease.id, waitId, callInfo.id)
  const rawWait = obj(wait.result), markerExists = Object.prototype.hasOwnProperty.call(rawWait, "sourceLifecycleRecovery")
  const savedMarker = obj(rawWait.sourceLifecycleRecovery)
  if (!exact(rawWait, markerExists ? ["request", "outcome", "sourceLifecycleRecovery"] : ["request", "outcome"])) return reject()
  const expectedMarker = marker(lease, sourceAttempt, stepId, waitId, callInfo.id, callItemId, resultItemId)
  if (markerExists && !validMarker(savedMarker, expectedMarker)) return reject()
  if (markerExists && resultItemId !== resultId(lease.id, waitId, callInfo.id)) return reject()
  const rawOutput = result ? obj(obj(result.content).output) : {}
  const recovered = !!result && markerExists && sameJson(rawOutput, safeSubagentWaitJson(output, LIMIT))
  const waiting = !markerExists && validWaitingReceipt(result, wait, ids, callInfo.id)
  const initial = !result && !markerExists && callItem.status === "started" && Number(callItem.revision) === 0
  if (!initial && !waiting && !recovered) return reject()
  if (initial && (!exact(call, ["toolCallId", "toolName", "toolVersion", "input"]) || callItem.phase !== null)) return reject()
  if (!initial && (callItem.status !== "completed" || Number(callItem.revision) !== 1 || !result || result.status !== "completed"
    || Number(result.revision) !== 1 || callItem.phase !== null || result.phase !== null
    || !exact(call, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
    || call.status !== "completed" || call.errorCode !== null || !sameJson(call.input, callInfo.input)
    || !exact(obj(result.content), ["toolCallId", "output", "errorCode"]) || obj(result.content).toolCallId !== callInfo.id
    || obj(result.content).errorCode !== null)) return reject()
  if (!initial && waiting && (markerExists || obj(result.content).output === undefined)) return reject()
  if (!initial && recovered && !validMarker(savedMarker, expectedMarker)) return reject()
  const expectedEvents = await validateEvents(client, lease, stepId, callItem, result, callInfo.id, resultItemId, output, initial, waiting)
  if (!expectedEvents) return reject()
  return { state: initial ? "unreconciled" : waiting ? "waiting" : "recovered", toolCallId: callInfo.id, callItemId, sourceAttempt, ...(result ? { resultItemId } : {}) }
}

async function validateEvents(client: QueryClient, lease: Lease, stepId: string, call: Row, result: Row | undefined, callId: string, resultIdValue: string,
  output: DurableSubagentWaitResult, initial: boolean, waiting: boolean): Promise<boolean> {
  const callItemId = String(call.id), prefix = "task:" + lease.id + ":event:"
  const keys = [prefix + "item-started:" + callItemId, prefix + "tool-started:" + callId,
    prefix + "tool-call-completed:" + callId + ":" + callItemId + ":1", prefix + "tool-finished:" + callId,
    prefix + "item-started:" + resultIdValue, prefix + "tool-result-completed:" + callId + ":" + resultIdValue + ":1"]
  const rows = (await client.query<Row>("SELECT \"id\", \"itemId\", \"type\", \"actor\", \"correlationId\", \"causationId\", \"sequence\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND (\"itemId\" = $4 OR \"correlationId\" = $5 OR \"itemId\" = $6 OR \"correlationId\" = $6 OR \"idempotencyKey\" = ANY($7::text[])) ORDER BY \"sequence\" FOR SHARE", [lease.sessionId, lease.turnId, lease.id, callItemId, callId, resultIdValue, keys])).rows
  const itemStart = rows.find(row => row.idempotencyKey === keys[0]), callStart = rows.find(row => row.idempotencyKey === keys[1])
  if (!itemStart || !callStart || !eventMatches(itemStart, { type: "item.started", itemId: callItemId, correlationId: stepId,
    cause: itemStart.causationId as string | null, key: keys[0]!, payload: { itemId: callItemId, type: "tool_call", phase: null } })
    || !eventMatches(callStart, { type: "tool_call.started", itemId: callItemId, correlationId: callId, cause: String(itemStart.id),
      key: keys[1]!, payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })) return false
  const seqStart = sequence(itemStart), seqCall = sequence(callStart)
  if (!seqStart || !seqCall || seqStart >= seqCall) return false
  const causeId = required(itemStart.causationId)
  const previous = (await client.query<Row>("SELECT event.\"id\", event.\"sequence\" FROM \"agent_events\" AS event WHERE event.\"sessionId\" = $1 AND event.\"turnId\" = $2 AND event.\"taskId\" = $3 AND event.\"id\" = $4 AND event.\"actor\" = 'subagent' AND (event.\"correlationId\" = $5 OR EXISTS (SELECT 1 FROM \"agent_items\" AS source WHERE source.\"id\" = event.\"itemId\" AND source.\"sessionId\" = $1 AND source.\"turnId\" = $2 AND source.\"taskId\" = $3 AND source.\"stepId\" = $5)) FOR SHARE", [lease.sessionId, lease.turnId, lease.id, causeId, stepId])).rows[0]
  const priorSequence = previous && sequence(previous)
  if (!previous || previous.id !== causeId || !priorSequence || priorSequence >= seqStart) return false
  if (rows.length !== (initial ? 2 : 6)) return false
  if (initial) {
    const causal = (await client.query<Row>("SELECT \"id\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"causationId\" = ANY($4::text[]) FOR SHARE", [lease.sessionId, lease.turnId, lease.id, [itemStart.id, callStart.id]])).rows
    return causal.length === 1 && causal[0]!.id === callStart.id
  }
  const callComplete = rows.find(row => row.idempotencyKey === keys[2]), toolComplete = rows.find(row => row.idempotencyKey === keys[3])
  const resultStart = rows.find(row => row.idempotencyKey === keys[4]), resultComplete = rows.find(row => row.idempotencyKey === keys[5])
  const callContent = obj(call.content)
  const inputIds = strictIds(obj(callContent.input).taskIds)
  if (!inputIds) return false
  const projectedCallContent = projectWaitCallEventContent(callContent)
  const completionMatches = (content: unknown) => eventMatches(callComplete!, { type: "item.completed", itemId: callItemId,
    correlationId: callItemId, cause: String(callStart.id), key: keys[2]!, payload: { itemId: callItemId, status: "completed", content } })
  const resultPayload = result ? obj(result.content) : {}
  if (!callComplete || !toolComplete || !resultStart || !resultComplete
    || !(completionMatches(projectedCallContent) || waiting && completionMatches(callContent))
    || !eventMatches(toolComplete, { type: "tool_call.completed", itemId: callItemId, correlationId: callId, cause: String(callComplete.id), key: keys[3]!,
      payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } })
    || !eventMatches(resultStart, { type: "item.started", itemId: resultIdValue, correlationId: stepId, cause: String(toolComplete.id), key: keys[4]!,
      payload: { itemId: resultIdValue, type: "tool_result", phase: null } })
    || !eventMatches(resultComplete, { type: "item.completed", itemId: resultIdValue, correlationId: resultIdValue, cause: String(resultStart.id), key: keys[5]!,
      payload: { itemId: resultIdValue, status: "completed", content: resultPayload } })) return false
  const ordered = [itemStart, callStart, callComplete, toolComplete, resultStart, resultComplete].map(sequence)
  if (ordered.some(value => !value) || ordered.some((value, index) => index > 0 && value! <= ordered[index - 1]!)) return false
  const causes = [itemStart.id, callStart.id, callComplete.id, toolComplete.id, resultStart.id]
  const extra = (await client.query<Row>("SELECT \"id\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"causationId\" = ANY($4::text[]) FOR SHARE", [lease.sessionId, lease.turnId, lease.id, causes])).rows
  return new Set([...rows, ...extra].map(row => row.id)).size === 6
}

/** Reconciles source items, event/outbox and private provenance within the existing acknowledgement transaction. */
export async function reconcileChildWaitSourceLifecycle(pool: Pool, client: Client, lease: Lease, wait: Row, stepId: string,
  output: DurableSubagentWaitResult, now: Date): Promise<Lifecycle> {
  const state = await inspectChildWaitSourceLifecycle(client, lease, wait, stepId, output)
  if (state.state === "waiting") return state
  if (state.state === "recovered" && (wait.consumedAt === null || wait.consumedAt === undefined)) return reject()
  const resultItemId = state.resultItemId ?? resultId(lease.id, String(wait.id), state.toolCallId)
  const waitJson = obj(wait.result), provenance = marker(lease, state.sourceAttempt, stepId, String(wait.id), state.toolCallId, state.callItemId, resultItemId)
  if (state.state === "unreconciled") {
    const call = (await client.query<Row>("SELECT \"content\" FROM \"agent_items\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"taskId\" = $4 AND \"stepId\" = $5 AND \"type\" = 'tool_call' FOR UPDATE", [state.callItemId, lease.sessionId, lease.turnId, lease.id, stepId])).rows[0]
    if (!call) return reject()
    const rawCall = obj(call.content), input = obj(rawCall.input), ids = strictIds(wait.targetTaskIds)
    if (!ids || !sameIds(strictIds(input.taskIds) ?? [], ids)) return reject()
    const completedCall = { toolCallId: state.toolCallId, toolName: "wait_subagents", toolVersion: "1", status: "completed", errorCode: null, input }
    const resultContent = safeResultContent(state.toolCallId, output), callEventContent = projectWaitCallEventContent(completedCall)
    const updatedCall = await client.query("UPDATE \"agent_items\" SET \"status\" = 'completed', \"content\" = $1::jsonb, \"revision\" = \"revision\" + 1, \"startedAt\" = $2, \"completedAt\" = $2, \"updatedAt\" = $2 WHERE \"id\" = $3 AND \"sessionId\" = $4 AND \"turnId\" = $5 AND \"taskId\" = $6 AND \"stepId\" = $7 AND \"type\" = 'tool_call' AND \"status\" = 'started' AND \"revision\" = 0", [JSON.stringify(completedCall), now, state.callItemId, lease.sessionId, lease.turnId, lease.id, stepId])
    if (updatedCall.rowCount !== 1) return reject()
    const inserted = await client.query("INSERT INTO \"agent_items\" (\"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"content\", \"startedAt\", \"updatedAt\") VALUES ($1, $2, $3, $4, $5, 'tool_result', 'started', NULL, $6::jsonb, $7, $7) ON CONFLICT (\"id\") DO NOTHING RETURNING \"id\"", [resultItemId, lease.sessionId, lease.turnId, stepId, lease.id, JSON.stringify(resultContent), now])
    if (inserted.rowCount !== 1) return reject()
    const updatedResult = await client.query("UPDATE \"agent_items\" SET \"status\" = 'completed', \"content\" = $1::jsonb, \"revision\" = \"revision\" + 1, \"startedAt\" = $2, \"completedAt\" = $2, \"updatedAt\" = $2 WHERE \"id\" = $3 AND \"sessionId\" = $4 AND \"turnId\" = $5 AND \"taskId\" = $6 AND \"stepId\" = $7 AND \"type\" = 'tool_result' AND \"status\" = 'started' AND \"revision\" = 0", [JSON.stringify(resultContent), now, resultItemId, lease.sessionId, lease.turnId, lease.id, stepId])
    if (updatedResult.rowCount !== 1) return reject()
    const start = await readStartEvent(client, lease, state.callItemId, state.toolCallId)
    await appendTurnEngineEventBatch(pool, completionEvents(owner(lease), state, stepId, resultItemId, resultContent, callEventContent, required(start.id)), client)
  } else {
    const ids = strictIds(wait.targetTaskIds)
    if (!ids) return reject()
    const call = (await client.query<Row>("SELECT \"content\" FROM \"agent_items\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"taskId\" = $4 AND \"stepId\" = $5 AND \"type\" = 'tool_call' FOR SHARE", [state.callItemId, lease.sessionId, lease.turnId, lease.id, stepId])).rows[0]
    if (!call) return reject()
    await appendTurnEngineEventBatch(pool, completionEvents(owner(lease), state, stepId, resultItemId, safeResultContent(state.toolCallId, output),
      projectWaitCallEventContent(obj(call.content)), required((await readStartEvent(client, lease, state.callItemId, state.toolCallId)).id)), client)
  }
  if (state.state === "recovered") return state
  const updated = { ...waitJson, sourceLifecycleRecovery: provenance }
  if (!exact(waitJson, ["request", "outcome"]) || Buffer.byteLength(JSON.stringify(updated), "utf8") > LIMIT) return reject()
  const changed = await client.query("UPDATE \"agent_wait_conditions\" SET \"result\" = $1::jsonb, \"updatedAt\" = $2 WHERE \"id\" = $3 AND \"userId\" = $4 AND \"sessionId\" = $5 AND \"turnId\" = $6 AND \"parentTaskId\" = $7 AND \"stepId\" = $8 AND \"status\" IN ('ready', 'timed_out') AND \"result\" = $9::jsonb", [JSON.stringify(updated), now, wait.id, lease.userId, lease.sessionId, lease.turnId, lease.id, stepId, JSON.stringify(waitJson)])
  if (changed.rowCount !== 1) return reject()
  return { ...state, state: "recovered", resultItemId }
}

function completionEvents(ownerFence: ExecutionOwnerFence, state: Lifecycle, stepId: string, resultIdValue: string, resultContent: unknown,
  callContent: unknown, cause: string): TurnEngineEventInput[] {
  const callItemId = state.callItemId, callId = state.toolCallId
  const entries = [
    event(ownerFence, "tool-call-completed:" + callId + ":" + callItemId + ":1", callItemId, callItemId, "item.completed", { itemId: callItemId, status: "completed", content: callContent }),
    event(ownerFence, "tool-finished:" + callId, callItemId, callId, "tool_call.completed", { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: ownerFence.taskId }),
    event(ownerFence, "item-started:" + resultIdValue, resultIdValue, stepId, "item.started", { itemId: resultIdValue, type: "tool_result", phase: null }),
    event(ownerFence, "tool-result-completed:" + callId + ":" + resultIdValue + ":1", resultIdValue, resultIdValue, "item.completed", { itemId: resultIdValue, status: "completed", content: resultContent }),
  ]
  entries[0] = { ...entries[0]!, causationId: cause }
  return entries
}
async function readStartEvent(client: QueryClient, lease: Lease, itemId: string, callId: string): Promise<Row> {
  const row = (await client.query<Row>("SELECT \"id\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"itemId\" = $4 AND \"type\" = 'tool_call.started' AND \"correlationId\" = $5 AND \"idempotencyKey\" = $6", [lease.sessionId, lease.turnId, lease.id, itemId, callId, "task:" + lease.id + ":event:tool-started:" + callId])).rows[0]
  if (!row) return reject()
  return row
}
