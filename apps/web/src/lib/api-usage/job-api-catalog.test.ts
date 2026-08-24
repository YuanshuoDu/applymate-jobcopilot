import { describe, expect, it } from 'vitest'
import { isJobApiProvider, JOB_API_PROVIDERS, jobApiProviderLabel } from './job-api-catalog'

describe('job API provider catalogue', () => {
  it('keeps current, public and future quota providers addressable', () => {
    expect(new Set(JOB_API_PROVIDERS.map(provider => provider.key))).toEqual(expect.objectContaining({ size: JOB_API_PROVIDERS.length }))
    expect(isJobApiProvider('cleanjobdata')).toBe(true)
    expect(isJobApiProvider('fantasticjobs')).toBe(true)
    expect(isJobApiProvider('unknown')).toBe(false)
    expect(jobApiProviderLabel('rapidapi-jsearch')).toContain('JSearch')
  })
})
