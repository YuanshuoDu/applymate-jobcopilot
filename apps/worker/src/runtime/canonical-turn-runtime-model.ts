import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import type { HarnessModelRuntime } from "./harness-model.js"
import type { TurnLease } from "./turns/lease.js"

export type UsageAuthorization = {
  settle(input: { status: "success" | "error"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; errorCode?: string }): Promise<void> | void
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
): Promise<void> {
  const hooks = (request as HarnessHookedRequest)[HARNESS_PRE_PROVIDER_HOOKS]
  if (!hooks) return
  try {
    await hooks.beforeProviderInvocation(route)
    hooks.providerInvocationStarted()
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
      let reservation: UsageAuthorization | undefined
      let authorizationPromise: Promise<UsageAuthorization> | undefined
      const authorizeRoute = (route: HarnessPreProviderRoute): Promise<UsageAuthorization> => {
        authorizationPromise ??= Promise.resolve().then(() => authorize({
          userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request),
          leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply",
          provider: route.provider, model: route.model,
        })).then(value => { reservation = value; return value })
        return authorizationPromise
      }
      const deferAuthorization = isHarnessRoutedAdapter(adapter)
      if (!deferAuthorization) await authorizeRoute(adapter.profile)
      let settled = false, providerStarted = false
      const settle = async (input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
        if (settled || !reservation) return
        settled = true
        await reservation.settle(input)
      }
      let inputTokens = 0
      let outputTokens = 0
      let estimatedCostUsd = 0
      const streamRequest = deferAuthorization
        ? withHarnessPreProviderHooks(request, { beforeProviderInvocation: route => authorizeRoute(route).then(() => undefined), providerInvocationStarted: () => { providerStarted = true } })
        : request
      try {
        if (!deferAuthorization) providerStarted = true
        for await (const event of adapter.stream(streamRequest)) {
          if (event.type === "usage") {
            inputTokens = event.inputTokens
            outputTokens = event.outputTokens
            estimatedCostUsd = event.estimatedCostUsd ?? 0
          }
          yield event
        }
        await settle({ status: "success", inputTokens, outputTokens, estimatedCostUsd })
      } catch (error: unknown) {
        if (reservation) await Promise.resolve(settle({ status: "error", inputTokens, outputTokens, estimatedCostUsd, errorCode: modelErrorCode(error) })).catch(() => undefined)
        throw error
      } finally {
        if (providerStarted && reservation && !settled) {
          await settle({
            status: "error", inputTokens, outputTokens, estimatedCostUsd,
            errorCode: "model_stream_interrupted",
          })
        }
      }
    },
    ...(adapter.complete ? {
      async complete(request: Parameters<NonNullable<ModelAdapter["complete"]>>[0]) {
        const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request), leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model })
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
