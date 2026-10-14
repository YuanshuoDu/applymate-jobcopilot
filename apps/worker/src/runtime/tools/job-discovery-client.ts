export type JobDiscoveryCriteria = Readonly<{
  targetRoles: readonly string[]
  targetLocations: readonly string[]
  source?: string
  pageSize?: number
  cursor?: string
}>

export type JobDiscoveryRequest = JobDiscoveryCriteria & Readonly<{
  userId: string
  sessionId: string
  turnId: string
  stepId: string
  toolCallId: string
  taskId: string
  rootTaskId: string
  role: "scout"
  leaseOwner: string
  attemptCount: number
}>

export type JobDiscoveryOutput = Readonly<{
  jobs: readonly Readonly<{
    id: string; title: string; company: string; location: string; url: string
    description: string; fullDescription: string; salary: string | null; logo: string | null
    source: string; evidenceRefs: readonly string[]
  }>[]
  evidence: readonly Readonly<{
    evidenceId: string; jobId: string; kind: "source" | "enrichment" | "analysis" | "comparison"
    source: string; url: string; summary: string
  }>[]
  nextCursor: string | null
  usage: Readonly<{
    ledgerKey: string; toolName: string; toolVersion: string; toolCallId: string
    sessionId: string; turnId: string; stepId: string; requests: number
    jobsProcessed: number; jobsSucceeded: number; jobsFailed: number; providerFailures?: number
    aiCalls: number; providers: readonly string[]; estimatedCostUsd: number; durationMs: number
  }>
}>

export type JobDiscoveryUsageSummary = Readonly<{
  requests: number
  jobsProcessed: number
  jobsSucceeded: number
  jobsFailed: number
  providerFailures?: number
  providers: readonly string[]
  estimatedCostUsd: number
  durationMs: number
}>

export class JobDiscoveryClientError extends Error {
  constructor(readonly code: string, readonly usage?: JobDiscoveryUsageSummary) {
    super(code)
    this.name = "JobDiscoveryClientError"
  }
}

export type JobDiscoveryClient = Readonly<{
  discover(request: JobDiscoveryRequest, signal: AbortSignal): Promise<JobDiscoveryOutput>
}>

export type JobDiscoveryClientOptions = Readonly<{
  endpointUrl?: string
  secret?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
}>

const DISCOVERY_PATH = "/api/internal/agent-runtime/discovery/search"
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

function endpointFromEnvironment(): string | undefined {
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim()
  if (!base) return undefined
  try {
    const url = new URL(`${base.replace(/\/$/, "")}${DISCOVERY_PATH}`)
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.toString() : undefined
  } catch { return undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function responseErrorCode(value: unknown): string {
  const code = isRecord(value) && isRecord(value.error) ? value.error.code : undefined
  return typeof code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(code) ? code : "job_discovery_failed"
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function responseUsageSummary(value: unknown): JobDiscoveryUsageSummary | undefined {
  const usage = isRecord(value) && isRecord(value.usage) ? value.usage : undefined
  if (!usage) return undefined
  const { requests, jobsProcessed, jobsSucceeded, jobsFailed, providerFailures, estimatedCostUsd, durationMs } = usage
  const rawProviders = usage.providers
  if (!isNonNegativeInteger(requests) || !isNonNegativeInteger(jobsProcessed) || !isNonNegativeInteger(jobsSucceeded)
    || !isNonNegativeInteger(jobsFailed) || !isNonNegativeInteger(durationMs)
    || (providerFailures !== undefined && !isNonNegativeInteger(providerFailures))
    || typeof estimatedCostUsd !== "number" || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0
    || !Array.isArray(rawProviders) || rawProviders.length > 32) return undefined

  const providerValues: readonly unknown[] = rawProviders
  const providers: string[] = []
  for (const provider of providerValues) {
    if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(provider)) return undefined
    providers.push(provider)
  }

  return {
    requests,
    jobsProcessed,
    jobsSucceeded,
    jobsFailed,
    ...(providerFailures === undefined ? {} : { providerFailures }),
    providers: [...new Set(providers)],
    estimatedCostUsd,
    durationMs,
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new JobDiscoveryClientError("job_discovery_response_too_large")
      }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  catch { throw new JobDiscoveryClientError("job_discovery_response_invalid") }
}

export function createJobDiscoveryClient(options: JobDiscoveryClientOptions = {}): JobDiscoveryClient {
  const endpoint = options.endpointUrl?.trim() || endpointFromEnvironment()
  const secret = options.secret?.trim() || process.env.AGENT_WORKER_SECRET?.trim()
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new RangeError("Invalid discovery timeout")
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) throw new RangeError("Invalid discovery response limit")

  return {
    async discover(request, signal) {
      if (!endpoint || !secret || typeof fetcher !== "function") throw new JobDiscoveryClientError("job_discovery_unavailable")
      if (signal.aborted) throw new JobDiscoveryClientError("cancelled")
      const controller = new AbortController()
      let cancelled = false
      let timedOut = false
      const onAbort = () => { cancelled = true; controller.abort() }
      signal.addEventListener("abort", onAbort, { once: true })
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      try {
        const response = await fetcher(endpoint, {
          method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": secret },
          body: JSON.stringify(request), cache: "no-store", redirect: "error", signal: controller.signal,
        })
        if (cancelled || signal.aborted) throw new JobDiscoveryClientError("cancelled")
        const length = response.headers.get("content-length")
        if (length && /^\d+$/.test(length) && Number(length) > maxResponseBytes) throw new JobDiscoveryClientError("job_discovery_response_too_large")
        const body = await readBoundedText(response, maxResponseBytes)
        if (cancelled || signal.aborted) throw new JobDiscoveryClientError("cancelled")
        let payload: unknown
        try { payload = JSON.parse(body) as unknown }
        catch { throw new JobDiscoveryClientError("job_discovery_response_invalid") }
        if (!response.ok) throw new JobDiscoveryClientError(responseErrorCode(payload), responseUsageSummary(payload))
        if (!isRecord(payload)) throw new JobDiscoveryClientError("job_discovery_response_invalid")
        return payload as JobDiscoveryOutput
      } catch (error: unknown) {
        if (cancelled || signal.aborted) throw new JobDiscoveryClientError("cancelled")
        if (timedOut) throw new JobDiscoveryClientError("timeout")
        if (error instanceof JobDiscoveryClientError) throw error
        throw new JobDiscoveryClientError("job_discovery_unavailable")
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
      }
    },
  }
}
