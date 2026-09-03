export type BudgetMetric = "steps" | "tool_calls" | "input_tokens" | "output_tokens" | "cost_usd"

export type TurnBudgetLimits = {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxCostUsd?: number
}

export type TurnUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd: number
}

export type BudgetSnapshot = {
  readonly limits: TurnBudgetLimits
  readonly used: TurnUsage & { readonly steps: number; readonly toolCalls: number }
  readonly reserved: TurnUsage & { readonly steps: number; readonly toolCalls: number }
}

export class BudgetExceededError extends Error {
  readonly code = "budget_exhausted" as const

  constructor(
    readonly metric: BudgetMetric,
    readonly limit: number,
    readonly attempted: number,
    readonly used: number,
  ) {
    super(`Turn budget exhausted for ${metric}: ${attempted} exceeds ${limit}`)
    this.name = "BudgetExceededError"
  }
}

export type BudgetReservation = {
  readonly id: string
  readonly settle: (usage: TurnUsage) => void
}

export type TurnBudgetLedger = {
  reserveStep(): void
  reserveToolCalls(count: number): void
  reserveModel(estimate?: Partial<TurnUsage>): BudgetReservation
  accountToolCalls(count: number): void
  usage(): TurnUsage
  snapshot(): BudgetSnapshot
}

const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite non-negative number`)
  return value
}

function add(left: TurnUsage, right: TurnUsage): TurnUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
  }
}

export function createTurnBudgetLedger(limits: TurnBudgetLimits, idFactory = (() => {
  let sequence = 0
  return () => `model-reservation-${++sequence}`
})()): TurnBudgetLedger {
  const used = { ...ZERO_USAGE, steps: 0, toolCalls: 0 }
  const reserved = { ...ZERO_USAGE, steps: 0, toolCalls: 0 }
  const reservations = new Map<string, TurnUsage>()

  function check(metric: BudgetMetric, attempted: number, current: number, limit: number | undefined): void {
    if (limit !== undefined && attempted > limit) throw new BudgetExceededError(metric, limit, attempted, current)
  }

  function reserveStep(): void {
    check("steps", used.steps + reserved.steps + 1, used.steps + reserved.steps, limits.maxSteps)
    used.steps += 1
  }

  function reserveToolCalls(count: number): void {
    nonNegative(count, "tool call count")
    if (!Number.isInteger(count)) throw new TypeError("tool call count must be an integer")
    check("tool_calls", used.toolCalls + reserved.toolCalls + count, used.toolCalls + reserved.toolCalls, limits.maxToolCalls)
    reserved.toolCalls += count
  }

  function remaining(metric: "inputTokens" | "outputTokens" | "estimatedCostUsd"): number {
    const limit = metric === "inputTokens" ? limits.maxInputTokens : metric === "outputTokens" ? limits.maxOutputTokens : limits.maxCostUsd
    const current = used[metric] + reserved[metric]
    return limit === undefined ? 0 : Math.max(0, limit - current)
  }

  function reserveModel(estimate?: Partial<TurnUsage>): BudgetReservation {
    const reservation: TurnUsage = {
      // A caller-provided estimate is preferred. Without one, reserve the
      // remaining allowance so work cannot silently consume capacity before
      // the provider reports actual usage.
      inputTokens: nonNegative(estimate?.inputTokens ?? (estimate === undefined ? remaining("inputTokens") : 0), "input token reservation"),
      outputTokens: nonNegative(estimate?.outputTokens ?? (estimate === undefined ? remaining("outputTokens") : 0), "output token reservation"),
      estimatedCostUsd: nonNegative(estimate?.estimatedCostUsd ?? (estimate === undefined ? remaining("estimatedCostUsd") : 0), "cost reservation"),
    }
    check("input_tokens", used.inputTokens + reserved.inputTokens + reservation.inputTokens, used.inputTokens + reserved.inputTokens, limits.maxInputTokens)
    check("output_tokens", used.outputTokens + reserved.outputTokens + reservation.outputTokens, used.outputTokens + reserved.outputTokens, limits.maxOutputTokens)
    check("cost_usd", used.estimatedCostUsd + reserved.estimatedCostUsd + reservation.estimatedCostUsd, used.estimatedCostUsd + reserved.estimatedCostUsd, limits.maxCostUsd)
    const id = idFactory()
    reservations.set(id, reservation)
    reserved.inputTokens += reservation.inputTokens
    reserved.outputTokens += reservation.outputTokens
    reserved.estimatedCostUsd += reservation.estimatedCostUsd
    let settled = false
    return {
      id,
      settle(actual): void {
        if (settled) throw new Error(`Budget reservation ${id} was settled twice`)
        settled = true
        const stored = reservations.get(id)
        if (!stored) throw new Error(`Budget reservation ${id} is unknown`)
        reservations.delete(id)
        reserved.inputTokens -= stored.inputTokens
        reserved.outputTokens -= stored.outputTokens
        reserved.estimatedCostUsd -= stored.estimatedCostUsd
        const normalized = {
          inputTokens: nonNegative(actual.inputTokens, "input tokens"),
          outputTokens: nonNegative(actual.outputTokens, "output tokens"),
          estimatedCostUsd: nonNegative(actual.estimatedCostUsd, "estimated cost"),
        }
        const next = add(used, normalized)
        const exceeded = limits.maxInputTokens !== undefined && next.inputTokens > limits.maxInputTokens
          ? { metric: "input_tokens" as const, limit: limits.maxInputTokens, attempted: next.inputTokens, used: used.inputTokens }
          : limits.maxOutputTokens !== undefined && next.outputTokens > limits.maxOutputTokens
            ? { metric: "output_tokens" as const, limit: limits.maxOutputTokens, attempted: next.outputTokens, used: used.outputTokens }
            : limits.maxCostUsd !== undefined && next.estimatedCostUsd > limits.maxCostUsd
              ? { metric: "cost_usd" as const, limit: limits.maxCostUsd, attempted: next.estimatedCostUsd, used: used.estimatedCostUsd }
              : undefined
        used.inputTokens = next.inputTokens
        used.outputTokens = next.outputTokens
        used.estimatedCostUsd = next.estimatedCostUsd
        if (exceeded) throw new BudgetExceededError(exceeded.metric, exceeded.limit, exceeded.attempted, exceeded.used)
      },
    }
  }

  function accountToolCalls(count: number): void {
    if (!Number.isInteger(count) || count < 0) throw new TypeError("tool call count must be a non-negative integer")
    const next = used.toolCalls + count
    check("tool_calls", next, used.toolCalls, limits.maxToolCalls)
    used.toolCalls = next
    reserved.toolCalls = Math.max(0, reserved.toolCalls - count)
  }

  return {
    reserveStep,
    reserveToolCalls,
    reserveModel,
    accountToolCalls,
    usage: () => ({ inputTokens: used.inputTokens, outputTokens: used.outputTokens, estimatedCostUsd: used.estimatedCostUsd }),
    snapshot: () => ({ limits: { ...limits }, used: { ...used }, reserved: { ...reserved } }),
  }
}
