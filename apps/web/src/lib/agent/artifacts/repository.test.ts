import { describe, expect, it } from 'vitest'
import { hashArtifactConstraints } from './hash'
import { reviewArtifact } from './review'
import { ArtifactRepositoryError, InMemoryArtifactRepository } from './repository'

describe('versioned artifact repository', () => {
  const constraints = { jobId: 'job-1', role: 'Engineer', company: 'ApplyMate' }
  const evidence = [{ sourceType: 'resume' as const, sourceRef: 'resume:base', content: 'Engineer at ApplyMate' }]

  it('keeps base, draft and approved artifacts distinct', () => {
    const repository = new InMemoryArtifactRepository()
    const base = repository.createBase({ id: 'resume:base', kind: 'resume', content: { summary: 'Engineer' }, createdBy: 'user' })
    const draft = repository.createDraft({ id: 'resume:draft', kind: 'resume', baseArtifactId: base.id, baseHash: base.hash, content: { summary: 'Engineer at ApplyMate' }, createdBy: 'writer', constraints, evidence })
    const review = reviewArtifact({ artifact: draft, expectedHash: draft.hash, reviewerId: 'user', decision: 'passed', evidence: [], constraintHash: hashArtifactConstraints(constraints) })
    const approved = repository.approve(draft.id, review, constraints)
    expect(base.lifecycle).toBe('base')
    expect(draft.lifecycle).toBe('draft')
    expect(approved.lifecycle).toBe('approved')
    expect(approved.id).not.toBe(draft.id)
    expect(() => repository.createDraft({ id: approved.id, kind: 'resume', baseArtifactId: base.id, baseHash: base.hash, content: { summary: 'Changed' }, createdBy: 'writer', constraints, evidence })).toThrow(/approved artifact cannot be overwritten/)
  })

  it('invalidates a draft when constraints change and blocks approved overwrite', () => {
    const repository = new InMemoryArtifactRepository()
    const base = repository.createBase({ id: 'resume:base', kind: 'resume', content: 'Engineer', createdBy: 'user' })
    const draft = repository.createDraft({ id: 'resume:draft', kind: 'resume', baseArtifactId: base.id, baseHash: base.hash, content: 'Engineer', createdBy: 'writer', constraints, evidence })
    expect(repository.invalidateStale({ ...constraints, coverTone: 'concise' })).toEqual([expect.objectContaining({ id: draft.id, lifecycle: 'stale' })])
    expect(() => repository.createDraft({ id: draft.id, kind: 'resume', baseArtifactId: base.id, baseHash: base.hash, content: 'Engineer', createdBy: 'writer', constraints: { ...constraints, coverTone: 'concise' }, evidence })).not.toThrow()
  })

  it('rejects a review bound to a different hash', () => {
    const repository = new InMemoryArtifactRepository()
    const base = repository.createBase({ id: 'resume:base', kind: 'resume', content: 'Engineer', createdBy: 'user' })
    const draft = repository.createDraft({ id: 'resume:draft', kind: 'resume', baseArtifactId: base.id, baseHash: base.hash, content: 'Engineer', createdBy: 'writer', constraints, evidence })
    expect(() => reviewArtifact({ artifact: draft, expectedHash: 'sha256:' + '0'.repeat(64), reviewerId: 'user', decision: 'passed', evidence: [], constraintHash: hashArtifactConstraints(constraints) })).toThrow(/stale artifact hash/)
    expect(() => repository.approve(draft.id, { id: 'r', artifactId: draft.id, artifactHash: 'sha256:' + '0'.repeat(64), status: 'passed', reviewerId: 'user', evidence: draft.provenance, constraintHash: hashArtifactConstraints(constraints), findings: [] }, constraints)).toThrow(ArtifactRepositoryError)
  })
})
