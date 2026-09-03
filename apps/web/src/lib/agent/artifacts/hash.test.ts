import { describe, expect, it } from 'vitest'
import { canonicalArtifactJson, hashArtifactContent, hashArtifactConstraints } from './hash'

describe('artifact hashes', () => {
  it('canonicalizes object key order and constraint arrays deterministically', () => {
    expect(canonicalArtifactJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(hashArtifactContent({ b: 2, a: 1 })).toBe(hashArtifactContent({ a: 1, b: 2 }))
    expect(hashArtifactConstraints({ jobId: 'job-1', roles: ['a', 'b'] })).toBe(hashArtifactConstraints({ roles: ['a', 'b'], jobId: 'job-1' }))
  })
})
