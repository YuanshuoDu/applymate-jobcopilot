import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity } from "../outbox-identity.js"
import { toRepositoryJson, type AtomicTurnCompletionInput, type AtomicTurnCompletionResult, type TurnEngineEvent, type TurnEngineEventInput } from "./turn-engine-types.js"

type Pool = Pick<pg.Pool, "connect">
type Client = Pick<pg.PoolClient, "query" | "release">
type Row = Record<string, unknown>
type TerminalInput = AtomicTurnCompletionInput & { readonly owner: TurnExecutionOwnerFence; readonly response: string; readonly now: Date }
const json = (value: unknown) => JSON.stringify(value)
const sameJson = (left: unknown, right: unknown) => json(toRepositoryJson(left)) === json(toRepositoryJson(right))
function conflict(resource: string): Error { return Object.assign(new Error(`TurnEngine persistence conflict: ${resource}`), { name: "TurnEnginePersistenceConflict" }) }

async function transaction<T>(pool: Pool, userId: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT"); committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function appendEvent(client: Client, input: TurnEngineEventInput): Promise<TurnEngineEvent> {
  const owner = input.owner
  const found = await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "correlationId", "causationId", "sequence", "actor", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [owner.sessionId, input.idempotencyKey])
  const existing = found.rows[0]
  let event: TurnEngineEvent
  if (existing) {
    if (existing.taskId !== owner.taskId || existing.turnId !== owner.turnId || existing.itemId !== input.itemId || existing.type !== input.type
      || existing.correlationId !== input.correlationId || existing.causationId !== input.causationId || existing.actor !== "orchestrator"
      || !sameJson(existing.payload, input.payload)) throw conflict(`event ${input.idempotencyKey} identity`)
    event = { id: String(existing.id), type: input.type, itemId: input.itemId, correlationId: input.correlationId, causationId: input.causationId, payload: input.payload }
  } else {
    const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [owner.sessionId, owner.userId])
    const next = sequence.rows[0]?.eventSequence
    if (next === undefined) throw conflict(`session ${owner.sessionId}`)
    await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'orchestrator', $8, $9, $10, $11::jsonb)`,
    [input.id, owner.sessionId, owner.turnId, input.itemId, owner.taskId, BigInt(next).toString(), input.type, input.correlationId, input.causationId, input.idempotencyKey, json(input.payload)])
    event = { id: input.id, type: input.type, itemId: input.itemId, correlationId: input.correlationId, causationId: input.causationId, payload: input.payload }
  }
  const identity: AgentOutboxIdentity = {
    id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: owner.sessionId, idempotencyKey: `agent-event:${event.id}`,
    payload: { eventId: event.id, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: input.itemId,
      sequence: String(existing?.sequence ?? (await client.query<{ eventSequence: bigint | string }>(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [owner.sessionId])).rows[0]?.eventSequence),
      type: input.type, actor: "orchestrator", correlationId: input.correlationId, causationId: input.causationId,
      idempotencyKey: input.idempotencyKey, payload: input.payload },
  }
  const outbox = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.events', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [identity.id, identity.aggregateId, identity.idempotencyKey, json(identity.payload)])
  if ((outbox.rowCount ?? 0) !== 1) {
    const saved = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [identity.idempotencyKey])
    if (!matchesAgentOutboxIdentity(saved.rows[0], identity)) throw conflict(`event outbox ${identity.idempotencyKey} identity`)
  }
  return event
}

function events(input: TerminalInput, startedBy: string): TurnEngineEventInput[] {
  const prefix = `turn:${input.owner.turnId}:event:`
  const finalCompletedKey = `final-completed:${input.finalItemId}:1`
  const completedPayload: RepositoryJsonValue = { itemId: input.finalItemId, status: "completed", content: input.finalContent }
  const entries = [
    { suffix: `item-started:${input.finalItemId}`, type: "item.started", itemId: input.finalItemId, correlationId: input.stepId, causationId: startedBy, payload: { itemId: input.finalItemId, type: "agent_message", phase: "final_answer" } },
    { suffix: finalCompletedKey, type: "item.completed", itemId: input.finalItemId, correlationId: input.finalItemId, causationId: null, payload: completedPayload },
    { suffix: "turn-completed", type: "turn.completed", itemId: input.finalItemId, correlationId: input.stepId, causationId: null, payload: { turnId: input.owner.turnId, taskId: input.owner.taskId, finalItemId: input.finalItemId, usage: input.usage } },
  ]
  return entries.map((entry, index) => ({
    owner: input.owner, id: `${prefix}${entry.suffix}`, itemId: entry.itemId, type: entry.type,
    correlationId: entry.correlationId, causationId: index === 0 ? entry.causationId : null,
    idempotencyKey: `${prefix}${entry.suffix}`, payload: toRepositoryJson(entry.payload),
  }))
}

export async function commitTurnTerminal(pool: Pool, input: TerminalInput): Promise<AtomicTurnCompletionResult> {
  if (input.owner.kind !== "turn") throw conflict(`child final response ${input.owner.taskId}`)
  const owner = input.owner
  return transaction(pool, owner.userId, async client => {
    const session = await client.query<Row>(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [owner.sessionId, owner.userId])
    if (!session.rows[0]) throw conflict(`session ${owner.sessionId}`)
    const turn = await client.query<Row>(`SELECT turn."id", turn."status", turn."finalResponse" FROM "agent_turns" AS turn
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $6 AND (
        (turn."status" = 'in_progress' AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5 AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP)
        OR (turn."status" = 'completed' AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL AND turn."leaseVersion" = $5)) FOR UPDATE`,
    [owner.turnId, owner.sessionId, owner.userId, owner.ownerId, owner.leaseVersion, owner.taskId])
    const turnRow = turn.rows[0]
    if (!turnRow) throw conflict(`turn ${owner.turnId}`)
    const root = await client.query<Row>(`SELECT "id", "status", "leaseOwner", "attemptCount", "result" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1 FOR UPDATE`, [owner.taskId, owner.sessionId, owner.turnId])
    const task = root.rows[0]
    if (!task) throw conflict(`root task ${owner.taskId}`)
    const result = { status: "completed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, finalItemId: input.finalItemId, waitId: null }
    const committed = turnRow.status === "completed"
    if (committed && (turnRow.finalResponse !== input.response || task.status !== "completed" || task.leaseOwner !== null || Number(task.attemptCount) !== 1 || !sameJson(task.result, result))) throw conflict(`terminal receipt ${owner.turnId}`)
    if (!committed && (turnRow.status !== "in_progress" || task.status !== "running" || task.leaseOwner !== owner.ownerId || Number(task.attemptCount) !== 1)) throw conflict(`root task ${owner.taskId} fence`)
    if (!committed) {
      const pending = await client.query<Row>(`SELECT "id" FROM "agent_inputs" WHERE "sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3
        AND "delivery" = 'follow_up' AND "status" IN ('accepted', 'queued') AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL
        ORDER BY "acceptedSequence" ASC FOR UPDATE`, [owner.sessionId, owner.userId, owner.turnId])
      if (pending.rows.length > 0) return { status: "pending_follow_up" }
    }
    const prior = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3 FOR UPDATE`,
      [owner.sessionId, owner.turnId, `turn:${owner.turnId}:event:step-completed:${input.stepId}`])
    if (!prior.rows[0]) throw conflict(`completed step event ${input.stepId}`)
    const content = input.finalContent
    const insertedItem = await client.query<{ id: string; revision: number }>(`INSERT INTO "agent_items"
      ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'agent_message', 'completed', 'final_answer', 1, $6::jsonb, $7, $7, $7)
      ON CONFLICT ("id") DO NOTHING RETURNING "id", "revision"`, [input.finalItemId, owner.sessionId, owner.turnId, input.stepId, owner.taskId, json(content), input.now])
    if (!insertedItem.rows[0]) {
      const existing = await client.query<Row>(`SELECT item."id", item."revision", item."sessionId", item."turnId", item."stepId", item."taskId", item."type", item."status", item."phase", item."content"
        FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId" WHERE item."id" = $1 AND turn."userId" = $2`, [input.finalItemId, owner.userId])
      const row = existing.rows[0]
      if (!row || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId || row.stepId !== input.stepId || row.taskId !== owner.taskId
        || row.type !== "agent_message" || row.status !== "completed" || row.phase !== "final_answer" || Number(row.revision) !== 1 || !sameJson(row.content, content)) throw conflict(`final item ${input.finalItemId} identity`)
    }
    const terminalEvents = events(input, String(prior.rows[0].id)); let previous: string | null = null
    const saved: TurnEngineEvent[] = []
    for (const entry of terminalEvents) {
      const event = await appendEvent(client, { ...entry, causationId: previous ?? entry.causationId })
      previous = event.id; saved.push(event)
    }
    if (!committed) {
      const updatedRoot = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = $1::jsonb, "failureReason" = NULL,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "completedAt" = $2, "updatedAt" = $2
        WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "rootTaskId" = $3 AND "status" = 'running' AND "leaseOwner" = $6 AND "attemptCount" = 1`,
      [json(result), input.now, owner.taskId, owner.sessionId, owner.turnId, owner.ownerId])
      if (updatedRoot.rowCount !== 1) throw conflict(`root task ${owner.taskId} completion`)
      const updatedTurn = await client.query(`UPDATE "agent_turns" SET "status" = 'completed', "finalResponse" = $1, "error" = NULL,
        "inputTokens" = $2, "outputTokens" = $3, "estimatedCostUsd" = $4, "durationMs" = CASE WHEN "startedAt" IS NULL THEN "durationMs" ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($5::timestamp(3) - "startedAt")) * 1000)::int) END,
        "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "completedAt" = $5, "revision" = "revision" + 1, "updatedAt" = $5
        WHERE "id" = $6 AND "sessionId" = $7 AND "userId" = $8 AND "rootTaskId" = $9 AND "status" = 'in_progress'
          AND "leaseOwnerId" = $10 AND "leaseVersion" = $11 AND "leaseExpiresAt" > $5`,
      [input.response, input.usage.inputTokens, input.usage.outputTokens, input.usage.estimatedCostUsd, input.now, owner.turnId, owner.sessionId, owner.userId, owner.taskId, owner.ownerId, owner.leaseVersion])
      if (updatedTurn.rowCount !== 1) throw conflict(`turn ${owner.turnId} completion`)
    }
    return { status: "completed", finalItemId: input.finalItemId, events: saved }
  })
}
