import { randomUUID } from "node:crypto"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskGraphEvent } from "../planning/task-graph.js"
import type { GraphEventScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, TASK_GRAPH_ITEM_TYPE, taskGraphItemId, taskGraphSnapshot,
  type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseTaskGraphSnapshot, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import type { TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"
import type { TaskGraphState } from "../planning/task-graph.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type PlanReceipt = Readonly<{ status: "accepted" | "duplicate"; revision: number; nodes: readonly { key: string; taskId: string; status: "queued" | "waiting" }[]; readyTaskIds: readonly string[] }>
export type TaskGraphPersistedEventIdentity = Readonly<{ id: string; sequence: string }>
export const TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION = "agent-harness.v2.task-graph-supersession.v2" as const
const MAX_EVENT_SEQUENCE = 9_223_372_036_854_775_807n
const OPERATION_KEY = /^agent\.plan\.reconciliation:sha256:[0-9a-f]{64}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function plainRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).every(key => typeof key === "string"
    && descriptors[key]?.enumerable === true && "value" in descriptors[key]!) ? value as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function boundedId(value: unknown, maximumLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    && value.trim() === value && !CONTROL_CHARACTERS.test(value)
}
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
function eventSequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_EVENT_SEQUENCE ? parsed : null
}
function parseTaskIdentity(value: unknown): TaskGraphSupersessionRelation["source"] | null {
  const row = plainRecord(value)
  if (!row || !exactKeys(row, ["nodeKey", "taskId"]) || !boundedId(row.nodeKey, 128) || !boundedId(row.taskId)) return null
  return { nodeKey: row.nodeKey, taskId: row.taskId }
}
function parseEventIdentity(value: unknown): TaskGraphSupersessionRelation["cancellationEvent"] | null {
  const row = plainRecord(value)
  if (!row || !exactKeys(row, ["id", "sequence"]) || !boundedId(row.id) || eventSequence(row.sequence) === null) return null
  return { id: row.id, sequence: row.sequence as string }
}
function parsePlanEventIdentity(value: unknown, observedRevision: number): TaskGraphSupersessionRelation["planEvent"] | null {
  const row = plainRecord(value), suffix = `:supersession:${observedRevision}`
  if (!row || !exactKeys(row, ["id", "sequence", "idempotencyKey"]) || !boundedId(row.id) || eventSequence(row.sequence) === null
    || !boundedId(row.idempotencyKey, 256) || !/^task-graph-[0-9a-f]{64}:supersession:(0|[1-9][0-9]*)$/.test(row.idempotencyKey)
    || !row.idempotencyKey.endsWith(suffix)) return null
  return { id: row.id, sequence: row.sequence as string, idempotencyKey: row.idempotencyKey }
}

export function parseTaskGraphSupersessionRelation(value: unknown): TaskGraphSupersessionRelation | null {
  try {
    const row = plainRecord(value), keys = ["schemaVersion", "operationKey", "observedRevision", "cancellationRevision", "resultingRevision",
      "source", "replacement", "cancellationEvent", "planEvent", "replacementFingerprint", "agentPlanCall"]
    if (!row || !exactKeys(row, keys) || row.schemaVersion !== TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION
      || typeof row.operationKey !== "string" || !OPERATION_KEY.test(row.operationKey) || !revision(row.observedRevision)
      || row.observedRevision > Number.MAX_SAFE_INTEGER - 2 || row.cancellationRevision !== row.observedRevision + 1
      || row.resultingRevision !== row.observedRevision + 2 || typeof row.replacementFingerprint !== "string"
      || !FINGERPRINT.test(row.replacementFingerprint)) return null
    const source = parseTaskIdentity(row.source), replacement = parseTaskIdentity(row.replacement)
    const cancellationEvent = parseEventIdentity(row.cancellationEvent), planEvent = parsePlanEventIdentity(row.planEvent, row.observedRevision)
    const call = plainRecord(row.agentPlanCall)
    if (!source || !replacement || source.nodeKey === replacement.nodeKey || source.taskId === replacement.taskId
      || !cancellationEvent || !planEvent || cancellationEvent.id === planEvent.id
      || BigInt(cancellationEvent.sequence) >= BigInt(planEvent.sequence) || !call
      || !exactKeys(call, ["callId", "stepId", "expectedRevision", "replaceUnstarted"])
      || !boundedId(call.callId) || !boundedId(call.stepId) || call.expectedRevision !== row.observedRevision) return null
    const replaceUnstarted = plainRecord(call.replaceUnstarted)
    if (!replaceUnstarted || !exactKeys(replaceUnstarted, ["nodeKey"]) || replaceUnstarted.nodeKey !== source.nodeKey) return null
    return { schemaVersion: TASK_GRAPH_SUPERSESSION_SCHEMA_VERSION, operationKey: row.operationKey,
      observedRevision: row.observedRevision, cancellationRevision: row.cancellationRevision as number,
      resultingRevision: row.resultingRevision as number, source, replacement, cancellationEvent, planEvent,
      replacementFingerprint: row.replacementFingerprint, agentPlanCall: { callId: call.callId, stepId: call.stepId,
        expectedRevision: call.expectedRevision as number, replaceUnstarted: { nodeKey: replaceUnstarted.nodeKey as string } } }
  } catch { return null }
}

