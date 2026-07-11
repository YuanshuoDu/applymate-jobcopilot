import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearCachedApiResponses,
  getCachedApiResponse,
  setCachedApiResponse,
} from './api-cache'

describe('API response cache', () => {
  beforeEach(clearCachedApiResponses)

  it('returns a saved response only for its original URL', () => {
    setCachedApiResponse('/api/dashboard', { total: 4 })

    expect(getCachedApiResponse<{ total: number }>('/api/dashboard')).toEqual({ total: 4 })
    expect(getCachedApiResponse('/api/jobs')).toBeNull()
  })

  it('replaces an older response when fresh data arrives', () => {
    setCachedApiResponse('/api/dashboard', { total: 4 })
    setCachedApiResponse('/api/dashboard', { total: 5 })

    expect(getCachedApiResponse<{ total: number }>('/api/dashboard')).toEqual({ total: 5 })
  })
})
