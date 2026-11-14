import type { HarnessModelRequest, ModelAdapter, ModelUsage } from "@jobcopilot/agent-model"
import { hasSharedAiPrice } from "@jobcopilot/shared"
import { resolveStartedOutput, settleWorkerUsage, type WorkerUsageAuthorization, type WorkerUsageAuthorizationInput, type WorkerUsageSettlementInput } from "../queue/ai-usage-bridge.js"
import type { HarnessModelRuntime } from "./harness-model.js"
import type { TurnLease } from "./turns/lease.js"

export type UsageAuthorization = WorkerUsageAuthorization
export type UsageAuthorizationInput = WorkerUsageAuthorizationInput
export type UsageAuthorizer = (input: UsageAuthorizationInput) => Promise<UsageAuthorization> | UsageAuthorization

export type HarnessPreProviderRoute = Pick<ModelAdapter["profile"], "provider" | "model" | "defaultMaxOutputTokens">
export type HarnessPreProviderHooks = {
  beforeProviderInvocation(route: HarnessPreProviderRoute): Promise<number | null> | number | null
  providerInvocationStarted(): void
  providerUsageObserved(route: HarnessPreProviderRoute, usage: ModelUsage): void
}

const HARNESS_ROUTED_ADAPTER: unique symbol = Symbol("harness-routed-adapter")
const HARNESS_PRE_PROVIDER_HOOKS: unique symbol = Symbol("harness-pre-provider-hooks")
type HarnessRoutedAdapter = ModelAdapter & { readonly [HARNESS_ROUTED_ADAPTER]?: true }
type HarnessHookedRequest = HarnessModelRequest & { readonly [HARNESS_PRE_PROVIDER_HOOKS]?: HarnessPreProviderHooks }

export function markHarnessRoutedAdapter<T extends ModelAdapter>(adapter: T): T & { readonly [HARNESS_ROUTED_ADAPTER]: true } {
  return Object.assign(adapter, { [HARNESS_ROUTED_ADAPTER]: true as const })
}

export function isHarnessRoutedAdapter(adapter: ModelAdapter): boolean {
  return (adapter as HarnessRoutedAdapter)[HARNESS_ROUTED_ADAPTER] === true
}

/** Enumerable symbols preserve this request-scoped hook through privacy wrappers that use object spread. */
export function withHarnessPreProviderHooks(request: HarnessModelRequest, hooks: HarnessPreProviderHooks): HarnessModelRequest {
  return { ...request, [HARNESS_PRE_PROVIDER_HOOKS]: hooks } as HarnessHookedRequest
}

export async function runHarnessPreProviderHooks(
  request: HarnessModelRequest,
  route: HarnessPreProviderRoute,
  onFailure: () => void,
): Promise<(usage: ModelUsage) => void> {
  const hooks = (request as HarnessHookedRequest)[HARNESS_PRE_PROVIDER_HOOKS]
  if (!hooks) return () => undefined
  try {
    const admittedOutputTokens = await hooks.beforeProviderInvocation(route)
    if (admittedOutputTokens !== null) request.maxOutputTokens = admittedOutputTokens
    if (request.signal.aborted) throw request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
    hooks.providerInvocationStarted()
    return usage => hooks.providerUsageObserved(route, usage)
  } catch (error: unknown) {
    onFailure()
    throw error
  }
}

function modelErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.trim()) return error.code
  return "model_error"
}

type ObservedUsage = { inputTokens: number; outputTokens: number; estimatedCostUsd?: number }

function knownCost(usage: ObservedUsage | null | undefined, provider: string, model: string): number | null {
  const cost = usage?.estimatedCostUsd ?? null
  const observedTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  return cost === 0 && observedTokens > 0 && !hasSharedAiPrice(provider, model) ? null : cost
}

function requestStepId(request: { readonly metadata: { readonly stepId?: unknown } }): string {
  return typeof request.metadata.stepId === "string" ? request.metadata.stepId : "unknown-step"
}