export function taskGraphSupersessionEnvelopeMatches(source: unknown, replacement: unknown, allowDependencyRewire = false): boolean {
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  const left = record(source), right = record(replacement), mutable = new Set(["key", "taskId", "goal", "successCriteria"])
  if (!left || !right) return false
  if (allowDependencyRewire) mutable.add("dependsOn")
  const envelope = (node: Record<string, unknown>) => Object.fromEntries(Object.entries(node).filter(([key]) => !mutable.has(key)))
  return canonicalTaskGraphJson(envelope(left)) === canonicalTaskGraphJson(envelope(right))
}
export function taskGraphSupersessionProposalMatches(source: unknown, proposal: unknown, rootTaskId: string, allowDependencyRewire = false): boolean {
  const left = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : null
  const right = proposal && typeof proposal === "object" && !Array.isArray(proposal) ? proposal as Record<string, unknown> : null
  if (!left || !right) return false
  const repairOf = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null
    const record = value as Record<string, unknown>
    return { ...record, graphRootTaskId: record.graphRootTaskId ?? rootTaskId }
  }
  return ["templateId", "verification", "nativeDelegation"]
    .every(key => canonicalTaskGraphJson(left[key] ?? null) === canonicalTaskGraphJson(right[key] ?? null))
    && (allowDependencyRewire || canonicalTaskGraphJson(left.dependsOn ?? null) === canonicalTaskGraphJson(right.dependsOn ?? null))
    && canonicalTaskGraphJson(repairOf(left.repairOf)) === canonicalTaskGraphJson(repairOf(right.repairOf))
}

export async function loadTaskGraphCancellationSource(client: Queryable, scope: GraphEventScope, selection: Readonly<{
  eventId?: string; sequence?: string; nodeKey: string; taskId: string; expectedRevision: number; stepId: string
}>): Promise<StoredTaskGraphNode | null> {
  const result = await client.query<Row>(`SELECT event."payload"->'item'->'content' AS "content",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE ($1::text IS NULL OR event."id" = $1) AND ($2::bigint IS NULL OR event."sequence" = $2::bigint)
      AND event."sessionId" = $3 AND event."turnId" = $4 AND event."itemId" = $5 AND event."taskId" = $6
      AND event."type" = 'item.delta' AND event."actor" = 'system' AND event."correlationId" = $4
      AND event."causationId" = $7 AND event."idempotencyKey" = $8
      AND event."payload"->>'kind' = 'lifecycle' AND event."payload"->>'revision' = $9::text
      AND event."payload"->'event'->>'type' = 'task.cancelled'
      AND event."payload"->'event'->>'nodeKey' = $10
      AND event."payload"->'event'->>'expectedRevision' = $11::text
      AND event."payload"->'item'->>'id' = $5 AND event."payload"->'item'->>'revision' = $9::text
      AND turn."userId" = $12 AND turn."rootTaskId" = $13 AND session."userId" = $12
    LIMIT 2`, [selection.eventId ?? null, selection.sequence ?? null, scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId),
    selection.taskId, selection.stepId, taskGraphLifecycleKey(scope.rootTaskId, selection.nodeKey, 0, "task.cancelled"),
    selection.expectedRevision + 1, selection.nodeKey, selection.expectedRevision, scope.userId, scope.rootTaskId])
  if (result.rows.length !== 1 || result.rows[0]!.hasOutbox !== true) return null
  try {
    const source = parseTaskGraphSnapshot(result.rows[0]!.content).nodes.find(node => node.key === selection.nodeKey)
    return source?.taskId === selection.taskId ? source : null
  } catch { return null }
}

