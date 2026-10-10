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
  request: HarnessModelRequest,
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
  type Attempt = {
    authorization?: WorkerUsageAuthorization
    authorizationPromise?: Promise<WorkerUsageAuthorization>
    providerAttempted: boolean
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    accountSettlementStarted: boolean
    accountSettlementUnknown: boolean
    releaseStarted: boolean
  }
  const attempts = new Map<string, Attempt>()
  let active: Attempt | undefined
  let providerAttempted = false
  const routeKey = (route: HarnessPreProviderRoute) => `${route.provider}\u001f${route.model}`
  const interrupted = () => request.signal.reason ?? Object.assign(new Error("model_cancelled"), { code: "model_cancelled" })
  const settleError = async (attempt: Attempt, error: unknown): Promise<void> => {
    if (attempt.accountSettlementStarted || !attempt.authorization) return
    attempt.accountSettlementStarted = true
    try {
      await attempt.authorization.settle({ status: "error", inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, estimatedCostUsd: attempt.estimatedCostUsd, errorCode: errorCode(error) })
    } catch { attempt.accountSettlementUnknown = true }
  }
  const releaseAttempt = async (attempt: Attempt): Promise<void> => {
    if (attempt.accountSettlementStarted || attempt.releaseStarted || attempt.providerAttempted || !attempt.authorization) return
    attempt.releaseStarted = true
    if (!attempt.authorization.release) { attempt.accountSettlementUnknown = true; return }
    try { await attempt.authorization.release() } catch { attempt.accountSettlementUnknown = true }
  }
  const settleRouteError = async (attempt: Attempt, code: string): Promise<void> => {
    if (attempt.accountSettlementStarted || !attempt.authorization) return
    attempt.accountSettlementStarted = true
    try {
      await attempt.authorization.settle({ status: "error", inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, estimatedCostUsd: attempt.estimatedCostUsd, errorCode: code })
    } catch { attempt.accountSettlementUnknown = true; throw new Error("usage_settlement_unknown") }
  }
  const authorizeRoute = async (route: HarnessPreProviderRoute): Promise<WorkerUsageAuthorization> => {
    if (request.signal.aborted) throw interrupted()
    const key = routeKey(route)
    let attempt = attempts.get(key)
    if (!attempt) {
      attempt = { providerAttempted: false, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, accountSettlementStarted: false, accountSettlementUnknown: false, releaseStarted: false }
      attempts.set(key, attempt)
    }
    if (active && active !== attempt && active.providerAttempted && !active.accountSettlementStarted) {
      await settleRouteError(active, "provider_rerouted")
    }
    active = attempt
    attempt.authorizationPromise ??= Promise.resolve().then(() => options.authorize(
      authInput(options.owner, request.metadata.stepId, route, options.featureKey ?? "autoApply"),
    )).then(value => { attempt!.authorization = value; return value })
    const value = await attempt.authorizationPromise
    if (request.signal.aborted) throw interrupted()
    return value
  }
  const hasUnknownAccountSettlement = () => [...attempts.values()].some(attempt => attempt.accountSettlementUnknown)
  const finishAttempts = async (error: unknown): Promise<void> => {
    for (const attempt of attempts.values()) {
      if (attempt.providerAttempted && !attempt.accountSettlementStarted) await settleError(attempt, error)
      else if (!attempt.providerAttempted) await releaseAttempt(attempt)
    }
  }
  const markProviderAttempted = (): void => {
    providerAttempted = true
    if (active) active.providerAttempted = true
  }
  const settleUsage = async (value: ModelResponse["usage"]): Promise<void> => {
    if (!active || active.accountSettlementStarted) return
    if (!active.authorization) throw new Error("usage_authorization_unavailable")
    active.inputTokens = value?.inputTokens ?? 0
    active.outputTokens = value?.outputTokens ?? 0
    active.estimatedCostUsd = value?.estimatedCostUsd ?? 0
    active.accountSettlementStarted = true
    try { await active.authorization.settle({ ...usage(value), status: "success" }) }
    catch (error: unknown) { active.accountSettlementUnknown = true; throw error }
  }
  const authorizedRequest = deferAuthorization
    ? withHarnessPreProviderHooks(request as HarnessModelRequest, {
      beforeProviderInvocation: route => authorizeRoute(route).then(() => undefined),
      providerInvocationStarted: markProviderAttempted,
      providerUsageObserved: (route, value) => {
        const attempt = attempts.get(routeKey(route))
        if (!attempt) return
        attempt.inputTokens = value.inputTokens
        attempt.outputTokens = value.outputTokens
        attempt.estimatedCostUsd = value.estimatedCostUsd ?? 0
      },
    })
    : request as HarnessModelRequest
  try {
    if (!deferAuthorization) await authorizeRoute(adapter.profile)
    if (request.signal.aborted) throw interrupted()
    const result = await run(authorizedRequest, markProviderAttempted, settleUsage)
    await settleTree("consumed")
    return result
  } catch (error: unknown) {
    await finishAttempts(error)
    // An unknown account settlement keeps the reserved row active. That
    // blocks a free retry while a later reconciliation can settle it safely.
    if (!hasUnknownAccountSettlement()) {
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
