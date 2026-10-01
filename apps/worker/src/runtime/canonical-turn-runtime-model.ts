import type { ModelAdapter } from "@jobcopilot/agent-model"
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
      const reservation = await authorize({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, stepId: requestStepId(request), leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, featureKey: "autoApply", provider: adapter.profile.provider, model: adapter.profile.model })
      let settled = false
      const settle = async (input: Parameters<UsageAuthorization["settle"]>[0]): Promise<void> => {
        if (settled) return
        settled = true
        await reservation.settle(input)
      }
      let inputTokens = 0
      let outputTokens = 0
      let estimatedCostUsd = 0
      try {
        for await (const event of adapter.stream(request)) {
          if (event.type === "usage") {
            inputTokens = event.inputTokens
            outputTokens = event.outputTokens
            estimatedCostUsd = event.estimatedCostUsd ?? 0
          }
          yield event
        }
        await settle({ status: "success", inputTokens, outputTokens, estimatedCostUsd })
      } catch (error: unknown) {
        await Promise.resolve(settle({ status: "error", inputTokens, outputTokens, estimatedCostUsd, errorCode: modelErrorCode(error) })).catch(() => undefined)
        throw error
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
