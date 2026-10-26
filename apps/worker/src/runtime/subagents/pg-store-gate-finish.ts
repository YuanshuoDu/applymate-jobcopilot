import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { parseScheduledGateRegistrationReceipt, readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import type { Queryable } from "./pg-store-persistence.js"

export async function lockScheduledGateFinish(client: Queryable, task: Record<string, unknown>, input: {
  taskId: string; sessionId: string; ownerId: string; attemptCount: number
}): Promise<boolean> {
  const userId = String(task.userId), turnId = String(task.turnId), rootTaskId = String(task.rootTaskId)
  if (task.parentTaskId !== rootTaskId || task.role !== SCHEDULED_GATE_ROLE) return false
  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`, [turnId, input.sessionId, userId])
  const root = await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
    AND "rootTaskId" = $1 AND "parentTaskId" IS NULL FOR UPDATE`, [rootTaskId, input.sessionId, turnId])
  const gate = await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
    AND "rootTaskId" = $4 AND "parentTaskId" = $4 AND "role" = $5 AND "taskType" = $6
    AND "status" = 'running' AND "leaseOwner" = $7 AND "attemptCount" = $8
    AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
    AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NULL FOR UPDATE`,
  [input.taskId, input.sessionId, turnId, rootTaskId, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, input.ownerId, input.attemptCount])
  if (turn.rows.length !== 1 || root.rows.length !== 1 || gate.rows.length !== 1) return false
  const event = await client.query(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
    AND "type" = 'agent.plan.scheduled_gate_binding' AND "payload"->>'gateTaskId' = $3`, [input.sessionId, turnId, input.taskId])
  const receipt = event.rows.length === 1 && parseScheduledGateRegistrationReceipt(event.rows[0]?.payload)
  if (!receipt || receipt.gateTaskId !== input.taskId) return false
  const registered = await readScheduledGateRegistrationReceipt(client, { userId, sessionId: input.sessionId, turnId,
    owner: receipt.owner, gateTaskId: input.taskId })
  if (!registered) return false
  const execution = await client.query(`SELECT "id" FROM "agent_executions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
    AND "status" = 'running' AND "attemptCount" = $4 FOR UPDATE`,
  [registered.owner.executionId, userId, input.sessionId, registered.owner.executionAttemptCount])
  return execution.rows.length === 1
}