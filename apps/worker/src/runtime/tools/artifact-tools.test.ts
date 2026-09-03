import { describe, expect, it } from 'vitest'
import { InMemoryArtifactToolStore, createArtifactTools, ArtifactToolError } from './artifact-tools.js'

describe('typed Agent artifact tools', () => {
  it('creates a versioned draft with a safe typed Item and never returns raw content', async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: 'resume-base', type: 'resume', content: { summary: 'Engineer' } })
    const tool = createArtifactTools(store).find(definition => definition.name === 'resume.draft')!
    const result = await tool.execute({ scope: { userId: 'user-a' } } as never, {
      baseArtifactId: base.id, baseHash: base.hash, content: { summary: 'Engineer at Example' }, constraints: { jobId: 'job-a' }, evidence: [{ sourceRef: 'resume:resume-base', content: 'Engineer at Example' }],
    }) as { artifact: Record<string, unknown>; item: Record<string, unknown> }
    expect(result.artifact.content).toBeUndefined()
    expect(result.item).toMatchObject({ type: 'artifact', lifecycle: 'draft', version: 1, hash: expect.stringMatching(/^sha256:/) })
    expect(tool.capabilities).toEqual(['read', 'write'])
  })

  it('fails closed for stale preflight and review hashes', async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: 'resume-base', type: 'resume', content: 'base' })
    const draft = await store.writeDraft('user-a', { baseArtifactId: base.id, baseHash: base.hash, content: 'draft', constraints: { jobId: 'job-a' }, evidence: [{ sourceRef: 'resume:resume-base', content: 'base' }], type: 'resume' })
    const review = createArtifactTools(store).find(definition => definition.name === 'artifact.review')!
    await expect(review.execute({ scope: { userId: 'user-a' } } as never, { artifactId: draft.id, expectedArtifactHash: 'sha256:stale', constraintHash: draft.constraintHash, decision: 'passed', evidence: [{ sourceRef: 'resume:resume-base', content: 'base' }] })).rejects.toBeInstanceOf(ArtifactToolError)
  })

  it('does not allow a base artifact to be replaced', () => {
    const store = new InMemoryArtifactToolStore()
    store.registerBase({ id: 'resume-base', type: 'resume', content: 'base' })
    expect(() => store.registerBase({ id: 'resume-base', type: 'resume', content: 'changed' })).toThrow(/cannot be overwritten/)
  })

  it('rejects unsupported biographical claims before the store writes a draft', async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: 'resume-base', type: 'resume', content: 'Engineer at ApplyMate from 2022.' })
    const tool = createArtifactTools(store).find(definition => definition.name === 'resume.draft')!
    await expect(tool.execute({ scope: { userId: 'user-a' } } as never, {
      baseArtifactId: base.id, baseHash: base.hash, content: 'Engineer at Acme Corp from 2022 with 80% growth', constraints: {}, evidence: [{ sourceRef: 'resume:resume-base', content: 'Engineer at ApplyMate from 2022.' }],
    })).rejects.toMatchObject({ code: 'invalid_provenance' })
  })

  it('does not expose an artifact across tenants', async () => {
    const store = new InMemoryArtifactToolStore()
    const base = store.registerBase({ id: 'resume-base', type: 'resume', content: 'base', userId: 'user-a' })
    await expect(store.read('user-b', base.id)).resolves.toBeNull()
    await expect(store.writeDraft('user-b', {
      baseArtifactId: base.id, baseHash: base.hash, content: 'draft', constraints: {},
      evidence: [{ sourceRef: 'resume:resume-base', content: 'base' }], type: 'resume',
    })).rejects.toMatchObject({ code: 'not_found' })
  })
})
