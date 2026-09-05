import { describe, expect, it } from 'vitest'
import { renderRolloutReport } from './report'

const metrics = { turnCompletionRate: 0.999, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1.1 }

describe('rollout report renderer', () => {
  it('renders a deterministic, metric-only stage report', () => {
    const report = renderRolloutReport({
      environment: 'staging', stageKey: '1%', observation: { start: '2026-09-04T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z' },
      deploymentVersion: 'abc123', decision: 'advance', metrics,
      diff: { total: 10, withinThreshold: 10, byMetric: { turn_completion_rate: { total: 2, withinThreshold: 2, latestAt: '2026-09-05T00:00:00.000Z' } } },
      feedback: { total: 2, byCategory: { positive: 1, correction: 1 } }, operator: 'admin-1', reviewer: 'admin-2', signedOffAt: '2026-09-05T00:00:00.000Z',
    })
    expect(report.filename).toBe('stage-1-20260905T000000Z.md')
    expect(report.markdown).toContain('| turn_completion_rate | 0.999 |')
    expect(report.markdown).toContain('| correction | 1 |')
    expect(report.markdown).not.toMatch(/resume|email|prompt|candidate/i)
  })

  it('rejects report data that could be used for content or markdown injection', () => {
    expect(() => renderRolloutReport({
      environment: 'staging', stageKey: '1%', observation: { start: '2026-09-04', end: '2026-09-05' }, deploymentVersion: 'abc123', decision: 'hold', metrics,
      diff: { total: 0, withinThreshold: 0, byMetric: {} }, feedback: { total: 1, byCategory: { 'candidate email': 1 } }, operator: 'admin-1', reviewer: 'admin-2', signedOffAt: '2026-09-05',
    })).toThrow('machine labels')
  })

  it('requires complete count relationships', () => {
    expect(() => renderRolloutReport({
      environment: 'staging', stageKey: '1%', observation: { start: '2026-09-04', end: '2026-09-05' }, deploymentVersion: 'abc123', decision: 'rollback', rollbackTarget: 'internal-only', metrics,
      diff: { total: 1, withinThreshold: 2, byMetric: {} }, feedback: { total: 0, byCategory: {} }, operator: 'admin-1', reviewer: 'admin-2', signedOffAt: '2026-09-05',
    })).toThrow('cannot exceed')
  })
})
