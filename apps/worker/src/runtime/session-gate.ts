import type pg from "pg"

/** Session statuses that still permit durable coordination and cleanup writes. */
export const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`

/** Compatibility name for open sessions that can accept new runtime work. */
export const RUNNABLE_SESSION = OPEN_SESSION

/** A durable pause still fences terminal writes, even when a derived wait changes Session status. */
const NO_UNRESOLVED_SESSION_PAUSE = `NOT EXISTS (
  SELECT 1 FROM "agent_events" AS pause_request
  WHERE pause_request."sessionId" = session."id" AND pause_request."turnId" = $3 AND pause_request."type" = 'session.pause_requested'
    AND NOT EXISTS (
      SELECT 1 FROM "agent_events" AS resumed
      WHERE resumed."sessionId" = pause_request."sessionId" AND resumed."turnId" = pause_request."turnId" AND resumed."type" = 'session.resume_requested'
        AND resumed."sequence" > pause_request."sequence"
    )
)`

/** Admission fence for new work; wait coordination and cleanup keep using OPEN_SESSION. */
export const SESSION_WORK_ADMISSION = `${OPEN_SESSION} AND session."status" = 'running' AND ${NO_UNRESOLVED_SESSION_PAUSE}`

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

/** Terminal receipt exception for the already-owned canonical application Fill Turn only. */
export async function assertSessionTerminalAdmission(
  client: Pick<pg.PoolClient, "query">,
  input: { readonly sessionId: string; readonly userId: string; readonly turnId: string; readonly source: string | null; readonly executionMode: string | null },
): Promise<void> {
  try {
    await assertSessionWorkAdmission(client, input)
    return
  } catch (error: unknown) {
    if (!isSessionPauseRequestedError(error)) throw error
  }
  if (input.source !== "user" || input.executionMode !== "canonical_task_graph") throw new SessionPauseRequestedError()
  const wait = await client.query<{ id: string }>(
    `SELECT session."id" FROM "agent_sessions" AS session
     JOIN "application_tasks" AS fill_task ON fill_task."sessionId" = session."id" AND fill_task."userId" = session."userId"
     WHERE session."id" = $1 AND session."userId" = $2 AND session."status" = 'waiting_for_user'
       AND ${NO_UNRESOLVED_SESSION_PAUSE}
       AND fill_task."fillTurnId" = $3 AND fill_task."fillTurnSessionId" = $1 AND fill_task."fillTurnUserId" = $2
       AND fill_task."status" = 'waiting_for_user' AND fill_task."checkpoint" = 'submission_uncertain'
     LIMIT 2`,
    [input.sessionId, input.userId, input.turnId],
  )
  if (wait.rows.length !== 1) throw new SessionPauseRequestedError()
}
