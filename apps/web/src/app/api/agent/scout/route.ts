/**
 * POST /api/agent/scout — trigger automated job discovery for the current user.
 *
 * Enqueues a scout-tasks job that fetches new jobs from Greenhouse and Lever,
 * filters by the user's target roles, and inserts matching jobs into the DB.
 */
import { NextRequest } from 'next/server'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const SCOUT_QUEUE_NAME = 'scout-tasks'

interface ScoutTaskPayload {
  userId: string
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })
  const scoutQueue = new Queue<ScoutTaskPayload>(SCOUT_QUEUE_NAME, { connection })

  try {
    await scoutQueue.add('scout', { userId: auth.userId }, {
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    })
    return ok({ queued: true })
  } catch (e) {
    console.error('[scout-api] Failed to enqueue scout task:', e)
    return err('Failed to enqueue scout task', 500)
  } finally {
    await scoutQueue.close()
    connection.disconnect()
  }
}
