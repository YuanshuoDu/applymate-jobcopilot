import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"

import { childWaitClaimEventKey, isExactChildWaitInput, type ChildWaitCallRecovery, type ChildWaitClaimRecovery, type ChildWaitOrphanRecovery } from "./child-durable-wait-replay.js"
import { childWaitRecoveryCausallyAfter, childWaitRecoveryEventKey, childWaitRecoveryEventSequence, childWaitRecoveryLogicalStepOrdinal,
  childWaitRecoveryValidEvent, parseChildWaitModelUsageReceipt, parseChildWaitModelUsage, type ChildWaitModelReceipt } from "./child-resume-wait-call-contract.js"
import { childWaitPgCost, childWaitStoredCostMatchesReceipt } from "./child-resume-wait-cost.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ChildWaitCallRecoveryState = Readonly<{
  readonly claim?: ChildWaitClaimRecovery
  readonly orphan?: ChildWaitOrphanRecovery
  readonly orphanCallIds: readonly string[]
}>

type ModelUsage = ChildWaitCallRecovery["modelUsage"]

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null
}
function exact(value: unknown, expected: unknown): boolean {
  try { return canonicalJson(value) === canonicalJson(expected) } catch { return false }
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
  step: Row, model: { usage: ModelUsage; sequence: bigint; eventId: string }, stepOrdinal: number,
): ChildWaitOrphanRecovery | undefined {
  const callItemId = itemId(lease, "call", callId), resultItemId = itemId(lease, "result", callId), content = object(row.content)
  const related = events.filter(event => event.itemId === callItemId || event.itemId === resultItemId || event.correlationId === callId)
  if (row.id !== callItemId || row.stepId !== wait.continuationStepId || row.attempt !== wait.attempt
    || row.ordinal !== wait.continuationOrdinal || row.status !== "started" || Number(row.revision) !== 0
    || !content || !contentForCall(content, callId, wait) || !exact(content, {
      toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: content.input,
    }) || results.length !== 0 || related.length !== 1 || step.status !== "streaming") return undefined
  if (!childWaitRecoveryValidEvent(related[0]!, lease, { type: "item.started", itemId: callItemId, correlationId: wait.continuationStepId,
    causationId: related[0]!.causationId, idempotencyKey: childWaitRecoveryEventKey(lease, `item-started:${callItemId}`) },
  { itemId: callItemId, type: "tool_call", phase: null }) || typeof related[0]!.id !== "string" || !related[0]!.id.trim()
    || (childWaitRecoveryEventSequence(related[0]!) ?? -1n) <= model.sequence || !childWaitRecoveryCausallyAfter(related[0]!, model.eventId, events)) return undefined
  return { owner: { id: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    ownerId: lease.ownerId, attemptCount: lease.attemptCount }, stepId: wait.continuationStepId!, stepOrdinal, stepStatus: "streaming",
    sourceWaitCallId: wait.toolCallId, sourceInput: wait.input, call: { id: callId, name: "wait_subagents", arguments: content.input },
    callItem: { id: callItemId, revision: 0, status: "started" }, callStartedEventId: related[0]!.id, modelUsage: model.usage, output: wait.output }
}

