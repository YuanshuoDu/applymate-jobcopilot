import type { Pool } from "pg"
import { RUNNABLE_SESSION } from "../runtime/session-gate.js"
import type { AgentArtifactTaskFence } from "./agent-artifact-repo-helpers.js"

type QueryClient = Pick<Pool, "query">
type Row = Record<string, unknown>

const TERMINAL_TURN = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_TASK = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
const TERMINAL_GRAPH_TASKS = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const CURRENT_TASK = `SELECT task."id", turn."status" AS "turnStatus", session."status" AS "sessionStatus",
    root."attemptCount" AS "rootAttemptCount"
  FROM "sub_agent_tasks" AS task
  JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
  JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
  JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
  WHERE task."id" = $1 AND session."userId" = $2 AND turn."userId" = $2 AND task."sessionId" = $3 AND task."turnId" = $4
    AND task."rootTaskId" = $5 AND task."parentTaskId" IS NOT DISTINCT FROM $6
    AND task."status" = 'running' AND task."leaseOwner" = $7 AND task."attemptCount" = $8
    AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL
    AND ($10 = 'scheduled_prepare' OR task."context"->'selectedJobPreparation'->>'jobId' = $9)
    AND ${RUNNABLE_SESSION} AND turn."status" NOT IN ${TERMINAL_TURN}
    AND ($10 <> 'scheduled_prepare' OR (task."role" = 'prepare' AND task."taskType" = 'scheduled_application_prepare'
      AND turn."leaseVersion" = $12 AND (
        (turn."status" = 'in_progress' AND turn."leaseOwnerId" = $11 AND turn."leaseExpiresAt" > clock_timestamp()
          AND root."status" = 'running' AND root."leaseOwner" = turn."leaseOwnerId")
        OR (turn."status" = 'waiting_for_dependency' AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL
          AND turn."leaseStartedAt" IS NULL AND root."status" = 'waiting' AND root."leaseOwner" IS NULL
          AND root."leaseExpiresAt" IS NULL AND root."completedAt" IS NULL AND root."closedAt" IS NULL
          AND root."nextAttemptAt" IS NULL AND session."status" = 'running')
      ) AND root."attemptCount" = $13))
    AND turn."rootTaskId" = root."id" AND root."rootTaskId" = root."id"
    AND root."status" NOT IN ${TERMINAL_TASK} AND root."interruptRequestedAt" IS NULL
  FOR UPDATE OF session, turn, root, task`

/** Locks the current artifact owner in Session-before-wait order. */
export async function artifactTaskFenceIsCurrent(client: QueryClient, fence: AgentArtifactTaskFence, jobId: string): Promise<boolean> {
  if (![fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.leaseOwner, jobId].every(validText)
    || !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1
    || (fence.taskFenceMode !== undefined && fence.taskFenceMode !== "selected_job" && fence.taskFenceMode !== "scheduled_prepare")
    || (fence.parentTaskId !== null && !validText(fence.parentTaskId))) return false
  const scheduled = fence.taskFenceMode === "scheduled_prepare"
  if (scheduled && (!validText(fence.turnLeaseOwnerId) || !positive(fence.turnLeaseVersion) || !positive(fence.rootAttemptCount))) return false
  const current = await client.query<Row>(CURRENT_TASK, [fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId,
    fence.parentTaskId, fence.leaseOwner, fence.attemptCount, jobId, scheduled ? "scheduled_prepare" : "selected_job",
    scheduled ? fence.turnLeaseOwnerId : null, scheduled ? fence.turnLeaseVersion : null,
    scheduled ? fence.rootAttemptCount : null])
  if (current.rows.length !== 1) return false
  if (scheduled) {
    const row = current.rows[0]
    if (row?.turnStatus === "waiting_for_dependency") {
      return await scheduledPrepareDependencyWaitIsCurrent(client, fence)
    }
    return row?.turnStatus === "in_progress"
  }
  if (fence.parentTaskId === null) return fence.taskId === fence.rootTaskId
  const parent = await client.query(
    `SELECT parent."id" FROM "sub_agent_tasks" AS parent WHERE parent."id" = $1 AND parent."sessionId" = $2
      AND parent."turnId" = $3 AND parent."rootTaskId" = $4 AND parent."status" NOT IN ${TERMINAL_TASK}
      AND parent."interruptRequestedAt" IS NULL FOR UPDATE`,
    [fence.parentTaskId, fence.sessionId, fence.turnId, fence.rootTaskId],
  )
  return parent.rows.length === 1
}

/** Rechecks child expiry and the same owner state immediately before commit. */
export async function artifactTaskLeaseIsLive(client: QueryClient, fence: AgentArtifactTaskFence): Promise<boolean> {
  if (fence.taskFenceMode === "scheduled_prepare"
    && !await artifactTaskFenceIsCurrent(client, fence, "scheduled_prepare_lease_recheck")) return false
  const result = await client.query<{ live: boolean }>(
    `SELECT task."leaseExpiresAt" > clock_timestamp() AS "live" FROM "sub_agent_tasks" task
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."leaseOwner" = $3 AND task."attemptCount" = $4
        AND task."status" = 'running' AND task."interruptRequestedAt" IS NULL`,
    [fence.taskId, fence.sessionId, fence.leaseOwner, fence.attemptCount],
  )
  return result.rows[0]?.live === true
}