export async function writeTaskGraphSnapshot(client: Queryable, scope: GraphEventScope, snapshot: TaskGraphSnapshot, expectedRevision: number, now: Date): Promise<{ itemId: string; revision: number }> {
  const itemId = taskGraphItemId(scope.parentTaskId)
  const revision = expectedRevision + 1
  const updated = await client.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
    SELECT $1, $2, $3, $4, $5, $6, 'streaming', NULL, $7, $8::jsonb, $9, $9
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $3 AND turn."sessionId" = $2 AND turn."userId" = $10
      AND session."userId" = $10 AND session."status" NOT IN ('aborted', 'archived')
    ON CONFLICT ("id") DO UPDATE SET "stepId" = EXCLUDED."stepId", "revision" = EXCLUDED."revision",
      "content" = EXCLUDED."content", "status" = 'streaming', "completedAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"
    WHERE "agent_items"."sessionId" = EXCLUDED."sessionId" AND "agent_items"."turnId" = EXCLUDED."turnId"
      AND "agent_items"."taskId" = EXCLUDED."taskId" AND "agent_items"."type" = $6 AND "agent_items"."revision" = $11
    RETURNING "id"`,
  [itemId, scope.sessionId, scope.turnId, scope.stepId, scope.parentTaskId, TASK_GRAPH_ITEM_TYPE, revision, JSON.stringify(snapshot), now, scope.userId, expectedRevision])
  if (updated.rowCount !== 1) throw new Error("task_graph_item_revision_conflict")
  return { itemId, revision }
}

export async function appendTaskGraphReceipt(client: Queryable, input: {
  scope: GraphEventScope
  itemId: string | null
  type: string
  idempotencyKey: string
  payload: unknown
  actor?: "orchestrator" | "system"
  taskId?: string | null
  causationId?: string | null
  outbox?: boolean
  allowClosedSession?: boolean
}): Promise<string> {
  return (await appendTaskGraphReceiptWithIdentity(client, input)).id
}

export async function appendTaskGraphReceiptWithIdentity(client: Queryable, input: {
  scope: GraphEventScope
  itemId: string | null
  type: string
  idempotencyKey: string
  payload: unknown
  actor?: "orchestrator" | "system"
  taskId?: string | null
  causationId?: string | null
  outbox?: boolean
  allowClosedSession?: boolean
}): Promise<TaskGraphPersistedEventIdentity> {
  const sequence = await nextSequence(client, input.scope, input.allowClosedSession ?? false)
  const id = randomUUID()
  const actor = input.actor ?? "orchestrator"
  await client.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3, $9, $10, $11::jsonb)`,
  [id, input.scope.sessionId, input.scope.turnId, input.itemId, input.taskId ?? null, sequence, input.type, actor, input.causationId ?? null, input.idempotencyKey, JSON.stringify(input.payload)])
  if (input.outbox) {
    const written = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
    [`agent-outbox-${id}`, input.scope.sessionId, `agent-event:${id}`, JSON.stringify({
      eventId: id, sessionId: input.scope.sessionId, turnId: input.scope.turnId, itemId: input.itemId,
      taskId: input.taskId ?? null, sequence, type: input.type, actor, correlationId: input.scope.turnId,
      causationId: input.causationId ?? null, idempotencyKey: input.idempotencyKey, payload: input.payload,
    })])
    if (written.rowCount !== 1) throw new Error("task_graph_event_outbox_conflict")
  }
  return { id, sequence }
}

export async function writePlanReceipt(client: Queryable, input: {
  scope: GraphEventScope; state: TaskGraphState; snapshot: TaskGraphSnapshot; expectedRevision: number;
  now: Date; idempotencyKey: string; fingerprint: string; receipt: PlanReceipt;
  operationKey?: string; observedRevision?: number
}): Promise<void> {
  await writePlanReceiptWithIdentity(client, input)
}

export async function writePlanReceiptWithIdentity(client: Queryable, input: {
  scope: GraphEventScope; state: TaskGraphState; snapshot: TaskGraphSnapshot; expectedRevision: number;
  now: Date; idempotencyKey: string; fingerprint: string; receipt: PlanReceipt;
  operationKey?: string; observedRevision?: number
}): Promise<TaskGraphPersistedEventIdentity> {
  const { scope, state, snapshot, expectedRevision, now, idempotencyKey, fingerprint, receipt } = input
  const stored = await writeTaskGraphSnapshot(client, scope, snapshot, expectedRevision, now)
  const item = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: stored.itemId, sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: scope.stepId ?? null, taskId: scope.parentTaskId, type: TASK_GRAPH_ITEM_TYPE,
    status: "streaming", phase: null, revision: state.revision, content: snapshot,
    startedAt: now.toISOString(), completedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const payload = { kind: "proposal", fingerprint, receipt, revision: state.revision, item,
    ...(input.operationKey ? { operationKey: input.operationKey } : {}),
    ...(input.observedRevision === undefined ? {} : { observedRevision: input.observedRevision }) }
  return appendTaskGraphReceiptWithIdentity(client, {
    scope, itemId: stored.itemId, taskId: scope.parentTaskId,
    type: expectedRevision === 0 ? "item.started" : "item.delta", idempotencyKey, causationId: scope.stepId,
    payload: expectedRevision === 0 ? payload : { ...payload, content: snapshot }, outbox: true,
  })
}

