import type { ExecutionOwnerFence } from "../execution-owner.js"
import type pg from "pg"

export type TurnEnginePool = Pick<pg.Pool, "connect">
export type TurnEngineQueryClient = Pick<pg.PoolClient, "query" | "release">
export type TurnEngineRow = Record<string, unknown>
const OPEN_SESSION = `"status" NOT IN ('aborted', 'archived')`

export type OwnerFenceSql = {
  readonly joins: string
  readonly where: string
  readonly values: readonly unknown[]
}

/**
 * Build the SQL fence shared by every durable Step, Item, and Event write.
 * The caller must bind the first four row keys (id/session/turn/task) itself.
 */
export function ownerFenceSql(owner: ExecutionOwnerFence, startParameter: number, allowWaiting = false): OwnerFenceSql {
  const p = (offset: number) => `$${startParameter + offset}`
  if (owner.kind === "turn") {
    return {
      where: `turn."userId" = ${p(0)} AND turn."leaseOwnerId" = ${p(1)}
        AND turn."leaseVersion" = ${p(2)} AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP
        AND turn."status" ${allowWaiting ? "IN ('in_progress', 'waiting_for_user')" : "= 'in_progress'"} AND EXISTS (
          SELECT 1 FROM "sub_agent_tasks" AS owner_task
          WHERE owner_task."id" = ${p(3)} AND owner_task."sessionId" = turn."sessionId"
            AND owner_task."turnId" = turn."id" AND owner_task."rootTaskId" = owner_task."id"
            AND owner_task."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))`,
      joins: "",
      values: [owner.userId, owner.ownerId, owner.leaseVersion, owner.taskId],
    }
  }
  return {
    joins: `JOIN "sub_agent_tasks" AS owner_task
      ON owner_task."id" = ${p(3)} AND owner_task."sessionId" = turn."sessionId"
     AND owner_task."turnId" = turn."id" AND owner_task."rootTaskId" = ${p(4)}
     JOIN "sub_agent_tasks" AS root_task
      ON root_task."id" = ${p(4)} AND root_task."sessionId" = turn."sessionId"
     AND root_task."turnId" = turn."id" AND root_task."rootTaskId" = root_task."id"`,
    where: `turn."userId" = ${p(0)} AND turn."sessionId" = ${p(1)} AND turn."id" = ${p(2)}
      AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
      AND owner_task."leaseOwner" = ${p(5)} AND owner_task."attemptCount" = ${p(6)}
      AND owner_task."leaseExpiresAt" > CURRENT_TIMESTAMP AND owner_task."interruptRequestedAt" IS NULL
      AND owner_task."status" = 'running'
      AND root_task."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`,
    values: [owner.userId, owner.sessionId, owner.turnId, owner.taskId, owner.rootTaskId, owner.ownerId, owner.attemptCount],
  }
}

export function ownerTaskId(owner: ExecutionOwnerFence): string {
  return owner.taskId
}

export function turnEngineOwnerConflict(resource: string): Error {
  const error = new Error(`TurnEngine persistence conflict: ${resource}`)
  error.name = "TurnEnginePersistenceConflict"
  return error
}

export async function turnEngineTenantTransaction<T>(pool: TurnEnginePool, userId: string, work: (client: TurnEngineQueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function lockTurnEngineOwnedTurn(client: TurnEngineQueryClient, owner: ExecutionOwnerFence, allowWaiting = false): Promise<boolean> {
  const fence = ownerFenceSql(owner, 1, allowWaiting)
  const result = owner.kind === "turn"
    ? await client.query<TurnEngineRow>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, owner.turnId, owner.sessionId])
    : await client.query<TurnEngineRow>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $3 AND turn."sessionId" = $2 AND ${fence.where} FOR UPDATE`, fence.values as unknown[])
  return Boolean(result.rows[0])
}

export async function lockTurnEngineOpenSession(client: TurnEngineQueryClient, owner: ExecutionOwnerFence): Promise<boolean> {
  const result = await client.query<TurnEngineRow>(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [owner.sessionId, owner.userId])
  return Boolean(result.rows[0])
}

export async function assertCurrentStepLineage(client: TurnEngineQueryClient, owner: ExecutionOwnerFence, stepId: string | null): Promise<void> {
  if (!stepId) return
  const attempt = owner.kind === "task" ? owner.attemptCount : 1
  const result = await client.query<TurnEngineRow>(`SELECT "id" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
  [stepId, owner.sessionId, owner.turnId, owner.taskId, attempt])
  if (!result.rows[0]) throw turnEngineOwnerConflict(`step ${stepId} lineage`)
}

export async function assertCurrentItemLineage(client: TurnEngineQueryClient, owner: ExecutionOwnerFence, itemId: string): Promise<void> {
  const attempt = owner.kind === "task" ? owner.attemptCount : 1
  const result = await client.query<TurnEngineRow>(`SELECT item."id" FROM "agent_items" AS item
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND (item."stepId" IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
        WHERE owner_step."id" = item."stepId" AND owner_step."sessionId" = item."sessionId"
          AND owner_step."turnId" = item."turnId" AND owner_step."taskId" = item."taskId" AND owner_step."attempt" = $5))`,
  [itemId, owner.sessionId, owner.turnId, owner.taskId, attempt])
  if (!result.rows[0]) throw turnEngineOwnerConflict(`item ${itemId} lineage`)
}
