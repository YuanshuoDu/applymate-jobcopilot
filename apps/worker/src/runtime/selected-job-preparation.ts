import type pg from "pg"
import type { TurnLease } from "./turns/lease.js"

export type SelectedJobPreparation = Readonly<{ jobId: string }>

type TurnRow = { input: unknown }

/** Reads only the server-injected selected-job intent from the currently owned Turn. */
export async function loadSelectedJobPreparation(
  pool: Pick<pg.Pool, "connect">,
  lease: TurnLease,
  now = new Date(),
): Promise<SelectedJobPreparation | undefined> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const result = await client.query<TurnRow>(
      `SELECT "input" FROM "agent_turns"
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
         AND "leaseOwnerId" = $4 AND "leaseVersion" = $5
         AND "leaseExpiresAt" > $6 AND "status" = 'in_progress'`,
      [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now],
    )
    const row = result.rows[0]
    if (!row) throw new Error("turn_not_owned")
    const input = record(parseJson(row.input))
    if (!Object.prototype.hasOwnProperty.call(input, "selectedJobPreparation")) {
      await client.query("COMMIT")
      committed = true
      return undefined
    }
    const selection = record(input.selectedJobPreparation)
    if (Object.keys(selection).sort().join(",") !== "jobId"
      || typeof selection.jobId !== "string" || !selection.jobId.trim() || selection.jobId.length > 256) {
      throw new Error("selected_job_preparation_invalid")
    }
    await client.query("COMMIT")
    committed = true
    return { jobId: selection.jobId }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { throw new Error("selected_job_preparation_invalid") }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : {}
}
