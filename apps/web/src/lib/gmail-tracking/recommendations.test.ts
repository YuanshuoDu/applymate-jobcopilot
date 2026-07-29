import { describe, expect, it } from 'vitest'
import { extractRecommendationCards } from './recommendations'

describe('extractRecommendationCards', () => {
  it('extracts and deduplicates cards from an HTML digest without following links', () => {
    const cards = extractRecommendationCards({
      html: `
        <table><tr><td>Senior Software Engineer</td><td>Acme</td><td>Berlin, Germany</td><td><a href="https://jobs.example.com/123?utm_source=digest">View job</a></td></tr></table>
        <a href="https://jobs.example.com/123?utm_source=digest">Senior Software Engineer at Acme</a>
      `,
      platform: 'Example Jobs',
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      platform: 'Example Jobs',
      company: 'Acme',
      role: 'Senior Software Engineer',
      location: 'Berlin, Germany',
      url: 'https://jobs.example.com/123?utm_source=digest',
    })
  })

  it('extracts a text-only recommendation card', () => {
    const cards = extractRecommendationCards({
      text: 'Data Analyst at Northstar | Dublin, Ireland | €60k–€75k\nhttps://www.indeed.com/viewjob?jk=42',
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      platform: 'Indeed',
      company: 'Northstar',
      role: 'Data Analyst',
      location: 'Dublin, Ireland',
      salary: '€60k–€75k',
    })
  })
})
