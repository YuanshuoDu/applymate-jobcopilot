import { sendWorkerCommand } from './worker-client'

export type QueueSloSnapshot = { available: boolean; waiting: number; active: number; failed: number; stuck: number; deadLetter: number }

export async function getQueueSloSnapshot(): Promise<QueueSloSnapshot> {
  try {
    const result = await sendWorkerCommand({ requestId: `slo-${Date.now()}`, actorId: 'observability', action: 'queue_summary', reason: 'Evaluate queue service level indicators', params: {} })
    const queues = Array.isArray(result.queues) ? result.queues as Array<{ name?: unknown; counts?: Record<string, unknown>; stuckActiveCount?: unknown }> : []
    return queues.reduce<QueueSloSnapshot>((summary, queue) => {
      const counts = queue.counts ?? {}
      summary.waiting += Number(counts.waiting ?? 0)
      summary.active += Number(counts.active ?? 0)
      summary.failed += Number(counts.failed ?? 0)
      summary.stuck += Number(queue.stuckActiveCount ?? 0)
      if (queue.name === 'dead-letter') summary.deadLetter += Number(counts.waiting ?? 0)
      return summary
    }, { available: true, waiting: 0, active: 0, failed: 0, stuck: 0, deadLetter: 0 })
  } catch {
    return { available: false, waiting: 0, active: 0, failed: 0, stuck: 0, deadLetter: 0 }
  }
}
