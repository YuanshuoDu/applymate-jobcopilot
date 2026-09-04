import { describe, expect, it } from 'vitest'
import {
  ROLLBACK_THRESHOLDS,
  ROLLOUT_STAGES,
  allocateSession,
  evaluateRollbackThresholds,
  isObservationComplete,
  observationWindow,
  stageDefinition,
} from './flags'

describe('rollout flags', () => {
  it('keeps the configured stage order and observation windows', () => {
    expect(ROLLOUT_STAGES.map((stage) => stage.key)).toEqual(['internal-only', '1%', '5%', '25%', '50%', '100%'])
    expect(stageDefinition('internal-only').observationMs).toBe(24 * 60 * 60 * 1000)
    expect(stageDefinition('1%').observationMs).toBe(4 * 60 * 60 * 1000)
    expect(observationWindow('5%', '2026-01-01T00:00:00.000Z').end.toISOString()).toBe('2026-01-01T04:00:00.000Z')
    expect(isObservationComplete('5%', '2026-01-01T00:00:00.000Z', new Date('2026-01-01T04:00:00.000Z'))).toBe(true)
  })

  it('allocates the same session deterministically and keeps internal-only closed by default', () => {
    const stage = { stageKey: '1%', rolloutPercent: 1, enabled: true, internalUserIds: [] as string[] }
    const first = allocateSession('session-fixed-001', stage)
    const second = allocateSession('session-fixed-001', stage)
    expect(second).toEqual(first)
    expect(allocateSession('session-fixed-001', { ...stage, stageKey: 'internal-only', rolloutPercent: 0 }, 'user-outside').useV2).toBe(false)
    expect(allocateSession('session-fixed-001', { ...stage, stageKey: 'internal-only', rolloutPercent: 0, internalUserIds: ['user-internal'] }, 'user-internal')).toMatchObject({ useV2: true, reason: 'internal_user' })
    expect(allocateSession('session-fixed-001', { stageKey: '100%', rolloutPercent: 100, enabled: true, internalUserIds: [] }).useV2).toBe(true)
  })

  it('fails closed when any rollback metric is missing or breaches its guardrail', () => {
    expect(evaluateRollbackThresholds({ turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 })).toMatchObject({ shouldRollback: false, reasons: [] })
    expect(evaluateRollbackThresholds({ turnCompletionRate: 0.98, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 }).reasons).toContain('turn_completion_below_99_percent')
    expect(evaluateRollbackThresholds({ turnCompletionRate: 1, unauthorizedExternalAction: 1, submissionDuplicate: 1, replayConsistency: 0.999, costP95Ratio: ROLLBACK_THRESHOLDS.costP95Ratio.maximum }).reasons).toEqual(['unauthorized_external_action_detected', 'duplicate_submission_detected'])
    expect(evaluateRollbackThresholds({ turnCompletionRate: 1 }).reasons).toEqual(expect.arrayContaining(['missing_metric:replayConsistency', 'missing_metric:costP95Ratio']))
  })
})
