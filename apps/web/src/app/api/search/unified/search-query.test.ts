import { describe, expect, it } from 'vitest'

import {
  canonicalizeJobSearchQuery,
  correctSearchSpelling,
  createSearchIntent,
  normalizeSearchText,
  semanticRoleScore,
} from './search-query'

describe('search query normalization', () => {
  it('normalizes case, accents, punctuation, and common technology spellings', () => {
    expect(normalizeSearchText('DÜSSELDORF C# / Node.js')).toBe('dusseldorf csharp nodejs')
  })

  it('corrects close role and location misspellings without changing known words', () => {
    expect(correctSearchSpelling('Sofware Enginer Dublen')).toBe('Software Engineer Dublin')
  })

  it('expands an unambiguous role acronym for provider search', () => {
    expect(canonicalizeJobSearchQuery('SWE')).toBe('Software Engineer')
  })

  it('keeps corrections and semantic alternatives in the search intent', () => {
    const intent = createSearchIntent('data developr')

    expect(intent.corrections).toEqual([{ from: 'developr', to: 'developer' }])
    expect(intent.tokens).toEqual(['data', 'developer'])
    expect(intent.semanticTokens).toContain('engineer')
    expect(intent.concepts.map(concept => concept.id)).toContain('data-engineering')
  })

  it('ranks a related role title above an unrelated title', () => {
    const intent = createSearchIntent('data developer')
    const related = semanticRoleScore('Senior Data Engineer', '', [], intent)
    const unrelated = semanticRoleScore('Senior Product Manager', '', [], intent)

    expect(related).toBeGreaterThan(unrelated)
    expect(related).toBeGreaterThan(0)
  })
})
