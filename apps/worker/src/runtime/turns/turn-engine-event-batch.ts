import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import type { ExecutionOwnerFence, TaskExecutionOwnerFence } from "../execution-owner.js"
import { STEERING_MARKER_EVENT_TYPE } from "../context/steering-marker.js"
import {
  acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness, readRootTaskHistoryChronologyWitness,
  type RootTaskHistoryChronologyBoundary, type RootTaskHistoryChronologyLock,
} from "../context/root-task-history-chronology-witness.js"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { conflict, projectRootTerminalEvent, sameEventPayload } from "./turn-engine-terminal-commit.js"
import { assertCurrentItemLineage, lockTurnEngineOpenSession as lockOpenSession, lockTurnEngineOwnedTurn as lockOwnedTurn, turnEngineTenantTransaction as tenantTransaction, type TurnEnginePool, type TurnEngineQueryClient as QueryClient, type TurnEngineRow as Row } from "./turn-engine-owner-sql.js"
import { toRepositoryJson, type TurnEngineEventInput } from "./turn-engine-types.js"
import { projectWaitCallEventContent } from "./turn-execution-wait-event-projection.js"
import { safeSubagentWaitJson, waitResult } from "../subagents/durable-subagent-wait-store.js"

function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function outboxPayload(input: { owner: ExecutionOwnerFence; eventId: string; itemId: string | null; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: RepositoryJsonValue }): AgentOutboxPayload {
  return { eventId: input.eventId, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId,
    itemId: input.itemId, sequence: input.sequence, type: input.type, actor: input.actor, correlationId: input.correlationId,
    causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload }
}
async function repairOutbox(client: QueryClient, expected: AgentOutboxIdentity): Promise<void> {
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.events', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
  [expected.id, expected.aggregateId, expected.idempotencyKey, json(expected.payload)])
  if ((inserted.rowCount ?? 0) === 1) return
  const existing = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
    WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(existing.rows[0], expected)) throw conflict(`event outbox ${expected.idempotencyKey} identity`)
}
function startBoundary(input: TurnEngineEventInput): RootTaskHistoryChronologyBoundary | undefined {
  const owner = input.owner
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || input.type !== "turn.started"
    || input.idempotencyKey !== `turn:${owner.turnId}:event:turn-started`) return undefined
  const payload = input.payload
  if (typeof input.id !== "string" || !input.id.trim() || input.id.trim() !== input.id
    || input.itemId !== null || input.correlationId !== owner.turnId
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.taskId !== owner.rootTaskId || payload.rootTaskId !== owner.rootTaskId) throw conflict("root turn-start boundary")
  return "turn_start"
}
function chronologyInput(owner: Extract<ExecutionOwnerFence, { kind: "turn" }>, boundary: RootTaskHistoryChronologyBoundary, boundaryEventId: string) {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, boundary, boundaryEventId }
}

export async function appendTurnEngineEventBatch(pool: TurnEnginePool, inputs: readonly TurnEngineEventInput[], transactionClient?: QueryClient): Promise<readonly { id: string }[]> {
  return appendEventBatch(pool, inputs, transactionClient)
}

export type ChildWaitSourceLifecycleEventBatch = Readonly<{
  owner: TaskExecutionOwnerFence
  waitId: string
  sourceStepId: string
  sourceAttempt: number
  callItemId: string
  resultItemId: string
  toolCallId: string
  events: readonly TurnEngineEventInput[]
}>

/** Replays only the four completion events for a validated historical consumed child wait. */
export async function appendChildWaitSourceLifecycleEventBatch(pool: TurnEnginePool, proof: ChildWaitSourceLifecycleEventBatch,
  transactionClient: QueryClient): Promise<readonly { id: string }[]> {
  if (!transactionClient || proof.events.length !== 4) throw conflict("historical child wait requires exact transaction batch")
  return appendEventBatch(pool, proof.events, transactionClient, proof)
}

