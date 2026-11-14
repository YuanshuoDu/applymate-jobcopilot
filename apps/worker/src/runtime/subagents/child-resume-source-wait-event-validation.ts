import { createHash } from "node:crypto"
import { PolicyDecisionSchema, validate } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import type pg from "pg"
import type { DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { prepareOwnerScopedWaitLifecycleOutput } from "../tools/lifecycle-receipt-output.js"
import { sanitizeLifecyclePreview } from "../tools/redaction.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"

type Row = Record<string, unknown>
type QueryClient = Pick<pg.PoolClient, "query">
type Lease = Readonly<{ id: string; userId: string; sessionId: string; turnId: string; attemptCount: number }>
type ValidationInput = Readonly<{
  client: QueryClient; lease: Lease; wait: Row; stepId: string; call: Row; result?: Row; callId: string; callItemId: string
  resultId: string; sourceAttempt: number; output: DurableSubagentWaitResult; initial: boolean; waiting: boolean; historicalWaitingAllowed: boolean
}>
type CanonicalEvent = Readonly<{ type: string; itemId: string; correlationId: string; cause: string | null; key: string; payload: unknown }>

function obj(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function exact(value: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
function sequence(row: Row): bigint | undefined {
  try { const value = BigInt(String(row.sequence)); return value > 0n ? value : undefined } catch { return undefined }
}
function ids(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(id => typeof id === "string"
    && id.length > 0 && id.length <= 256 && id.trim() === id) && new Set(value).size === value.length ? value as string[] : undefined
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id))
}
function epoch(value: unknown): number | undefined {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.getTime() : undefined
}
function eventMatches(row: Row, expected: CanonicalEvent, lease: Lease): boolean {
  return row.sessionId === lease.sessionId && row.turnId === lease.turnId && row.taskId === lease.id
    && row.type === expected.type && row.itemId === expected.itemId && row.correlationId === expected.correlationId
    && row.causationId === expected.cause && row.actor === "subagent" && row.idempotencyKey === expected.key
    && sameJson(row.payload, expected.payload)
}
function policyIdentity(lease: Lease, sourceAttempt: number, stepId: string, callId: string): string {
  return createHash("sha256").update(JSON.stringify([
    lease.userId, lease.sessionId, lease.turnId, "task", lease.id, sourceAttempt, stepId, callId,
  ])).digest("hex")
}
function validPolicyEvent(row: Row, input: ValidationInput, digest: string): boolean {
  const payload = obj(row.payload), scope = obj(payload.scope)
  return row.id === `agent-policy-${digest}` && row.idempotencyKey === `policy-decision:${digest}`
    && row.sessionId === input.lease.sessionId && row.turnId === input.lease.turnId && row.taskId === input.lease.id
    && row.type === "policy.decision" && row.itemId === null && row.actor === "subagent"
    && row.correlationId === input.callId && row.causationId === null
    && validate(PolicyDecisionSchema, payload) && payload.hook === "before_tool_use" && payload.outcome === "allow"
    && scope.userId === input.lease.userId && scope.sessionId === input.lease.sessionId && scope.turnId === input.lease.turnId
    && scope.stepId === input.stepId && scope.toolCallId === input.callId && scope.toolName === "wait_subagents"
    && scope.toolVersion === "1" && scope.role === "subagent" && scope.domain === "coordination" && scope.risk === "internal_write"
}
function lifecycleDigest(row: Row, input: ValidationInput, phase: "started" | "completed"): string | undefined {
  const idPrefix = `tool-lifecycle:task:${input.lease.id}:${input.callId}:${phase}:`
  const keyPrefix = `task:${input.lease.id}:tool-lifecycle:${input.callId}:${phase}:`
  if (typeof row.id !== "string" || !row.id.startsWith(idPrefix) || typeof row.idempotencyKey !== "string"
    || !row.idempotencyKey.startsWith(keyPrefix)) return undefined
  const idDigest = row.id.slice(idPrefix.length), keyDigest = row.idempotencyKey.slice(keyPrefix.length)
  return /^[0-9a-f]{24}$/.test(idDigest) && idDigest === keyDigest ? idDigest : undefined
}
function validLifecycleEvent(row: Row, input: ValidationInput, phase: "started" | "completed"): boolean {
  const digest = lifecycleDigest(row, input, phase), payload = obj(row.payload)
  if (!digest || row.sessionId !== input.lease.sessionId || row.turnId !== input.lease.turnId || row.taskId !== input.lease.id
    || row.type !== `tool_call.${phase}` || row.itemId !== null || row.actor !== "subagent"
    || row.correlationId !== input.callId || row.causationId !== null || payload.toolCallId !== input.callId
    || payload.toolName !== "wait_subagents" || payload.toolVersion !== "1" || payload.status !== phase) return false
  if (phase === "started") {
    return exact(payload, ["toolCallId", "toolName", "toolVersion", "status", "input"])
      && sameJson(payload.input, sanitizeLifecyclePreview(obj(input.call.content).input))
  }
  const candidates = [input.output, obj(input.result?.content).output].filter(value => value !== undefined)
  if (candidates.some(value => safeWaitOutputMatches(payload.output, value))) return exact(payload, ["toolCallId", "toolName", "toolVersion", "status", "output", "errorCode"])
    && payload.errorCode === null
  return exact(payload, ["toolCallId", "toolName", "toolVersion", "status", "output", "errorCode"])
    && payload.errorCode === null && input.historicalWaitingAllowed && validHistoricalWaitingOutput(payload.output, input)
}
function safeWaitOutputMatches(actual: unknown, expected: unknown): boolean {
  try { return sameJson(actual, prepareOwnerScopedWaitLifecycleOutput(expected, "wait_subagents", "task").safe) }
  catch { return false }
}
function validHistoricalWaitingOutput(value: unknown, input: ValidationInput): boolean {
  const output = obj(value), waitId = input.wait.id, waitIds = ids(input.wait.targetTaskIds)
  const callInput = obj(obj(input.call.content).input), callIds = ids(callInput.taskIds), outputIds = ids(output.taskIds)
  const savedDeadline = epoch(input.wait.deadlineAt), outputDeadline = epoch(output.deadlineAt)
  const tasks = Array.isArray(output.tasks) ? output.tasks.map(obj) : []
  if (!waitIds || !callIds || !outputIds || !sameIds(waitIds, callIds) || !sameIds(waitIds, outputIds)
    || !exact(output, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"])
    || output.waitId !== waitId || output.status !== "waiting" || !Array.isArray(output.matchedTaskIds) || output.matchedTaskIds.length !== 0
    || !savedDeadline || outputDeadline !== savedDeadline || tasks.length !== outputIds.length
    || !tasks.every((task, index) => exact(task, ["taskId", "status", "role", "result", "failureReason"]) && task.taskId === outputIds[index])) return false
  return safeWaitOutputMatches(value, output)
}
function validSideEvents(rows: readonly Row[], canonical: readonly Row[], input: ValidationInput, policyDigest: string): boolean {
  const side = rows.filter(row => !canonical.includes(row))
  if (side.length === 0) return true
  const valid = side.map(row => row.type === "tool_call.started" ? validLifecycleEvent(row, input, "started")
    : row.type === "policy.decision" ? validPolicyEvent(row, input, policyDigest)
      : row.type === "tool_call.completed" ? validLifecycleEvent(row, input, "completed") : false)
  if (valid.some(value => !value)) return false
  const types = side.map(row => row.type)
  const prefix = input.initial
    ? [["tool_call.started"], ["tool_call.started", "policy.decision"], ["tool_call.started", "policy.decision", "tool_call.completed"]]
    : [["tool_call.started", "policy.decision", "tool_call.completed"]]
  if (!prefix.some(expected => expected.length === types.length && expected.every((type, index) => types[index] === type))) return false
  const sideSequences = side.map(sequence)
  if (sideSequences.some(value => value === undefined) || sideSequences.some((value, index) => index > 0 && value! <= sideSequences[index - 1]!)) return false
  const callStart = canonical.find(row => row.idempotencyKey === `task:${input.lease.id}:event:tool-started:${input.callId}`)
  const callItemCompletion = canonical.find(row => row.idempotencyKey === `task:${input.lease.id}:event:tool-call-completed:${input.callId}:${input.callItemId}:1`)
  const first = sideSequences[0]!, last = sideSequences.at(-1)!
  const callStartSequence = callStart && sequence(callStart), callCompletionSequence = callItemCompletion && sequence(callItemCompletion)
  return !!callStartSequence && callStartSequence < first
    && (input.initial ? !callCompletionSequence || last < callCompletionSequence : !!callCompletionSequence && last < callCompletionSequence)
}

/** Validates canonical wait evidence separately from narrowly recognized runtime side events. */
export async function validateChildWaitSourceEvents(input: ValidationInput): Promise<boolean> {
  const { client, lease, callId, callItemId, resultId } = input
  const prefix = `task:${lease.id}:event:`
  const keys = [prefix + `item-started:${callItemId}`, prefix + `tool-started:${callId}`,
    prefix + `tool-call-completed:${callId}:${callItemId}:1`, prefix + `tool-finished:${callId}`,
    prefix + `item-started:${resultId}`, prefix + `tool-result-completed:${callId}:${resultId}:1`]
  const policyDigest = policyIdentity(lease, input.sourceAttempt, input.stepId, callId)
  const lifeIdPrefix = `tool-lifecycle:task:${lease.id}:${callId}:`
  const lifeKeyPrefix = `task:${lease.id}:tool-lifecycle:${callId}:`
  const rows = (await client.query<Row>(
    `SELECT "id", "sessionId", "turnId", "taskId", "itemId", "type", "actor", "correlationId", "causationId", "sequence", "idempotencyKey", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND ("itemId" = $4 OR "correlationId" = $5 OR "itemId" = $6 OR "correlationId" = $6 OR "idempotencyKey" = ANY($7::text[]) OR left("id", length($8)) = $8 OR left("idempotencyKey", length($9)) = $9 OR "id" = $10 OR "idempotencyKey" = $11) ORDER BY "sequence" FOR SHARE`,
    [lease.sessionId, lease.turnId, lease.id, callItemId, callId, resultId, keys, lifeIdPrefix, lifeKeyPrefix, `agent-policy-${policyDigest}`, `policy-decision:${policyDigest}`],
  )).rows
  const canonical = rows.filter(row => keys.includes(String(row.idempotencyKey)))
  if (canonical.length !== (input.initial ? 2 : 6) || rows.some(row => row.sessionId !== lease.sessionId || row.turnId !== lease.turnId || row.taskId !== lease.id)) return false
  const itemStart = canonical.find(row => row.idempotencyKey === keys[0]), callStart = canonical.find(row => row.idempotencyKey === keys[1])
  if (!itemStart || !callStart || !eventMatches(itemStart, { type: "item.started", itemId: callItemId, correlationId: input.stepId,
    cause: itemStart.causationId as string | null, key: keys[0]!, payload: { itemId: callItemId, type: "tool_call", phase: null } }, lease)
    || !eventMatches(callStart, { type: "tool_call.started", itemId: callItemId, correlationId: callId, cause: String(itemStart.id),
      key: keys[1]!, payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } }, lease)) return false
  const firstSequence = sequence(itemStart), callSequence = sequence(callStart)
  if (!firstSequence || !callSequence || firstSequence >= callSequence) return false
  const previousId = String(itemStart.causationId ?? "")
  if (!previousId) return false
  const previous = (await client.query<Row>(
    `SELECT event."id", event."sequence" FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3 AND event."id" = $4 AND event."actor" = 'subagent' AND (event."correlationId" = $5 OR EXISTS (SELECT 1 FROM "agent_items" AS source WHERE source."id" = event."itemId" AND source."sessionId" = $1 AND source."turnId" = $2 AND source."taskId" = $3 AND source."stepId" = $5)) FOR SHARE`,
    [lease.sessionId, lease.turnId, lease.id, previousId, input.stepId],
  )).rows[0]
  const previousSequence = previous && sequence(previous)
  if (!previous || previous.id !== previousId || !previousSequence || previousSequence >= firstSequence) return false
  const causalIds = [itemStart.id, callStart.id]
  if (input.initial) {
    const causal = (await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "causationId" = ANY($4::text[]) FOR SHARE`,
      [lease.sessionId, lease.turnId, lease.id, causalIds])).rows
    return causal.length === 1 && causal[0]!.id === callStart.id && validSideEvents(rows, canonical, input, policyDigest)
  }
  const callComplete = canonical.find(row => row.idempotencyKey === keys[2]), toolComplete = canonical.find(row => row.idempotencyKey === keys[3])
  const resultStart = canonical.find(row => row.idempotencyKey === keys[4]), resultComplete = canonical.find(row => row.idempotencyKey === keys[5])
  const callContent = obj(input.call.content), projected = projectWaitCallEventContent(callContent)
  const completionMatches = (content: unknown) => eventMatches(callComplete!, { type: "item.completed", itemId: callItemId,
    correlationId: callItemId, cause: String(callStart.id), key: keys[2]!, payload: { itemId: callItemId, status: "completed", content } }, lease)
  if (!callComplete || !toolComplete || !resultStart || !resultComplete
    || !(completionMatches(projected) || input.waiting && completionMatches(callContent))
    || !eventMatches(toolComplete, { type: "tool_call.completed", itemId: callItemId, correlationId: callId, cause: String(callComplete.id), key: keys[3]!,
      payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } }, lease)
    || !eventMatches(resultStart, { type: "item.started", itemId: resultId, correlationId: input.stepId, cause: String(toolComplete.id), key: keys[4]!,
      payload: { itemId: resultId, type: "tool_result", phase: null } }, lease)
    || !eventMatches(resultComplete, { type: "item.completed", itemId: resultId, correlationId: resultId, cause: String(resultStart.id), key: keys[5]!,
      payload: { itemId: resultId, status: "completed", content: obj(input.result?.content) } }, lease)) return false
  const ordered = [itemStart, callStart, callComplete, toolComplete, resultStart, resultComplete].map(sequence)
  if (ordered.some(value => !value) || ordered.some((value, index) => index > 0 && value! <= ordered[index - 1]!)) return false
  const causes = [itemStart.id, callStart.id, callComplete.id, toolComplete.id, resultStart.id]
  const extra = (await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "causationId" = ANY($4::text[]) FOR SHARE`,
    [lease.sessionId, lease.turnId, lease.id, causes])).rows
  return new Set([...canonical, ...extra].map(row => row.id)).size === 6 && validSideEvents(rows, canonical, input, policyDigest)
}
