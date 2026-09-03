import { describe, expect, it } from 'vitest'
import { assertSupportedClaims, ProvenanceError } from './provenance'

describe('artifact provenance guard', () => {
  const evidence = [{ sourceType: 'resume' as const, sourceRef: 'resume:base', content: 'Backend engineer at ApplyMate from 2022 to 2024.' }]

  it('accepts a wording change supported by the base resume', () => {
    expect(assertSupportedClaims({ content: { summary: 'Backend engineer at ApplyMate, 2022-2024' }, evidence })).toHaveLength(1)
  })

  it('rejects an unsupported employer and metric before a draft can pass', () => {
    expect(() => assertSupportedClaims({ content: { summary: 'Backend engineer at Acme Corp delivered 80% growth' }, evidence })).toThrow(ProvenanceError)
    expect(() => assertSupportedClaims({ content: { summary: 'Backend engineer at Acme Corp delivered 80% growth' }, evidence })).toThrow(/Unsupported claims/)
  })
})