function recoverClaim(
  row: Row, claim: Row, callId: string, wait: DurableWaitResume, lease: SubagentLease, results: readonly Row[], events: readonly Row[],
  step: Row, model: { usage: ModelUsage; sequence: bigint; eventId: string }, stepOrdinal: number,
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
  const callEvents = events.filter(event => event.itemId === callItemId), itemStartedKey = childWaitRecoveryEventKey(lease, `item-started:${callItemId}`)
  const started = callEvents.filter(event => event.idempotencyKey === itemStartedKey)
  const claimKey = childWaitRecoveryEventKey(lease, childWaitClaimEventKey(wait.attempt, wait.continuationStepId!))
  if (started.length !== 1 || !childWaitRecoveryValidEvent(started[0]!, lease, { type: "item.started", itemId: callItemId,
    correlationId: wait.continuationStepId, causationId: started[0]!.causationId, idempotencyKey: itemStartedKey },
  { itemId: callItemId, type: "tool_call", phase: null }) || !started[0]!.id
    || (childWaitRecoveryEventSequence(started[0]!) ?? -1n) <= model.sequence || !childWaitRecoveryCausallyAfter(started[0]!, model.eventId, events)
    || claim.idempotencyKey !== claimKey || !childWaitRecoveryValidEvent(claim, lease, { type: "tool_call.started", itemId: callItemId,
      correlationId: callId, causationId: started[0]!.id, idempotencyKey: claimKey },
    { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id })) throw new Error("child_resume_wait_tool_call_conflict")
  const finish = callEvents.filter(event => event.type === "tool_call.completed"), complete = callEvents.filter(event => event.type === "item.completed")
  const finishKey = childWaitRecoveryEventKey(lease, `tool-finished:${callId}`), completeKey = childWaitRecoveryEventKey(lease, `tool-call-completed:${callId}:${callItemId}:${revision}`)
  if (callEvents.filter(event => event.type === "tool_call.started").length !== 1
    || callEvents.some(event => !["item.started", "tool_call.started", "item.completed", "tool_call.completed"].includes(String(event.type))
      || event.type === "tool_call.failed" || event.type === "item.failed")
    || status === "started" && (finish.length > 0 || complete.length > 0) || finish.length > 1 || complete.length > 1
    || complete.length === 1 && !childWaitRecoveryValidEvent(complete[0]!, lease, { type: "item.completed", itemId: callItemId,
      correlationId: callItemId, causationId: claim.id, idempotencyKey: completeKey },
    { itemId: callItemId, status: "completed", content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input: content.input, status: "completed", errorCode: null } })
    || finish.length === 1 && (!complete.length || !childWaitRecoveryValidEvent(finish[0]!, lease, { type: "tool_call.completed", itemId: callItemId,
      correlationId: callId, causationId: complete[0]!.id, idempotencyKey: finishKey },
    { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id }))) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
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
    const startKey = childWaitRecoveryEventKey(lease, `item-started:${resultItemId}`), completeResultKey = childWaitRecoveryEventKey(lease, `tool-result-completed:${callId}:${resultItemId}:${Number(result.revision)}`)
    if (starts.length > 1 || completes.length > 1 || result.status === "completed" && starts.length !== 1
      || result.status === "started" && completes.length > 0
      || starts.length === 1 && !childWaitRecoveryValidEvent(starts[0]!, lease, { type: "item.started", itemId: resultItemId, correlationId: wait.continuationStepId,
        causationId: finish[0]!.id, idempotencyKey: startKey }, { itemId: resultItemId, type: "tool_result", phase: null })
      || completes.length === 1 && !childWaitRecoveryValidEvent(completes[0]!, lease, { type: "item.completed", itemId: resultItemId,
        correlationId: resultItemId, causationId: starts[0]!.id, idempotencyKey: completeResultKey },
      { itemId: resultItemId, status: "completed", content: { toolCallId: callId, output: wait.output, errorCode: null } })) {
      throw new Error("child_resume_wait_tool_call_conflict")
    }
    resultItem = { id: resultItemId, revision: Number(result.revision), status: String(result.status) as "started" | "completed" }
  }
  const payload = object(claim.payload)
  if (!payload || payload.toolCallId !== callId || payload.toolName !== "wait_subagents" || payload.taskId !== lease.id) throw new Error("child_resume_wait_tool_call_conflict")
  if (step.status !== "streaming" && step.status !== "completed"
    || step.status === "completed" && (status !== "completed" || result?.status !== "completed")) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  return { owner: { id: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    ownerId: lease.ownerId, attemptCount: lease.attemptCount }, stepId: wait.continuationStepId!, stepOrdinal,
    stepStatus: step.status as "streaming" | "completed", sourceWaitCallId: wait.toolCallId,
    sourceInput: wait.input, call: { id: callId, name: "wait_subagents", arguments: content.input },
    callItem: { id: callItemId, revision, status: status as "started" | "completed" }, callStartedEventId: String(started[0]!.id),
    claimEventId: String(claim.id), modelUsage: model.usage, output: wait.output, ...(resultItem ? { resultItem } : {}) }
}

