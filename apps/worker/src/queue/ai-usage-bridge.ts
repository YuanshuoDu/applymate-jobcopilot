export type WorkerUsageExecutionOwner =
  | { kind: "turn"; leaseOwnerId: string; leaseVersion: number }
  | { kind: "task"; taskId: string; rootTaskId: string; ownerId: string; attemptCount: number }

type WorkerUsageCommon = {
  userId: string
  featureKey: string
  turnId: string
  stepId: string
  provider: string
  model: string
  sessionId: string
  attemptId?: string
  requestedOutputTokens?: number
  startProtocolVersion?: 1
}

type WorkerLegacyTurnOwner = { executionOwner?: never; leaseOwnerId: string; leaseVersion: number }
type WorkerEnvelopedOwner = { executionOwner: WorkerUsageExecutionOwner; leaseOwnerId?: never; leaseVersion?: never }
export type WorkerUsageAuthorizationInput = WorkerUsageCommon & (WorkerLegacyTurnOwner | WorkerEnvelopedOwner)

export type WorkerUsageSettlementInput = {
  status: "success" | "error"
  inputTokens: number | null
  outputTokens: number | null
  estimatedCostUsd: number | null
  errorCode?: string
}

export type WorkerKnownUsageSettlementInput = Omit<WorkerUsageSettlementInput, "inputTokens" | "outputTokens" | "estimatedCostUsd"> & {
  inputTokens: number; outputTokens: number; estimatedCostUsd: number
}
export interface WorkerUsageAuthorization {
  outputReservationRequired?: boolean
  maxOutputTokens?: number | null
  start?(): Promise<number | null> | number | null
  release?(): Promise<void> | void
  settle(input: WorkerKnownUsageSettlementInput): Promise<void> | void
  settleUnknown?(input: WorkerUsageSettlementInput): Promise<void> | void
}

type UsageBridgeFetch = typeof fetch

export type WorkerUsageBridgeOptions = {
  endpointUrl?: string
  secret?: string
  fetch?: UsageBridgeFetch
  timeoutMs?: number
}

export class UsageBridgeError extends Error {
  constructor(readonly code: string, message = code, readonly retryable = false) {
    super(message)
    this.name = "UsageBridgeError"
  }
}

export async function settleWorkerUsage(authorization: WorkerUsageAuthorization, input: WorkerUsageSettlementInput): Promise<void> {
  if (input.inputTokens === null || input.outputTokens === null || input.estimatedCostUsd === null) {
    if (authorization.settleUnknown) return authorization.settleUnknown(input)
    throw new UsageBridgeError("usage_settlement_unknown")
  }
  await authorization.settle({ ...input, inputTokens: input.inputTokens, outputTokens: input.outputTokens, estimatedCostUsd: input.estimatedCostUsd })
}

export function resolveStartedOutput(
  authorization: Pick<WorkerUsageAuthorization, "outputReservationRequired" | "maxOutputTokens">,
  started: unknown,
  requestedOutputTokens?: number | null,
): number | null {
  if (authorization.outputReservationRequired !== true && authorization.outputReservationRequired !== false) {
    throw new UsageBridgeError("usage_start_unavailable")
  }
  const cap = authorization.maxOutputTokens
  if (authorization.outputReservationRequired === false) {
    if (cap != null || (started !== undefined && started !== null)) throw new UsageBridgeError("usage_start_conflict")
    return null
  }
  if (!Number.isSafeInteger(started) || Number(started) < 1 ||
      (typeof requestedOutputTokens === "number" && Number(started) > requestedOutputTokens) ||
      (typeof cap === "number" && Number(started) > cap) ||
      (authorization.outputReservationRequired === true && (typeof cap !== "number" || Number(started) !== cap))) {
    throw new UsageBridgeError(started === undefined ? "usage_start_unavailable" : started === null ? "output_reservation_unknown" : "usage_start_conflict")
  }
  return Number(started)
}

