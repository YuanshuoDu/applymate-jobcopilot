import { db } from '@/lib/db'

import { CONTEXT_COMPACTION_EVENT_TYPE, CONTEXT_COMPACTION_QUERY_LIMIT, projectContextCompactionRow, type ContextCompactionQueryRow } from './timeline-context-compaction'

const EVENT_SELECT = {
  id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
  type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true,
} as const

/** Reads only the bounded first-page compaction tail and returns display-safe envelopes. */
export async function recentTimelineContextCompactionEvents(sessionId: string) {
  const rows = await db.agentEvent.findMany({
    where: { sessionId, type: CONTEXT_COMPACTION_EVENT_TYPE }, orderBy: { sequence: 'desc' }, take: CONTEXT_COMPACTION_QUERY_LIMIT, select: EVENT_SELECT,
  }) as ContextCompactionQueryRow[]
  return rows.map(row => projectContextCompactionRow(row, sessionId))
    .filter((event): event is NonNullable<typeof event> => event !== null)
    .sort((left, right) => compareSequence(left.sequence, right.sequence) || left.id.localeCompare(right.id))
}

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left), rightValue = BigInt(right)
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1
}