async function scheduledPrepareDependencyWaitIsCurrent(client: QueryClient, fence: AgentArtifactTaskFence): Promise<boolean> {
  if (!positive(fence.rootAttemptCount) || !validText(fence.taskGraphItemId)
    || typeof fence.parseTaskGraphSnapshot !== "function") return false
  const graphRows = await client.query<Row>(
    `SELECT item."content" FROM "agent_items" AS item
      JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
      WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
        AND item."type" = 'task_graph' AND session."userId" = $5 AND session."status" = 'running'
        AND turn."userId" = $5 AND turn."status" = 'waiting_for_dependency' AND turn."leaseVersion" = $6
      FOR UPDATE OF item`,
    [fence.taskGraphItemId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.userId, fence.turnLeaseVersion],
  )
  if (graphRows.rows.length !== 1) return false
  let nodeIds
  try { nodeIds = parseIds(fence.parseTaskGraphSnapshot(graphRows.rows[0]?.content).nodes.map(node => node.taskId)) } catch { return false }
  if (!nodeIds) return false
  const waits = await client.query<Row>(
    `SELECT root."result" AS "rootResult", wait."id", wait."targetTaskIds", wait."mode", wait."status",
        wait."suspendedAt", wait."resolvedAt", wait."consumedAt", wait."result",
        step."taskId" AS "stepTaskId", step."status" AS "stepStatus", step."attempt", step."ordinal",
        (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId"
          AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt") AS "latestOrdinal"
      FROM "agent_wait_conditions" AS wait
      JOIN "sub_agent_tasks" AS root ON root."id" = wait."parentTaskId"
        AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
        AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."status" = 'waiting'
      JOIN "agent_steps" AS step ON step."id" = wait."stepId"
        AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId"
      WHERE wait."userId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4
        AND wait."consumedAt" IS NULL
      ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2 FOR UPDATE OF wait, step`,
    [fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId],
  )
  if (waits.rows.length !== 1) return false
  const rootResult = object(waits.rows[0]?.rootResult)
  if (!rootResult || !exactKeys(rootResult, "finalItemId,status,stepCount,toolCallCount,waitId")
    || rootResult.status !== "waiting_for_dependency" || rootResult.finalItemId !== null
    || !validCount(rootResult.stepCount) || !validCount(rootResult.toolCallCount) || !validText(rootResult.waitId)
    || !validWait(waits.rows[0], fence, rootResult.waitId)) return false
  const tasks = await client.query<Row>(
    `SELECT task."id", task."status" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $4 AND session."userId" = $5 FOR UPDATE OF task`,
    [nodeIds, fence.sessionId, fence.turnId, fence.rootTaskId, fence.userId],
  )
  if (tasks.rows.length !== nodeIds.length) return false
  const statusById = new Map(tasks.rows.map(row => [row.id, row.status]))
  if (statusById.size !== nodeIds.length) return false
  const targets = parseIds(waits.rows[0]?.targetTaskIds)
  if (!targets || !targets.includes(fence.taskId)) return false
  const pending = nodeIds.filter(taskId => !TERMINAL_GRAPH_TASKS.has(String(statusById.get(taskId))))
  return sameIds(targets, pending)
}

function validWait(row: Row | undefined, fence: AgentArtifactTaskFence, rootWaitId: string): boolean {
  if (!row || row.id !== rootWaitId || row.status !== "waiting" || row.mode !== "all" || row.suspendedAt == null
    || row.resolvedAt !== null || row.consumedAt !== null
    || (row.stepTaskId !== null && row.stepTaskId !== fence.rootTaskId) || row.stepStatus !== "waiting_for_tool"
    || !positive(Number(row.attempt)) || Number(row.attempt) !== fence.rootAttemptCount
    || !positive(Number(row.ordinal)) || Number(row.ordinal) !== Number(row.latestOrdinal)) return false
  const ids = parseIds(row.targetTaskIds), result = object(row.result), request = object(result?.request)
  const requestIds = parseIds(request?.targetTaskIds)
  return Boolean(ids && request && request.mode === "all" && exactKeys(request, "mode,targetTaskIds,timeoutMs")
    && Number.isSafeInteger(request.timeoutMs) && Number(request.timeoutMs) >= 1 && Number(request.timeoutMs) <= 86_400_000
    && requestIds && sameIds(ids, requestIds))
}

function parseIds(value: unknown): readonly string[] | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 11
    || parsed.some(id => !validText(id)) || new Set(parsed).size !== parsed.length) return null
  return parsed as string[]
}
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return null } }
function exactKeys(value: Row, expected: string): boolean { return Object.keys(value).sort().join(",") === expected }
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(id => right.includes(id))
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647 }
