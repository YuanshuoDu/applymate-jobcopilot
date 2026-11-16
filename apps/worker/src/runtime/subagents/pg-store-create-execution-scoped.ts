import { randomUUID } from "node:crypto"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { assertSpawnSpecMatchesParentFence, clampNestedSubagentPolicy, type SubagentParentExecutionFence } from "./parent-execution-fence.js"
import { assertCurrentParentExecutionStep } from "./nested-spawn-step-fence.js"
import { inheritSubagentPolicy, isTerminalSubagentStatus, NestedScoutBudgetPolicyError, SubagentLeaseError, type AtomicSubagentSpawnFromLeaseInput,
  type AtomicSubagentSpawnResult, type PgSubagentPool, type SubagentTaskRecord } from "./types.js"
import { policyFromTask } from "./manager-task-scope.js"
import { assertFallbackPlannerRootCanDispatch, createSubagentTask, lockSubagentSession } from "./pg-store-create.js"
import { dateValue, rowToTask, SELECT_TASK, spawnKey, transaction, type Queryable } from "./pg-store-persistence.js"
import { hasPersistedTaskGraphMembership, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { hasNestedScoutPrivateContext, hasUnsupportedNestedScoutBudgetLimits, isNestedScoutCreationAuthorityValid } from "./nested-scout-creation-authority.js"

function denyStaleFence(): never {
  throw new SubagentLeaseError("lost", "Parent execution lease is no longer current")
}

type CurrentParentExecution = Readonly<{ task: SubagentTaskRecord; rootBudgetSnapshot: unknown }>

async function lockCurrentParent(client: Queryable, fence: SubagentParentExecutionFence): Promise<CurrentParentExecution> {
  const binding = await client.query<{ rootTaskId: string }>(
    `SELECT "rootTaskId" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [fence.id, fence.sessionId],
  )
  const rootTaskId = binding.rows[0]?.rootTaskId
  if (typeof rootTaskId !== "string" || rootTaskId !== fence.rootTaskId) return denyStaleFence()
  const root = await client.query<{ id: string; rootTaskId: string; turnId: string; parentTaskId: string | null; status: string; interruptRequestedAt: unknown; absoluteDeadlineAt: Date | null; budgetSnapshot: unknown }>(
    `SELECT "id", "rootTaskId", "turnId", "parentTaskId", "status", "interruptRequestedAt", "absoluteDeadlineAt", "budgetSnapshot"
      FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [rootTaskId, fence.sessionId],
  )
  const rootRow = root.rows[0]
  if (!rootRow || !Object.hasOwn(rootRow, "budgetSnapshot") || rootRow.id !== fence.rootTaskId || rootRow.rootTaskId !== fence.rootTaskId
    || rootRow.turnId !== fence.turnId || rootRow.parentTaskId !== null
    || rootRow.interruptRequestedAt != null || isTerminalSubagentStatus(rootRow.status)) return denyStaleFence()
  const parent = await client.query(
    `SELECT task.*, session."userId" AS "userId" FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4
      FOR UPDATE OF task`, [fence.id, fence.sessionId, fence.turnId, fence.userId],
  )
  const parentRow = parent.rows[0] as Record<string, unknown> | undefined
  if (!parentRow || parentRow.id !== fence.id || parentRow.userId !== fence.userId
    || parentRow.sessionId !== fence.sessionId || parentRow.turnId !== fence.turnId
    || parentRow.rootTaskId !== fence.rootTaskId || parentRow.status !== "running"
    || parentRow.leaseOwner !== fence.ownerId || Number(parentRow.attemptCount) !== fence.attemptCount
    || parentRow.interruptRequestedAt != null) return denyStaleFence()
  const expiry = await client.query<{ leaseLive: boolean; deadlineLive: boolean; rootDeadlineLive: boolean }>(
    `SELECT $1::timestamptz > clock_timestamp() AS "leaseLive",
      ($2::timestamptz IS NULL OR $2::timestamptz > clock_timestamp()) AS "deadlineLive",
      ($3::timestamptz IS NULL OR $3::timestamptz > clock_timestamp()) AS "rootDeadlineLive"`,
    [parentRow.leaseExpiresAt, parentRow.absoluteDeadlineAt ?? null, rootRow.absoluteDeadlineAt],
  )
  if (expiry.rows[0]?.leaseLive !== true || expiry.rows[0]?.deadlineLive !== true
    || expiry.rows[0]?.rootDeadlineLive !== true) return denyStaleFence()
  return { task: rowToTask(parentRow), rootBudgetSnapshot: rootRow.budgetSnapshot }
}

async function lockFenceScope(client: Queryable, fence: SubagentParentExecutionFence): Promise<void> {
  try { await lockSubagentSession(client, { sessionId: fence.sessionId, userId: fence.userId }) }
  catch (error: unknown) {
    if (error instanceof Error && error.message === "Session is unavailable") return denyStaleFence()
    throw error
  }
  const turn = await client.query<{ rootTaskId: string }>(
    `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
      AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') FOR UPDATE`,
    [fence.turnId, fence.sessionId, fence.userId],
  )
  if (turn.rows[0]?.rootTaskId !== fence.rootTaskId) return denyStaleFence()
}

async function replayedTask(client: Queryable, taskId: string, fence: SubagentParentExecutionFence): Promise<SubagentTaskRecord> {
  const result = await client.query(SELECT_TASK, [taskId, fence.sessionId])
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return denyStaleFence()
  const task = rowToTask(row)
  if (task.userId !== fence.userId || task.sessionId !== fence.sessionId || task.turnId !== fence.turnId
    || task.rootTaskId !== fence.rootTaskId || task.parentTaskId !== fence.id) return denyStaleFence()
  return task
}

export async function createSubagentWithSpawnFromLease(
  pool: PgSubagentPool,
  input: AtomicSubagentSpawnFromLeaseInput,
): Promise<AtomicSubagentSpawnResult> {
  const { parentExecutionFence: fence, spawnIdempotencyKey, ...taskInput } = input
  return transaction(pool, async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [fence.userId])
    await lockFenceScope(client, fence)
    assertSpawnSpecMatchesParentFence(taskInput, fence)
    const parentExecution = await lockCurrentParent(client, fence)
    const parent = parentExecution.task
    await assertCurrentParentExecutionStep(client, fence)
    let nestedScoutAuthority: "child_execution" | undefined
    if (hasNestedScoutPrivateContext(taskInput.context)) {
      const parentGraph: GraphIdentityScope = { userId: fence.userId, sessionId: fence.sessionId,
        turnId: fence.turnId, rootTaskId: fence.rootTaskId, parentTaskId: fence.rootTaskId }
      if (!fence.step || !isNestedScoutCreationAuthorityValid("parent_template", parent)
        || !await hasPersistedTaskGraphMembership(client, parentGraph, fence.id)
        || !isNestedScoutCreationAuthorityValid("child_execution", {
          ...taskInput, depth: 2, parentTaskId: fence.id, rootTaskId: fence.rootTaskId,
        })) return denyStaleFence()
      if (hasUnsupportedNestedScoutBudgetLimits(parentExecution.rootBudgetSnapshot)) throw new NestedScoutBudgetPolicyError()
      nestedScoutAuthority = "child_execution"
    }
    const key = spawnKey(fence.sessionId, spawnIdempotencyKey)
    const existing = await client.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.spawn'
        AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [fence.sessionId, key],
    )
    if (existing.rows[0]) {
      const payload = existing.rows[0].payload as Record<string, unknown> | undefined
      if (!payload || typeof payload.taskId !== "string") throw new Error("Spawn idempotency record is invalid")
      return { task: await replayedTask(client, payload.taskId, fence), duplicate: true }
    }
    await assertSessionWorkAdmission(client, { userId: fence.userId, sessionId: fence.sessionId, turnId: fence.turnId })
    await assertFallbackPlannerRootCanDispatch(client, taskInput)
    const policy = clampNestedSubagentPolicy(inheritSubagentPolicy(policyFromTask(parent), input.policy))
    const created = await createSubagentTask(client, { ...taskInput, policy }, true, {
      taskGraphChildDeadline: true, ...(nestedScoutAuthority ? { nestedScoutAuthority } : {}),
    })
    const deadline = await client.query<{ absoluteDeadlineAt: Date | string | null }>(`UPDATE "sub_agent_tasks" AS child
      SET "absoluteDeadlineAt" = LEAST(child."absoluteDeadlineAt", COALESCE(parent."absoluteDeadlineAt", child."absoluteDeadlineAt")),
        "updatedAt" = clock_timestamp()
      FROM "sub_agent_tasks" AS parent
      WHERE child."id" = $1 AND child."sessionId" = $2 AND child."absoluteDeadlineAt" IS NOT NULL
        AND parent."id" = $3 AND parent."sessionId" = $2 RETURNING child."absoluteDeadlineAt"`, [created.id, fence.sessionId, fence.id])
    if (!deadline.rows[0]) throw new Error("Nested child deadline could not be bounded")
    const task = { ...created, absoluteDeadlineAt: dateValue(deadline.rows[0].absoluteDeadlineAt) }
    const outbox = await persistSubagentSpawnOutbox(client, fence.sessionId, key, task)
    if (!outbox.operationCreated) throw new Error("Fenced spawn idempotency record already exists")
    if (!outbox.dispatchCreated) throw new Error("Fenced spawn dispatch already exists")
    return { task, duplicate: false }
  })
}

export async function persistSubagentSpawnOutbox(
  client: Queryable,
  sessionId: string,
  key: string,
  task: SubagentTaskRecord,
): Promise<{ operationCreated: boolean; dispatchCreated: boolean }> {
  const operation = await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.spawn', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
    [`spawn-operation-${randomUUID()}`, sessionId, key, JSON.stringify({ taskId: task.id })],
  )
  if (operation.rowCount !== 1) return { operationCreated: false, dispatchCreated: false }
  const dispatch = await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
    [`subagent-dispatch-${randomUUID()}`, sessionId, `subagent-dispatch:${task.id}`,
      JSON.stringify({ taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId: `coordination-${randomUUID()}` })],
  )
  return { operationCreated: true, dispatchCreated: dispatch.rowCount === 1 }
}
