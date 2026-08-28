import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { normalizeExternalApiErrorCode } from '@jobcopilot/shared'

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
  await input.pool.query(`INSERT INTO external_api_usage_events (id, user_id, provider, operation, credential_source, request_count, input_bytes, output_bytes, estimated_cost_usd, latency_ms, status, http_status, error_code) VALUES ($1, $2, $3, $4, 'platform', 1, $5, $6, $7, $8, $9, $10, $11)`, [randomUUID(), input.userId ?? null, safeKey(input.provider), safeKey(input.operation), nonNegativeInteger(input.inputBytes), nonNegativeInteger(input.outputBytes), estimateCost(input.provider), nonNegativeInteger(input.latencyMs), input.status, normalizedHttpStatus(input.httpStatus), normalizeExternalApiErrorCode(input)]).catch(() => undefined)
}

/** Measure response metadata without retaining or logging the response body. */
export async function measureWorkerResponseBytes(response: Response): Promise<number> {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isSafeInteger(contentLength) && contentLength > 0) return contentLength
  try {
    return (await response.clone().arrayBuffer()).byteLength
  } catch {
    return 0
  }
}

function safeKey(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80) || 'unknown' }
function estimateCost(provider: string): number { const value = Number(process.env[`EXTERNAL_API_COST_PER_REQUEST_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? 0); return Number.isFinite(value) && value > 0 ? value : 0 }
function nonNegativeInteger(value: number | undefined): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0 }
function normalizedHttpStatus(value: number | undefined): number | null { return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null }
