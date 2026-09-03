import { describe, expect, it } from 'vitest'
import { canonicalArtifactJson, hashArtifactContent, hashArtifactConstraints } from './hash'
import { canonicalJsonFixtures } from '@jobcopilot/shared'

describe('artifact hashes', () => {
  it('matches the shared canonical hash baseline', () => {
    for (const fixture of canonicalJsonFixtures) expect(hashArtifactContent(fixture.value)).toBe(fixture.hash)
  })

  it('canonicalizes object key order and constraint arrays deterministically', () => {
    expect(canonicalArtifactJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(hashArtifactContent({ b: 2, a: 1 })).toBe(hashArtifactContent({ a: 1, b: 2 }))
    expect(hashArtifactConstraints({ jobId: 'job-1', roles: ['a', 'b'] })).toBe(hashArtifactConstraints({ roles: ['a', 'b'], jobId: 'job-1' }))
  })
})
