import { describe, expect, it } from 'vitest'
import { decideAdvance, defaultRolloutStage, getRolloutStage, rollbackTarget, stageTransitionData, type RolloutStageStore } from './stage-controller'

const passingMetrics = { turnCompletionRate: 1, unauthorizedExternalAction: 0, submissionDuplicate: 0, replayConsistency: 1, costP95Ratio: 1 }

describe('rollout stage controller', () => {
  it('returns a safe internal-only default when storage is not initialized', async () => {
    const client = { rolloutStage: { findUnique: async () => null, create: async () => ({}), updateMany: async () => ({ count: 0 }) } } satisfies RolloutStageStore
    await expect(getRolloutStage('staging', client)).resolves.toMatchObject({ persisted: false, stage: { stageKey: 'internal-only', rolloutPercent: 0, enabled: true } })
  })

  it('requires the observation window and all passing metrics before advancing', () => {
    const open = defaultRolloutStage('staging', new Date('2026-01-01T00:00:00.000Z'))
    expect(decideAdvance(open, '1%', passingMetrics, new Date('2026-01-01T01:00:00.000Z'))).toMatchObject({ ok: false, code: 'OBSERVATION_WINDOW_OPEN' })
    const internal = { ...open, observationStartedAt: '2026-01-01T00:00:00.000Z' }
    expect(decideAdvance(internal, '1%', passingMetrics, new Date('2026-01-02T00:00:00.000Z'))).toMatchObject({ ok: true, targetStage: '1%' })
    expect(decideAdvance(internal, '1%', { ...passingMetrics, submissionDuplicate: 1 }, new Date('2026-01-02T00:00:00.000Z'))).toMatchObject({ ok: false, code: 'ROLLBACK_REQUIRED' })
  })

  it('moves one stage backward and resets the next observation window', () => {
    const current = { ...defaultRolloutStage(), stageKey: '5%', rolloutPercent: 5, observationStartedAt: new Date('2026-01-01T00:00:00.000Z') }
    expect(rollbackTarget(current)).toBe('1%')
    expect(stageTransitionData('1%', 'admin-1', new Date('2026-01-02T00:00:00.000Z'), 'threshold breach')).toMatchObject({ stageKey: '1%', rolloutPercent: 1, observationEndsAt: new Date('2026-01-02T04:00:00.000Z'), rollbackReason: 'threshold breach' })
  })
})