export async function writeTaskLifecycleReceipt(client: Queryable, scope: GraphEventScope, itemId: string, taskId: string, event: TaskGraphEvent, expectedRevision: number, snapshot: TaskGraphSnapshot, now = new Date(), options: { stream?: boolean; allowClosedSession?: boolean } = {}): Promise<number> {
  return (await writeTaskLifecycleReceiptWithIdentity(client, scope, itemId, taskId, event, expectedRevision, snapshot, now, options)).revision
}

export async function writeTaskLifecycleReceiptWithIdentity(client: Queryable, scope: GraphEventScope, itemId: string, taskId: string, event: TaskGraphEvent, expectedRevision: number, snapshot: TaskGraphSnapshot, now = new Date(), options: { stream?: boolean; allowClosedSession?: boolean } = {}): Promise<TaskGraphPersistedEventIdentity & Readonly<{ revision: number }>> {
  const safeEvent = sanitizeTaskGraphLifecycleEvent(event)
  const nextRevision = expectedRevision + 1
  const updated = await client.query(`UPDATE "agent_items" AS item SET "revision" = $6, "updatedAt" = $7
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = $5 AND item."revision" = $8
      AND EXISTS (SELECT 1 FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
        ON session."id" = turn."sessionId" WHERE turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
          AND turn."userId" = $9 AND session."userId" = $9)
    RETURNING item."stepId", item."status", item."phase", item."startedAt", item."completedAt", item."createdAt"`,
  [itemId, scope.sessionId, scope.turnId, scope.parentTaskId, TASK_GRAPH_ITEM_TYPE, nextRevision, now, expectedRevision, scope.userId])
  if (updated.rowCount !== 1) throw new Error("task_graph_item_revision_conflict")
  const row = updated.rows[0] as Record<string, unknown>
  const item = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: scope.sessionId, turnId: scope.turnId,
    stepId: row.stepId ?? null, taskId: scope.parentTaskId, type: TASK_GRAPH_ITEM_TYPE,
    status: row.status, phase: row.phase ?? null, revision: nextRevision, content: snapshot,
    startedAt: timestamp(row.startedAt), completedAt: timestamp(row.completedAt),
    createdAt: timestamp(row.createdAt), updatedAt: now.toISOString(),
  }
  const identity = await appendTaskGraphReceiptWithIdentity(client, {
    scope, itemId, taskId, type: "item.delta",
    idempotencyKey: safeEvent.idempotencyKey, actor: "system", causationId: scope.stepId ?? null,
    payload: { kind: "lifecycle", event: safeEvent, revision: nextRevision, item },
    outbox: options.stream ?? true, allowClosedSession: options.allowClosedSession ?? false,
  })
  return { ...identity, revision: nextRevision }
}

/** Keep raw worker errors in the restricted task row, never in the stream/event log. */
export function sanitizeTaskGraphLifecycleEvent(event: TaskGraphEvent): TaskGraphEvent {
  if (event.type !== "task.failed") return event
  const redacted = redactSensitiveText(event.failureReason).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  let failureReason = ""
  for (const character of redacted) {
    if (Buffer.byteLength(failureReason + character, "utf8") > 500) break
    failureReason += character
  }
  return { ...event, failureReason: failureReason || "Child task failed." }
}

async function nextSequence(client: Queryable, scope: GraphEventScope, allowClosedSession: boolean): Promise<string> {
  const result = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" AS session
    SET "eventSequence" = "eventSequence" + 1 WHERE session."id" = $1 AND session."userId" = $2
      AND ($3::boolean OR session."status" NOT IN ('aborted', 'archived')) RETURNING "eventSequence"`, [scope.sessionId, scope.userId, allowClosedSession])
  const sequence = result.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("task_graph_session_sequence_unavailable")
  return String(sequence)
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  return null
}
