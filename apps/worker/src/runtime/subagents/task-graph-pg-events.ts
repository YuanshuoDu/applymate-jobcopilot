import { randomUUID } from "node:crypto"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskGraphEvent } from "../planning/task-graph.js"
import type { GraphEventScope } from "./task-graph-pg-state.js"
import { TASK_GRAPH_ITEM_TYPE, taskGraphItemId, taskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphState } from "../planning/task-graph.js"

type Queryable = Pick<pg.PoolClient, "query">
type PlanReceipt = Readonly<{ status: "accepted" | "duplicate"; revision: number; nodes: readonly { key: string; taskId: string; status: "queued" | "waiting" }[]; readyTaskIds: readonly string[] }>

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
  itemId: string
  type: string
  idempotencyKey: string
  payload: unknown
  actor?: "orchestrator" | "system"
  taskId?: string | null
  causationId?: string | null
  outbox?: boolean
  allowClosedSession?: boolean
}): Promise<string> {
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
  return id
}

export async function writePlanReceipt(client: Queryable, input: {
  scope: GraphEventScope; state: TaskGraphState; snapshot: TaskGraphSnapshot; expectedRevision: number;
  now: Date; idempotencyKey: string; fingerprint: string; receipt: PlanReceipt;
}): Promise<void> {
  const { scope, state, snapshot, expectedRevision, now, idempotencyKey, fingerprint, receipt } = input
  const stored = await writeTaskGraphSnapshot(client, scope, snapshot, expectedRevision, now)
  const item = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: stored.itemId, sessionId: scope.sessionId,
    turnId: scope.turnId, stepId: scope.stepId ?? null, taskId: scope.parentTaskId, type: TASK_GRAPH_ITEM_TYPE,
    status: "streaming", phase: null, revision: state.revision, content: snapshot,
    startedAt: now.toISOString(), completedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }
  const payload = { kind: "proposal", fingerprint, receipt, revision: state.revision, item }
  await appendTaskGraphReceipt(client, {
    scope, itemId: stored.itemId, taskId: scope.parentTaskId,
    type: expectedRevision === 0 ? "item.started" : "item.delta", idempotencyKey, causationId: scope.stepId,
    payload: expectedRevision === 0 ? payload : { ...payload, content: snapshot }, outbox: true,
  })
}

export async function writeTaskLifecycleReceipt(client: Queryable, scope: GraphEventScope, itemId: string, taskId: string, event: TaskGraphEvent, expectedRevision: number, snapshot: TaskGraphSnapshot, now = new Date(), options: { stream?: boolean; allowClosedSession?: boolean } = {}): Promise<number> {
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
  await appendTaskGraphReceipt(client, {
    scope, itemId, taskId, type: "item.delta",
    idempotencyKey: safeEvent.idempotencyKey, actor: "system", causationId: scope.stepId ?? null,
    payload: { kind: "lifecycle", event: safeEvent, revision: nextRevision, item },
    outbox: options.stream ?? true, allowClosedSession: options.allowClosedSession ?? false,
  })
  return nextRevision
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
