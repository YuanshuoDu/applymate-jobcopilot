/** Automated job discovery via Greenhouse and Lever public APIs. */
import { Queue, Worker } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/apply-results.js'
import { isUserActive } from '../db/application-task-state.js'
import { isWorkerFeatureEnabled } from '../admin/runtime-feature-flags.js'
import { workerPollingOptions } from './worker-polling-options.js'
import { discoverGreenhouseJobs, discoverLeverJobs, type DiscoveredJob } from './scout-discovery.js'
import { loadEnabledAtsSlugs } from './ats-registry.js'
import { redisConnection } from '../redis.js'

const connection = redisConnection

export const SCOUT_QUEUE_NAME = 'scout-tasks'

export interface ScoutTaskPayload {
  userId: string
}

export const scoutQueue = new Queue<ScoutTaskPayload>(SCOUT_QUEUE_NAME, { connection, skipVersionCheck: true })

const GREENHOUSE_STAGED_FALLBACK = [
  'n26', 'personio', 'contentful', 'deliveroo', 'zalando', 'spotify', 'revolut', 'klarna', 'checkout', 'stripe',
  'datadog', 'figma', 'airtable', 'notion', 'vercel', 'hubspot', 'gitlab', 'databricks', 'snowflake', 'confluent',
]
const LEVER_STAGED_FALLBACK = [
  'spotify', 'klarna', 'tiermobility', 'n26', 'deliveroo', 'monzo', 'revolut', 'checkout', 'wefox', 'tradeRepublic',
  'personio', 'zalando', 'deliveryHero', 'bolt', 'northvolt',
]

export const scoutWorker = new Worker<ScoutTaskPayload>(
  SCOUT_QUEUE_NAME,
  async job => {
    const { userId } = job.data
    const pool = getPool()
    const startedAt = Date.now()
    if (!await isUserActive(pool, userId)) {
      return { skipped: true, reason: 'account-inactive' }
    }
    try {
      if (!await isWorkerFeatureEnabled(pool, 'worker_discovery', userId)) {
        return { skipped: true, reason: 'feature-disabled' }
      }
    } catch (error) {
      console.warn('[scout-worker] Platform feature control unavailable', { error: error instanceof Error ? error.message : String(error) })
      return { skipped: true, reason: 'feature-control-unavailable' }
    }
    const configResult = await pool.query(
      'SELECT "targetRoles", "targetLocations" FROM "AgentConfig" WHERE "userId" = $1',
      [userId],
    )
    const config = configResult.rows[0] as { targetRoles?: string[]; targetLocations?: string[] } | undefined
    if (!config?.targetRoles?.length) {
      console.log('[scout-worker] User %s has no target roles configured -- skipping', userId)
      return { skipped: true, reason: 'no-target-roles' }
    }

    let greenhouseSlugs: string[]
    let leverSlugs: string[]
    try {
      [greenhouseSlugs, leverSlugs] = await Promise.all([
        loadEnabledAtsSlugs(pool, 'greenhouse', GREENHOUSE_STAGED_FALLBACK),
        loadEnabledAtsSlugs(pool, 'lever', LEVER_STAGED_FALLBACK),
      ])
    } catch (error) {
      console.warn('[scout-worker] ATS registry unavailable', { error: error instanceof Error ? error.message : String(error) })
      return { skipped: true, reason: 'ats-registry-unavailable' }
    }
    const existingResult = await pool.query('SELECT url FROM "Job" WHERE "userId" = $1 AND url IS NOT NULL', [userId])
    const existingUrls = new Set<string>(existingResult.rows.map((row: { url: string }) => row.url).filter(Boolean))
    const [greenhouseJobs, leverJobs] = await Promise.all([
      discoverGreenhouseJobs({ pool, redis: connection, userId, slugs: greenhouseSlugs }),
      discoverLeverJobs({ pool, redis: connection, userId, slugs: leverSlugs }),
    ])
    const discovered = [...greenhouseJobs, ...leverJobs]
    const matching = discovered.filter(job => matchesRole(job, config.targetRoles!, existingUrls))
    let inserted = 0
    for (const job of matching) {
      if (existingUrls.has(job.url)) continue
      try {
        await pool.query(
          'INSERT INTO "Job" ("id", "userId", "company", "role", "location", "url", "description", "salary", "logo", "source", "status") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING',
          [randomUUID(), userId, job.company, job.title, job.location || null, job.url, job.description || null, job.salary, job.logo ?? job.company.slice(0, 2).toUpperCase(), job.source, 'saved'],
        )
        existingUrls.add(job.url)
        inserted += 1
      } catch (error) {
        console.warn('[scout-worker] Failed to insert job %s: %s', job.url, String(error))
      }
    }
    const durationMs = Date.now() - startedAt
    console.log('[scout-worker] User %s: %d discovered, %d matching, %d inserted, %dms', userId, discovered.length, matching.length, inserted, durationMs)
    return { discovered: discovered.length, matching: matching.length, inserted, duplicates: discovered.length - matching.length, durationMs }
  },
  { connection, skipVersionCheck: true, ...workerPollingOptions(), concurrency: 1 },
)

function matchesRole(job: DiscoveredJob, targetRoles: string[], existingUrls: Set<string>): boolean {
  if (!job.url || existingUrls.has(job.url) || !job.title || !job.company) return false
  const title = job.title.toLowerCase()
  return targetRoles.some(role => {
    const normalized = role.toLowerCase()
    return title.includes(normalized) || normalized.split(/\s+/).every(word => title.includes(word))
  })
}
