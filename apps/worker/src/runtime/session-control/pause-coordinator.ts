import { createHash } from "node:crypto"
import type pg from "pg"

import { persistTurnDispatchInTransaction } from "../turns/recovery-scanner-storage.js"
import { recoverExpired as recoverExpiredTasks } from "../subagents/pg-store-expiry-recovery.js"

type Pool = Pick<pg.Pool, "connect">
type Client = Pick<pg.PoolClient, "query" | "release">
type Row = Record<string, unknown>
type Input = { readonly userId: string; readonly sessionId: string; readonly turnId: string; readonly now?: Date }
type Locked = { status: string; turnStatus: string; turnRevision: number; rootTaskId: string | null; leaseOwnerId: string | null; leaseExpiresAt: unknown }
type ControlEvent = { id: string; sequence: number; idempotencyKey: string; payload: Record<string, unknown> }
type OutboxPayload = { eventId: string; sessionId: string; turnId: string; taskId: string | null; itemId: null; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown }
const TERMINAL_TURN_STATUSES = ["completed", "failed", "interrupted", "cancelled", "aborted", "archived"] as const
type TerminalTurnStatus = typeof TERMINAL_TURN_STATUSES[number]
type ResumeWaitStatus = "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user"
type ResumeResult =
  | { readonly status: "queued"; readonly sessionStatus: "running"; readonly dispatched: true }
  | { readonly status: ResumeWaitStatus; readonly sessionStatus: "resuming"; readonly dispatched: false }
  | { readonly status: TerminalTurnStatus; readonly sessionStatus: "completed" | "failed" | "paused"; readonly dispatched: false }
