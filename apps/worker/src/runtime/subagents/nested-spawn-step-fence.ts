import { SubagentLeaseError } from "./types.js"
import type { ParentExecutionStepFence, SubagentParentExecutionFence } from "./parent-execution-fence.js"
import type { Queryable } from "./pg-store-persistence.js"

function lost(): never {
  throw new SubagentLeaseError("lost", "Parent tool step is no longer current")
}

export function captureParentExecutionStepFence(value: unknown): ParentExecutionStepFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return lost()
  const row = value as Record<string, unknown>
  if (Object.getPrototypeOf(row) !== Object.prototype
    || Object.keys(row).sort().join(",") !== "stepId,toolCallId"
    || typeof row.stepId !== "string" || !row.stepId.trim() || row.stepId.length > 256
    || typeof row.toolCallId !== "string" || !row.toolCallId.trim() || row.toolCallId.length > 256) return lost()
  return Object.freeze({ stepId: row.stepId, toolCallId: row.toolCallId })
}

export async function assertCurrentParentExecutionStep(
  client: Queryable,
  parent: SubagentParentExecutionFence,
): Promise<void> {
  if (!parent.step) return
  const step = captureParentExecutionStepFence(parent.step)
  const result = await client.query<{ id: string }>(`SELECT step."id"
    FROM "agent_steps" AS step
    JOIN "agent_items" AS item ON item."stepId" = step."id" AND item."sessionId" = step."sessionId"
      AND item."turnId" = step."turnId" AND item."taskId" = step."taskId"
    WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
      AND step."attempt" = $5 AND step."status" IN ('streaming', 'waiting_for_tool')
      AND item."type" = 'tool_call' AND item."status" = 'started'
      AND item."content"->>'toolCallId' = $6 AND item."content"->>'toolName' = 'scout.delegate'
      AND item."content"->>'toolVersion' = '1'
    FOR UPDATE OF step, item`, [step.stepId, parent.sessionId, parent.turnId, parent.id, parent.attemptCount, step.toolCallId])
  if (result.rows.length !== 1) return lost()
}
