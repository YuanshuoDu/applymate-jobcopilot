import { pinnedFetch, type PinnedFetchOptions } from '@jobcopilot/shared'
import { db } from '@/lib/db'
import { isExternalApiProvider } from './external-api-catalog'

export type ExternalApiCredentialSource = 'platform' | 'user' | 'public' | 'internal'
export type ExternalApiRequestMeta = { provider: string; operation: string; credentialSource: ExternalApiCredentialSource; userId?: string }
type UsageRecord = ExternalApiRequestMeta & { requestCount: number; inputBytes: number; outputBytes: number; estimatedCostUsd: number; latencyMs: number; status: 'success' | 'error'; httpStatus?: number; errorCode?: string }
type Dependencies = { request?: typeof pinnedFetch; create?: (input: UsageRecord) => Promise<void> }

/** Fetch and persist only safe numeric/status metadata; bodies and URLs are never stored. */
export async function trackedExternalApiFetch(url: string | URL, init: PinnedFetchOptions, meta: ExternalApiRequestMeta, dependencies: Dependencies = {}): Promise<Response> {
  const request = dependencies.request ?? pinnedFetch
  const create = dependencies.create ?? persistUsage
  const startedAt = Date.now()
  const inputBytes = bodySize(init.body)
  try {
    const response = await request(url, init)
    await create({ ...safeMeta(meta), requestCount: 1, inputBytes, outputBytes: headerSize(response.headers), estimatedCostUsd: estimateCost(meta.provider), latencyMs: Date.now() - startedAt, status: response.ok ? 'success' : 'error', httpStatus: response.status, ...(response.ok ? {} : { errorCode: classifyHttp(response.status) }) })
    return response
  } catch (error) {
    await create({ ...safeMeta(meta), requestCount: 1, inputBytes, outputBytes: 0, estimatedCostUsd: estimateCost(meta.provider), latencyMs: Date.now() - startedAt, status: 'error', errorCode: classifyError(error) })
    throw error
  }
}

function safeMeta(meta: ExternalApiRequestMeta): ExternalApiRequestMeta { return { provider: isExternalApiProvider(meta.provider) ? meta.provider : 'unknown', operation: safeKey(meta.operation, 'request'), credentialSource: meta.credentialSource, userId: meta.userId?.slice(0, 120) } }
function safeKey(value: string, fallback: string): string { const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80); return normalized || fallback }
function bodySize(body: unknown): number { if (typeof body === 'string') return new TextEncoder().encode(body).byteLength; if (body instanceof Uint8Array) return body.byteLength; if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength; return 0 }
function headerSize(headers: Headers): number { const value = Number(headers.get('content-length') ?? 0); return Number.isSafeInteger(value) && value > 0 ? value : 0 }
function estimateCost(provider: string): number { const key = `EXTERNAL_API_COST_PER_REQUEST_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`; const value = Number(process.env[key] ?? 0); return Number.isFinite(value) && value > 0 ? value : 0 }
function classifyHttp(status: number): string { return status === 429 ? 'http_429' : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'provider_error' }
function classifyError(error: unknown): string { return error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : error instanceof TypeError ? 'network_error' : 'provider_error' }
async function persistUsage(input: UsageRecord): Promise<void> { if (process.env.NODE_ENV === 'test' || typeof db.externalApiUsageEvent?.create !== 'function') return; await db.externalApiUsageEvent.create({ data: { ...input, requestCount: 1, inputBytes: Math.max(0, Math.trunc(input.inputBytes)), outputBytes: Math.max(0, Math.trunc(input.outputBytes)), estimatedCostUsd: Math.max(0, input.estimatedCostUsd), latencyMs: Math.max(0, Math.trunc(input.latencyMs)) } }).catch(() => undefined) }
