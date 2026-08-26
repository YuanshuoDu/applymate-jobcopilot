import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { loadEnabledAtsSlugs } from './ats-registry.js'

function poolWith(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as Pool
}

describe('Worker ATS employer registry', () => {
  it('returns the enabled database registry and removes invalid duplicates', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ slug: 'n26' }, { slug: 'n26' }, { slug: 'bad slug' }, { slug: 'tradeRepublic' }] })

    await expect(loadEnabledAtsSlugs(poolWith(query), 'greenhouse', ['fallback'])).resolves.toEqual(['n26', 'tradeRepublic'])
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"enabled" = true'), ['greenhouse'])
  })

  it('respects an intentionally empty registry', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })

    await expect(loadEnabledAtsSlugs(poolWith(query), 'lever', ['spotify'])).resolves.toEqual([])
  })

  it('uses the staged fallback only when the table or column is not deployed', async () => {
    const query = vi.fn().mockRejectedValue({ code: '42703' })

    await expect(loadEnabledAtsSlugs(poolWith(query), 'lever', ['spotify', 'spotify'])).resolves.toEqual(['spotify'])
  })

  it('fails closed on other database errors', async () => {
    const query = vi.fn().mockRejectedValue({ code: '08006' })

    await expect(loadEnabledAtsSlugs(poolWith(query), 'lever', ['spotify'])).rejects.toThrow('ATS registry lookup failed')
  })
})
