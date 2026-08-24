import { describe, expect, it } from 'vitest'
import { canonicalJobKey, compareShadowJobs } from './shadow'

describe('Fantastic Jobs shadow comparison', () => {
  it('canonicalizes tracking parameters before comparing providers', () => {
    expect(canonicalJobKey('https://jobs.example/1?utm_source=fantastic#top')).toBe('https://jobs.example/1')
  })

  it('reports only aggregate quality evidence', () => {
    const result = compareShadowJobs(
      [{ url: 'https://jobs.example/1', description: 'existing' }],
      [
        { url: 'https://jobs.example/1?utm_source=fantastic', description: 'duplicate' },
        { url: 'https://jobs.example/2', description: 'A'.repeat(100) },
        { url: 'not-a-url', description: 'A'.repeat(100) },
      ],
    )
    expect(result).toEqual({ shadowJobs: 3, netNewJobs: 2, validApplyUrls: 2, completeDescriptions: 2 })
  })
})
