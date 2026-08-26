import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

export type WorkerExternalApiUsage = {
  pool: Pick<Pool, 'query'>
  userId?: string
  provider: string
  operation: string
  status: 'success' | 'error'
  latencyMs: number
  httpStatus?: number
  inputBytes?: number
  outputBytes?: number
  errorCode?: string
}

/** Best-effort worker-side accounting; never stores email bodies or provider errors. */
export async function recordWorkerExternalApiUsage(input: WorkerExternalApiUsage): Promise<void> {
  await input.pool.query(`INSERT INTO external_api_usage_events (id, user_id, provider, operation, credential_source, request_count, input_bytes, output_bytes, estimated_cost_usd, latency_ms, status, http_status, error_code) VALUES ($1, $2, $3, $4, 'platform', 1, $5, $6, $7, $8, $9, $10, $11)`, [randomUUID(), input.userId ?? null, safeKey(input.provider), safeKey(input.operation), Math.max(0, Math.trunc(input.inputBytes ?? 0)), Math.max(0, Math.trunc(input.outputBytes ?? 0)), estimateCost(input.provider), Math.max(0, Math.trunc(input.latencyMs)), input.status, input.httpStatus ?? null, input.errorCode ?? null]).catch(() => undefined)
}

function safeKey(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80) || 'unknown' }
function estimateCost(provider: string): number { const value = Number(process.env[`EXTERNAL_API_COST_PER_REQUEST_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? 0); return Number.isFinite(value) && value > 0 ? value : 0 }
