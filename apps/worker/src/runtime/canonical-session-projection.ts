import type pg from "pg"

import type { TurnEngineResult } from "./turns/turn-engine-types.js"

type ProjectionPool = Pick<pg.Pool, "connect">
type ProjectionClient = Pick<pg.PoolClient, "query" | "release">

export type CanonicalSessionIdentity = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
}

export type CanonicalSessionProjection = {
  start(input: CanonicalSessionIdentity): Promise<void>
  finish(input: CanonicalSessionIdentity & { readonly result: { readonly status: TurnEngineResult["status"]; readonly errorCode?: string | null } }): Promise<void>
}

function identity(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 256) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

async function transaction<T>(pool: ProjectionPool, userId: string, work: (client: ProjectionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function lockOpenSession(client: ProjectionClient, input: CanonicalSessionIdentity): Promise<void> {
  const result = await client.query(
    `SELECT "id" FROM "agent_sessions"
     WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived')
     FOR UPDATE`,
    [input.sessionId, input.userId],
  )
  if (!result.rows[0]) throw new Error("session_projection_session_fenced")
}

const AUTOMATION_SESSION = `EXISTS (
  SELECT 1 FROM "agent_sessions" AS automation_session
  WHERE automation_session."id" = session."id"
    AND automation_session."id" = $2
    AND automation_session."userId" = $1
    AND automation_session."status" NOT IN ('aborted', 'archived')
    AND automation_session."source" = 'automation'
)`

const CURRENT_AUTOMATION_TURN = `EXISTS (
  SELECT 1 FROM "agent_turns" AS turn
  WHERE turn."id" = $3
    AND turn."sessionId" = $2
    AND turn."userId" = $1
    AND turn."source" = 'automation'
    AND NOT EXISTS (
      SELECT 1 FROM "agent_turns" AS newer_turn
      WHERE newer_turn."sessionId" = turn."sessionId"
        AND newer_turn."userId" = turn."userId"
        AND (newer_turn."createdAt" > turn."createdAt"
          OR (newer_turn."createdAt" = turn."createdAt" AND newer_turn."id" > turn."id"))
    )
)`

const PROJECTABLE_SESSION_STATUSES = "'queued', 'running', 'paused', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user'"

async function startSession(client: ProjectionClient, input: CanonicalSessionIdentity): Promise<void> {
  await lockOpenSession(client, input)
  await client.query(
    `UPDATE "agent_sessions" AS session
     SET "status" = 'running', "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE session."id" = $2 AND session."userId" = $1
       AND session."status" NOT IN ('aborted', 'archived')
       AND ${AUTOMATION_SESSION}
       AND ${CURRENT_AUTOMATION_TURN}`,
    [input.userId, input.sessionId, input.turnId],
  )
}

function sessionStatus(status: TurnEngineResult["status"]): "completed" | "failed" | "paused" | "waiting_for_user" | null {
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  if (status === "waiting_for_dependency" || status === "interrupted") return "paused"
  if (status === "waiting_for_user" || status === "waiting_for_approval") return "waiting_for_user"
  return null
}

function failureCode(value: string | null | undefined): string {
  const code = value?.trim()
  return (code && code.length > 0 ? code : "canonical_turn_failed").slice(0, 256)
}

async function finishSession(
  client: ProjectionClient,
  input: CanonicalSessionIdentity & { readonly result: { readonly status: TurnEngineResult["status"]; readonly errorCode?: string | null } },
): Promise<void> {
  const status = sessionStatus(input.result.status)
  if (!status) return
  await lockOpenSession(client, input)
  const memorySummary = status === "failed" ? failureCode(input.result.errorCode) : null
  await client.query(
    `UPDATE "agent_sessions" AS session
     SET "status" = $4,
         "memorySummary" = CASE WHEN $4 = 'failed' THEN $5 ELSE "memorySummary" END,
         "completedAt" = CASE WHEN $4 IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE session."id" = $2 AND session."userId" = $1
       AND session."status" IN (${PROJECTABLE_SESSION_STATUSES})
       AND ${AUTOMATION_SESSION}
       AND ${CURRENT_AUTOMATION_TURN}`,
    [input.userId, input.sessionId, input.turnId, status, memorySummary],
  )
}

/** Projects canonical Turn lifecycle into automation sessions only. */
export function createCanonicalSessionProjection(pool: ProjectionPool): CanonicalSessionProjection {
  return {
    async start(raw) {
      const input = { userId: identity(raw.userId, "userId"), sessionId: identity(raw.sessionId, "sessionId"), turnId: identity(raw.turnId, "turnId") }
      await transaction(pool, input.userId, client => startSession(client, input))
    },
    async finish(raw) {
      const input = { userId: identity(raw.userId, "userId"), sessionId: identity(raw.sessionId, "sessionId"), turnId: identity(raw.turnId, "turnId"), result: raw.result }
      if (!sessionStatus(input.result.status)) return
      await transaction(pool, input.userId, client => finishSession(client, input))
    },
  }
}

export const noopCanonicalSessionProjection: CanonicalSessionProjection = {
  async start() { return undefined },
  async finish() { return undefined },
}
