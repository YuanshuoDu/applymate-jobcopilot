import { describe, expect, it } from 'vitest'
import { extractSearchQuery } from './search-query'

describe('search query extraction', () => {
  it('extracts a fresh location, remote preference, and seniority', () => {
    expect(extractSearchQuery('Senior UI UX Designer, London remote')).toEqual({
      cleanQ: 'Senior UI UX Designer',
      filters: { location: 'London', remote: true, experience: 'senior' },
    })
  })

  it('extracts an internship time filter without inventing a location', () => {
    expect(extractSearchQuery('Product design internship this week')).toEqual({
      cleanQ: 'Product design internship this week',
      filters: { jobType: 'internship', datePosted: 'week' },
    })
  })

  it('corrects a misspelled location before extracting filters', () => {
    expect(extractSearchQuery('Sofware Enginer Dublen')).toEqual({
      cleanQ: 'Software Engineer',
      filters: { location: 'Dublin' },
    })
  })

  it('keeps accented city aliases discoverable after normalization', () => {
    expect(extractSearchQuery('Backend Engineer München')).toEqual({
      cleanQ: 'Backend Engineer',
      filters: { location: 'Munich' },
    })
  })
})
