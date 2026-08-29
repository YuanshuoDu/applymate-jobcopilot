/**
 * POST /api/agent/scout — trigger automated job discovery for the current user.
 *
 * Enqueues a scout-tasks job that fetches new jobs from Greenhouse and Lever,
 * filters by the user's target roles, and inserts matching jobs into the DB.
 *
 * Rate-limited to one scout run per user per 24 hours via Redis TTL key,
 * with BullMQ jobId dedup as defense-in-depth against race conditions.
 */
import { NextRequest } from 'next/server'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const SCOUT_QUEUE_NAME = 'scout-tasks'
const COOLDOWN_SECONDS = 86_400 // 24 hours
// Keep this key aligned with the Worker control plane. A paused Worker must
// not accumulate Scout jobs that cannot be processed until a later resume.
const WORKER_RUNTIME_STATE_KEY = 'admin-control:worker-runtime-state'

interface ScoutTaskPayload {
  userId: string
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'job_discovery')
  if (isErrorResponse(auth)) return auth

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null })
  const scoutQueue = new Queue<ScoutTaskPayload>(SCOUT_QUEUE_NAME, { connection })

  try {
    const runtimeState = await connection.get(WORKER_RUNTIME_STATE_KEY)
    if (isWorkerPaused(runtimeState)) {
      return err('Automatic Scout is currently off. Search Jobs remains available.', 409)
    }

    const cooldownKey = `scout:cooldown:${auth.userId}`
    const existing = await connection.get(cooldownKey)
    if (existing) {
      const ttl = await connection.ttl(cooldownKey)
      return err(
        `Scout already ran recently. Next run available in ${Math.ceil(ttl / 3600)} hours.`,
        409,
      )
    }

    const jobId = `scout:${auth.userId}`
    await scoutQueue.add('scout', { userId: auth.userId }, {
      jobId,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    })

    // Set 24h cooldown after successful enqueue
    await connection.set(cooldownKey, Date.now().toString(), 'EX', COOLDOWN_SECONDS)

    return ok({ queued: true })
  } catch (e) {
    console.error('[scout-api] Failed to enqueue scout task:', e)
    return err('Failed to enqueue scout task', 500)
  } finally {
    await scoutQueue.close()
    connection.disconnect()
  }
}

function isWorkerPaused(raw: string | null): boolean {
  if (!raw) return false
  try {
    const state = JSON.parse(raw) as { status?: unknown }
    return state.status === 'paused'
  } catch {
    return false
  }
}
