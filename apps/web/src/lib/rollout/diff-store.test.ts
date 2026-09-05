import { describe, expect, it, vi } from 'vitest'
import { persistRolloutDiff, summarizeRolloutDiffs, type RolloutDiffStore } from './diff-store'

function store() {
  return { rolloutDiff: { createMany: vi.fn(), findMany: vi.fn() } } as unknown as RolloutDiffStore & { rolloutDiff: { createMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } }
}

describe('rollout diff store', () => {
  it('persists only the allow-listed metric pairs with a server-derived delta', async () => {
    const client = store()
    client.rolloutDiff.createMany.mockResolvedValue({ count: 5 })
    const result = await persistRolloutDiff({
      comparisonId: 'comparison-1', environment: 'staging', stageKey: '1%', sessionId: 'session-1', traceId: 'trace-1',
      metrics: {
        turn_completion_rate: { legacyValue: 0.99, v2Value: 1, withinThreshold: true },
        unauthorized_external_action: { legacyValue: 0, v2Value: 0, withinThreshold: true },
        submission_duplicate: { legacyValue: 0, v2Value: 0, withinThreshold: true },
        replay_consistency: { legacyValue: 1, v2Value: 1, withinThreshold: true },
        cost_p95_ratio: { legacyValue: 1, v2Value: 1.1, withinThreshold: true },
      },
    }, client)
    expect(result).toEqual({ count: 5 })
    const args = client.rolloutDiff.createMany.mock.calls[0]?.[0]
    expect(args.skipDuplicates).toBe(true)
    expect(args.data).toHaveLength(5)
    expect(args.data[4]).toMatchObject({ metricKey: 'cost_p95_ratio', delta: 0.10000000000000009, sessionId: 'session-1' })
    expect(JSON.stringify(args.data)).not.toMatch(/prompt|resume|email|content/i)
  })

  it('summarizes only recognized metrics and never reads payload content', async () => {
    const client = store()
    client.rolloutDiff.findMany.mockResolvedValue([
      { metricKey: 'turn_completion_rate', withinThreshold: true, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { metricKey: 'turn_completion_rate', withinThreshold: false, createdAt: new Date('2026-01-01T00:01:00.000Z') },
      { metricKey: 'unknown', withinThreshold: true, createdAt: new Date('2026-01-01T00:02:00.000Z') },
    ])
    await expect(summarizeRolloutDiffs('staging', client)).resolves.toEqual({ total: 3, withinThreshold: 1, byMetric: { turn_completion_rate: { total: 2, withinThreshold: 1, latestAt: '2026-01-01T00:00:00.000Z' } } })
    expect(client.rolloutDiff.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { metricKey: true, withinThreshold: true, createdAt: true } }))
  })

  it('rejects unsupported or non-finite metric input', async () => {
    const client = store()
    await expect(persistRolloutDiff({ comparisonId: 'comparison-1', environment: 'staging', stageKey: '1%', sessionId: 'session-1', metrics: { prompt: { legacyValue: 0, v2Value: 0, withinThreshold: true } } as never }, client)).rejects.toThrow('Unsupported rollout metric')
    await expect(persistRolloutDiff({ comparisonId: 'comparison-1', environment: 'staging', stageKey: '1%', sessionId: 'session-1', metrics: { cost_p95_ratio: { legacyValue: Number.NaN, v2Value: 1, withinThreshold: true } } }, client)).rejects.toThrow('finite')
  })
})
