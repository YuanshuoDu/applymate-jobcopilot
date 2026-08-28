import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

type Queryable = Pick<Pool, 'query'>

export async function recordWorkerJobApiUsage(input: {
  pool: Queryable
  userId: string
  provider: 'greenhouse' | 'lever'
  latencyMs: number
  status: 'success' | 'error'
  httpStatus?: number
  jobsReturned?: number
}): Promise<void> {
  try {
    await input.pool.query(
      `INSERT INTO job_api_usage_events
        (id, user_id, provider, operation, credential_source, request_count, jobs_returned,
         latency_ms, status, http_status, runtime, created_at)
       VALUES ($1, $2, $3, 'list', 'public', 1, $4, $5, $6, $7, 'worker', NOW())`,
      [randomUUID(), input.userId, input.provider, Math.max(0, Math.trunc(input.jobsReturned ?? 0)),
       Math.max(0, Math.trunc(input.latencyMs)), input.status, input.httpStatus ?? null],
    )
  } catch {
    // Usage tracking is fail-open and never blocks discovery.
  }
}
