import { Queue, type Worker, type Job } from 'bullmq'
import { Redis } from 'ioredis'

export const DEAD_LETTER_QUEUE_NAME = 'dead-letter'
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })

export type DeadLetterRecord = {
  sourceQueue: string
  sourceJobId: string
  name: string
  attemptsMade: number
  failedReason: string
  failedAt: number
  userId?: string
}

export const deadLetterQueue = new Queue<DeadLetterRecord>(DEAD_LETTER_QUEUE_NAME, { connection })

function safeUserId(job: Job<unknown>): string | undefined {
  const data = job.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const value = (data as Record<string, unknown>).userId
  return typeof value === 'string' && value.length <= 200 ? value : undefined
}

export async function recordDeadLetter(queueName: string, job: Job<unknown>, error: Error): Promise<void> {
  const record: DeadLetterRecord = {
    sourceQueue: queueName,
    sourceJobId: String(job.id),
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: error.message.slice(0, 1000),
    failedAt: Date.now(),
    userId: safeUserId(job),
  }
  await deadLetterQueue.add('dead-lettered-job', record, {
    jobId: `${queueName}:${job.id}`,
    removeOnComplete: false,
    removeOnFail: false,
  })
}

export function registerDeadLetterListeners(workers: Array<{ name: string; worker: Worker }>): void {
  for (const { name, worker } of workers) {
    worker.on('failed', (job, error) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return
      void recordDeadLetter(name, job as Job<unknown>, error).catch((recordError) => {
        console.error('[worker] Failed to record dead-letter job', { queue: name, jobId: job.id, error: recordError })
      })
    })
  }
}

export async function closeDeadLetterResources(): Promise<void> {
  await deadLetterQueue.close()
  connection.disconnect()
}
