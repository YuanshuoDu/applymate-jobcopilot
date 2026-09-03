import { describe, expect, it } from 'vitest'
import { artifactItemData } from './item'

describe('artifact Item integration', () => {
  it('emits traceable refs and hashes without raw material content', () => {
    const item = artifactItemData({ id: 'resume:draft', kind: 'resume', lifecycle: 'draft', version: 2, hash: 'sha256:' + 'a'.repeat(64), baseArtifactId: 'resume:base', baseHash: 'sha256:' + 'b'.repeat(64), constraintHash: 'sha256:' + 'c'.repeat(64), provenance: [{ sourceType: 'resume', sourceRef: 'resume:base', evidenceHash: 'sha256:' + 'b'.repeat(64) }] })
    expect(item).toMatchObject({ artifactId: 'resume:draft', artifactType: 'resume', version: 2, provenanceRefs: ['resume:base'] })
    expect(item).not.toHaveProperty('content')
  })
})
