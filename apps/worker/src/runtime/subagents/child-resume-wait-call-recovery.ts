import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"

import { childWaitClaimEventKey, isExactChildWaitInput, type ChildWaitClaimRecovery } from "./child-durable-wait-replay.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ChildWaitCallRecoveryState = Readonly<{
  readonly claim?: ChildWaitClaimRecovery
  readonly orphanCallIds: readonly string[]
}>

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null
}
function exact(value: unknown, expected: unknown): boolean {
  try { return canonicalJson(value) === canonicalJson(expected) } catch { return false }
}
function eventKey(lease: SubagentLease, key: string): string { return `task:${lease.id}:event:${key}` }
function validEvent(row: Row, lease: SubagentLease, expected: Row, payload: unknown): boolean {
  return row.sessionId === lease.sessionId && row.turnId === lease.turnId && row.taskId === lease.id && row.actor === "subagent"
    && row.type === expected.type && row.itemId === expected.itemId && row.correlationId === expected.correlationId
    && row.causationId === expected.causationId && row.idempotencyKey === expected.idempotencyKey && exact(row.payload, payload)
}
function callIdOf(row: Row): string {
  const id = object(row.content)?.toolCallId
  if (typeof id !== "string" || !id.trim()) throw new Error("child_resume_wait_tool_call_conflict")
  return id
}
function itemId(lease: SubagentLease, kind: "call" | "result", callId: string): string {
  return `task:${lease.id}:item:tool-${kind === "call" ? "call" : "result"}:${callId}:attempt:${lease.attemptCount}`
}
function contentForCall(content: Row, callId: string, wait: DurableWaitResume): boolean {
  return content.toolCallId === callId && content.toolName === "wait_subagents" && content.toolVersion === "1"
    && isExactChildWaitInput(content.input, wait.input)
}
function validOrphan(
  row: Row, callId: string, wait: DurableWaitResume, lease: SubagentLease, results: readonly Row[], events: readonly Row[],
): boolean {
  const callItemId = itemId(lease, "call", callId), resultItemId = itemId(lease, "result", callId), content = object(row.content)
  const related = events.filter(event => event.itemId === callItemId || event.itemId === resultItemId || event.correlationId === callId)
  if (row.id !== callItemId || row.stepId !== wait.continuationStepId || row.attempt !== wait.attempt
    || row.ordinal !== wait.continuationOrdinal || row.status !== "started" || Number(row.revision) !== 0
    || !content || !contentForCall(content, callId, wait) || !exact(content, {
      toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: content.input,
    }) || results.length !== 0 || related.length !== 1) return false
  return validEvent(related[0]!, lease, { type: "item.started", itemId: callItemId, correlationId: wait.continuationStepId,
    causationId: related[0]!.causationId, idempotencyKey: eventKey(lease, `item-started:${callItemId}`) },
  { itemId: callItemId, type: "tool_call", phase: null }) && typeof related[0]!.id === "string" && !!related[0]!.id.trim()
}

