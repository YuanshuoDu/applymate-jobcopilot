import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { STEERING_MARKER_EVENT_TYPE } from "../context/steering-marker.js"
import {
  acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness, readRootTaskHistoryChronologyWitness,
  type RootTaskHistoryChronologyBoundary, type RootTaskHistoryChronologyLock,
} from "../context/root-task-history-chronology-witness.js"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { conflict, projectRootTerminalEvent, sameEventPayload } from "./turn-engine-terminal-commit.js"
import { assertCurrentItemLineage, lockTurnEngineOpenSession as lockOpenSession, lockTurnEngineOwnedTurn as lockOwnedTurn, turnEngineTenantTransaction as tenantTransaction, type TurnEnginePool, type TurnEngineQueryClient as QueryClient, type TurnEngineRow as Row } from "./turn-engine-owner-sql.js"
import type { TurnEngineEventInput } from "./turn-engine-types.js"

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
function startBoundary(input: TurnEngineEventInput): { boundary: RootTaskHistoryChronologyBoundary; boundaryEventId: string } | undefined {
  const owner = input.owner
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || input.type !== "turn.started"
    || input.idempotencyKey !== `turn:${owner.turnId}:event:turn-started`) return undefined
  const payload = input.payload
  if (input.id !== input.idempotencyKey || input.itemId !== null || input.correlationId !== owner.turnId
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.taskId !== owner.rootTaskId || payload.rootTaskId !== owner.rootTaskId) throw conflict("root turn-start boundary")
  return { boundary: "turn_start", boundaryEventId: input.id }
}
function chronologyInput(owner: Extract<ExecutionOwnerFence, { kind: "turn" }>, boundary: RootTaskHistoryChronologyBoundary, boundaryEventId: string) {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, boundary, boundaryEventId }
}

export async function appendTurnEngineEventBatch(pool: TurnEnginePool, inputs: readonly TurnEngineEventInput[], transactionClient?: QueryClient): Promise<readonly { id: string }[]> {
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
    if (inputs.some(input => ["step.started", "tool_call.started", "model.started"].includes(input.type))) await assertSessionWorkAdmission(client, owner)
    const result: { id: string }[] = []; let previousId: string | null = null
    for (const input of inputs) {
      if (input.itemId) await assertCurrentItemLineage(client, owner, input.itemId)
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
        const witnessInput = chronologyInput(owner, start.boundary.boundary, start.boundary.boundaryEventId)
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
