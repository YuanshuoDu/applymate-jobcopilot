import { describe, expect, it, vi } from 'vitest'
import { reportJobApiJobs, trackedJobApiFetch } from './job-api-usage'

describe('job API usage tracking', () => {
  it('records safe request metadata and provider rate-limit headers', async () => {
    const response = new Response('{}', { status: 200, headers: {
      'x-ratelimit-limit': '250', 'x-ratelimit-remaining': '249', 'x-ratelimit-reset': '1787529600',
    } })
    const create = vi.fn().mockResolvedValue('event-1')
    const updateJobs = vi.fn().mockResolvedValue(undefined)

    const result = await trackedJobApiFetch('https://api.cleanjobdata.com/jobs?title=secret', {}, {
      provider: 'cleanjobdata', operation: 'List Jobs', credentialSource: 'platform', userId: 'user-1',
    }, { request: vi.fn().mockResolvedValue(response), create, updateJobs })
    await reportJobApiJobs(result, 20, { updateJobs })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'cleanjobdata', operation: 'list_jobs', credentialSource: 'platform',
      httpStatus: 200, status: 'success', rateLimitLimit: 250, rateLimitRemaining: 249,
    }))
    expect(create.mock.calls[0][0]).not.toHaveProperty('url')
    expect(updateJobs).toHaveBeenCalledWith('event-1', 20)
  })

  it('records a failed request without replacing the original error', async () => {
    const error = new Error('network unavailable')
    const create = vi.fn().mockResolvedValue(null)
    await expect(trackedJobApiFetch('https://jobicy.com/api', {}, {
      provider: 'jobicy', operation: 'search', credentialSource: 'public',
    }, { request: vi.fn().mockRejectedValue(error), create })).rejects.toBe(error)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', provider: 'jobicy' }))
  })
})
