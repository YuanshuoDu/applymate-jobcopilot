import type { ExecutionOwnerFence } from "../execution-owner.js"

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