const TERMINAL = new Set<string>(TERMINAL_TURN_STATUSES)
const QUIET_TASKS = new Set(["queued", "retrying", "waiting", "waiting_for_user", ...TERMINAL])
const QUIET_TURNS = new Set(["queued", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user", ...TERMINAL])
const PAUSE_RECOVERY_LEASE_BATCH = 50
const json = (value: unknown) => JSON.stringify(value)
function required(value: string, name: string): string { if (!value.trim() || Buffer.byteLength(value, "utf8") > 256) throw new TypeError(`${name}_invalid`); return value }
function eventId(key: string): string { return `session-control-${createHash("sha256").update(key).digest("hex").slice(0, 32)}` }
function object(value: unknown): Record<string, unknown> { if (typeof value === "string") { try { return object(JSON.parse(value) as unknown) } catch { return {} } }; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${json(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  const serialized = json(value)
  if (serialized === undefined) throw new TypeError("session_control_json_value_invalid")
  return serialized
}
function sameJson(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right) }
function validControl(row: Row | undefined, input: Input, type: string): ControlEvent | null {
  if (!row || row.type !== type || row.actor !== "user" || row.taskId !== null || row.itemId !== null || row.correlationId !== input.turnId
    || row.causationId !== null || typeof row.idempotencyKey !== "string" || !row.idempotencyKey.startsWith("agent-session-control:")) return null
  const payload = object(row.payload), sequence = Number(row.sequence)
  if (payload.turnId !== input.turnId || !Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) < 0
    || typeof payload.requestedAt !== "string" || !Number.isFinite(Date.parse(payload.requestedAt)) || !Number.isSafeInteger(sequence) || sequence < 1) return null
  return { id: String(row.id), sequence, idempotencyKey: row.idempotencyKey, payload }
}

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.user_id', $1, true)", [userId]); const result = await work(client); await client.query("COMMIT"); committed = true; return result }
  catch (error: unknown) { if (!committed) await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

async function lockControl(client: Client, input: Input): Promise<Locked> {
  const session = (await client.query<Row>(`SELECT session."id", session."status" FROM "agent_sessions" AS session
    WHERE session."id" = $1 AND session."userId" = $2 FOR UPDATE`, [input.sessionId, input.userId])).rows[0]
  if (!session || TERMINAL.has(String(session.status))) throw new Error("session_control_session_unavailable")
  const turn = (await client.query<Row>(`SELECT turn."id", turn."status", turn."revision", turn."rootTaskId", turn."leaseOwnerId", turn."leaseExpiresAt"
    FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR UPDATE`, [input.turnId, input.sessionId, input.userId])).rows[0]
  if (!turn || !Number.isSafeInteger(Number(turn.revision))) throw new Error("session_control_turn_unavailable")
  return { status: String(session.status), turnStatus: String(turn.status), turnRevision: Number(turn.revision), rootTaskId: turn.rootTaskId == null ? null : String(turn.rootTaskId), leaseOwnerId: turn.leaseOwnerId == null ? null : String(turn.leaseOwnerId), leaseExpiresAt: turn.leaseExpiresAt }
}

async function readActivePause(client: Client, input: Input): Promise<ControlEvent> {
  const row = (await client.query<Row>(`SELECT pause."id", pause."sequence", pause."type", pause."actor", pause."taskId", pause."itemId", pause."correlationId", pause."causationId", pause."idempotencyKey", pause."payload"
    FROM "agent_events" AS pause WHERE pause."sessionId" = $1 AND pause."turnId" = $2 AND pause."type" = 'session.pause_requested'
      AND pause."actor" = 'user' AND pause."taskId" IS NULL AND pause."itemId" IS NULL AND pause."correlationId" = $2
      AND pause."causationId" IS NULL AND pause."idempotencyKey" LIKE 'agent-session-control:%'
      AND pause."payload"->>'turnId' = $2
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resumed WHERE resumed."sessionId" = pause."sessionId" AND resumed."turnId" = pause."turnId"
        AND resumed."type" = 'session.resume_requested' AND resumed."actor" = 'user' AND resumed."sequence" > pause."sequence")
    ORDER BY pause."sequence" DESC LIMIT 1`, [input.sessionId, input.turnId])).rows[0]
  const event = validControl(row, input, "session.pause_requested")
  if (!event) throw new Error("session_control_pause_request_unavailable")
  return event
}

async function readResume(client: Client, input: Input, turnRevision: number): Promise<{ event: ControlEvent; pause: ControlEvent }> {
  const row = (await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."taskId", event."itemId", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'session.resume_requested'
      AND event."actor" = 'user' AND event."taskId" IS NULL AND event."itemId" IS NULL AND event."correlationId" = $2
      AND event."causationId" IS NULL AND event."idempotencyKey" LIKE 'agent-session-control:%' AND event."payload"->>'turnId' = $2
    ORDER BY event."sequence" DESC LIMIT 1`, [input.sessionId, input.turnId])).rows[0]
  const event = validControl(row, input, "session.resume_requested")
  if (!event || Number(event.payload.expectedRevision) > turnRevision) throw new Error("session_control_resume_request_unavailable")
  const pauseRow = (await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."taskId", event."itemId", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'session.pause_requested'
      AND event."actor" = 'user' AND event."taskId" IS NULL AND event."itemId" IS NULL AND event."correlationId" = $2
      AND event."causationId" IS NULL AND event."idempotencyKey" LIKE 'agent-session-control:%'
      AND event."payload"->>'turnId' = $2 AND event."sequence" < $3 ORDER BY event."sequence" DESC LIMIT 1`, [input.sessionId, input.turnId, event.sequence])).rows[0]
  const pause = validControl(pauseRow, input, "session.pause_requested")
  if (!pause || pause.sequence >= event.sequence) throw new Error("session_control_pause_history_unavailable")
  return { event, pause }
}

async function appendWorkerEvent(client: Client, input: Input, rootTaskId: string | null, cause: ControlEvent, type: string, payload: unknown, suffix: string): Promise<void> {
  const key = `worker-session-control:${type}:${input.sessionId}:${input.turnId}:${cause.id}:${suffix}`
  const found = (await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "actor", "correlationId", "causationId", "sequence", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.sessionId, key])).rows[0]
  let id = found ? String(found.id) : eventId(key), sequence = found ? String(found.sequence) : ""
  if (found && (found.taskId !== rootTaskId || found.turnId !== input.turnId || found.itemId !== null || found.type !== type || found.actor !== "orchestrator"
    || found.correlationId !== input.turnId || found.causationId !== cause.id || found.idempotencyKey !== key || !sameJson(found.payload, payload))) throw new Error(`session_control_worker_event_conflict:${type}`)
  if (!found) {
    const next = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [input.sessionId, input.userId])
    if (next.rows[0]?.eventSequence === undefined) throw new Error("session_control_sequence_unavailable")
    sequence = String(next.rows[0].eventSequence)
    await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, $5, $6, 'orchestrator', $3, $7, $8, $9::jsonb)`, [id, input.sessionId, input.turnId, rootTaskId, sequence, type, cause.id, key, json(payload)])
  }
  const expected: OutboxPayload = { eventId: id, sessionId: input.sessionId, turnId: input.turnId, taskId: rootTaskId, itemId: null, sequence, type, actor: "orchestrator", correlationId: input.turnId, causationId: cause.id, idempotencyKey: key, payload }
  const outboxKey = `agent-event:${id}`, outboxId = `agent-outbox-${id}`
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [outboxId, input.sessionId, outboxKey, json(expected)])
  if ((inserted.rowCount ?? 0) !== 1) {
    const saved = (await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [outboxKey])).rows[0]
    if (!saved || saved.id !== outboxId || saved.topic !== "agent.session.event" || saved.aggregateId !== input.sessionId || saved.idempotencyKey !== outboxKey || !sameJson(saved.payload, expected)) throw new Error(`session_control_outbox_conflict:${type}`)
  }
}

function expired(value: unknown, now: Date): boolean | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed <= now : null
}

function isTerminalTurnStatus(value: string): value is TerminalTurnStatus { return TERMINAL.has(value) }
function terminalSessionStatus(value: TerminalTurnStatus): "completed" | "failed" | "paused" {
  return value === "completed" || value === "failed" ? value : "paused"
}

/** Reconciles the API-authored pause request after root, Turn, child and external work is quiescent. */
export async function reconcileSessionPause(pool: Pool, raw: Input): Promise<{ readonly state: "pausing" | "paused"; readonly blockers: readonly string[]; readonly preservedWaitCount: number; readonly recoveredExpiredLeases: number }> {
  const input = { ...raw, userId: required(raw.userId, "userId"), sessionId: required(raw.sessionId, "sessionId"), turnId: required(raw.turnId, "turnId") }
  const recoveredTasks = await recoverExpiredTasks(pool, { now: input.now ?? new Date(), limit: PAUSE_RECOVERY_LEASE_BATCH, sessionId: input.sessionId, turnId: input.turnId })
  return transaction(pool, input.userId, async client => {
    const state = await lockControl(client, input)
    const waits = await client.query<Row>(`SELECT "id" FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "consumedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC FOR UPDATE`, [input.userId, input.sessionId, input.turnId])
    const steps = await client.query<Row>(`SELECT "id", "status" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "status" = 'streaming' ORDER BY "id" FOR UPDATE`, [input.sessionId, input.turnId])
    const pause = await readActivePause(client, input)
    const calls = await client.query<Row>(`SELECT started."taskId", started."correlationId" FROM "agent_events" AS started
      WHERE started."sessionId" = $1 AND started."turnId" = $2 AND started."type" IN ('tool_call.started', 'model.started')
        AND NOT EXISTS (SELECT 1 FROM "agent_events" AS finished WHERE finished."sessionId" = started."sessionId" AND finished."turnId" = started."turnId"
          AND finished."taskId" IS NOT DISTINCT FROM started."taskId" AND finished."correlationId" = started."correlationId"
          AND ((started."type" = 'tool_call.started' AND finished."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))
            OR (started."type" = 'model.started' AND finished."type" IN ('model.completed', 'model.failed')))`, [input.sessionId, input.turnId])
    const tasks = await client.query<Row>(`SELECT "id", "status", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') ORDER BY "id" FOR UPDATE`, [input.sessionId, input.turnId])
    const now = input.now ?? new Date(), blockers: string[] = []; let recovered = recoveredTasks.length
    if (steps.rows.length) blockers.push("streaming_step")
    if (calls.rows.length) blockers.push("started_external_call")
    for (const row of tasks.rows) {
      if (row.interruptRequestedAt != null) { blockers.push(`task_interrupt_requested:${String(row.id)}`); continue }
      const leaseOwner = row.leaseOwner == null ? null : String(row.leaseOwner), expiry = expired(row.leaseExpiresAt, now)
      if (QUIET_TASKS.has(String(row.status)) && leaseOwner === null && expiry === null) continue
      if (expiry === true && leaseOwner && !steps.rows.length && !calls.rows.length && row.id === state.rootTaskId) {
        const released = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = $3
          WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $4 AND "leaseExpiresAt" <= $3 AND "status" = 'running'
            AND "rootTaskId" = $1 AND "parentTaskId" IS NULL AND "taskType" = 'root' AND "interruptRequestedAt" IS NULL`, [row.id, input.sessionId, now, leaseOwner])
        if (released.rowCount === 1) { recovered += 1; continue }
        blockers.push(`task_recovery_conflict:${String(row.id)}`); continue
      }
      blockers.push(expiry === null ? `task_state_unknown:${String(row.id)}` : `task_not_quiescent:${String(row.id)}`)
    }
    const turnExpiry = expired(state.leaseExpiresAt, now)
    if (QUIET_TURNS.has(state.turnStatus) && state.leaseOwnerId === null && turnExpiry === null) { /* already quiescent */ }
    else if (state.turnStatus === "in_progress" && turnExpiry === true && state.leaseOwnerId && !steps.rows.length && !calls.rows.length) {
      const released = await client.query(`UPDATE "agent_turns" SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
        "leaseVersion" = "leaseVersion" + 1, "revision" = "revision" + 1, "updatedAt" = $3 WHERE "id" = $1 AND "sessionId" = $2
        AND "status" = 'in_progress' AND "leaseOwnerId" = $4 AND "leaseExpiresAt" <= $3`, [input.turnId, input.sessionId, now, state.leaseOwnerId])
      if (released.rowCount === 1) recovered += 1
      else blockers.push("turn_recovery_conflict")
    } else blockers.push(turnExpiry === null ? "turn_state_unknown" : "turn_not_quiescent")
    const unique = [...new Set(blockers)].sort()
    if (unique.length) {
      const signature = createHash("sha256").update(unique.join(",")).digest("hex").slice(0, 12)
      await appendWorkerEvent(client, input, state.rootTaskId, pause, "session.pause_blocked", { pauseRequestEventId: pause.id, blockers: unique }, signature)
      await client.query(`UPDATE "agent_sessions" SET "status" = 'pausing', "updatedAt" = $3 WHERE "id" = $1 AND "userId" = $2`, [input.sessionId, input.userId, now])
      return { state: "pausing", blockers: unique, preservedWaitCount: waits.rows.length, recoveredExpiredLeases: recovered }
    }
    await appendWorkerEvent(client, input, state.rootTaskId, pause, "session.paused", { pauseRequestEventId: pause.id, turnId: input.turnId }, "settled")
    await client.query(`UPDATE "agent_sessions" SET "status" = 'paused', "completedAt" = NULL, "updatedAt" = $3 WHERE "id" = $1 AND "userId" = $2`, [input.sessionId, input.userId, now])
    return { state: "paused", blockers: [], preservedWaitCount: waits.rows.length, recoveredExpiredLeases: recovered }
  })
}

/** Consumes the API-authored resume event; an unresolved durable wait remains authoritative and is never dispatched here. */
export async function resumeSession(pool: Pool, raw: Input): Promise<ResumeResult> {
  const input = { ...raw, userId: required(raw.userId, "userId"), sessionId: required(raw.sessionId, "sessionId"), turnId: required(raw.turnId, "turnId") }
  return transaction(pool, input.userId, async client => {
    const state = await lockControl(client, input)
    if (state.status !== "resuming") throw new Error("session_control_not_resuming")
    const waits = await client.query<Row>(`SELECT "id", "status" FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "consumedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC FOR UPDATE`, [input.userId, input.sessionId, input.turnId])
    const approvals = await client.query<Row>(`SELECT "id" FROM "agent_approvals" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'pending' ORDER BY "id" FOR UPDATE`, [input.userId, input.sessionId, input.turnId])
    const questions = await client.query<Row>(`SELECT item."id" FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2
      AND item."type" = 'question' AND item."status" = 'started' AND item."content"->>'waitKind' = 'question' ORDER BY item."id" FOR UPDATE`, [input.sessionId, input.turnId])
    const requests = await readResume(client, input, state.turnRevision)
    if (isTerminalTurnStatus(state.turnStatus)) {
      const sessionStatus = terminalSessionStatus(state.turnStatus), now = input.now ?? new Date()
      const completedAt = sessionStatus === "completed" || sessionStatus === "failed" ? now : null
      const settled = await client.query(`UPDATE "agent_sessions" SET "status" = $3, "completedAt" = $4, "updatedAt" = $5
        WHERE "id" = $1 AND "userId" = $2 AND "status" = 'resuming'`, [input.sessionId, input.userId, sessionStatus, completedAt, now])
      if (settled.rowCount !== 1) throw new Error("session_control_terminal_resume_conflict")
      return { status: state.turnStatus, sessionStatus, dispatched: false }
    }
    const unresolvedDependency = waits.rows.some(row => String(row.status) === "waiting")
    const resolvedDependency = waits.rows.some(row => ["ready", "timed_out"].includes(String(row.status)))
    const approvalPending = approvals.rows.length > 0, questionPending = questions.rows.length > 0
    const dependencyPending = unresolvedDependency || state.turnStatus === "waiting_for_dependency" && !resolvedDependency
    const status = dependencyPending ? "waiting_for_dependency"
      : approvalPending ? "waiting_for_approval"
        : questionPending ? "waiting_for_user"
          : resolvedDependency || ["waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(state.turnStatus) ? "queued" : state.turnStatus
    if (status !== "queued") {
      if (state.turnStatus === "queued" && ["waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(status)) {
        const changed = await client.query(`UPDATE "agent_turns" SET "status" = $3, "revision" = "revision" + 1, "updatedAt" = $4
          WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued'`, [input.turnId, input.sessionId, status, input.now ?? new Date()])
        if (changed.rowCount !== 1) throw new Error("session_control_wait_turn_conflict")
      }
      const sessionStatus = "resuming"
      await client.query(`UPDATE "agent_sessions" SET "status" = $3, "completedAt" = NULL, "updatedAt" = $4 WHERE "id" = $1 AND "userId" = $2`, [input.sessionId, input.userId, sessionStatus, input.now ?? new Date()])
      return { status: status as "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user", sessionStatus, dispatched: false }
    }
    if (state.turnStatus !== "queued") {
      if (!["waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(state.turnStatus)) throw new Error("session_control_turn_not_resumable")
      const resumed = await client.query(`UPDATE "agent_turns" SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
        "leaseStartedAt" = NULL, "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $3
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = $4 AND "leaseOwnerId" IS NULL`,
      [input.turnId, input.sessionId, input.now ?? new Date(), state.turnStatus])
      if (resumed.rowCount !== 1) throw new Error("session_control_wait_turn_conflict")
    }
    await persistTurnDispatchInTransaction(client as pg.PoolClient, { turnId: input.turnId, sessionId: input.sessionId, ownerId: `resume:${requests.event.id}` }, true)
    await appendWorkerEvent(client, input, state.rootTaskId, requests.event, "session.resumed", { resumeRequestEventId: requests.event.id, turnId: input.turnId }, "resumed")
    const resumed = await client.query(`UPDATE "agent_sessions" SET "status" = 'running', "updatedAt" = $3 WHERE "id" = $1 AND "userId" = $2 AND "status" = 'resuming'`, [input.sessionId, input.userId, input.now ?? new Date()])
    if (resumed.rowCount !== 1) throw new Error("session_control_resume_session_conflict")
    return { status: "queued", sessionStatus: "running", dispatched: true }
  })
}
