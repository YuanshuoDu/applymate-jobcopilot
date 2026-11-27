import type pg from "pg"

const terminalAdmissionBrand: unique symbol = Symbol("SessionTerminalAdmission")
type TerminalAdmissionInput = Readonly<{ sessionId: string; userId: string; turnId: string; rootTaskId: string }>
type TerminalAdmissionEvidence = TerminalAdmissionInput & Readonly<{ client: Pick<pg.PoolClient, "query">; kind: "work" | "derived_fill" }>
const terminalAdmissions = new WeakMap<object, TerminalAdmissionEvidence>()
const terminalAdmissionsByClient = new WeakMap<object, Set<object>>()
export type SessionTerminalAdmission = Readonly<{ [terminalAdmissionBrand]: true }>

function terminalAdmission(client: Pick<pg.PoolClient, "query">, input: TerminalAdmissionInput, kind: TerminalAdmissionEvidence["kind"]): SessionTerminalAdmission {
  const receipt = Object.freeze({ [terminalAdmissionBrand]: true as const })
  terminalAdmissions.set(receipt, { ...input, client, kind })
  const receipts = terminalAdmissionsByClient.get(client) ?? new Set<object>()
  receipts.add(receipt)
  terminalAdmissionsByClient.set(client, receipts)
  return receipt
}

export function revokeSessionTerminalAdmissionsForClient(client: Pick<pg.PoolClient, "query">): void {
  for (const receipt of terminalAdmissionsByClient.get(client) ?? []) terminalAdmissions.delete(receipt)
  terminalAdmissionsByClient.delete(client)
}

export function sessionTerminalAdmissionKindFor(
  admission: SessionTerminalAdmission, client: Pick<pg.PoolClient, "query">, scope: TerminalAdmissionInput,
): "work" | "derived_fill" {
  const evidence = terminalAdmissions.get(admission as object)
  if (!evidence || evidence.client !== client || evidence.sessionId !== scope.sessionId || evidence.userId !== scope.userId
    || evidence.turnId !== scope.turnId || evidence.rootTaskId !== scope.rootTaskId) throw new Error("session_terminal_admission_mismatch")
  return evidence.kind
}

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
  input: { readonly sessionId: string; readonly userId: string; readonly turnId: string; readonly rootTaskId: string; readonly source: string | null; readonly executionMode: string | null },
): Promise<SessionTerminalAdmission> {
  try {
    await assertSessionWorkAdmission(client, input)
    return terminalAdmission(client, input, "work")
  } catch (error: unknown) {
    if (!isSessionPauseRequestedError(error)) throw error
  }
  if (input.source !== "user" || (input.executionMode !== null && input.executionMode !== "canonical_task_graph")
    || !input.rootTaskId.trim()) throw new SessionPauseRequestedError()
  const wait = await client.query<{ id: string }>(
    `SELECT session."id" FROM "agent_sessions" AS session
     JOIN "application_tasks" AS fill_task ON fill_task."sessionId" = session."id" AND fill_task."userId" = session."userId"
     JOIN "sub_agent_tasks" AS filler ON filler."sessionId" = fill_task."sessionId" AND filler."turnId" = fill_task."fillTurnId"
     WHERE session."id" = $1 AND session."userId" = $2 AND session."status" = 'waiting_for_user'
       AND ${NO_UNRESOLVED_SESSION_PAUSE}
       AND fill_task."fillTurnId" = $3 AND fill_task."fillTurnSessionId" = $1 AND fill_task."fillTurnUserId" = $2
       AND fill_task."status" = 'waiting_for_user' AND fill_task."checkpoint" = 'submission_uncertain'
       AND filler."rootTaskId" = $4 AND filler."parentTaskId" = $4 AND filler."role" = 'application_filler'
       AND filler."taskType" = 'application_fill_for_review' AND filler."status" = 'completed'
     LIMIT 2`,
    [input.sessionId, input.userId, input.turnId, input.rootTaskId],
  )
  if (wait.rows.length !== 1) throw new SessionPauseRequestedError()
  return terminalAdmission(client, input, "derived_fill")
}
