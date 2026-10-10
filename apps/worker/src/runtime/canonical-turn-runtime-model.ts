import type { HarnessModelRequest, ModelAdapter, ModelUsage } from "@jobcopilot/agent-model"
import type { HarnessModelRuntime } from "./harness-model.js"
import type { TurnLease } from "./turns/lease.js"

export type UsageAuthorization = {
  settle(input: { status: "success" | "error"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode?: string }): Promise<void> | void
  release?(): Promise<void> | void
}

export type UsageAuthorizationInput = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly leaseOwnerId: string
  readonly leaseVersion: number
  readonly featureKey: string
  readonly provider: string
  readonly model: string
}

export type UsageAuthorizer = (input: UsageAuthorizationInput) => Promise<UsageAuthorization> | UsageAuthorization

export type HarnessPreProviderRoute = Pick<ModelAdapter["profile"], "provider" | "model">
export type HarnessPreProviderHooks = {
  beforeProviderInvocation(route: HarnessPreProviderRoute): Promise<void> | void
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
    await hooks.beforeProviderInvocation(route)
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
        providerStarted: boolean
        inputTokens: number
        outputTokens: number
        estimatedCostUsd: number
        settlementStarted: boolean
        releaseStarted: boolean
        settlementUnknown: boolean
      }
      const attempts = new Map<string, Attempt>()
      let active: Attempt | undefined
      const routeKey = (route: HarnessPreProviderRoute) => `${route.provider}\u001f${route.model}`
      const interrupted = () => request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
      const settle = async (attempt: Attempt, input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
        if (attempt.settlementStarted || !attempt.authorization) return
        attempt.settlementStarted = true
        try { await attempt.authorization.settle(input) } catch (error: unknown) { attempt.settlementUnknown = true; throw error }
      }
      const release = async (attempt: Attempt): Promise<void> => {
        if (attempt.settlementStarted || attempt.releaseStarted || attempt.providerStarted || !attempt.authorization) return
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
          attempt = { route, providerStarted: false, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, settlementStarted: false, releaseStarted: false, settlementUnknown: false }
          attempts.set(key, attempt)
        }
        if (active && active !== attempt && active.providerStarted && !active.settlementStarted) {
          await settle(active, { status: "error", inputTokens: active.inputTokens, outputTokens: active.outputTokens, estimatedCostUsd: active.estimatedCostUsd, errorCode: "provider_rerouted" })
        }
        active = attempt
        attempt.authorizationPromise ??= Promise.resolve().then(() => authorize({
          userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request),
          leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply",
          provider: route.provider, model: route.model,
        })).then(value => { attempt!.authorization = value; return value })
        const value = await attempt.authorizationPromise
        if (request.signal.aborted) throw interrupted()
        return value
      }
      const deferAuthorization = isHarnessRoutedAdapter(adapter)
      const streamRequest = deferAuthorization
        ? withHarnessPreProviderHooks(request, {
          beforeProviderInvocation: route => authorizeRoute(route).then(() => undefined),
          providerInvocationStarted: () => { if (active) active.providerStarted = true },
          providerUsageObserved: (route, usage) => {
            const attempt = attempts.get(routeKey(route))
            if (!attempt) return
            attempt.inputTokens = usage.inputTokens
            attempt.outputTokens = usage.outputTokens
            attempt.estimatedCostUsd = usage.estimatedCostUsd ?? 0
          },
        })
        : request
      try {
        if (!deferAuthorization) await authorizeRoute(adapter.profile)
        if (request.signal.aborted) throw interrupted()
        if (!deferAuthorization && active) active.providerStarted = true
        for await (const event of adapter.stream(streamRequest)) {
          if (event.type === "usage" && active) {
            active.inputTokens = event.inputTokens
            active.outputTokens = event.outputTokens
            active.estimatedCostUsd = event.estimatedCostUsd ?? 0
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
        const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request), leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model })
        if (request.signal.aborted) {
          if (reservation.release) await reservation.release()
          throw request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
        }
        let settled = false
        const settle = async (input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
          if (settled) return
          settled = true
          await reservation.settle(input)
        }
        try {
          const result = await adapter.complete!(request)
          await settle({ status: "success", inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, estimatedCostUsd: result.usage?.estimatedCostUsd ?? 0 })
          return result
        } catch (error: unknown) {
          await Promise.resolve(settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: modelErrorCode(error) })).catch(() => undefined)
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
