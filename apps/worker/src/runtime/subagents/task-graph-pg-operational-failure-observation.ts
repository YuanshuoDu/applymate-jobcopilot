import { createHash } from "node:crypto"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import type { TaskGraphOperationalEventIdentity } from "./task-graph-pg-operational-failed-branch-relation.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId,
  taskGraphLifecycleKey, TASK_GRAPH_ITEM_TYPE, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type ObservedGraph = Readonly<{ event: TaskGraphOperationalEventIdentity; snapshot: TaskGraphSnapshot }>
type Input = Readonly<{ scope: GraphIdentityScope; observedRevision: number; expectedSnapshot?: TaskGraphSnapshot;
  event?: TaskGraphOperationalEventIdentity }>
const SEQUENCE = /^(?:[1-9][0-9]{0,18})$/
const HEX = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
const CONTROL = /[\u0000-\u001f\u007f]/

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed), descriptors = Object.getOwnPropertyDescriptors(parsed)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(parsed).every(key => typeof key === "string"
      && descriptors[key]?.enumerable === true && "value" in descriptors[key]!) ? parsed as Row : null
  } catch { return null }
}
function exact(row: Row | null, keys: readonly string[]): row is Row {
  if (!row) return false
  const actual = Reflect.ownKeys(row)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !CONTROL.test(value)
}
function eventIdentity(value: unknown): value is TaskGraphOperationalEventIdentity {
  const row = record(value)
  return !!row && exact(row, ["id", "sequence", "idempotencyKey"]) && id(row.id) && sequence(row.sequence) && id(row.idempotencyKey)
}
function sequence(value: unknown): value is string {
  return typeof value === "string" && SEQUENCE.test(value) && BigInt(value) <= MAX_SEQUENCE
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function timestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) }
function currentItemMatches(row: Row, scope: GraphIdentityScope, itemId: string, observedRevision: number): TaskGraphSnapshot | null {
  if (row.currentItemId !== itemId || row.currentSessionId !== scope.sessionId || row.currentTurnId !== scope.turnId
    || row.currentTaskId !== scope.rootTaskId || row.currentType !== TASK_GRAPH_ITEM_TYPE
    || !Number.isSafeInteger(row.currentRevision) || Number(row.currentRevision) < observedRevision) return null
  try { return parseTaskGraphSnapshot(row.currentContent) } catch { return null }
}
function eventItemMatches(value: unknown, scope: GraphIdentityScope, itemId: string, observedRevision: number): boolean {
  const item = record(value)
  return !!item && exact(item, ["schemaVersion", "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase",
    "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"])
    && item.schemaVersion === AGENT_STREAM_SCHEMA_VERSION && item.id === itemId && item.sessionId === scope.sessionId
    && item.turnId === scope.turnId && (item.stepId === null || id(item.stepId)) && item.taskId === scope.rootTaskId
    && item.type === TASK_GRAPH_ITEM_TYPE && item.status === "streaming" && item.phase === null
    && item.revision === observedRevision && item.completedAt === null
    && timestamp(item.startedAt) && timestamp(item.createdAt) && timestamp(item.updatedAt)
}
function lifecycleKeyMatches(key: unknown, scope: GraphIdentityScope, taskId: unknown, snapshot: TaskGraphSnapshot,
  payloadEvent: unknown): boolean {
  const event = parseTaskGraphEvent(payloadEvent), node = event && snapshot.nodes.find(candidate => candidate.key === event.nodeKey)
  if (!event || !node || taskId !== node.taskId || typeof key !== "string") return false
  const nodeHash = createHash("sha256").update(event.nodeKey).digest("hex").slice(0, 20)
  const prefix = `${taskGraphItemId(scope.rootTaskId)}:node:${nodeHash}:`, suffix = `:${event.type}`
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return false
  const attemptText = key.slice(prefix.length, -suffix.length), attempt = Number(attemptText)
  return /^(0|[1-9][0-9]*)$/.test(attemptText) && Number.isSafeInteger(attempt)
    && taskGraphLifecycleKey(scope.rootTaskId, event.nodeKey, attempt, event.type) === key
}
function proposalReceiptMatches(value: unknown, snapshot: TaskGraphSnapshot, observedRevision: number): boolean {
  const receipt = record(value)
  if (!receipt || !exact(receipt, ["status", "revision", "nodes", "readyTaskIds"])
    || (receipt.status !== "accepted" && receipt.status !== "duplicate") || receipt.revision !== observedRevision
    || !Array.isArray(receipt.nodes) || receipt.nodes.length === 0 || receipt.nodes.length > snapshot.nodes.length
    || !Array.isArray(receipt.readyTaskIds)) return false
  const keys = new Set<string>(), ids = new Set<string>(), queued = new Set<string>()
  for (const raw of receipt.nodes) {
    const node = record(raw)
    if (!node || !exact(node, ["key", "taskId", "status"]) || !id(node.key) || !id(node.taskId)
      || (node.status !== "queued" && node.status !== "waiting") || keys.has(node.key) || ids.has(node.taskId)
      || !snapshot.nodes.some(candidate => candidate.key === node.key && candidate.taskId === node.taskId)) return false
    keys.add(node.key); ids.add(node.taskId)
    if (node.status === "queued") queued.add(node.taskId)
  }
  const ready = new Set<string>()
  for (const taskId of receipt.readyTaskIds) {
    if (!id(taskId) || !queued.has(taskId) || ready.has(taskId)) return false
    ready.add(taskId)
  }
  return true
}
function envelopeMatches(row: Row, scope: GraphIdentityScope, itemId: string, observedRevision: number,
  snapshot: TaskGraphSnapshot): boolean {
  const payload = record(row.payload)
  if (!payload || payload.revision !== observedRevision || !eventItemMatches(payload.item, scope, itemId, observedRevision)) return false
  if (row.type === "item.started" || row.type === "item.delta" && payload.kind === "proposal") {
    const isDelta = row.type === "item.delta", hasOperation = Object.hasOwn(payload, "operationKey"), hasObserved = Object.hasOwn(payload, "observedRevision")
    const keys = ["fingerprint", "item", "kind", "receipt", "revision", ...(isDelta ? ["content"] : []),
      ...(hasOperation && hasObserved ? ["operationKey", "observedRevision"] : [])]
    if (!exact(payload, keys) || payload.kind !== "proposal" || typeof payload.fingerprint !== "string" || !HEX.test(payload.fingerprint)
      || (hasOperation !== hasObserved) || row.actor !== "orchestrator" || row.taskId !== scope.rootTaskId
      || !proposalReceiptMatches(payload.receipt, snapshot, observedRevision)) return false
    const item = record(payload.item)
    return !!item && (item.stepId === row.causationId) && same(item.content, snapshot)
  }
  if (row.type !== "item.delta" || payload.kind !== "lifecycle" || !exact(payload, ["kind", "event", "revision", "item"])
    || row.actor !== "system" || !lifecycleKeyMatches(row.idempotencyKey, scope, row.taskId, snapshot, payload.event)) return false
  return same(record(payload.item)?.content, snapshot)
}
function outboxMatches(row: Row): boolean {
  const expected = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    sequence: String(row.sequence), type: row.type, actor: row.actor, correlationId: row.correlationId,
    causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  return row.outboxTopic === "agent.session.event" && row.outboxAggregateId === row.sessionId
    && row.outboxIdempotencyKey === `agent-event:${row.id}` && same(row.outboxPayload, expected)
}
function rowMatches(row: Row, input: Input, snapshot: TaskGraphSnapshot, itemId: string): boolean {
  const { scope, observedRevision } = input, seq = row.sequence
  return id(row.id) && sequence(seq) && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.itemId === itemId && row.correlationId === scope.turnId && (row.causationId === null || id(row.causationId))
    && id(row.idempotencyKey) && envelopeMatches(row, scope, itemId, observedRevision, snapshot) && outboxMatches(row)
    && (!input.event || row.id === input.event.id && seq === input.event.sequence && row.idempotencyKey === input.event.idempotencyKey)
}

