import { RUNNABLE_SESSION, assertSessionWorkAdmission } from "../session-gate.js"
import { lockSubagentTurnForWork, readSubagentTask, SubagentTurnUnavailableError } from "./pg-store-create.js"
import { transaction } from "./pg-store-persistence.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import { PAUSE_DEFERRED_MARKER, parseSubagentJobPayload, type PgSubagentPool, type SubagentJobPayload, type SubagentPolicy, type SubagentTaskRecord } from "./types.js"
import { parseSubagentDispatchIdentity, SubagentDispatchIdentityMismatchError, type SubagentDispatchIdentity } from "./dispatch-identity.js"

type ClaimInput = { taskId: string; sessionId: string; ownerId: string; rootTaskId?: string; policy: SubagentPolicy; now: Date; dispatchIdentity?: SubagentDispatchIdentity }

const CHILD_WAIT_RESUMABLE_SQL = `(SELECT COUNT(*) = 1
  FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId"
    AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $7 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
    AND step."turnId" = wait."turnId" AND step."taskId" = task."id"
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'queued'
    AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
    AND step."attempt" = task."attemptCount" AND task."attemptCount" >= 0 AND task."maxAttempts" > 0
    AND ((wait."consumedAt" IS NULL AND step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
        WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
          AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))
      OR (step."status" IN ('waiting_for_tool', 'completed')
        AND EXISTS (SELECT 1 FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id"
          AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId"
          AND continuation."attempt" = task."attemptCount"
          AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
            WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId"
              AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal")
          AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
            WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
              AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))))
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId"
        AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId"
        AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId"
        AND currentWait."turnId" = task."turnId"
      ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) > 0
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) <= 8
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT target."value")
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value") WHERE jsonb_typeof(target."value") = 'string')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array'
      THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") <> 'string' OR NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child
      WHERE child."id" = target."value" #>> '{}' AND child."id" <> task."id"
        AND child."parentTaskId" = task."id" AND child."sessionId" = task."sessionId"
        AND child."turnId" = task."turnId" AND child."rootTaskId" = task."rootTaskId"))) = true`

/** Read-only identity check used only to classify local concurrency denial. */
export async function matchesPublishedSubagentDispatch(pool: PgSubagentPool, input: { payload: SubagentJobPayload; dispatchIdentity: SubagentDispatchIdentity }): Promise<boolean> {
  const identity = parseSubagentDispatchIdentity(input.dispatchIdentity, input.payload.taskId)
  if (!identity) return false
  return transaction(pool, async client => {
    const session = await client.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1`, [input.payload.sessionId])
    const userId = session.rows[0]?.userId
    if (!userId) return false
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const dispatch = await client.query<{ payload: unknown; attemptCount: unknown; publishedAt: unknown }>(`SELECT dispatch."payload", dispatch."attemptCount", dispatch."publishedAt"
      FROM "agent_outbox" AS dispatch
      JOIN "agent_sessions" AS session ON session."id" = dispatch."aggregateId" AND session."id" = $1 AND session."userId" = $4
      JOIN "sub_agent_tasks" AS task ON task."id" = $2 AND task."sessionId" = session."id" AND task."rootTaskId" = $3
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId" AND turn."rootTaskId" = root."id"
      WHERE dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"`,
    [input.payload.sessionId, input.payload.taskId, input.payload.rootTaskId, userId])
    const row = dispatch.rows[0]
    const currentPayload = row ? parseSubagentJobPayload(row.payload) : null
    const attemptCount = row ? Number(row.attemptCount) : Number.NaN
    return !!row && !!currentPayload && row.publishedAt != null && Number.isSafeInteger(attemptCount) && attemptCount === identity.generation + 1
      && currentPayload.taskId === input.payload.taskId && currentPayload.sessionId === input.payload.sessionId
      && currentPayload.rootTaskId === input.payload.rootTaskId && currentPayload.ownerId === input.payload.ownerId
  })
}

