import type { ModelAdapter, ModelResponse, ModelStreamEvent } from "@jobcopilot/agent-model"

import type { WorkerUsageAuthorizationInput, WorkerUsageAuthorization, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "../subagents/tree-budget-types.js"

export type UsageAwareModelOptions = {
  readonly owner: ExecutionOwnerFence
  readonly authorize: (input: WorkerUsageAuthorizationInput) => Promise<WorkerUsageAuthorization> | WorkerUsageAuthorization
  /** Omit for the legacy root path; child execution must provide this explicitly. */
  readonly treeBudget?: TreeBudgetReservationStore
  readonly featureKey?: string
}

function authInput(owner: ExecutionOwnerFence, stepId: string, adapter: ModelAdapter, featureKey: string): WorkerUsageAuthorizationInput {
  const common = {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, stepId,
    featureKey, provider: adapter.profile.provider, model: adapter.profile.model,
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
  run: (markProviderAttempted: () => void, settleUsage: (value: ModelResponse["usage"]) => Promise<void>) => Promise<T>,
): Promise<T> {
  const input = reservationInput(options.owner, request.metadata.stepId)
  const reservation = input && options.treeBudget ? await options.treeBudget.reserve(input) : null
  let treeSettlementStarted = false
  const settleTree = async (status: "consumed" | "released"): Promise<void> => {
    if (!reservation || !options.treeBudget || treeSettlementStarted) return
    treeSettlementStarted = true
    await options.treeBudget.settle(settlement(reservation, status))
  }
  let authorization: WorkerUsageAuthorization
  try {
    authorization = await options.authorize(authInput(options.owner, request.metadata.stepId, adapter, options.featureKey ?? "autoApply"))
  } catch (error: unknown) {
    await settleTree("released").catch(() => undefined)
    throw error
  }
  let providerAttempted = false
  let accountSettlementStarted = false
  let accountSettlementUnknown = false
  const settleUsage = async (value: ModelResponse["usage"]): Promise<void> => {
    if (accountSettlementStarted) return
    accountSettlementStarted = true
    try { await authorization.settle({ ...usage(value), status: "success" }) }
    catch (error: unknown) { accountSettlementUnknown = true; throw error }
  }
  const settleError = async (error: unknown): Promise<void> => {
    if (accountSettlementStarted) return
    accountSettlementStarted = true
    try {
      await authorization.settle({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: errorCode(error) })
    } catch { accountSettlementUnknown = true }
  }
  try {
    const result = await run(() => { providerAttempted = true }, settleUsage)
    await settleTree("consumed")
    return result
  } catch (error: unknown) {
    if (!accountSettlementStarted) {
      await settleError(error)
    }
    // An unknown account settlement keeps the reserved row active. That
    // blocks a free retry while a later reconciliation can settle it safely.
    if (!accountSettlementUnknown) {
      if (providerAttempted) await settleTree("consumed").catch(() => undefined)
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
      const events = await runAuthorized(options, request, adapter, async (markProviderAttempted, settleUsage) => {
        async function* source(): AsyncGenerator<ModelStreamEvent> {
          markProviderAttempted()
          for await (const event of adapter.stream(request)) {
            if (event.type === "usage") latestUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0 }
            yield event
          }
        }
        const collected: ModelStreamEvent[] = []
        for await (const event of source()) collected.push(event)
        await settleUsage(latestUsage)
        return collected
      })
      yield* events
    },
    ...(adapter.complete ? {
      async complete(request: Parameters<NonNullable<ModelAdapter["complete"]>>[0]) {
        return runAuthorized(options, request, adapter, async (markProviderAttempted, settleUsage) => {
          markProviderAttempted()
          const result = await adapter.complete!(request)
          await settleUsage(result.usage)
          return result
        })
      },
    } : {}),
  }
}
