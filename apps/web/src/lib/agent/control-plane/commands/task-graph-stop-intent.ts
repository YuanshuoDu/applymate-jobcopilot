import type { CommandTransaction } from "./transaction"

const TASK_GRAPH_STOP_OUTBOX_TOPIC = "agent.task-graph.stop"

export async function enqueueTaskGraphStopIntent(
  tx: CommandTransaction,
  scope: { sessionId: string; turnId: string },
): Promise<void> {
  await tx.agentOutbox.createMany({
    data: [{
      id: `task-graph-stop-${scope.turnId}`,
      topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
      aggregateId: scope.sessionId,
      idempotencyKey: `agent-task-graph-stop:${scope.sessionId}:${scope.turnId}`,
      payload: { sessionId: scope.sessionId, turnId: scope.turnId },
    }],
    skipDuplicates: true,
  })
}
