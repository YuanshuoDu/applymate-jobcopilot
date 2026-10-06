import { randomUUID } from "node:crypto"

import type { CommandTransaction } from "./transaction"

export const TASK_INTERRUPT_OUTBOX_TOPIC = "agent.subagent.task-interrupt"

export function taskInterruptOutboxKey(sessionId: string, clientMessageId: string): string {
  return `agent-task-interrupt:${sessionId}:${clientMessageId}`
}

export function taskInterruptAcceptedEventKey(sessionId: string, clientMessageId: string): string {
  return `agent-task-interrupt-accepted:${sessionId}:${clientMessageId}`
}

export async function enqueueTaskInterruptIntent(
  tx: CommandTransaction,
  input: { sessionId: string; turnId: string; taskId: string; intentId: string; clientMessageId: string },
): Promise<void> {
  await tx.agentOutbox.create({
    data: {
      id: randomUUID(),
      topic: TASK_INTERRUPT_OUTBOX_TOPIC,
      aggregateId: input.sessionId,
      idempotencyKey: taskInterruptOutboxKey(input.sessionId, input.clientMessageId),
      payload: { sessionId: input.sessionId, turnId: input.turnId, taskId: input.taskId, intentId: input.intentId },
    },
  })
}
