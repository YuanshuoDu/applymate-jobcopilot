import type pg from "pg"

import type { TurnEngineResult } from "./turns/turn-engine-types.js"

type ProjectionPool = Pick<pg.Pool, "connect">
type ProjectionClient = Pick<pg.PoolClient, "query" | "release">
type QueryResult = { readonly rowCount: number | null }

export type CanonicalExecutionIdentity = {
  readonly userId: string
  readonly sessionId: string
}

export type CanonicalExecutionProjection = {
  start(input: CanonicalExecutionIdentity): Promise<void>
  finish(input: CanonicalExecutionIdentity & { readonly result: { readonly status: TurnEngineResult["status"]; readonly errorCode?: string | null } }): Promise<void>
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

const AUTOMATION_SESSION = `EXISTS (
  SELECT 1 FROM "agent_sessions" AS session
  WHERE session."id" = execution."sessionId"
    AND session."id" = $2
    AND session."userId" = $1
    AND session."source" = 'automation'
)`

const ACTIVE_EXECUTION_STATUSES = "'queued', 'running', 'paused', 'waiting_for_user'"

async function startExecution(client: ProjectionClient, input: CanonicalExecutionIdentity): Promise<void> {
  await client.query(
    `UPDATE "agent_executions" AS execution
     SET "status" = 'running', "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP), "completedAt" = NULL, "error" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE execution."userId" = $1 AND execution."sessionId" = $2
       AND execution."status" IN ('queued', 'paused', 'waiting_for_user')
       AND ${AUTOMATION_SESSION}`,
    [input.userId, input.sessionId],
  ) as QueryResult
}

function executionStatus(status: TurnEngineResult["status"]): "completed" | "failed" | "paused" | "waiting_for_user" | null {
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

async function finishExecution(client: ProjectionClient, input: CanonicalExecutionIdentity & { readonly result: { readonly status: TurnEngineResult["status"]; readonly errorCode?: string | null } }): Promise<void> {
  const status = executionStatus(input.result.status)
  if (!status) return
  const error = status === "failed" ? failureCode(input.result.errorCode) : null
  await client.query(
    `UPDATE "agent_executions" AS execution
     SET "status" = $3,
         "error" = $4,
         "completedAt" = CASE WHEN $3 IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE execution."userId" = $1 AND execution."sessionId" = $2
       AND execution."status" IN (${ACTIVE_EXECUTION_STATUSES})
       AND ${AUTOMATION_SESSION}`,
    [input.userId, input.sessionId, status, error],
  ) as QueryResult
}

/**
 * Projects canonical Turn outcomes into an automation control row only.
 * Interrupted Turns become paused so a later worker attempt can recover them.
 * A missing row and a conditional no-op are both safe and intentionally silent.
 * An unexpected shutdown leaves a running row untouched so the existing stale
 * execution claim can recover it on a later attempt.
 */
export function createCanonicalExecutionProjection(pool: ProjectionPool): CanonicalExecutionProjection {
  return {
    async start(raw) {
      const input = { userId: identity(raw.userId, "userId"), sessionId: identity(raw.sessionId, "sessionId") }
      await transaction(pool, input.userId, client => startExecution(client, input))
    },
    async finish(raw) {
      const input = { userId: identity(raw.userId, "userId"), sessionId: identity(raw.sessionId, "sessionId"), result: raw.result }
      if (!executionStatus(input.result.status)) return
      await transaction(pool, input.userId, client => finishExecution(client, input))
    },
  }
}

export const noopCanonicalExecutionProjection: CanonicalExecutionProjection = {
  async start() { return undefined },
  async finish() { return undefined },
}