/** Claims a queued child only after the owning Session, Turn, root, and child are fenced. */
export async function claimSubagentTask(pool: PgSubagentPool, input: ClaimInput, leaseMs: number): Promise<SubagentTaskRecord | null> {
  return transaction(pool, async client => {
    const session = await client.query(`SELECT session."id", session."userId", session."status" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND ${RUNNABLE_SESSION} FOR UPDATE`, [input.sessionId])
    const sessionRow = session.rows[0] as Record<string, unknown> | undefined
    if (!sessionRow || ["aborted", "archived"].includes(String(sessionRow.status))) return null
    const userId = String(sessionRow.userId)
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])

    const binding = await client.query(`SELECT "turnId", "rootTaskId" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [input.taskId, input.sessionId])
    const turnId = binding.rows[0]?.turnId
    const rootTaskId = binding.rows[0]?.rootTaskId
    if (typeof turnId !== "string" || !turnId || typeof rootTaskId !== "string" || (input.rootTaskId && rootTaskId !== input.rootTaskId)) return null
    try {
      await lockSubagentTurnForWork(client, { sessionId: input.sessionId, userId, turnId })
    } catch (error: unknown) {
      if (error instanceof SubagentTurnUnavailableError) return null
      throw error
    }

    await assertSessionWorkAdmission(client, { userId, sessionId: input.sessionId, turnId })

    const root = await client.query(`SELECT "id", "turnId", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [rootTaskId, input.sessionId, turnId])
    const rootRow = root.rows[0] as Record<string, unknown> | undefined
    if (!rootRow || rootRow.interruptRequestedAt != null || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(rootRow.status))) return null

    const task = await client.query(`SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [input.taskId, input.sessionId])
    const taskRow = task.rows[0] as Record<string, unknown> | undefined
    if (!taskRow || taskRow.turnId !== turnId || taskRow.rootTaskId !== rootTaskId
      || taskRow.status !== "queued" || taskRow.interruptRequestedAt != null) return null

    const dispatch = await client.query<{ id: string; payload: unknown; lastError: string | null; attemptCount: unknown; publishedAt: unknown }>(`SELECT dispatch."id", dispatch."payload", dispatch."lastError", dispatch."attemptCount", dispatch."publishedAt"
      FROM "agent_outbox" AS dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = $1 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || $2 FOR UPDATE`, [input.sessionId, input.taskId])
    const deferred = dispatch.rows[0]
    let currentDispatchIdentity = false
    if (input.dispatchIdentity) {
      const identity = parseSubagentDispatchIdentity(input.dispatchIdentity, input.taskId)
      const currentPayload = deferred ? parseSubagentJobPayload(deferred.payload) : null
      const generationCount = deferred ? Number(deferred.attemptCount) : Number.NaN
      if (!identity || !deferred || deferred.publishedAt == null || !Number.isSafeInteger(generationCount)
        || generationCount !== identity.generation + 1 || !currentPayload
        || currentPayload.taskId !== input.taskId || currentPayload.sessionId !== input.sessionId
        || currentPayload.rootTaskId !== rootTaskId || currentPayload.ownerId !== input.ownerId) {
        throw new SubagentDispatchIdentityMismatchError()
      }
      currentDispatchIdentity = true
    }
    if (deferred?.lastError === PAUSE_DEFERRED_MARKER) {
      const payload = parseSubagentJobPayload(deferred.payload)
      if (!payload || payload.taskId !== input.taskId || payload.sessionId !== input.sessionId
        || payload.rootTaskId !== rootTaskId || payload.ownerId !== input.ownerId) return null
    }
    const running = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "status" = 'running' AND "leaseExpiresAt" > clock_timestamp()`, [input.sessionId])
    if (Number(running.rows[0]?.count ?? 0) >= input.policy.maxConcurrency) return null
    const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.started" })
    if (graph && "blocked" in graph) return null
    const updated = await client.query(`UPDATE "sub_agent_tasks" AS task
      SET "status" = 'running', "leaseOwner" = $3, "leaseExpiresAt" = clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
        "attemptCount" = CASE WHEN $8::boolean AND ${CHILD_WAIT_RESUMABLE_SQL} THEN "attemptCount" ELSE "attemptCount" + 1 END,
        "startedAt" = COALESCE("startedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $5 AND "rootTaskId" = $6
        AND "status" = 'queued' AND "interruptRequestedAt" IS NULL
        AND ("attemptCount" < "maxAttempts" OR ($8::boolean AND ${CHILD_WAIT_RESUMABLE_SQL}))
        AND (NOT ${CHILD_WAIT_RESUMABLE_SQL} OR $8::boolean)
        AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" root WHERE root."id" = $6 AND root."sessionId" = $2
          AND root."turnId" = $5 AND root."interruptRequestedAt" IS NULL
          AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))`,
    [input.taskId, input.sessionId, input.ownerId, leaseMs, turnId, rootTaskId, userId, currentDispatchIdentity])
    if (updated.rowCount !== 1) return null
    if (graph) await persistGraphTransition(client, graph, input.now)
    return readSubagentTask(client, input.taskId, input.sessionId)
  })
}
