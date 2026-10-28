import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { isScheduledAutomationTurn } from "./scheduled-automation-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"

const MAX_SCHEDULED_SCOUTS = 4
type Node = Readonly<{ templateId: string }>

/** Caps the resulting active snapshot, after replacement has filtered retired nodes. */
export async function scheduledScoutPlanCapacityAllowed(
  client: Queryable,
  scope: Pick<TaskGraphExecutionScope, "userId" | "sessionId" | "turnId">,
  nodes: readonly Node[],
): Promise<boolean> {
  if (nodes.filter(node => node.templateId === "scout").length <= MAX_SCHEDULED_SCOUTS) return true
  const result = await client.query<{ source: unknown; executionMode: unknown; input: unknown }>(
    `SELECT "source", "executionMode", "input" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
    [scope.turnId, scope.sessionId, scope.userId],
  )
  if (result.rows.length !== 1) return false
  const turn = result.rows[0]!
  return turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
    || !isScheduledAutomationTurn(turn.source, turn.input)
}
