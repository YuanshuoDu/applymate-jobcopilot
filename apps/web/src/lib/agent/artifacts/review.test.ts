import { describe, expect, it } from 'vitest'
import { hashArtifactConstraints } from './hash'
import { preflightArtifact, reviewArtifact } from './review'
import type { ArtifactSummary } from './types'

describe('artifact review binding', () => {
  const constraints = { jobId: 'job-1', role: 'Engineer', company: 'ApplyMate' }
  const artifact: ArtifactSummary = {
    id: 'resume:draft',
    kind: 'resume',
    lifecycle: 'draft',
    version: 2,
    hash: `sha256:${'a'.repeat(64)}`,
    baseArtifactId: 'resume:base',
    baseHash: `sha256:${'b'.repeat(64)}`,
    constraintHash: hashArtifactConstraints(constraints),
    provenance: [{ sourceType: 'resume', sourceRef: 'resume:base', evidenceHash: `sha256:${'c'.repeat(64)}` }],
  }

  it('preflights a current draft and rejects changed constraints', () => {
    expect(preflightArtifact(artifact, artifact.constraintHash)).toEqual({ ok: true, issues: [] })
    expect(preflightArtifact(artifact, hashArtifactConstraints({ ...constraints, coverTone: 'concise' }))).toEqual({ ok: false, issues: ['stale_constraints'] })
  })

  it('requires review evidence to match the artifact provenance hash', () => {
    expect(() => reviewArtifact({
      artifact,
      expectedHash: artifact.hash,
      reviewerId: 'agent-reviewer',
      decision: 'passed',
      constraintHash: artifact.constraintHash,
      evidence: [{ sourceType: 'resume', sourceRef: 'resume:base', content: 'different evidence' }],
    })).toThrow(/provenance chain/)
  })
})
