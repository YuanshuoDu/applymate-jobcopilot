import type pg from "pg"
import type { AgentProjection, TenantScope } from "@jobcopilot/agent-protocol"

import { mapEvent, mapItem, mapStep, mapTurn } from "./mapping.js"

export async function readPgProjection(
  client: pg.PoolClient,
  scope: TenantScope,
  input: { sessionId: string; turnId: string },
): Promise<AgentProjection | null> {
  const turn = await client.query(
    `SELECT "id", "sessionId", "userId", "source", "status", "revision", "createdAt", "updatedAt"
     FROM "agent_turns"
     WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
       AND EXISTS (
         SELECT 1 FROM "agent_sessions" AS session
         WHERE session."id" = "agent_turns"."sessionId" AND session."userId" = $3
       )`,
    [input.turnId, input.sessionId, scope.userId],
  )
  if (!turn.rows[0]) return null

  const [steps, items, events] = await Promise.all([
    client.query(
      `SELECT "id", "sessionId", "turnId", "ordinal", "attempt", "status",
              "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "createdAt"
       FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2
       ORDER BY "ordinal" ASC, "attempt" ASC`,
      [input.sessionId, input.turnId],
    ),
    client.query(
      `SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase",
              "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"
       FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
       ORDER BY "createdAt" ASC`,
      [input.sessionId, input.turnId],
    ),
    client.query(
      `SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type",
              "actor", "correlationId", "causationId", "idempotencyKey", "payload", "createdAt"
       FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
       ORDER BY "sequence" ASC`,
      [input.sessionId, input.turnId],
    ),
  ])

  return {
    turn: mapTurn(turn.rows[0]),
    steps: steps.rows.map(mapStep),
    items: items.rows.map(mapItem),
    events: events.rows.map(mapEvent),
  }
}
