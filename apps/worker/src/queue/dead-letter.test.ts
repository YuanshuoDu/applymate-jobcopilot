import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn(), disconnect: vi.fn() }))
vi.mock('ioredis', () => ({ Redis: class { ping = vi.fn(); disconnect = mocks.disconnect } }))
vi.mock('bullmq', () => ({ Queue: class { add = mocks.add; close = mocks.close }, Worker: class {} }))

describe('dead-letter recording', () => {
  beforeEach(() => { vi.resetModules(); mocks.add.mockReset(); mocks.add.mockResolvedValue({ id: 'dlq-id' }) })

  it('stores retry metadata without copying sensitive task payloads', async () => {
    const { recordDeadLetter } = await import('./dead-letter.js')
    await recordDeadLetter('apply-tasks', { id: 'job-1', name: 'apply', attemptsMade: 3, data: { userId: 'user-1', resumePath: 'private/resume.pdf', coverLetterPath: 'private/letter.pdf' } } as never, new Error('provider timeout'))
    expect(mocks.add).toHaveBeenCalledWith('dead-lettered-job', expect.objectContaining({ sourceQueue: 'apply-tasks', sourceJobId: 'job-1', userId: 'user-1', failedReason: 'provider timeout' }), expect.objectContaining({ jobId: 'apply-tasks:job-1' }))
    const record = mocks.add.mock.calls[0][1] as Record<string, unknown>
    expect(record).not.toHaveProperty('resumePath')
    expect(record).not.toHaveProperty('coverLetterPath')
  })
})
