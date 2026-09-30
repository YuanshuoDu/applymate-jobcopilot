import { randomUUID } from "node:crypto"

import { isTerminalSubagentStatus, SubagentLimitError, type SubagentPolicy, type SubagentTaskRecord, type SubagentTaskSpec } from "./types.js"
import { actionList, asObject, INSERT_TASK, json, rowToTask, SELECT_TASK, type Queryable } from "./pg-store-persistence.js"

export async function readSubagentTask(client: Queryable, taskId: string, sessionId: string): Promise<SubagentTaskRecord> {
  const result = await client.query(SELECT_TASK, [taskId, sessionId])
  if (!result.rows[0]) throw new Error("Subagent task disappeared")
  return rowToTask(result.rows[0] as Record<string, unknown>)
}

export async function lockSubagentSession(client: Queryable, input: { sessionId: string; userId: string }): Promise<void> {
  const session = await client.query(`SELECT "id", "status" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [input.sessionId, input.userId])
  const sessionStatus = String(session.rows[0]?.status ?? "")
  if (!session.rows[0] || sessionStatus === "aborted" || sessionStatus === "archived") throw new Error("Session is unavailable")
}

export async function createSubagentTask(
  client: Queryable,
  input: SubagentTaskSpec & { policy: SubagentPolicy },
  sessionLocked = false,
): Promise<SubagentTaskRecord> {
  if (!sessionLocked) await lockSubagentSession(client, input)
  const parent = input.parentTaskId
    ? await client.query(`SELECT "id", "rootTaskId", "path", "depth", "status", "allowedActions", "modelProfileSnapshot", "budgetSnapshot", "toolPolicySnapshot"
         FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [input.parentTaskId, input.sessionId])
    : { rows: [] }
  if (input.parentTaskId && !parent.rows[0]) throw new Error("Parent task is unavailable")
  const parentRow = parent.rows[0] as Record<string, unknown> | undefined
  if (parentRow && isTerminalSubagentStatus(String(parentRow.status))) throw new Error("Parent task is terminal")
  const depth = parentRow ? Number(parentRow.depth) + 1 : 0
  if (depth > input.policy.maxDepth) throw new SubagentLimitError("depth", "Subagent depth limit reached")
  if (input.parentTaskId) {
    const children = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "parentTaskId" = $2
        AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.sessionId, input.parentTaskId])
    if (Number(children.rows[0]?.count ?? 0) >= input.policy.maxFanOut) throw new SubagentLimitError("fan_out", "Subagent fan-out limit reached")
  }
  const id = `subagent-${randomUUID()}`
  const rootTaskId = parentRow ? String(parentRow.rootTaskId ?? input.parentTaskId) : id
  const path = parentRow ? `${String(parentRow.path).replace(/\/$/, "")}/${id}` : `/${id}`
  // Tree step limits are shared through AgentTreeBudgetReservation; copying
  // the parent snapshot here would create a second spendable allowance.
  const budget = { subagentPolicy: input.policy }
  const toolPolicy = parentRow ? asObject(parentRow.toolPolicySnapshot) : asObject(input.toolPolicySnapshot)
  const inheritedModel = parentRow?.modelProfileSnapshot
  const modelProfile = parentRow ? (inheritedModel ?? input.modelProfileSnapshot ?? {}) : (input.modelProfileSnapshot ?? {})
  const parentActions = parentRow ? actionList(parentRow.allowedActions) : []
  const requestedActions = actionList(input.allowedActions)
  if (parentRow && requestedActions.some(action => !parentActions.includes(action))) throw new Error("Child allowed actions exceed parent policy")
  const allowedActions = parentRow && requestedActions.length === 0 ? parentActions : requestedActions
  const result = await client.query(`${INSERT_TASK} RETURNING "id"`, [
    id, input.sessionId, input.turnId ?? null, rootTaskId, input.parentTaskId ?? null, path, depth,
    input.role, input.taskType, input.goal, json(input.constraints, []), json(input.successCriteria, []),
    json(allowedActions, []), json(input.context, {}), json(input.expectedOutputSchema, {}),
    json(modelProfile, {}, "model_profile"), json(toolPolicy, {}, "tool_policy"), json(budget, {}, "budget"), input.policy.maxAttempts,
  ])
  if (!result.rows[0]?.id) throw new Error("Subagent task insert failed")
  return readSubagentTask(client, String(result.rows[0].id), input.sessionId)
}
