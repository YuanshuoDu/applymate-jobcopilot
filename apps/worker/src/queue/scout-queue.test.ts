import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((job: { data: { userId: string } }) => Promise<unknown>),
  query: vi.fn(),
  featureEnabled: vi.fn(),
  discoverGreenhouse: vi.fn(),
  discoverLever: vi.fn(),
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
vi.mock('../admin/runtime-feature-flags.js', () => ({ isWorkerFeatureEnabled: mocks.featureEnabled }))

async function runScout() {
  await import('./scout-queue.js')
  return mocks.handler?.({ data: { userId: 'user-1' } })
}

describe('Scout queue platform controls', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.handler = undefined
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.query.mockRejectedValue(new Error('target config must not be read'))
  })

  it('stops before source work when Worker discovery is disabled', async () => {
    await expect(runScout()).resolves.toEqual({ skipped: true, reason: 'feature-disabled' })

    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.discoverGreenhouse).not.toHaveBeenCalled()
    expect(mocks.discoverLever).not.toHaveBeenCalled()
  })
})
