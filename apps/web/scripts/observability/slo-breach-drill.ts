import { evaluateSloRules, type SloWindow } from '../../src/lib/observability/slo-rules'

const injectedLatencyMs = Number(process.env.OBSERVABILITY_DRILL_TURN_P95_LATENCY_MS ?? '60000')

if (!Number.isFinite(injectedLatencyMs) || injectedLatencyMs < 0) {
  throw new Error('OBSERVABILITY_DRILL_TURN_P95_LATENCY_MS must be a non-negative number')
}

const window: SloWindow = {
  turnLatenciesMs: [injectedLatencyMs],
  toolInvocations: 1,
  toolFailures: 0,
  approvalRequests: 1,
  approvalTimeouts: 0,
  submissionAttempts: 1,
  submissionFailures: 0,
}

const evaluation = evaluateSloRules(window, {
  evaluatedAt: '2026-01-01T00:00:00.000Z',
  idFactory: (() => {
    let index = 0
    return () => `synthetic-alert-${index++}`
  })(),
})
const latencyAlert = evaluation.alerts.find((alert) => alert.ruleId === 'turn_p95_latency_ms')

if (injectedLatencyMs === 60000 && (!latencyAlert || latencyAlert.status !== 'breach' || latencyAlert.observedValue !== 60000)) {
  throw new Error(`Expected a 60000ms turn latency breach, received ${JSON.stringify(evaluation)}`)
}

if (injectedLatencyMs <= 30000 && latencyAlert?.status === 'breach') {
  throw new Error(`Did not expect a turn latency breach at ${injectedLatencyMs}ms`)
}

console.log(JSON.stringify({ status: 'passed', injectedLatencyMs, evaluation }))
