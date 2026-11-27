import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acquireSourceMaterialFence: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  events: [] as string[],
}))

vi.mock('@/lib/agent/source-material-fence', () => ({
  acquireSourceMaterialFence: mocks.acquireSourceMaterialFence,
}))

import { writeEnrichmentSourceMaterial, type EnrichmentJobSnapshot } from './enrichment-source-write'

const snapshot = (overrides: Partial<EnrichmentJobSnapshot> = {}): EnrichmentJobSnapshot => ({
  id: 'job-1', userId: 'user-1', url: 'https://jobs.example/role', company: 'Acme', role: 'Engineer',
  location: 'Dublin', description: null, salary: null, logo: null, analysisNote: null,
  ...overrides,
})

const transaction = () => ({ job: { updateMany: mocks.updateMany, findFirst: mocks.findFirst } })

describe('writeEnrichmentSourceMaterial', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.acquireSourceMaterialFence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.updateMany.mockImplementation(async (input: { data: Record<string, unknown> }) => {
      mocks.events.push(Object.keys(input.data)[0] ?? 'update')
      return { count: 1 }
    })
    mocks.findFirst.mockImplementation(async () => {
      mocks.events.push('read')
      return { id: 'job-1', userId: 'user-1' }
    })
  })

  it('takes the tenant fence before owner/source/old-value CAS writes and returns an owner-scoped row', async () => {
    const tx = transaction()
    const source = snapshot()

    await writeEnrichmentSourceMaterial(tx as never, source, {
      description: 'Fresh description', salary: '€80k', logo: 'AC', analysisNote: 'enrichment summary',
    })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(tx, ['user-1'])
    expect(mocks.events).toEqual(['fence', 'description', 'salary', 'logo', 'analysisNote', 'read'])
    expect(mocks.updateMany.mock.calls.map(call => call[0])).toEqual([
      { where: { id: 'job-1', userId: 'user-1', url: source.url, company: source.company, role: source.role, location: source.location, description: null }, data: { description: 'Fresh description' } },
      { where: { id: 'job-1', userId: 'user-1', url: source.url, company: source.company, role: source.role, location: source.location, salary: null }, data: { salary: '€80k' } },
      { where: { id: 'job-1', userId: 'user-1', url: source.url, company: source.company, role: source.role, location: source.location, logo: null }, data: { logo: 'AC' } },
      { where: { id: 'job-1', userId: 'user-1', url: source.url, company: source.company, role: source.role, location: source.location, analysisNote: null }, data: { analysisNote: 'enrichment summary' } },
    ])
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
  })

  it('returns the current owner row without overwriting a stale CAS match', async () => {
    const tx = transaction()
    const current = { ...snapshot(), description: 'User-edited description' }
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.findFirst.mockResolvedValue(current)

    await expect(writeEnrichmentSourceMaterial(tx as never, snapshot(), { description: 'Stale description' }))
      .resolves.toEqual(current)

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'job-1', userId: 'user-1', url: snapshot().url, description: null }),
    }))
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
  })

  it('does not apply enrichment when a request source input changed before the fenced CAS', async () => {
    const tx = transaction()
    const source = snapshot()
    const current = { ...source, role: 'Staff Engineer' }
    mocks.updateMany.mockImplementation(async (input: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const matchesCurrentRow = Object.entries(input.where).every(([key, value]) => current[key as keyof typeof current] === value)
      if (!matchesCurrentRow) return { count: 0 }
      Object.assign(current, input.data)
      return { count: 1 }
    })
    mocks.findFirst.mockImplementation(async (input: { where: Record<string, unknown> }) => (
      current.id === input.where.id && current.userId === input.where.userId ? current : null
    ))

    await expect(writeEnrichmentSourceMaterial(tx as never, source, { description: 'Stale description' }))
      .resolves.toEqual(current)

    expect(mocks.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1', userId: 'user-1', url: source.url, company: source.company,
        role: source.role, location: source.location, description: null,
      },
      data: { description: 'Stale description' },
    })
    expect(current).toEqual({ ...source, role: 'Staff Engineer' })
  })

  it('does not apply enrichment or return a Job after ownership changes before the fenced CAS', async () => {
    const tx = transaction()
    const source = snapshot()
    const current = { ...source, userId: 'user-2' }
    mocks.updateMany.mockImplementation(async (input: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const matchesCurrentRow = Object.entries(input.where).every(([key, value]) => current[key as keyof typeof current] === value)
      if (!matchesCurrentRow) return { count: 0 }
      Object.assign(current, input.data)
      return { count: 1 }
    })
    mocks.findFirst.mockImplementation(async (input: { where: Record<string, unknown> }) => (
      current.id === input.where.id && current.userId === input.where.userId ? current : null
    ))

    await expect(writeEnrichmentSourceMaterial(tx as never, source, { description: 'Stale description' }))
      .resolves.toBeNull()

    expect(mocks.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1', userId: 'user-1', url: source.url, company: source.company,
        role: source.role, location: source.location, description: null,
      },
      data: { description: 'Stale description' },
    })
    expect(current).toEqual({ ...source, userId: 'user-2' })
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
  })

  it('does not overwrite populated source fields or an Analyst recommendation', async () => {
    const tx = transaction()
    const source = snapshot({
      description: 'Existing description', salary: 'Existing salary', logo: 'Existing logo',
      analysisNote: 'Analyst recommendation',
    })

    await writeEnrichmentSourceMaterial(tx as never, source, {
      description: 'Stale description', salary: 'Stale salary', logo: 'Stale logo', analysisNote: 'Enrichment JSON',
    })

    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
  })

  it('fails closed when the source fence cannot be acquired', async () => {
    const tx = transaction()
    const failure = new Error('fence failed')
    mocks.acquireSourceMaterialFence.mockRejectedValue(failure)

    await expect(writeEnrichmentSourceMaterial(tx as never, snapshot(), { description: 'Fresh description' }))
      .rejects.toBe(failure)

    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})
