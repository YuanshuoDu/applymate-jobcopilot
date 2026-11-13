import { randomUUID } from "node:crypto"
import type pg from "pg"
import { isTerminalSubagentStatus, PAUSE_DEFERRED_MARKER, type PgSubagentPool, type SubagentExecutionResult,
  type SubagentFinishResult, type SubagentRetryDisposition } from "./types.js"
import { computeSubagentNextAttemptAt } from "./retry-policy.js"
import { persistGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { handoffDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"
import { dateValue, json, SELECT_TASK, transaction, uniqueMessageIds } from "./pg-store-persistence.js"
import { findUnobservedMailboxMessageIds } from "./subagent-mailbox-completion.js"
import { prepareTaskGraphFinish } from "./pg-store-lifecycle.js"
import { taskGraphDeadlineLive } from "./pg-store-claim.js"
import { lockScheduledGateFinish } from "./pg-store-gate-finish.js"
import { SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { hasActiveSubagentDescendants } from "./pg-store-descendant-completion.js"
import { interruptMatchingInSession } from "./pg-store-subtree-interrupt.js"

export type FinishSubagentTaskInput = Readonly<{
  taskId: string
  sessionId: string
  ownerId: string
  attemptCount: number
  status: SubagentExecutionResult["status"]
  result?: unknown
  failureReason?: string
  retryDisposition?: SubagentRetryDisposition
  mailboxMessageIds?: readonly string[]
  now: Date
}>

export async function finishSubagentTask(pool: PgSubagentPool, input: FinishSubagentTaskInput): Promise<SubagentFinishResult | null> {
  const mailboxMessageIds = uniqueMessageIds(input.mailboxMessageIds)
  try {
    return await transaction(pool, async client => {
      const session = await client.query<{ id: string; userId: string; status: string }>(`SELECT "id", "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
      const sessionRow = session.rows[0]
      if (!sessionRow || sessionRow.status === "aborted" || sessionRow.status === "archived") return null
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [sessionRow.userId])
      const taskSql = `${SELECT_TASK}
        AND task."status" = 'running' AND task."leaseOwner" = $3 AND task."attemptCount" = $4
        AND task."leaseExpiresAt" > clock_timestamp()
        AND (task."absoluteDeadlineAt" IS NULL OR task."absoluteDeadlineAt" > clock_timestamp())
        AND session."status" NOT IN ('aborted', 'archived')
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
          WHERE root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."rootTaskId" = root."id"
            AND (turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
              OR (turn."status" = 'interrupted' AND task."interruptRequestedAt" IS NOT NULL)))`
      const task = await client.query(taskSql, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
      const row = task.rows[0] as Record<string, unknown> | undefined
      if (!row || String(row.id) !== input.taskId || String(row.sessionId) !== input.sessionId
        || row.status !== "running" || row.leaseOwner !== input.ownerId || Number(row.attemptCount) !== input.attemptCount) return null
      if (row.taskType === SCHEDULED_GATE_TASK_TYPE && !await lockScheduledGateFinish(client, row, input)) return null
      const interrupted = row.interruptRequestedAt !== null && row.interruptRequestedAt !== undefined
      const retry = input.status === "failed" && !interrupted && input.retryDisposition !== "terminal" && Number(row.attemptCount) < Number(row.maxAttempts)
      let status = interrupted ? "interrupted" : retry ? "queued" : input.status
      let result = input.result
      let failureReason = input.failureReason
      const finish = await prepareTaskGraphFinish(client, {
        taskId: input.taskId, sessionId: input.sessionId, attemptCount: input.attemptCount,
        status, retry, failureReason, result, ownerId: input.ownerId, taskRole: String(row.role), taskType: String(row.taskType),
      })
      status = finish.status; result = finish.result; failureReason = finish.failureReason
      const graph = finish.graph
      if (graph && "blocked" in graph) return null
      const terminal = isTerminalSubagentStatus(status)
      const lockedTask = await client.query(`${taskSql} FOR UPDATE OF task`, [input.taskId, input.sessionId, input.ownerId, input.attemptCount])
      const lockedRow = lockedTask.rows[0] as Record<string, unknown> | undefined
      if (!lockedRow || lockedRow.status !== "running" || lockedRow.leaseOwner !== input.ownerId
        || Number(lockedRow.attemptCount) !== input.attemptCount) return null
      const lockedExpiry = dateValue(lockedRow.leaseExpiresAt)
      const leaseClock = await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)
      const finishAt = leaseClock.rows[0]?.checkedAt
      const absoluteDeadlineAt = dateValue(lockedRow.absoluteDeadlineAt)
      if (!lockedExpiry || !finishAt || lockedExpiry <= finishAt
        || absoluteDeadlineAt && absoluteDeadlineAt <= finishAt) return null
      if (status === "completed" && !interrupted && await hasActiveSubagentDescendants(client, {
        taskId: input.taskId, sessionId: input.sessionId, turnId: String(lockedRow.turnId), rootTaskId: String(lockedRow.rootTaskId),
      })) return { status: "children_pending" }
      if (input.status === "waiting" && row.parentTaskId !== null && row.parentTaskId !== undefined) {
        const handoff = await handoffDurableSubagentWaitWithGraph(client, { lease: { id: input.taskId, userId: sessionRow.userId, sessionId: input.sessionId, turnId: String(row.turnId), rootTaskId: String(row.rootTaskId), ownerId: input.ownerId, attemptCount: input.attemptCount, leaseExpiresAt: lockedExpiry }, now: finishAt })
        if (handoff) {
          if ("blocked" in handoff) return null
          const closedSegment = await client.query(`UPDATE "sub_agent_tasks" SET "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END
            WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = $3 AND "status" IN ('waiting', 'queued')
              AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL
              AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp()) RETURNING "id"`,
          [input.taskId, input.sessionId, input.attemptCount])
          if (closedSegment.rowCount !== 1) throw new FinishFenceSignal()
          return "waiting"
        }
      }
      if (input.status === "completed" && !interrupted) {
        const missingMessageIds = await findUnobservedMailboxMessageIds(client, {
          sessionId: input.sessionId, taskId: input.taskId, attemptCount: input.attemptCount, observedMessageIds: mailboxMessageIds,
        })
        if (missingMessageIds.length > 0) return { status: "input_pending", messageIds: missingMessageIds }
      }
      const nextAttemptAt = retry ? computeSubagentNextAttemptAt(input.attemptCount, finishAt) : null
      const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $3, "result" = $4::jsonb,
        "failureReason" = $5, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
        "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END,
        "nextAttemptAt" = $10, "completedAt" = CASE WHEN $6 THEN $7::timestamp(3) ELSE NULL::timestamp(3) END,
        "updatedAt" = $7::timestamp(3)
        WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $8 AND "status" = 'running'
          AND "attemptCount" = $9 AND "leaseExpiresAt" > clock_timestamp()
          AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = "sub_agent_tasks"."sessionId"
              AND session."status" NOT IN ('aborted', 'archived'))
          AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId"
            WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = "sub_agent_tasks"."sessionId" AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
              AND turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = "sub_agent_tasks"."sessionId"
              AND turn."rootTaskId" = root."id" AND (turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
                OR (turn."status" = 'interrupted' AND "sub_agent_tasks"."interruptRequestedAt" IS NOT NULL)))`,
      [input.taskId, input.sessionId, status, json(result, null), failureReason ?? null, terminal, finishAt, input.ownerId, input.attemptCount, nextAttemptAt])
      if (updated.rowCount !== 1) throw new FinishFenceSignal()
      if (graph) {
        await persistGraphTransition(client, graph, finishAt)
        if (terminal && finish.reconcileDependents !== false) await reconcileGraphDependents(client, graph.scope, finishAt)
      }
      if (interrupted) await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
        [input.sessionId, `subagent-dispatch:${input.taskId}`])
      if (retry) {
        await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1,
          "payload" = CASE WHEN "lastError" = $3 THEN jsonb_set("payload", '{ownerId}', to_jsonb($4::text), true) ELSE "payload" END,
          "lastError" = CASE WHEN "lastError" = $3 THEN "lastError" ELSE NULL END
          WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1 AND "aggregateId" = $2`,
        [`subagent-dispatch:${input.taskId}`, input.sessionId, PAUSE_DEFERRED_MARKER, `retry-${randomUUID()}`])
      }
      if (status === "completed" && mailboxMessageIds.length > 0) {
        await client.query(`UPDATE "agent_mailbox_messages" AS message
          SET "consumedAt" = CURRENT_TIMESTAMP
          WHERE message."sessionId" = $1 AND message."toTaskId" = $2
            AND message."id" = ANY($3::text[]) AND message."consumedAt" IS NULL
            AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS target
              WHERE target."id" = $2 AND target."sessionId" = $1
                AND message."turnId" = target."turnId")`,
        [input.sessionId, input.taskId, mailboxMessageIds])
      }
      if (status === "failed" || status === "interrupted") {
        if (typeof lockedRow.rootTaskId !== "string" || typeof lockedRow.path !== "string") throw new Error("subagent_finish_subtree_scope_missing")
        await interruptMatchingInSession(client, { sessionId: input.sessionId, rootTaskId: lockedRow.rootTaskId, targetPath: lockedRow.path }, sessionRow.userId, finishAt)
      }
      if (!await taskGraphDeadlineLive(client, input.taskId, input.sessionId)) throw new FinishFenceSignal()
      if (interrupted) return "interrupted"
      if (retry) return "retrying"
      return status as "completed" | "failed" | "waiting" | "waiting_for_user"
    })
  } catch (error: unknown) {
    if (error instanceof FinishFenceSignal) return null
    throw error
  }
}

class FinishFenceSignal extends Error {}