export async function loadChildWaitCallRecovery(
  client: Client, lease: SubagentLease, wait: DurableWaitResume,
): Promise<ChildWaitCallRecoveryState | undefined> {
  const stepId = wait.continuationStepId, ordinal = wait.continuationOrdinal
  if (wait.attempt !== lease.attemptCount || !stepId || !Number.isSafeInteger(ordinal)) return undefined
  const claimKey = childWaitRecoveryEventKey(lease, childWaitClaimEventKey(wait.attempt, stepId))
  const steps = (await client.query<Row>(`SELECT step."id", step."status", step."attempt", step."ordinal", step."inputTokens", step."outputTokens", step."estimatedCostUsd"
    FROM "agent_steps" AS step WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4 FOR SHARE` ,
  [stepId, lease.sessionId, lease.turnId, lease.id])).rows
  if (steps.length !== 1 || steps[0]!.attempt !== wait.attempt || steps[0]!.ordinal !== wait.continuationOrdinal) throw new Error("child_resume_wait_tool_call_conflict")
  const step = steps[0]!
  const stepOrdinal = childWaitRecoveryLogicalStepOrdinal(stepId, lease)
  if (stepOrdinal === undefined) throw new Error("child_resume_wait_tool_call_conflict")
  const calls = (await client.query<Row>(`SELECT item."id", item."status", item."revision", item."content", item."stepId", step."attempt", step."ordinal"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4 AND item."type" = 'tool_call'
      AND step."attempt" = $5 AND step."ordinal" = $6 ORDER BY item."id" LIMIT 3 FOR SHARE OF item, step`,
  [lease.sessionId, lease.turnId, lease.id, stepId, wait.attempt, ordinal])).rows
  if (calls.length > 1) throw new Error("child_resume_wait_tool_call_conflict")
  const ids = calls.map(callIdOf), callItemIds = ids.map(id => itemId(lease, "call", id)), resultItemIds = ids.map(id => itemId(lease, "result", id))
  const results = ids.length ? (await client.query<Row>(`SELECT item."id", item."status", item."revision", item."content", item."stepId"
    FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4
      AND item."type" = 'tool_result' AND item."content"->>'toolCallId' = ANY($5::text[]) ORDER BY item."id" LIMIT 3 FOR SHARE`,
  [lease.sessionId, lease.turnId, lease.id, stepId, ids])).rows : []
  const modelKeys = ["model-started", "model-completed", "model-usage"].map(key => childWaitRecoveryEventKey(lease, `${key}:${stepId}`))
  const stepCompleteKey = childWaitRecoveryEventKey(lease, `step-completed:${stepId}`)
  const events = (await client.query<Row>(`SELECT event."id", event."sequence", event."sessionId", event."turnId", event."taskId", event."itemId", event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
      AND (event."idempotencyKey" = ANY($4::text[]) OR event."itemId" = ANY($5::text[])
        OR event."correlationId" = ANY($6::text[]) OR event."correlationId" = $7
        OR event."itemId" IN (SELECT item."id" FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $7)
        OR event."correlationId" IN (SELECT item."id" FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $7))
    ORDER BY event."sequence" LIMIT 64`, [lease.sessionId, lease.turnId, lease.id,
    [claimKey, ...modelKeys, stepCompleteKey], [...callItemIds, ...resultItemIds], ids, stepId])).rows
  if (events.length >= 64) throw new Error("child_resume_wait_tool_call_conflict")
  const claims = events.filter(event => event.idempotencyKey === claimKey)
  if (claims.length > 1) throw new Error("child_resume_wait_tool_call_conflict")
  const hasModelEvidence = events.some(event => ["model.started", "model.completed", "model.usage"].includes(String(event.type))
    || modelKeys.includes(String(event.idempotencyKey)))
  const stepCompletions = events.filter(event => event.type === "step.completed" || event.idempotencyKey === stepCompleteKey)
  if (calls.length === 0 && claims.length === 0) {
    if (hasModelEvidence || stepCompletions.length > 0) throw new Error("child_resume_wait_tool_call_conflict")
    return undefined
  }
  const model = parseChildWaitModelUsageReceipt(events, lease, stepId)
  if (childWaitPgCost(model.usage.estimatedCostUsd) === undefined) throw new Error("child_resume_wait_tool_call_conflict")
  const storedUsage = parseChildWaitModelUsage({ inputTokens: Number(step.inputTokens), outputTokens: Number(step.outputTokens),
    estimatedCostUsd: Number(step.estimatedCostUsd) })
  if (!storedUsage || step.status === "streaming" && (storedUsage.inputTokens !== 0 || storedUsage.outputTokens !== 0 || storedUsage.estimatedCostUsd !== 0)
    || step.status === "completed" && (storedUsage.inputTokens !== model.usage.inputTokens || storedUsage.outputTokens !== model.usage.outputTokens
      || !childWaitStoredCostMatchesReceipt(storedUsage.estimatedCostUsd, model.usage.estimatedCostUsd))) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  const claimedId = claims.length === 1 ? object(claims[0]!.payload)?.toolCallId : undefined
  const claimedRows = calls.filter((row, index) => ids[index] === claimedId)
  if (claims.length === 1 && (typeof claimedId !== "string" || claimedRows.length !== 1)) throw new Error("child_resume_wait_tool_call_conflict")
  if (calls.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
  const orphanCallIds: string[] = []
  for (let index = 0; index < calls.length; index += 1) {
    if (claimedId === ids[index]) continue
    const callResults = results.filter(result => object(result.content)?.toolCallId === ids[index])
    const orphan = validOrphan(calls[index]!, ids[index]!, wait, lease, callResults, events, step, model, stepOrdinal)
    if (!orphan || stepCompletions.length > 0) throw new Error("child_resume_wait_tool_call_conflict")
    orphanCallIds.push(ids[index]!)
    if (claims.length === 0) {
      if (calls.length !== 1 || orphanCallIds.length !== 1) throw new Error("child_resume_wait_tool_call_conflict")
      return { orphan, orphanCallIds }
    }
  }
  const claimed = claimedRows[0]!, callId = claimedId as string
  const claim = recoverClaim(claimed, claims[0]!, callId, wait, lease, results.filter(result => object(result.content)?.toolCallId === callId), events, step, model, stepOrdinal)
  return { claim, orphanCallIds }
}
