import { createChildTraceContext, createRootTraceContext, type TraceContext } from "./trace-context"

export const SLO_RULES = {
  turn_p95_latency_ms: { threshold: 30_000, unit: "ms", comparator: "less_than_or_equal" },
  tool_error_rate: { threshold: 0.01, unit: "ratio", comparator: "less_than_or_equal" },
  approval_timeout_rate: { threshold: 0.05, unit: "ratio", comparator: "less_than_or_equal" },
  submission_failed_rate: { threshold: 0.02, unit: "ratio", comparator: "less_than_or_equal" },
} as const

export type SloRuleId = keyof typeof SLO_RULES

export interface SloWindow {
  turnLatenciesMs: readonly number[]
  toolInvocations: number
  toolFailures: number
  approvalRequests: number
  approvalTimeouts: number
  submissionAttempts: number
  submissionFailures: number
}

export interface SloAlertEvent {
  alertId: string
  ruleId: SloRuleId
  status: "pass" | "breach"
  observedValue: number
  threshold: number
  evaluatedAt: string
  traceId: string
  spanId: string
  parentSpanId: string | null
}

export interface SloEvaluation {
  alerts: readonly SloAlertEvent[]
  breached: boolean
}

export interface SloEvaluationOptions {
  evaluatedAt?: Date | string
  trace?: TraceContext
  idFactory?: () => string
}

function ratio(failures: number, total: number, label: string): number {
  if (!Number.isInteger(failures) || !Number.isInteger(total) || failures < 0 || total < 0 || failures > total) {
    throw new Error(`${label} must have integer counts with 0 <= failures <= total`)
  }
  return total === 0 ? 0 : failures / total
}

export function calculateP95(values: readonly number[]): number {
  if (values.length === 0) return 0
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("latency values must be finite and non-negative")
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function observations(window: SloWindow): Record<SloRuleId, number> {
  return {
    turn_p95_latency_ms: calculateP95(window.turnLatenciesMs),
    tool_error_rate: ratio(window.toolFailures, window.toolInvocations, "tool counts"),
    approval_timeout_rate: ratio(window.approvalTimeouts, window.approvalRequests, "approval counts"),
    submission_failed_rate: ratio(window.submissionFailures, window.submissionAttempts, "submission counts"),
  }
}

function isoDate(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) throw new Error("evaluatedAt must be a valid date")
  return date.toISOString()
}

/** Evaluates all rules and always emits one traceable alert event per rule. */
export function evaluateSloRules(window: SloWindow, options: SloEvaluationOptions = {}): SloEvaluation {
  const observed = observations(window)
  const trace = options.trace ?? createRootTraceContext(options.idFactory)
  const idFactory = options.idFactory ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  const evaluatedAt = isoDate(options.evaluatedAt)
  const alerts = (Object.keys(SLO_RULES) as SloRuleId[]).map((ruleId) => {
    const threshold = SLO_RULES[ruleId].threshold
    const observedValue = observed[ruleId]
    const alertTrace = createChildTraceContext(trace, idFactory)
    return {
      alertId: idFactory(),
      ruleId,
      status: observedValue <= threshold ? "pass" : "breach",
      observedValue,
      threshold,
      evaluatedAt,
      traceId: alertTrace.traceId,
      spanId: alertTrace.spanId,
      parentSpanId: alertTrace.parentSpanId,
    } satisfies SloAlertEvent
  })
  return { alerts, breached: alerts.some((alert) => alert.status === "breach") }
}

/** CI-friendly deterministic proof that a 60-second p95 breaches the 30-second SLO. */
export function runSyntheticLatencyBreachDrill(): SloEvaluation {
  return evaluateSloRules({
    turnLatenciesMs: [60_000],
    toolInvocations: 1,
    toolFailures: 0,
    approvalRequests: 1,
    approvalTimeouts: 0,
    submissionAttempts: 1,
    submissionFailures: 0,
  }, { evaluatedAt: "2026-01-01T00:00:00.000Z", idFactory: (() => { let index = 0; return () => `synthetic-alert-${index++}` })() })
}
