import type { HarnessModelRequest, ModelAdapter, ModelResponse, ModelStreamEvent } from "@jobcopilot/agent-model"

import type { WorkerUsageAuthorizationInput, WorkerUsageAuthorization, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../subagents/tree-budget-types.js"
import { ContextEstimateExceededError } from "./model-request-admission.js"
import { isHarnessRoutedAdapter, withHarnessPreProviderHooks, type HarnessPreProviderRoute } from "../canonical-turn-runtime-model.js"

export type UsageAwareModelOptions = {
  readonly owner: ExecutionOwnerFence
  readonly authorize: (input: WorkerUsageAuthorizationInput) => Promise<WorkerUsageAuthorization> | WorkerUsageAuthorization
  /** Omit for the legacy root path; child execution must provide this explicitly. */
  readonly treeBudget?: TreeBudgetReservationStore
  readonly featureKey?: string
}

function authInput(owner: ExecutionOwnerFence, stepId: string, adapter: HarnessPreProviderRoute, featureKey: string): WorkerUsageAuthorizationInput {
  const common = {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, stepId,
    featureKey, provider: adapter.provider, model: adapter.model,
    attemptId: owner.kind === "task" ? `${owner.taskId}:${owner.attemptCount}` : `${owner.turnId}:1`,
  }
  return owner.kind === "task"
    ? { ...common, executionOwner: { kind: "task", taskId: owner.taskId, rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, attemptCount: owner.attemptCount } }
    : { ...common, leaseOwnerId: owner.ownerId, leaseVersion: owner.leaseVersion }
}

function reservationInput(owner: ExecutionOwnerFence, stepId: string) {
  if (owner.kind !== "task") return null
  return {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, taskId: owner.taskId, stepId,
    attempt: owner.attemptCount, idempotencyKey: `model-step:${owner.taskId}:${owner.attemptCount}:${stepId}`,
  }
}

function settlement(reservation: TreeBudgetReservation, status: "consumed" | "released"): Parameters<TreeBudgetReservationStore["settle"]>[0] {
  return { ...reservation, status }
}

function usage(value: ModelResponse["usage"] | null | undefined): WorkerUsageSettlementInput {
  return {
    status: "success", inputTokens: value?.inputTokens ?? 0, outputTokens: value?.outputTokens ?? 0,
    estimatedCostUsd: value?.estimatedCostUsd ?? 0,
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "model_error"
}

async function runAuthorized<T>(
  options: UsageAwareModelOptions,
  request: { metadata: { stepId: string } },
  adapter: ModelAdapter,
  run: (request: HarnessModelRequest, markProviderAttempted: () => void, settleUsage: (value: ModelResponse["usage"]) => Promise<void>) => Promise<T>,
  deferAuthorization = false,
): Promise<T> {
  const input = reservationInput(options.owner, request.metadata.stepId)
  const reservation = input && options.treeBudget ? await options.treeBudget.reserve(input) : null
  let treeSettlementStarted = false
  const settleTree = async (status: "consumed" | "released"): Promise<void> => {
    if (!reservation || !options.treeBudget || treeSettlementStarted) return
    treeSettlementStarted = true
    await options.treeBudget.settle(settlement(reservation, status))
  }
  let authorization: WorkerUsageAuthorization | undefined
  let authorizationPromise: Promise<WorkerUsageAuthorization> | undefined
  const authorizeRoute = (route: HarnessPreProviderRoute): Promise<WorkerUsageAuthorization> => {
    authorizationPromise ??= Promise.resolve().then(() => options.authorize(
      authInput(options.owner, request.metadata.stepId, route, options.featureKey ?? "autoApply"),
    )).then(value => { authorization = value; return value })
    return authorizationPromise
  }
  if (!deferAuthorization) {
    try { await authorizeRoute(adapter.profile) }
    catch (error: unknown) {
      await settleTree("released").catch(() => undefined)
      throw error
    }
  }
  let providerAttempted = false
  let accountSettlementStarted = false
  let accountSettlementUnknown = false
  const settleUsage = async (value: ModelResponse["usage"]): Promise<void> => {
    if (accountSettlementStarted) return
    accountSettlementStarted = true
    if (!authorization) throw new Error("usage_authorization_unavailable")
    try { await authorization.settle({ ...usage(value), status: "success" }) }
    catch (error: unknown) { accountSettlementUnknown = true; throw error }
  }
  const settleError = async (error: unknown): Promise<void> => {
    if (accountSettlementStarted || !authorization) return
    accountSettlementStarted = true
    try {
      await authorization.settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: errorCode(error) })
    } catch { accountSettlementUnknown = true }
  }
  const authorizedRequest = deferAuthorization
    ? withHarnessPreProviderHooks(request as HarnessModelRequest, {
      beforeProviderInvocation: route => authorizeRoute(route).then(() => undefined),
      providerInvocationStarted: () => { providerAttempted = true },
    })
    : request as HarnessModelRequest
  try {
    const result = await run(authorizedRequest, () => { providerAttempted = true }, settleUsage)
    await settleTree("consumed")
    return result
  } catch (error: unknown) {
    if (!accountSettlementStarted) {
      await settleError(error)
    }
    // An unknown account settlement keeps the reserved row active. That
    // blocks a free retry while a later reconciliation can settle it safely.
    if (!accountSettlementUnknown) {
      const providerAttemptedForReservation = error instanceof ContextEstimateExceededError
        ? !error.guaranteedNoProviderAttempt : providerAttempted
      if (providerAttemptedForReservation) await settleTree("consumed").catch(() => undefined)
      else await settleTree("released").catch(() => undefined)
    }
    throw error
  }
}

export function createUsageAwareModelAdapter(adapter: ModelAdapter, options: UsageAwareModelOptions): ModelAdapter {
  return {
    ...adapter,
    async *stream(request) {
      let latestUsage: ModelResponse["usage"] = null
      const deferAuthorization = isHarnessRoutedAdapter(adapter)
      const events = await runAuthorized(options, request, adapter, async (streamRequest, markProviderAttempted, settleUsage) => {
        async function* source(): AsyncGenerator<ModelStreamEvent> {
          if (!deferAuthorization) markProviderAttempted()
          for await (const event of adapter.stream(streamRequest)) {
            if (event.type === "usage") latestUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0 }
            yield event
          }
        }
        const collected: ModelStreamEvent[] = []
        for await (const event of source()) collected.push(event)
        await settleUsage(latestUsage)
        return collected
      }, deferAuthorization)
      yield* events
    },
    ...(adapter.complete ? {
      async complete(request: Parameters<NonNullable<ModelAdapter["complete"]>>[0]) {
        return runAuthorized(options, request, adapter, async (completeRequest, markProviderAttempted, settleUsage) => {
          markProviderAttempted()
          const result = await adapter.complete!(completeRequest)
          await settleUsage(result.usage)
          return result
        })
      },
    } : {}),
  }
}
