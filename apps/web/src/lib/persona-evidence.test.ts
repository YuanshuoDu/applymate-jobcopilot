import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { personaEvidenceChunk: { findMany: mocks.findMany } } }))
vi.mock('@/lib/persona-embeddings', () => ({ embedPersonaText: vi.fn().mockResolvedValue(null), PERSONA_EMBEDDING_MODEL: 'test', vectorLiteral: vi.fn() }))

import { retrievePersonaEvidence } from './persona-evidence'

describe('retrievePersonaEvidence', () => {
  beforeEach(() => { mocks.findMany.mockReset() })

  it('falls back to task-scoped lexical evidence when no embedding provider is configured', async () => {
    mocks.findMany.mockResolvedValue([
      { content: 'Built TypeScript APIs for a payments platform.', sourceType: 'resume', sourceRef: 'resume:1', updatedAt: new Date() },
      { content: 'Fluent German speaker.', sourceType: 'resume', sourceRef: 'resume:2', updatedAt: new Date() },
    ])

    await expect(retrievePersonaEvidence('user_1', 'tailor', 'TypeScript API engineer')).resolves.toEqual([
      expect.objectContaining({ sourceRef: 'resume:1', score: 2 }),
    ])
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1', allowedUses: { has: 'tailor' } }) }))
  })
})
