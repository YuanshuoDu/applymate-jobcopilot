import { stageDefinition, isRolloutEnvironment, isRolloutStageKey, ROLLOUT_DIFF_METRICS, type RolloutDiffMetricKey, type RolloutEnvironment, type RolloutMetrics, type RolloutStageKey } from './flags'

export type RolloutDecision = 'advance' | 'hold' | 'rollback'

export interface RolloutReportInput {
  environment: RolloutEnvironment
  stageKey: RolloutStageKey
  observation: { start: Date | string; end: Date | string }
  deploymentVersion: string
  decision: RolloutDecision
  metrics: RolloutMetrics
  diff: {
    total: number
    withinThreshold: number
    byMetric: Partial<Record<RolloutDiffMetricKey, { total: number; withinThreshold: number; latestAt: string | null }>>
  }
  feedback: { total: number; byCategory: Record<string, number> }
  operator: string
  reviewer: string
  signedOffAt: Date | string
  rollbackTarget?: RolloutStageKey | null
}

export interface RenderedRolloutReport {
  filename: string
  markdown: string
}

const METRIC_LABELS: Record<keyof RolloutMetrics, string> = {
  turnCompletionRate: 'turn_completion_rate',
  unauthorizedExternalAction: 'unauthorized_external_action',
  submissionDuplicate: 'submission_duplicate',
  replayConsistency: 'replay_consistency',
  costP95Ratio: 'cost_p95_ratio',
}

export function renderRolloutReport(input: RolloutReportInput): RenderedRolloutReport {
  validateInput(input)
  const signedOffAt = toIso(input.signedOffAt, 'signedOffAt')
  const timestamp = signedOffAt.replace(/[-:]/gu, '').replace(/\.\d{3}/u, '')
  const stageNumber = stageDefinition(input.stageKey).rolloutPercent
  const metricRows = Object.entries(METRIC_LABELS).map(([key, label]) => `| ${label} | ${formatMetric(input.metrics[key as keyof RolloutMetrics])} |`).join('\n')
  const diffRows = ROLLOUT_DIFF_METRICS.map((metric) => {
    const summary = input.diff.byMetric[metric]
    return `| ${metric} | ${summary?.total ?? 0} | ${summary?.withinThreshold ?? 0} | ${summary?.latestAt ?? 'not recorded'} |`
  }).join('\n')
  const feedbackRows = Object.entries(input.feedback.byCategory).sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => `| ${category} | ${count} |`).join('\n') || '| none | 0 |'
  const rollbackTarget = input.rollbackTarget ?? 'none'
  const markdown = [
    `# Rollout stage ${input.stageKey} (${input.environment})`,
    '',
    `- Observation: ${toIso(input.observation.start, 'observation.start')} → ${toIso(input.observation.end, 'observation.end')}`,
    `- Deployment/version: ${input.deploymentVersion}`,
    `- Decision: **${input.decision}**`,
    `- Rollback target: ${rollbackTarget}`,
    '',
    '## SLO actuals',
    '',
    '| Metric | Actual |',
    '| --- | ---: |',
    metricRows,
    '',
    '## V1/V2 diff summary',
    '',
    `- Total metric comparisons: ${input.diff.total}`,
    `- Within threshold: ${input.diff.withinThreshold}`,
    '',
    '| Metric | Comparisons | Within threshold | Latest record |',
    '| --- | ---: | ---: | --- |',
    diffRows,
    '',
    '## User feedback',
    '',
    `- Total feedback items: ${input.feedback.total}`,
    '',
    '| Category | Count |',
    '| --- | ---: |',
    feedbackRows,
    '',
    '## Sign-off',
    '',
    `- Operator: ${input.operator}`,
    `- Reviewer: ${input.reviewer}`,
    `- Signed off at (UTC): ${signedOffAt}`,
    '',
    '> This report contains metrics and opaque identifiers only. It is not a substitute for staging smoke, the required observation window, or a rollback exercise.',
    '',
  ].join('\n')
  return { filename: `stage-${stageNumber}-${timestamp}.md`, markdown }
}

function validateInput(input: RolloutReportInput): void {
  if (!isRolloutEnvironment(input.environment) || !isRolloutStageKey(input.stageKey)) throw new Error('Report environment or stage is invalid')
  if (!['advance', 'hold', 'rollback'].includes(input.decision)) throw new Error('Report decision is invalid')
  safeIdentifier(input.deploymentVersion, 'deploymentVersion')
  safeIdentifier(input.operator, 'operator')
  safeIdentifier(input.reviewer, 'reviewer')
  if (input.decision === 'rollback' && input.rollbackTarget !== null && input.rollbackTarget !== undefined && !isRolloutStageKey(input.rollbackTarget)) throw new Error('Report rollback target is invalid')
  for (const key of Object.keys(METRIC_LABELS) as Array<keyof RolloutMetrics>) {
    const value = input.metrics[key]
    if (!Number.isFinite(value) || value < 0) throw new Error(`Report metric ${key} is invalid`)
  }
  count(input.diff.total, 'diff.total')
  count(input.diff.withinThreshold, 'diff.withinThreshold')
  if (input.diff.withinThreshold > input.diff.total) throw new Error('diff.withinThreshold cannot exceed diff.total')
  for (const metric of ROLLOUT_DIFF_METRICS) {
    const summary = input.diff.byMetric[metric]
    if (!summary) continue
    count(summary.total, `${metric}.total`)
    count(summary.withinThreshold, `${metric}.withinThreshold`)
    if (summary.withinThreshold > summary.total) throw new Error(`${metric}.withinThreshold cannot exceed total`)
    if (summary.latestAt !== null) toIso(summary.latestAt, `${metric}.latestAt`)
  }
  count(input.feedback.total, 'feedback.total')
  for (const [category, value] of Object.entries(input.feedback.byCategory)) {
    if (!/^[a-z0-9_-]{1,64}$/u.test(category)) throw new Error('Feedback categories must be bounded machine labels')
    count(value, `feedback.${category}`)
  }
  toIso(input.observation.start, 'observation.start')
  toIso(input.observation.end, 'observation.end')
}

function safeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/u.test(value)) throw new Error(`${label} must be a bounded opaque identifier`)
}

function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
}

function toIso(value: Date | string, label: string): string {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`)
  return date.toISOString()
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')
}