async function appendEventBatch(pool: TurnEnginePool, inputs: readonly TurnEngineEventInput[], transactionClient?: QueryClient,
  historical?: ChildWaitSourceLifecycleEventBatch): Promise<readonly { id: string }[]> {
  if (inputs.length === 0) return []
  const owner = inputs[0]!.owner
  if (inputs.some(input => input.owner.kind !== owner.kind || input.owner.userId !== owner.userId || input.owner.sessionId !== owner.sessionId
    || input.owner.turnId !== owner.turnId || input.owner.taskId !== owner.taskId || input.owner.rootTaskId !== owner.rootTaskId
    || input.owner.ownerId !== owner.ownerId || input.owner.leaseExpiresAt.getTime() !== owner.leaseExpiresAt.getTime()
    || (owner.kind === "task" ? input.owner.attemptCount !== owner.attemptCount : input.owner.leaseVersion !== owner.leaseVersion))) throw conflict("event batch owner")
  for (const input of inputs) if (input.owner.kind === "task" && ["turn.completed", "turn.failed", "turn.interrupted"].includes(input.type)) throw conflict(`child root lifecycle ${input.type}`)
  const starts = inputs.map(input => ({ input, boundary: startBoundary(input) })).filter(entry => entry.boundary)
  if (starts.length > 1) throw conflict("multiple root turn-start boundaries")
  const start = starts[0]
  const append = async (client: QueryClient) => {
    let chronologyLock: RootTaskHistoryChronologyLock | undefined
    if (start && owner.kind === "turn") chronologyLock = await acquireRootTaskHistoryChronologyLock(client, owner.userId)
    if (!await lockOpenSession(client, owner)) throw conflict(`session ${owner.sessionId}`)
    if (!await lockOwnedTurn(client, owner, true)) throw conflict(`turn ${owner.turnId}`)
    const historicalItems = historical ? await assertHistoricalChildWaitEvents(client, owner, historical, inputs) : undefined
    if (inputs.some(input => ["step.started", "tool_call.started", "model.started"].includes(input.type))) await assertSessionWorkAdmission(client, owner)
    const result: { id: string }[] = []; let previousId: string | null = null
    for (const input of inputs) {
      if (input.itemId && !historicalItems?.has(input.itemId)) await assertCurrentItemLineage(client, owner, input.itemId)
      if (input.actor !== undefined && (input.actor !== "system" || input.type !== STEERING_MARKER_EVENT_TYPE)) throw conflict(`event ${input.idempotencyKey} actor`)
      const actor = input.actor ?? (owner.kind === "task" ? "subagent" : "orchestrator")
      const existing = await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "correlationId", "causationId", "sequence", "actor", "payload"
        FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [owner.sessionId, input.idempotencyKey])
      const causationId = previousId ?? input.causationId
      let eventId: string, eventSequence: string, created = false
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.taskId !== owner.taskId || row.turnId !== owner.turnId || row.itemId !== input.itemId || row.type !== input.type
          || row.correlationId !== input.correlationId || row.causationId !== causationId || String(row.actor) !== actor || !sameEventPayload(row.type, row.payload, input.payload)) throw conflict(`event ${input.idempotencyKey} identity`)
        eventId = String(row.id); eventSequence = String(row.sequence)
        await repairOutbox(client, { id: `agent-outbox-${eventId}`, topic: "agent.events", aggregateId: owner.sessionId, idempotencyKey: `agent-event:${eventId}`,
          payload: outboxPayload({ owner, eventId, itemId: input.itemId, sequence: eventSequence, type: input.type, actor: String(row.actor), correlationId: input.correlationId,
            causationId: row.causationId === null ? null : String(row.causationId), idempotencyKey: input.idempotencyKey, payload: input.payload }) })
      } else {
        if (input.itemId) {
          const item = await client.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`, [input.itemId, owner.sessionId, owner.turnId, owner.taskId])
          if (!item.rows[0]) throw conflict(`item ${input.itemId}`)
        }
        const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
          WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [owner.sessionId, owner.userId])
        const next = sequence.rows[0]?.eventSequence
        if (next === undefined) throw conflict(`session ${owner.sessionId}`)
        eventId = input.id; eventSequence = BigInt(next).toString(); created = true
        await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`, [eventId, owner.sessionId, owner.turnId, input.itemId, owner.taskId, eventSequence, input.type, actor, input.correlationId, causationId, input.idempotencyKey, json(input.payload)])
        await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`,
          [`agent-outbox-${eventId}`, owner.sessionId, `agent-event:${eventId}`, json(outboxPayload({ owner, eventId, itemId: input.itemId, sequence: eventSequence,
            type: input.type, actor, correlationId: input.correlationId, causationId, idempotencyKey: input.idempotencyKey, payload: input.payload }))])
      }
      if (start?.input === input && owner.kind === "turn" && start.boundary) {
        const witnessInput = chronologyInput(owner, start.boundary, eventId)
        if (created) {
          if (!chronologyLock) throw conflict("root turn-start chronology lock")
          await appendRootTaskHistoryChronologyWitness(client, witnessInput, chronologyLock)
        } else await readRootTaskHistoryChronologyWitness(client, witnessInput)
      }
      await projectRootTerminalEvent(client, owner, input.type, eventId)
      result.push({ id: eventId }); previousId = eventId
    }
    return result
  }
  return transactionClient ? append(transactionClient) : tenantTransaction(pool, owner.userId, append)
}

function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0") }
function ids(value: unknown, minimum = 1): string[] | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!Array.isArray(parsed) || parsed.length < minimum || parsed.length > 8 || !parsed.every(id => typeof id === "string" && !!id.trim() && id === id.trim())
    || new Set(parsed).size !== parsed.length) return undefined
  return parsed as string[]
}
function sameIds(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\0") === [...right].sort().join("\0") }
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function itemKey(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function expectedResult(callId: string, output: unknown): RepositoryJsonValue {
  const safe = record(safeSubagentWaitJson({ toolCallId: callId, output, errorCode: null }, 16_384))
  safe.toolCallId = callId
  return toRepositoryJson(safe)
}
function sequence(row: Row): bigint | undefined { try { const value = BigInt(String(row.sequence)); return value > 0n ? value : undefined } catch { return undefined } }
function sameOwner(left: ExecutionOwnerFence, right: ExecutionOwnerFence): boolean {
  return left.kind === "task" && right.kind === "task" && left.userId === right.userId && left.sessionId === right.sessionId
    && left.turnId === right.turnId && left.taskId === right.taskId && left.rootTaskId === right.rootTaskId && left.ownerId === right.ownerId
    && left.attemptCount === right.attemptCount && left.leaseExpiresAt.getTime() === right.leaseExpiresAt.getTime()
}
function sourceResultId(taskId: string, waitId: string, callId: string): string {
  const digest = createHash("sha256").update("child-wait-source-result:v1\0" + waitId + "\0" + callId).digest("hex")
  return `task:${taskId}:item:tool-result:source-wait-recovery:${digest}`
}
const TERMINAL_WAIT_TASK = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const VALID_WAIT_TASK = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", ...TERMINAL_WAIT_TASK])

async function assertHistoricalChildWaitEvents(client: QueryClient, ownerFence: ExecutionOwnerFence, proof: ChildWaitSourceLifecycleEventBatch,
  inputs: readonly TurnEngineEventInput[]): Promise<ReadonlySet<string>> {
  const { owner, waitId, sourceStepId, sourceAttempt, callItemId, resultItemId, toolCallId } = proof
  if (ownerFence.kind !== "task" || !sameOwner(owner, ownerFence) || !Number.isSafeInteger(sourceAttempt)
    || sourceAttempt < 1 || sourceAttempt >= owner.attemptCount || ![waitId, sourceStepId, callItemId, resultItemId, toolCallId].every(itemKey)
    || resultItemId !== sourceResultId(owner.taskId, waitId, toolCallId) || inputs.length !== 4) throw conflict("historical child wait event scope")
  const wait = (await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "idempotencyKey", "mode", "status", "deadlineAt", "matchedTaskIds", "suspendedAt", "consumedAt", "result"
    FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "parentTaskId" = $5
      AND "stepId" = $6 AND "status" IN ('ready', 'timed_out') AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NOT NULL FOR SHARE`,
  [waitId, owner.userId, owner.sessionId, owner.turnId, owner.taskId, sourceStepId])).rows[0]
  const step = (await client.query<Row>(`SELECT "id" FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5 FOR SHARE`,
    [sourceStepId, owner.sessionId, owner.turnId, owner.taskId, sourceAttempt])).rows[0]
  if (!wait || !step || wait.id !== waitId || wait.stepId !== sourceStepId || wait.parentTaskId !== owner.taskId) throw conflict("historical child wait row")
  const sourceCalls = (await client.query<Row>(`SELECT "id" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
    AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents' ORDER BY "id" LIMIT 2 FOR SHARE`,
  [owner.sessionId, owner.turnId, owner.taskId, sourceStepId])).rows
  if (sourceCalls.length !== 1 || sourceCalls[0]!.id !== callItemId) throw conflict("historical child wait call count")
  const saved = record(wait.result), request = record(saved.request), outcome = record(saved.outcome), targetIds = ids(wait.targetTaskIds)
  const savedKeys = Object.hasOwn(saved, "sourceLifecycleRecovery") ? ["request", "outcome", "sourceLifecycleRecovery"] : ["request", "outcome"]
  const matched = ids(wait.matchedTaskIds, 0), savedMatched = ids(outcome.matchedTaskIds, 0)
  const outcomeTasks = Array.isArray(outcome.tasks) ? outcome.tasks.map(record) : []
  const terminal = outcomeTasks.filter(task => TERMINAL_WAIT_TASK.has(String(task.status))).map(task => String(task.taskId))
  if (!targetIds || !exactKeys(request, ["targetTaskIds", "mode", "timeoutMs"]) || !sameIds(ids(request.targetTaskIds) ?? [], targetIds)
    || !exactKeys(saved, savedKeys) || !matched || matched.some(id => !targetIds.includes(id)) || !savedMatched || !sameIds(savedMatched, matched)
    || !(request.mode === "any" || request.mode === "all") || request.mode !== wait.mode || !Number.isSafeInteger(request.timeoutMs) || Number(request.timeoutMs) < 1 || Number(request.timeoutMs) > 30_000
    || !exactKeys(outcome, ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"]) || outcome.waitId !== waitId
    || outcome.status !== wait.status || !sameIds(ids(outcome.taskIds) ?? [], targetIds)
    || outcomeTasks.length !== targetIds.length || outcomeTasks.some(task => typeof task.taskId !== "string")
    || !sameIds(outcomeTasks.map(task => String(task.taskId)), targetIds) || !sameIds(terminal, matched)
    || outcome.status === "ready" && (request.mode === "any" ? matched.length === 0 : matched.length !== targetIds.length)
    || outcome.status === "timed_out" && Date.now() < new Date(String(wait.deadlineAt)).getTime()
    || !outcomeTasks.every(row => exactKeys(row, ["taskId", "status", "role", "result", "failureReason"])
      && typeof row.status === "string" && VALID_WAIT_TASK.has(row.status) && typeof row.role === "string" && !!row.role.trim()
      && (row.failureReason === null || typeof row.failureReason === "string"))
    || Number.isNaN(new Date(String(outcome.deadlineAt)).getTime()) || Number.isNaN(new Date(String(wait.deadlineAt)).getTime())
    || new Date(String(outcome.deadlineAt)).getTime() !== new Date(String(wait.deadlineAt)).getTime()) throw conflict("historical child wait receipt")
  const marker = record(saved.sourceLifecycleRecovery)
  if (Object.hasOwn(saved, "sourceLifecycleRecovery") && (!exactKeys(marker, ["schemaVersion", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "ownerId", "attempt", "stepId", "waitId", "toolCallId", "callItemId", "resultItemId"])
    || marker.schemaVersion !== "child-wait-source-lifecycle.v1" || marker.userId !== owner.userId || marker.sessionId !== owner.sessionId
    || marker.turnId !== owner.turnId || marker.rootTaskId !== owner.rootTaskId || marker.taskId !== owner.taskId
    || !itemKey(marker.ownerId) || marker.ownerId.length > 256
    || marker.attempt !== sourceAttempt || marker.stepId !== sourceStepId || marker.waitId !== waitId || marker.toolCallId !== toolCallId
    || marker.callItemId !== callItemId || marker.resultItemId !== resultItemId)) throw conflict("historical child wait marker")
  const callRows = (await client.query<Row>(`SELECT item."id", item."stepId", item."type", item."status", item."phase", item."revision", item."content"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
      AND step."attempt" = $7 WHERE item."sessionId" = $3 AND item."turnId" = $4 AND item."taskId" = $5 AND item."stepId" = $6
      AND (item."id" = $1 OR item."id" = $2 OR item."content"->>'toolCallId' = $8) ORDER BY item."id" LIMIT 3 FOR SHARE OF item, step`,
  [callItemId, resultItemId, owner.sessionId, owner.turnId, owner.taskId, sourceStepId, sourceAttempt, toolCallId])).rows
  const call = callRows.find(row => row.id === callItemId), result = callRows.find(row => row.id === resultItemId)
  if (callRows.length !== 2 || !call || !result || call.type !== "tool_call" || result.type !== "tool_result"
    || call.status !== "completed" || result.status !== "completed" || Number(call.revision) !== 1 || Number(result.revision) !== 1
    || call.phase !== null || result.phase !== null) throw conflict("historical child wait items")
  const callContent = record(call.content), callInput = record(callContent.input), resultContent = record(result.content)
  if (callContent.toolCallId !== toolCallId || callContent.toolName !== "wait_subagents" || callContent.toolVersion !== "1"
    || callContent.status !== "completed" || callContent.errorCode !== null || !exactKeys(callInput, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    || callInput.idempotencyKey !== wait.idempotencyKey || !sameIds(ids(callInput.taskIds) ?? [], targetIds) || callInput.mode !== request.mode
    || callInput.timeoutMs !== request.timeoutMs || !sameJson(resultContent, expectedResult(toolCallId, waitResult(wait)))) throw conflict("historical child wait item content")
  const startKeys = [`task:${owner.taskId}:event:item-started:${callItemId}`, `task:${owner.taskId}:event:tool-started:${toolCallId}`]
  const starts = (await client.query<Row>(`SELECT "id", "itemId", "type", "actor", "correlationId", "causationId", "sequence", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[]) FOR SHARE`,
  [owner.sessionId, owner.turnId, owner.taskId, startKeys])).rows
  const itemStart = starts.find(row => row.idempotencyKey === startKeys[0]), callStart = starts.find(row => row.idempotencyKey === startKeys[1])
  if (starts.length !== 2 || !itemStart || !callStart || itemStart.itemId !== callItemId || itemStart.type !== "item.started" || itemStart.actor !== "subagent"
    || itemStart.correlationId !== sourceStepId || !sameJson(itemStart.payload, { itemId: callItemId, type: "tool_call", phase: null })
    || callStart.itemId !== callItemId || callStart.type !== "tool_call.started" || callStart.actor !== "subagent" || callStart.correlationId !== toolCallId
    || callStart.causationId !== itemStart.id || !sameJson(callStart.payload, { toolCallId, toolName: "wait_subagents", taskId: owner.taskId })) throw conflict("historical child wait start events")
  const prior = (await client.query<Row>(`SELECT event."id" FROM "agent_events" AS event WHERE event."id" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND event."taskId" = $4
    AND event."actor" = 'subagent' AND event."sequence" < $5 AND (event."correlationId" = $6 OR EXISTS (SELECT 1 FROM "agent_items" AS source
      WHERE source."id" = event."itemId" AND source."sessionId" = $2 AND source."turnId" = $3 AND source."taskId" = $4 AND source."stepId" = $6)) FOR SHARE`,
  [itemStart.causationId, owner.sessionId, owner.turnId, owner.taskId, itemStart.sequence, sourceStepId])).rows[0]
  if (!prior || prior.id !== itemStart.causationId || !sequence(itemStart) || !sequence(callStart) || sequence(itemStart)! >= sequence(callStart)!) throw conflict("historical child wait start order")
  const expected = [
    { type: "item.completed", itemId: callItemId, correlationId: callItemId, causationId: callStart.id, idempotencyKey: `task:${owner.taskId}:event:tool-call-completed:${toolCallId}:${callItemId}:1`, payload: { itemId: callItemId, status: "completed", content: projectWaitCallEventContent(callContent) } },
    { type: "tool_call.completed", itemId: callItemId, correlationId: toolCallId, causationId: null, idempotencyKey: `task:${owner.taskId}:event:tool-finished:${toolCallId}`, payload: { toolCallId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: owner.taskId } },
    { type: "item.started", itemId: resultItemId, correlationId: sourceStepId, causationId: null, idempotencyKey: `task:${owner.taskId}:event:item-started:${resultItemId}`, payload: { itemId: resultItemId, type: "tool_result", phase: null } },
    { type: "item.completed", itemId: resultItemId, correlationId: resultItemId, causationId: null, idempotencyKey: `task:${owner.taskId}:event:tool-result-completed:${toolCallId}:${resultItemId}:1`, payload: { itemId: resultItemId, status: "completed", content: resultContent } },
  ]
  if (inputs.some((input, index) => !sameOwner(input.owner, owner) || input.actor !== undefined || input.idempotencyKey !== expected[index]!.idempotencyKey
    || input.type !== expected[index]!.type || input.itemId !== expected[index]!.itemId || input.correlationId !== expected[index]!.correlationId
    || input.causationId !== expected[index]!.causationId || !sameJson(input.payload, expected[index]!.payload) || !itemKey(input.id))
    || new Set(inputs.map(input => input.id)).size !== inputs.length) throw conflict("historical child wait event batch identity")
  return new Set([callItemId, resultItemId])
}