/** Proves an immutable graph event at one revision; it does not authorize a replacement or any task action. */
export async function proveTaskGraphOperationalObservedGraph(client: Client, input: Input): Promise<ObservedGraph | null> {
  const { scope, observedRevision } = input
  if (!id(scope.userId) || !id(scope.sessionId) || !id(scope.turnId) || !id(scope.rootTaskId)
    || scope.parentTaskId !== scope.rootTaskId || !revision(observedRevision)
    || input.event !== undefined && !eventIdentity(input.event)) return null
  const itemId = taskGraphItemId(scope.rootTaskId)
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId",
      event."sequence"::text AS "sequence", event."type", event."actor", event."correlationId", event."causationId",
      event."idempotencyKey", event."payload", item."id" AS "currentItemId", item."sessionId" AS "currentSessionId",
      item."turnId" AS "currentTurnId", item."taskId" AS "currentTaskId", item."type" AS "currentType",
      item."revision" AS "currentRevision", item."content" AS "currentContent", outbox."topic" AS "outboxTopic",
      outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $4
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      AND turn."userId" = $4 AND turn."rootTaskId" = $5
    JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId"
      AND item."turnId" = event."turnId" AND item."taskId" = $5 AND item."type" = 'task_graph'
    LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'revision' = $6
      AND event."payload"->>'kind' IN ('proposal', 'lifecycle') AND ($7::text IS NULL OR event."id" = $7)
    ORDER BY event."sequence", event."id" LIMIT 2`,
  [scope.sessionId, scope.turnId, itemId, scope.userId, scope.rootTaskId, String(observedRevision), input.event?.id ?? null])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, current = currentItemMatches(row, scope, itemId, observedRevision), payload = record(row.payload)
  const snapshot = (() => { try { return parseTaskGraphSnapshot(record(payload?.item)?.content) } catch { return null } })()
  if (!current || !snapshot || !rowMatches(row, input, snapshot, itemId)) return null
  const loaded = { id: itemId, revision: Number(row.currentRevision) }
  let parsed: unknown
  try {
    parsed = parsePersistedTaskGraphReceipt(row.type, payload, loaded, current,
      { sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId },
      { itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey })
  } catch { return null }
  if (payload?.kind === "lifecycle" ? !parsed : parsed !== null) return null
  if (!snapshot || input.expectedSnapshot && (!same(current, input.expectedSnapshot) || !same(snapshot, input.expectedSnapshot))
    || input.expectedSnapshot && Number(row.currentRevision) !== observedRevision) return null
  return { event: { id: row.id as string, sequence: row.sequence as string, idempotencyKey: row.idempotencyKey as string }, snapshot }
}
