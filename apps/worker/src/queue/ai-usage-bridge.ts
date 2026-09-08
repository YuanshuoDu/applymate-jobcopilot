export type WorkerUsageAuthorizationInput = {
  userId: string
  featureKey: string
  turnId: string
  stepId: string
  provider: string
  model: string
  sessionId: string
  leaseOwnerId: string
  leaseVersion: number
  attemptId?: string
}

export type WorkerUsageSettlementInput = {
  status: "success" | "error"
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  errorCode?: string
}

export type WorkerUsageAuthorization = {
  settle(input: WorkerUsageSettlementInput): Promise<void>
}

type UsageBridgeFetch = typeof fetch

export type WorkerUsageBridgeOptions = {
  endpointUrl?: string
  secret?: string
  fetch?: UsageBridgeFetch
  timeoutMs?: number
}

export class UsageBridgeError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = "UsageBridgeError"
  }
}

const USAGE_PATH = "/api/internal/agent-runtime/usage"

function endpointFromEnvironment(): string | undefined {
  // AGENT_RUNTIME_USAGE_URL is the complete internal endpoint. The other
  // variables follow the existing Worker -> Web base URL convention.
  const direct = process.env.AGENT_RUNTIME_USAGE_URL?.trim()
  if (direct) return direct
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim()
  return base ? `${base.replace(/\/$/, "")}${USAGE_PATH}` : undefined
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : fallback
}

function requiredContext(input: WorkerUsageAuthorizationInput): void {
  if (!input.sessionId.trim() || !input.leaseOwnerId.trim() || !Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 0) {
    throw new UsageBridgeError("usage_context_unavailable")
  }
}

async function post(
  endpoint: string,
  secret: string,
  body: unknown,
  fetcher: UsageBridgeFetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-worker-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new UsageBridgeError("usage_broker_unavailable")
  }
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const row = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    throw new UsageBridgeError(response.status >= 500 ? "usage_broker_unavailable" : safeCode(row.code, "usage_denied"))
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new UsageBridgeError("usage_broker_unavailable")
  return payload as Record<string, unknown>
}

/** Bridge Worker model calls to the Web entitlement and usage authority. */
export function createWorkerUsageAuthorizer(options: WorkerUsageBridgeOptions = {}) {
  const endpoint = options.endpointUrl?.trim() || endpointFromEnvironment()
  const secret = options.secret?.trim() || process.env.AGENT_WORKER_SECRET?.trim()
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Usage bridge timeout must be positive")

  return async (input: WorkerUsageAuthorizationInput): Promise<WorkerUsageAuthorization> => {
    requiredContext(input)
    if (!endpoint || !secret || typeof fetcher !== "function") throw new UsageBridgeError("usage_authorization_unavailable")
    const response = await post(endpoint, secret, { operation: "authorize", input }, fetcher, timeoutMs)
    const operationId = response.operationId
    if (typeof operationId !== "string" || operationId.length < 1) throw new UsageBridgeError("usage_broker_unavailable")
    return {
      settle: async (settlement) => {
        await post(endpoint, secret, {
          operation: "settle",
          input: { operationId, userId: input.userId, provider: input.provider, model: input.model, ...settlement },
        }, fetcher, timeoutMs)
      },
    }
  }
}
