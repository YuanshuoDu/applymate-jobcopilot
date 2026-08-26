import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((job: { data: { userId: string } }) => Promise<unknown>),
  query: vi.fn(),
  featureEnabled: vi.fn(),
  isUserActive: vi.fn(),
  discoverGreenhouse: vi.fn(),
  discoverLever: vi.fn(),
  loadRegistry: vi.fn(),
}))

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({})),
  Worker: vi.fn().mockImplementation((_name, handler) => {
    mocks.handler = handler
    return { close: vi.fn() }
  }),
}))
vi.mock('ioredis', () => ({ Redis: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../db/apply-results.js', () => ({ getPool: vi.fn(() => ({ query: mocks.query })) }))
vi.mock('./worker-polling-options.js', () => ({ workerPollingOptions: vi.fn(() => ({})) }))
vi.mock('./scout-discovery.js', () => ({
  discoverGreenhouseJobs: mocks.discoverGreenhouse,
  discoverLeverJobs: mocks.discoverLever,
}))
vi.mock('./ats-registry.js', () => ({ loadEnabledAtsSlugs: mocks.loadRegistry }))
vi.mock('../admin/runtime-feature-flags.js', () => ({ isWorkerFeatureEnabled: mocks.featureEnabled }))
vi.mock('../db/application-task-state.js', () => ({ isUserActive: mocks.isUserActive }))

async function runScout() {
  await import('./scout-queue.js')
  return mocks.handler?.({ data: { userId: 'user-1' } })
}

describe('Scout queue platform controls', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.handler = undefined
    mocks.isUserActive.mockResolvedValue(true)
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.query.mockRejectedValue(new Error('target config must not be read'))
    mocks.loadRegistry.mockReset()
  })

  it('stops before source work when Worker discovery is disabled', async () => {
    await expect(runScout()).resolves.toEqual({ skipped: true, reason: 'feature-disabled' })

    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.discoverGreenhouse).not.toHaveBeenCalled()
    expect(mocks.discoverLever).not.toHaveBeenCalled()
  })

  it('stops before feature and source work when the account is suspended', async () => {
    mocks.isUserActive.mockResolvedValue(false)

    await expect(runScout()).resolves.toEqual({ skipped: true, reason: 'account-inactive' })

    expect(mocks.featureEnabled).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.discoverGreenhouse).not.toHaveBeenCalled()
    expect(mocks.discoverLever).not.toHaveBeenCalled()
  })

  it('uses the database-backed employer registry for discovery', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.query
      .mockResolvedValueOnce({ rows: [{ targetRoles: ['Engineer'], targetLocations: [] }] })
      .mockResolvedValueOnce({ rows: [] })
    mocks.loadRegistry.mockResolvedValueOnce(['n26']).mockResolvedValueOnce(['spotify'])
    mocks.discoverGreenhouse.mockResolvedValue([])
    mocks.discoverLever.mockResolvedValue([])

    await expect(runScout()).resolves.toMatchObject({ discovered: 0, inserted: 0 })

    expect(mocks.discoverGreenhouse).toHaveBeenCalledWith(expect.objectContaining({ slugs: ['n26'] }))
    expect(mocks.discoverLever).toHaveBeenCalledWith(expect.objectContaining({ slugs: ['spotify'] }))
  })

  it('fails closed before provider calls when the registry is unavailable', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.query.mockResolvedValueOnce({ rows: [{ targetRoles: ['Engineer'], targetLocations: [] }] })
    mocks.loadRegistry.mockRejectedValue(new Error('database unavailable'))

    await expect(runScout()).resolves.toEqual({ skipped: true, reason: 'ats-registry-unavailable' })

    expect(mocks.discoverGreenhouse).not.toHaveBeenCalled()
    expect(mocks.discoverLever).not.toHaveBeenCalled()
  })
})
