import type pg from "pg"
import type { TurnLease } from "./turns/lease.js"

/** A positive marker carries no ApplicationTask identity into model-visible context. */
export type ApplicationFillPreparation = Readonly<{ available: true }>

type BoundApplicationTask = {
  id: string
  userId: string
  sessionId: string | null
  fillTurnSessionId: string | null
  fillTurnUserId: string | null
  status: string
  checkpoint: string | null
}

/** Exposes the fixed fill template only after the leased Turn's persisted materials validate. */
export async function loadApplicationFillPreparation(
  pool: Pick<pg.Pool, "connect">,
  lease: TurnLease,
  now = new Date(),
): Promise<ApplicationFillPreparation | undefined> {
  if (![lease.userId, lease.sessionId, lease.turnId, lease.ownerId].every(value => typeof value === "string" && value.trim())
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return undefined
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const bound = await client.query<BoundApplicationTask>(
      `SELECT app."id", app."userId", app."sessionId", app."fillTurnSessionId", app."fillTurnUserId", app."status", app."checkpoint"
       FROM "agent_turns" AS turn
       INNER JOIN "application_tasks" AS app ON app."fillTurnId" = turn."id"
       WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
         AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5
         AND turn."leaseExpiresAt" > $6 AND turn."status" = 'in_progress'`,
      [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now],
    )
    if (bound.rows.length === 0) return await commitUnavailable(client, () => { committed = true })
    if (bound.rows.length !== 1) throw new Error("application_fill_binding_invalid")
    const task = bound.rows[0]!
    if (task.status !== "filling" || task.checkpoint !== "taskgraph_fill_queued") {
      throw new Error("application_fill_state_invalid")
    }
    if (task.userId !== lease.userId || task.sessionId !== lease.sessionId
      || task.fillTurnUserId !== lease.userId || task.fillTurnSessionId !== lease.sessionId) {
      throw new Error("application_fill_binding_invalid")
    }

    const materials = await client.query<{ id: string }>(
      `SELECT app."id"
       FROM "application_tasks" AS app
       INNER JOIN "Job" AS job ON job."id" = app."jobId" AND job."userId" = app."userId"
       INNER JOIN "Resume" AS resume ON resume."id" = app."resumeId" AND resume."userId" = app."userId"
         AND (resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")
       LEFT JOIN "CoverLetter" AS cover ON cover."id" = app."coverLetterId"
         AND cover."userId" = app."userId" AND cover."jobId" = app."jobId"
       WHERE app."id" = $1 AND app."userId" = $2 AND app."sessionId" = $3
         AND app."fillTurnId" = $4 AND app."fillTurnSessionId" = $3 AND app."fillTurnUserId" = $2
         AND app."status" = 'filling' AND app."checkpoint" = 'taskgraph_fill_queued'
         AND app."resumeId" IS NOT NULL AND (app."coverLetterId" IS NULL OR cover."id" IS NOT NULL)`,
      [task.id, lease.userId, lease.sessionId, lease.turnId],
    )
    if (materials.rows.length !== 1) throw new Error("application_fill_material_unavailable")
    await client.query("COMMIT")
    committed = true
    return Object.freeze({ available: true })
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function commitUnavailable(client: Pick<pg.PoolClient, "query">, markCommitted: () => void): Promise<undefined> {
  await client.query("COMMIT")
  markCommitted()
  return undefined
}
