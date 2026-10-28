import { describe, expect, it, vi } from 'vitest'
import { readPersonalUsage } from './personal-usage'

describe('personal usage read model', () => {
  it('aggregates recorded calls without merging identical model names across providers', async () => {
    const query = vi.fn().mockResolvedValue([
      { date: '2026-10-22', provider: 'openai', model: 'shared-name', calls: BigInt('2'), inputTokens: BigInt('100'), outputTokens: BigInt('20') },
      { date: '2026-10-28', provider: 'openai', model: 'shared-name', calls: BigInt('1'), inputTokens: BigInt('40'), outputTokens: BigInt('10') },
      { date: '2026-10-28', provider: 'other', model: 'shared-name', calls: BigInt('1'), inputTokens: BigInt('3'), outputTokens: BigInt('0') },
    ])
    const result = await readPersonalUsage({ $queryRaw: query }, 'owner-1', 7, new Date('2026-10-28T12:34:56Z'))
    expect(result.summary).toEqual({ calls: 4, inputTokens: 143, outputTokens: 30, totalTokens: 173 })
    expect(result.daily).toHaveLength(7)
    expect(result.daily[1]).toEqual({ date: '2026-10-23', calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.daily[6]).toEqual({ date: '2026-10-28', calls: 2, inputTokens: 43, outputTokens: 10, totalTokens: 53 })
    expect(result.models).toEqual([
      { provider: 'openai', model: 'shared-name', calls: 3, inputTokens: 140, outputTokens: 30, totalTokens: 170 },
      { provider: 'other', model: 'shared-name', calls: 1, inputTokens: 3, outputTokens: 0, totalTokens: 3 },
    ])
  })

  it('uses UTC calendar days across a DST change with an inclusive start and exclusive end', async () => {
    const query = vi.fn().mockResolvedValue([])
    const result = await readPersonalUsage({ $queryRaw: query }, 'owner-1', 7, new Date('2026-10-28T12:34:56Z'))
    const statement = query.mock.calls[0][0]
    expect(statement.text).toMatch(/user_id = \$1/)
    expect(statement.text).toMatch(/created_at >= \$2 AND created_at < \$3/)
    expect(statement.text).toContain("status IN ('success', 'error')")
    expect(statement.values).toEqual(['owner-1', new Date('2026-10-22T00:00:00Z'), new Date('2026-10-28T12:34:56Z')])
    expect(result).toMatchObject({ days: 7, timezone: 'UTC', from: '2026-10-22T00:00:00.000Z', to: '2026-10-28T12:34:56.000Z' })
  })

  it('returns 30 zero-filled UTC days only when a successful read is empty', async () => {
    const result = await readPersonalUsage({ $queryRaw: vi.fn().mockResolvedValue([]) }, 'owner-1', 30, new Date('2026-03-01T00:00:00Z'))
    expect(result.from).toBe('2026-01-31T00:00:00.000Z')
    expect(result.daily).toHaveLength(30)
    expect(result.daily.at(-1)?.date).toBe('2026-03-01')
    expect(result.summary).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.models).toEqual([])
  })

  it('propagates storage failure instead of claiming no usage', async () => {
    await expect(readPersonalUsage({ $queryRaw: vi.fn().mockRejectedValue(new Error('database unavailable')) }, 'owner-1', 7))
      .rejects.toThrow('database unavailable')
  })

  it('rejects unsafe totals and unexpected dates instead of silently corrupting the chart', async () => {
    for (const row of [
      { date: '2026-10-28', calls: BigInt('1'), inputTokens: BigInt('9007199254740992'), outputTokens: BigInt('0') },
      { date: '2026-10-21', calls: BigInt('1'), inputTokens: BigInt('1'), outputTokens: BigInt('0') },
    ]) {
      await expect(readPersonalUsage({ $queryRaw: vi.fn().mockResolvedValue([{ ...row, provider: 'openai', model: 'model' }]) }, 'owner-1', 7, new Date('2026-10-28T12:00:00Z')))
        .rejects.toThrow()
    }
  })
})
