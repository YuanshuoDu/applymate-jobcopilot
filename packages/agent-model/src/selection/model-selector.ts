import type { ModelUsage } from "@jobcopilot/agent-protocol"
import {
  AgentModelError,
  isAgentModelError,
  type ModelErrorDescriptor,
} from "../errors.js"
import type {
  ModelAdapter,
  ModelCapabilityRequirement,
} from "../contracts.js"
import type { ModelAdapterResolver, ModelTarget } from "../registry.js"

export const MAX_MODEL_REROUTES = 2

export interface ModelRouteCandidate {
  target: ModelTarget
  requirement?: ModelCapabilityRequirement
  reason?: string
}

export interface ModelInvocationResult<T> {
  value: T
  usage?: ModelUsage | null
}

export type ModelSelectionEvent =
  | {
      type: "model.attempt"
      attempt: number
      provider: string
      model: string
      status: "started" | "succeeded" | "failed"
      failure?: ModelErrorDescriptor
      rerouteBlocked?: boolean
    }
  | {
      type: "model.rerouted"
      attempt: number
      from: { provider: string; model: string }
      to: { provider: string; model: string }
      reason: string
      failure: ModelErrorDescriptor
    }
  | {
      type: "model.usage"
      attempt: number
      provider: string
      model: string
      usage: ModelUsage | null
    }

export interface ModelFallbackOptions {
  irreversibleActionStarted?: boolean | (() => boolean)
  maxReroutes?: number
  onEvent?: (event: ModelSelectionEvent) => void
}

export interface ModelFallbackResult<T> {
  value: T
  adapter: ModelAdapter
  attempt: number
  events: readonly ModelSelectionEvent[]
}

export async function executeWithModelFallback<T>(
  resolver: ModelAdapterResolver,
  candidates: readonly ModelRouteCandidate[],
  invoke: (adapter: ModelAdapter, attempt: number) => Promise<ModelInvocationResult<T>>,
  options: ModelFallbackOptions = {},
): Promise<ModelFallbackResult<T>> {
  if (candidates.length === 0) throw new AgentModelError({
    code: "adapter_not_found", message: "At least one model route candidate is required", recoverable: false,
  })
  const events: ModelSelectionEvent[] = []
  const configuredMaxReroutes = options.maxReroutes ?? MAX_MODEL_REROUTES
  const maxReroutes = Number.isSafeInteger(configuredMaxReroutes)
    ? Math.max(0, Math.min(configuredMaxReroutes, MAX_MODEL_REROUTES))
    : MAX_MODEL_REROUTES
  let lastFailure: AgentModelError | undefined
  for (let index = 0; index < candidates.length && index <= maxReroutes; index += 1) {
    const candidate = candidates[index]
    const attempt = index + 1
    let adapter: ModelAdapter
    try {
      adapter = resolver.resolve(candidate.target, candidate.requirement)
    } catch (error) {
      const failure = normalizeFailure(error, candidate.target)
      const blocked = rerouteBlocked(options)
      emitAttempt(events, options, candidate.target, attempt, "failed", failure, blocked)
      lastFailure = failure
      if (!shouldReroute(failure, index, candidates.length, maxReroutes, blocked)) throw failure
      const nextCandidate = candidates[index + 1]
      emitReroute(events, options, candidate.target, nextCandidate.target, attempt + 1, failure, nextCandidate.reason)
      continue
    }

    emitAttempt(events, options, candidate.target, attempt, "started")
    try {
      const result = await invoke(adapter, attempt)
      emitAttempt(events, options, candidate.target, attempt, "succeeded")
      emit(events, options, {
        type: "model.usage", attempt, provider: candidate.target.provider, model: candidate.target.model,
        usage: result.usage ?? null,
      })
      return { value: result.value, adapter, attempt, events }
    } catch (error) {
      const failure = normalizeFailure(error, candidate.target)
      const blocked = rerouteBlocked(options)
      emitAttempt(events, options, candidate.target, attempt, "failed", failure, blocked)
      lastFailure = failure
      if (!shouldReroute(failure, index, candidates.length, maxReroutes, blocked)) throw failure
      emitReroute(events, options, candidate.target, candidates[index + 1].target, attempt + 1, failure, candidates[index + 1].reason)
    }
  }

  throw lastFailure ?? new AgentModelError({
    code: "provider_error", message: "Model fallback routes were exhausted", recoverable: false,
  })
}

function emitAttempt(
  events: ModelSelectionEvent[],
  options: ModelFallbackOptions,
  target: ModelTarget,
  attempt: number,
  status: "started" | "succeeded" | "failed",
  failure?: AgentModelError,
  blocked = false,
): void {
  emit(events, options, {
    type: "model.attempt", attempt, provider: target.provider, model: target.model, status,
    ...(failure ? { failure: failure.descriptor() } : {}),
    ...(blocked ? { rerouteBlocked: true } : {}),
  })
}

function emitReroute(
  events: ModelSelectionEvent[],
  options: ModelFallbackOptions,
  from: ModelTarget,
  to: ModelTarget,
  attempt: number,
  failure: AgentModelError,
  reason?: string,
): void {
  emit(events, options, {
    type: "model.rerouted", attempt,
    from: { provider: from.provider, model: from.model },
    to: { provider: to.provider, model: to.model },
    reason: reason ?? failure.message,
    failure: failure.descriptor(),
  })
}

function emit(events: ModelSelectionEvent[], options: ModelFallbackOptions, event: ModelSelectionEvent): void {
  events.push(event)
  options.onEvent?.(event)
}

function shouldReroute(
  failure: AgentModelError,
  index: number,
  candidateCount: number,
  maxReroutes: number,
  blocked: boolean,
): boolean {
  if (index >= candidateCount - 1 || index >= maxReroutes) return false
  if (blocked) return false
  return failure.retryable || failure.code === "unsupported_capability" || failure.code === "adapter_not_found" || failure.code === "cursor_lost"
}

function rerouteBlocked(options: ModelFallbackOptions): boolean {
  if (typeof options.irreversibleActionStarted !== "function") return options.irreversibleActionStarted === true
  try {
    return options.irreversibleActionStarted()
  } catch {
    return true
  }
}

function normalizeFailure(error: unknown, target: ModelTarget): AgentModelError {
  if (isAgentModelError(error)) {
    if (error.provider && error.model) return error
    return new AgentModelError({
      code: error.code,
      message: error.message,
      provider: error.provider ?? target.provider,
      model: error.model ?? target.model,
      retryable: error.retryable,
      recoverable: error.recoverable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    })
  }
  return new AgentModelError({
    code: "provider_error", message: error instanceof Error ? error.message : "Model invocation failed",
    provider: target.provider, model: target.model, retryable: true, recoverable: true,
  })
}
