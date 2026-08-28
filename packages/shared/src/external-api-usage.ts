import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import pg from 'pg'

type UsagePool = Pick<Pool, 'query'>
export type SharedExternalApiUsage = {
  provider: string
  operation: string
  credentialSource?: 'platform' | 'user' | 'public' | 'internal'
  status: 'success' | 'error'
  latencyMs: number
  httpStatus?: number
  errorCode?: string
  inputBytes?: number
  outputBytes?: number
}

export type ExternalApiErrorCode = 'http_429' | 'http_5xx' | 'http_4xx' | 'timeout' | 'network_error' | 'provider_error'
const EXTERNAL_API_ERROR_CODES = new Set<ExternalApiErrorCode>(['http_429', 'http_5xx', 'http_4xx', 'timeout', 'network_error', 'provider_error'])

let sharedPool: Pool | null = null

/** Record safe metadata for shared-package integrations without storing payloads or errors. */
export async function recordSharedExternalApiUsage(input: SharedExternalApiUsage, dependencies: { pool?: UsagePool } = {}): Promise<void> {
  if (process.env.NODE_ENV === 'test') return
  const pool = dependencies.pool ?? getPool()
  if (!pool) return
  await pool.query(
    `INSERT INTO external_api_usage_events (id, provider, operation, credential_source, request_count, input_bytes, output_bytes, estimated_cost_usd, latency_ms, status, http_status, error_code) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [randomUUID(), safeKey(input.provider), safeKey(input.operation), input.credentialSource ?? 'platform', nonNegativeInteger(input.inputBytes), nonNegativeInteger(input.outputBytes), estimateCost(input.provider), nonNegativeInteger(input.latencyMs), input.status, normalizedHttpStatus(input.httpStatus), normalizeExternalApiErrorCode(input),],
  ).catch(() => undefined)
}

/** Keep provider response bodies and unstable SDK messages out of the usage ledger. */
export function normalizeExternalApiErrorCode(input: Pick<SharedExternalApiUsage, 'status' | 'httpStatus' | 'errorCode'>): ExternalApiErrorCode | null {
  if (input.status !== 'error') return null
  const status = normalizedHttpStatus(input.httpStatus)
  if (status === 429) return 'http_429'
  if (status !== null && status >= 500) return 'http_5xx'
  if (status !== null && status >= 400) return 'http_4xx'
  const candidate = input.errorCode?.trim() as ExternalApiErrorCode | undefined
  return candidate && EXTERNAL_API_ERROR_CODES.has(candidate) ? candidate : 'provider_error'
}

export function sharedExternalApiErrorCode(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'timeout'
  if (error instanceof Error && error.name.toLowerCase() === 'timeouterror') return 'timeout'
  if (isStatusError(error)) {
    if (error.statusCode === 429) return 'http_429'
    if (error.statusCode >= 500) return 'http_5xx'
    if (error.statusCode >= 400) return 'http_4xx'
  }
  return error instanceof TypeError ? 'network_error' : 'provider_error'
}

function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL?.trim()
  if (!connectionString) return null
  if (!sharedPool) sharedPool = new pg.Pool({ connectionString, max: 1 })
  return sharedPool
}

function safeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80) || 'unknown'
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizedHttpStatus(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

function estimateCost(provider: string): number {
  const key = `EXTERNAL_API_COST_PER_REQUEST_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const value = Number(process.env[key] ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function isStatusError(value: unknown): value is { statusCode: number } {
  return Boolean(value && typeof value === 'object' && 'statusCode' in value && typeof (value as { statusCode?: unknown }).statusCode === 'number')
}