export function modelWithUsage(runtime: HarnessModelRuntime, lease: TurnLease, authorize: UsageAuthorizer): ModelAdapter {
  const adapter = runtime.adapter
  return {
    ...adapter,
    async *stream(request) {
      type Attempt = {
        route: HarnessPreProviderRoute
        authorization?: UsageAuthorization
        authorizationPromise?: Promise<UsageAuthorization>
        admittedOutputTokens: number | null
        providerStarted: boolean
        startClaimed: boolean
        inputTokens: number | null
        outputTokens: number | null
        estimatedCostUsd: number | null
        settlementStarted: boolean
        releaseStarted: boolean
        settlementUnknown: boolean
      }
      const attempts = new Map<string, Attempt>()
      let active: Attempt | undefined
      const routeKey = (route: HarnessPreProviderRoute) => `${route.provider}\u001f${route.model}`
      const interrupted = () => request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
      const settle = async (attempt: Attempt, input: WorkerUsageSettlementInput): Promise<void> => {
        if (attempt.settlementStarted || !attempt.authorization) return
        attempt.settlementStarted = true
        try { await settleWorkerUsage(attempt.authorization, input) } catch (error: unknown) { attempt.settlementUnknown = true; throw error }
      }
      const release = async (attempt: Attempt): Promise<void> => {
        if (attempt.settlementStarted || attempt.releaseStarted || attempt.startClaimed || attempt.providerStarted || !attempt.authorization) return
        attempt.releaseStarted = true
        if (!attempt.authorization.release) { attempt.settlementUnknown = true; throw new Error("usage_release_unavailable") }
        try { await attempt.authorization.release() } catch (error: unknown) { attempt.settlementUnknown = true; throw error }
      }
      const finishAttempts = async (errorCode: string): Promise<void> => {
        for (const attempt of attempts.values()) {
          if (attempt.providerStarted && !attempt.settlementStarted) {
            await settle(attempt, { status: "error", inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, estimatedCostUsd: attempt.estimatedCostUsd, errorCode })
          } else if (!attempt.providerStarted) await release(attempt)
        }
      }
      const authorizeRoute = async (route: HarnessPreProviderRoute): Promise<UsageAuthorization> => {
        if (request.signal.aborted) throw interrupted()
        const key = routeKey(route)
        let attempt = attempts.get(key)
        if (!attempt) {
          attempt = { route, admittedOutputTokens: null, providerStarted: false, startClaimed: false, inputTokens: null, outputTokens: null, estimatedCostUsd: null, settlementStarted: false, releaseStarted: false, settlementUnknown: false }
          attempts.set(key, attempt)
        }
        if (active && active !== attempt && active.providerStarted && !active.settlementStarted) {
          await settle(active, { status: "error", inputTokens: active.inputTokens, outputTokens: active.outputTokens, estimatedCostUsd: active.estimatedCostUsd, errorCode: "provider_rerouted" })
        }
        active = attempt
        const requestedOutputTokens = request.maxOutputTokens ?? route.defaultMaxOutputTokens
        attempt.authorizationPromise ??= Promise.resolve().then(() => authorize({
          userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request),
          leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply",
          provider: route.provider, model: route.model, attemptId: "route-1",
          ...(requestedOutputTokens == null ? {} : { requestedOutputTokens }),
        })).then(value => { attempt!.authorization = value; return value })
        const value = await attempt.authorizationPromise
        if (request.signal.aborted) throw interrupted()
        return value
      }
      const startRoute = async (attempt: Attempt): Promise<number | null> => {
        if (!attempt.authorization || attempt.startClaimed) throw Object.assign(new Error("usage_start_replayed"), { code: "usage_start_replayed" })
        const authorization = attempt.authorization
        const requested = request.maxOutputTokens ?? attempt.route.defaultMaxOutputTokens
        if (!authorization.start) {
          attempt.admittedOutputTokens = resolveStartedOutput(authorization, undefined, requested)
          attempt.startClaimed = true
          return attempt.admittedOutputTokens
        }
        attempt.startClaimed = true
        attempt.admittedOutputTokens = resolveStartedOutput(authorization, await authorization.start(), requested)
        return attempt.admittedOutputTokens
      }
      const deferAuthorization = isHarnessRoutedAdapter(adapter)
      const streamRequest = deferAuthorization
        ? withHarnessPreProviderHooks(request, {
          beforeProviderInvocation: async route => {
            await authorizeRoute(route)
            const attempt = attempts.get(routeKey(route))
            if (!attempt) throw new Error("usage_authorization_unavailable")
            const admitted = await startRoute(attempt)
            return admitted
          },
          providerInvocationStarted: () => { if (active) active.providerStarted = true },
          providerUsageObserved: (route, usage) => {
            const attempt = attempts.get(routeKey(route))
            if (!attempt) return
            attempt.inputTokens = usage.inputTokens
            attempt.outputTokens = usage.outputTokens
            attempt.estimatedCostUsd = knownCost(usage, route.provider, route.model)
          },
        })
        : request
      try {
        if (!deferAuthorization) await authorizeRoute(adapter.profile)
        if (request.signal.aborted) throw interrupted()
        let directRequest = streamRequest
        if (!deferAuthorization && active) {
          directRequest = { ...request }
          const admitted = await startRoute(active)
          if (admitted !== null) directRequest.maxOutputTokens = admitted
          if (request.signal.aborted) throw interrupted()
          active.providerStarted = true
        }
        for await (const event of adapter.stream(directRequest)) {
          if (event.type === "usage" && active) {
            active.inputTokens = event.inputTokens
            active.outputTokens = event.outputTokens
            active.estimatedCostUsd = knownCost(event, active.route.provider, active.route.model)
          }
          yield event
        }
        if (active) await settle(active, { status: "success", inputTokens: active.inputTokens, outputTokens: active.outputTokens, estimatedCostUsd: active.estimatedCostUsd })
      } catch (error: unknown) {
        await finishAttempts(modelErrorCode(error))
        throw error
      } finally {
        await finishAttempts("model_stream_interrupted")
      }
    },
    ...(adapter.complete ? {
      async complete(request: Parameters<NonNullable<ModelAdapter["complete"]>>[0]) {
        if (request.signal.aborted) throw request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
        const requestedOutputTokens = request.maxOutputTokens ?? adapter.profile.defaultMaxOutputTokens
        const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request), leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model, attemptId: "route-1", ...(requestedOutputTokens == null ? {} : { requestedOutputTokens }) })
        if (request.signal.aborted) {
          if (reservation.release) await reservation.release()
          throw request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
        }
        let startClaimed = false
        const start = async (): Promise<number | null> => {
          if (startClaimed) throw Object.assign(new Error("usage_start_replayed"), { code: "usage_start_replayed" })
          const requested = request.maxOutputTokens ?? adapter.profile.defaultMaxOutputTokens
          if (!reservation.start) {
            const admitted = resolveStartedOutput(reservation, undefined, requested)
            startClaimed = true
            return admitted
          }
          startClaimed = true
          return resolveStartedOutput(reservation, await reservation.start(), requested)
        }
        let settled = false
        const settle = async (input: WorkerUsageSettlementInput): Promise<void> => {
          if (settled) return
          settled = true
          await settleWorkerUsage(reservation, input)
        }
        try {
          const admitted = await start()
          const providerRequest = { ...request, ...(admitted === null ? {} : { maxOutputTokens: admitted }) }
          if (request.signal.aborted) throw request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
          const result = await adapter.complete!(providerRequest)
          await settle({ status: "success", inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null, estimatedCostUsd: knownCost(result.usage, adapter.profile.provider, adapter.profile.model) })
          return result
        } catch (error: unknown) {
          if (startClaimed) await Promise.resolve(settle({ status: "error", inputTokens: null, outputTokens: null, estimatedCostUsd: null, errorCode: modelErrorCode(error) })).catch(() => undefined)
          else if (reservation.release) await Promise.resolve(reservation.release()).catch(() => undefined)
          throw error
        }
      },
    } : {}),
  }
}

export function defaultAuthorization(): never {
  const error = new Error("usage_authorization_unavailable")
  Object.assign(error, { code: "usage_authorization_unavailable" })
  throw error
}
