import type pg from "pg"

import { RUNNABLE_SESSION } from "../session-gate.js"
import type { TurnJobPayload } from "./lease.js"

export async function lockClaimSession(client: Pick<pg.PoolClient, "query">, payload: TurnJobPayload): Promise<string | null> {
  const result = await client.query<{ userId: string }>(
    `SELECT session."userId" FROM "agent_sessions" AS session
     WHERE session."id" = $1 AND ${RUNNABLE_SESSION}
       AND EXISTS (SELECT 1 FROM "agent_turns" AS turn
         WHERE turn."id" = $2 AND turn."sessionId" = session."id" AND turn."userId" = session."userId") FOR UPDATE`,
    [payload.sessionId, payload.turnId],
  )
  if ((!result.rows[0] && result.rowCount !== 1) || (result.rows[0] && result.rowCount !== undefined && result.rowCount !== 1)) {
    throw new ClaimSessionUnavailable()
  }
  return result.rows[0]?.userId ?? null
}

export class ClaimSessionUnavailable extends Error {
  constructor() { super("Turn session is no longer open"); this.name = "ClaimSessionUnavailable" }
}
