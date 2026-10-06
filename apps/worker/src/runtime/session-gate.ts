import type pg from "pg"

/** Session statuses that still permit durable coordination and cleanup writes. */
export const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`

/** Compatibility name for open sessions that can accept new runtime work. */
export const RUNNABLE_SESSION = OPEN_SESSION

/** Admission fence for new work; wait coordination and cleanup keep using OPEN_SESSION. */
export const SESSION_WORK_ADMISSION = `${OPEN_SESSION} AND session."status" = 'running' AND NOT EXISTS (
  SELECT 1 FROM "agent_events" AS pause_request
  WHERE pause_request."sessionId" = session."id" AND pause_request."turnId" = $3 AND pause_request."type" = 'session.pause_requested'
    AND NOT EXISTS (
      SELECT 1 FROM "agent_events" AS resumed
      WHERE resumed."sessionId" = pause_request."sessionId" AND resumed."turnId" = pause_request."turnId" AND resumed."type" = 'session.resume_requested'
        AND resumed."sequence" > pause_request."sequence"
    )
)`

export class SessionPauseRequestedError extends Error {
  readonly code = "session_pause_requested" as const

  constructor() {
    super("Session work is fenced by a durable pause request")
    this.name = "SessionPauseRequestedError"
  }
}

export function isSessionPauseRequestedError(error: unknown): error is SessionPauseRequestedError {
  return error instanceof SessionPauseRequestedError
}

/** Call only after locking the Session row; the fresh statement snapshot linearizes admission with pause requests. */
export async function assertSessionWorkAdmission(
  client: Pick<pg.PoolClient, "query">,
  input: { readonly sessionId: string; readonly userId: string; readonly turnId: string },
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT session."id" FROM "agent_sessions" AS session
     WHERE session."id" = $1 AND session."userId" = $2 AND ${SESSION_WORK_ADMISSION}`,
    [input.sessionId, input.userId, input.turnId],
  )
  if (!result.rows[0]) throw new SessionPauseRequestedError()
}