const USAGE_PATH = "/api/internal/agent-runtime/usage"
const RELEASE_RETRY_DELAYS_MS = [50, 100] as const

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
  if (!input.sessionId.trim()) throw new UsageBridgeError("usage_context_unavailable")
  const row = input as unknown as Record<string, unknown>
  const hasEnvelope = Object.prototype.hasOwnProperty.call(row, "executionOwner")
  const hasLegacy = Object.prototype.hasOwnProperty.call(row, "leaseOwnerId") || Object.prototype.hasOwnProperty.call(row, "leaseVersion")
  const hasTaskFields = ["taskId", "rootTaskId", "ownerId", "attemptCount"].some(key => Object.prototype.hasOwnProperty.call(row, key))
  if (hasTaskFields && (hasEnvelope || hasLegacy)) throw new UsageBridgeError("usage_context_unavailable")
  if (hasEnvelope === hasLegacy) throw new UsageBridgeError("usage_context_unavailable")
  if (hasEnvelope) {
    const owner = row.executionOwner as Record<string, unknown> | null
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw new UsageBridgeError("usage_context_unavailable")
    const hasTaskFields = ["taskId", "rootTaskId", "ownerId", "attemptCount"].some(key => Object.prototype.hasOwnProperty.call(owner, key))
    const hasTurnFields = ["leaseOwnerId", "leaseVersion"].some(key => Object.prototype.hasOwnProperty.call(owner, key))
    if (owner.kind === "turn" && !hasTaskFields && typeof owner.leaseOwnerId === "string" && owner.leaseOwnerId.trim() && Number.isSafeInteger(owner.leaseVersion) && Number(owner.leaseVersion) >= 0) return
    if (owner.kind === "task" && !hasTurnFields && typeof owner.taskId === "string" && owner.taskId.trim() && typeof owner.rootTaskId === "string" && owner.rootTaskId.trim() && typeof owner.ownerId === "string" && owner.ownerId.trim() && Number.isSafeInteger(owner.attemptCount) && Number(owner.attemptCount) >= 1) return
    throw new UsageBridgeError("usage_context_unavailable")
  }
  if (typeof row.leaseOwnerId !== "string" || !row.leaseOwnerId.trim() || !Number.isSafeInteger(row.leaseVersion) || Number(row.leaseVersion) < 0) {
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
    throw new UsageBridgeError("usage_broker_unavailable", undefined, true)
  }
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const row = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    const transient = response.status >= 500
    throw new UsageBridgeError(transient ? "usage_broker_unavailable" : safeCode(row.code, "usage_denied"), undefined, transient)
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

  const release = async (input: WorkerUsageAuthorizationInput): Promise<void> => {
    requiredContext(input)
    if (!endpoint || !secret || typeof fetcher !== "function") throw new UsageBridgeError("usage_authorization_unavailable")
    const protocolInput = { ...input, startProtocolVersion: 1 as const }
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await post(endpoint, secret, { operation: "release", input: protocolInput }, fetcher, timeoutMs)
        if (response.status !== "released") throw new UsageBridgeError("usage_broker_unavailable")
        return
      } catch (error: unknown) {
        const delay = RELEASE_RETRY_DELAYS_MS[attempt]
        if (!(error instanceof UsageBridgeError) || !error.retryable || delay === undefined) throw error
        await new Promise<void>(resolve => setTimeout(resolve, delay))
      }
    }
  }
  return async (input: WorkerUsageAuthorizationInput) => {
    requiredContext(input)
    if (!endpoint || !secret || typeof fetcher !== "function") throw new UsageBridgeError("usage_authorization_unavailable")
    const protocolInput = { ...input, startProtocolVersion: 1 as const }
    let response: Record<string, unknown>
    try {
      response = await post(endpoint, secret, { operation: "authorize", input: protocolInput }, fetcher, timeoutMs)
    } catch (error: unknown) {
      if (error instanceof UsageBridgeError && error.code === "usage_broker_unavailable") await release(input).catch(() => undefined)
      throw error
    }
    const operationId = response.operationId
    if (typeof operationId !== "string" || operationId.length < 1) {
      await release(input).catch(() => undefined)
      throw new UsageBridgeError("usage_broker_unavailable")
    }
    if (typeof response.outputReservationRequired !== "boolean" ||
        response.startProtocolVersion !== 1 ||
        !(response.maxOutputTokens === null || (Number.isSafeInteger(response.maxOutputTokens) && Number(response.maxOutputTokens) > 0)) ||
        (response.outputReservationRequired && response.maxOutputTokens === null) ||
        (!response.outputReservationRequired && response.maxOutputTokens !== null)) {
      await release(input).catch(() => undefined)
      throw new UsageBridgeError("usage_broker_unavailable")
    }
    const outputReservationRequired = response.outputReservationRequired
    const maxOutputTokens = response.maxOutputTokens === null ? null : Number(response.maxOutputTokens)
    let startCalled = false
    const settle = async (settlement: WorkerUsageSettlementInput): Promise<void> => {
      await post(endpoint, secret, {
        operation: "settle",
        input: { operationId, userId: input.userId, provider: input.provider, model: input.model, ...settlement },
      }, fetcher, timeoutMs)
    }
    return {
      outputReservationRequired,
      maxOutputTokens,
      settle,
      settleUnknown: settle,
      start: async () => {
        if (startCalled) throw new UsageBridgeError("usage_start_replayed")
        startCalled = true
        const started = await post(endpoint, secret, {
          operation: "start", input: { ...protocolInput, operationId },
        }, fetcher, timeoutMs)
        if (started.status !== "started" || started.startProtocolVersion !== 1 || started.outputReservationRequired !== outputReservationRequired ||
            started.maxOutputTokens !== maxOutputTokens) throw new UsageBridgeError("usage_start_conflict")
        if (outputReservationRequired && maxOutputTokens === null) throw new UsageBridgeError("output_reservation_unknown")
        return maxOutputTokens
      },
      release: () => release(input),
    }
  }
}