function recoverClaim(
  row: Row, claim: Row, callId: string, wait: DurableWaitResume, lease: SubagentLease, results: readonly Row[], events: readonly Row[],
): ChildWaitClaimRecovery {
  const callItemId = itemId(lease, "call", callId), resultItemId = itemId(lease, "result", callId)
  const content = object(row.content), status = String(row.status), revision = Number(row.revision)
  if (row.id !== callItemId || row.stepId !== wait.continuationStepId || row.attempt !== wait.attempt
    || row.ordinal !== wait.continuationOrdinal || !content || !contentForCall(content, callId, wait)
    || status !== "started" && status !== "completed" || revision !== (status === "started" ? 0 : 1)
    || !exact(content, { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: content.input,
      ...(status === "completed" ? { status: "completed", errorCode: null } : {}) })) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  const callEvents = events.filter(event => event.itemId === callItemId), itemStartedKey = eventKey(lease, `item-started:${callItemId}`)
  const started = callEvents.filter(event => event.idempotencyKey === itemStartedKey)
  const claimKey = eventKey(lease, childWaitClaimEventKey(wait.attempt, wait.continuationStepId!))
  if (started.length !== 1 || !validEvent(started[0]!, lease, { type: "item.started", itemId: callItemId,
    correlationId: wait.continuationStepId, causationId: started[0]!.causationId, idempotencyKey: itemStartedKey },
  { itemId: callItemId, type: "tool_call", phase: null }) || !started[0]!.id
    || claim.idempotencyKey !== claimKey || !validEvent(claim, lease, { type: "tool_call.started", itemId: callItemId,
      correlationId: callId, causationId: started[0]!.id, idempotencyKey: claimKey },
    { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id })) throw new Error("child_resume_wait_tool_call_conflict")
  const finish = callEvents.filter(event => event.type === "tool_call.completed"), complete = callEvents.filter(event => event.type === "item.completed")
  const finishKey = eventKey(lease, `tool-finished:${callId}`), completeKey = eventKey(lease, `tool-call-completed:${callId}:${callItemId}:${revision}`)
  if (callEvents.filter(event => event.type === "tool_call.started").length !== 1
    || callEvents.some(event => !["item.started", "tool_call.started", "item.completed", "tool_call.completed"].includes(String(event.type))
      || event.type === "tool_call.failed" || event.type === "item.failed")
    || status === "started" && (finish.length > 0 || complete.length > 0) || finish.length > 1 || complete.length > 1
    || complete.length === 1 && !validEvent(complete[0]!, lease, { type: "item.completed", itemId: callItemId,
      correlationId: callItemId, causationId: claim.id, idempotencyKey: completeKey },
    { itemId: callItemId, status: "completed", content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: content.input, status: "completed", errorCode: null } })
    || finish.length === 1 && (!complete.length || !validEvent(finish[0]!, lease, { type: "tool_call.completed", itemId: callItemId,
      correlationId: callId, causationId: complete[0]!.id, idempotencyKey: finishKey },
    { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id }))) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  if (status === "completed" && complete.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
  const result = results[0], resultContent = result && object(result.content)
  if (result && finish.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
  if (results.length > 1 || result && (result.id !== resultItemId || status !== "completed"
    || !["started", "completed"].includes(String(result.status)) || Number(result.revision) !== (result.status === "started" ? 0 : 1)
    || !exact(resultContent, { toolCallId: callId, output: wait.output, errorCode: null }))) throw new Error("child_resume_wait_tool_call_conflict")
  const resultEvents = events.filter(event => event.itemId === resultItemId)
  if (!result && resultEvents.length > 0) throw new Error("child_resume_wait_tool_call_conflict")
  let resultItem: ChildWaitClaimRecovery["resultItem"]
  if (result) {
    const starts = resultEvents.filter(event => event.type === "item.started"), completes = resultEvents.filter(event => event.type === "item.completed")
    const startKey = eventKey(lease, `item-started:${resultItemId}`), completeResultKey = eventKey(lease, `tool-result-completed:${callId}:${resultItemId}:${Number(result.revision)}`)
    if (starts.length > 1 || completes.length > 1 || result.status === "completed" && starts.length !== 1
      || result.status === "started" && completes.length > 0
      || starts.length === 1 && !validEvent(starts[0]!, lease, { type: "item.started", itemId: resultItemId, correlationId: wait.continuationStepId,
        causationId: finish[0]!.id, idempotencyKey: startKey }, { itemId: resultItemId, type: "tool_result", phase: null })
      || completes.length === 1 && !validEvent(completes[0]!, lease, { type: "item.completed", itemId: resultItemId,
        correlationId: resultItemId, causationId: starts[0]!.id, idempotencyKey: completeResultKey },
      { itemId: resultItemId, status: "completed", content: { toolCallId: callId, output: wait.output, errorCode: null } })) {
      throw new Error("child_resume_wait_tool_call_conflict")
    }
    resultItem = { id: resultItemId, revision: Number(result.revision), status: String(result.status) as "started" | "completed" }
  }
  const payload = object(claim.payload)
  if (!payload || payload.toolCallId !== callId || payload.toolName !== "wait_subagents" || payload.taskId !== lease.id) throw new Error("child_resume_wait_tool_call_conflict")
  return { owner: { id: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    ownerId: lease.ownerId, attemptCount: lease.attemptCount }, stepId: wait.continuationStepId!, sourceWaitCallId: wait.toolCallId,
    sourceInput: wait.input, call: { id: callId, name: "wait_subagents", arguments: content.input },
    callItem: { id: callItemId, revision, status: status as "started" | "completed" }, callStartedEventId: String(started[0]!.id),
    claimEventId: String(claim.id), output: wait.output, ...(resultItem ? { resultItem } : {}) }
}

export async function loadChildWaitCallRecovery(
  client: Client, lease: SubagentLease, wait: DurableWaitResume,
): Promise<ChildWaitCallRecoveryState | undefined> {
  const stepId = wait.continuationStepId, ordinal = wait.continuationOrdinal
  if (wait.attempt !== lease.attemptCount || !stepId || !Number.isSafeInteger(ordinal)) return undefined
  const claimKey = eventKey(lease, childWaitClaimEventKey(wait.attempt, stepId))
  const calls = (await client.query<Row>(`SELECT item."id", item."status", item."revision", item."content", item."stepId", step."attempt", step."ordinal"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4 AND item."type" = 'tool_call'
      AND item."content"->>'toolName' = 'wait_subagents' AND step."attempt" = $5 AND step."ordinal" = $6 ORDER BY item."id" LIMIT 3 FOR SHARE OF item, step`,
  [lease.sessionId, lease.turnId, lease.id, stepId, wait.attempt, ordinal])).rows
  if (calls.length > 2) throw new Error("child_resume_wait_tool_call_conflict")
  const ids = calls.map(callIdOf), callItemIds = ids.map(id => itemId(lease, "call", id)), resultItemIds = ids.map(id => itemId(lease, "result", id))
  const results = ids.length ? (await client.query<Row>(`SELECT item."id", item."status", item."revision", item."content", item."stepId"
    FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4
      AND item."type" = 'tool_result' AND item."content"->>'toolCallId' = ANY($5::text[]) ORDER BY item."id" LIMIT 3 FOR SHARE`,
  [lease.sessionId, lease.turnId, lease.id, stepId, ids])).rows : []
  const events = (await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."taskId", event."itemId", event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND (event."idempotencyKey" = $4 OR event."itemId" = ANY($5::text[]) OR event."correlationId" = ANY($6::text[])) ORDER BY event."sequence" LIMIT 32`,
  [lease.sessionId, lease.turnId, lease.id, claimKey, [...callItemIds, ...resultItemIds], ids])).rows
  if (events.length >= 32) throw new Error("child_resume_wait_tool_call_conflict")
  const claims = events.filter(event => event.idempotencyKey === claimKey)
  if (claims.length > 1) throw new Error("child_resume_wait_tool_call_conflict")
  if (calls.length === 0 && claims.length === 0) return undefined
  const claimedId = claims.length === 1 ? object(claims[0]!.payload)?.toolCallId : undefined
  const claimedRows = calls.filter((row, index) => ids[index] === claimedId)
  if (claims.length === 1 && (typeof claimedId !== "string" || claimedRows.length !== 1)) throw new Error("child_resume_wait_tool_call_conflict")
  if (claims.length === 0 && calls.length !== 1 || claims.length === 1 && calls.length - claimedRows.length > 1) throw new Error("child_resume_wait_tool_call_conflict")
  const orphanCallIds: string[] = []
  for (let index = 0; index < calls.length; index += 1) {
    if (claimedId === ids[index]) continue
    const callResults = results.filter(result => object(result.content)?.toolCallId === ids[index])
    if (!validOrphan(calls[index]!, ids[index]!, wait, lease, callResults, events)) throw new Error("child_resume_wait_tool_call_conflict")
    orphanCallIds.push(ids[index]!)
  }
  if (claims.length === 0) return { orphanCallIds }
  const claimed = claimedRows[0]!, callId = claimedId as string
  const claim = recoverClaim(claimed, claims[0]!, callId, wait, lease, results.filter(result => object(result.content)?.toolCallId === callId), events)
  return { claim, orphanCallIds }
}
