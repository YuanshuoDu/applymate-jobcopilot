import { describe, expect, it } from 'vitest'
import { fillMissingResumeContactFields } from '@/lib/resume-contact-merge'
import type { ResumeContent } from '@/lib/types'

const content: ResumeContent = {
  contact: {
    name: 'Parsed Candidate',
    email: 'parsed@example.test',
    location: 'Dublin, Ireland',
    phone: '+0000000000',
    linkedin: 'linkedin.example/parsed-candidate',
  },
  summary: 'Technical support professional.',
  experience: [],
  education: [],
  skills: [],
}

describe('fillMissingResumeContactFields', () => {
  it('preserves parsed contact details when the account profile differs', () => {
    const { merged, persona } = fillMissingResumeContactFields(content, {
      email: 'account@example.test',
      phone: '+1111111111',
    })

    expect(merged.contact.email).toBe('parsed@example.test')
    expect(merged.contact.phone).toBe('+0000000000')
    expect(persona).toEqual({})
  })

  it('fills only missing contact details from the account profile', () => {
    const { merged, persona } = fillMissingResumeContactFields({
      ...content,
      contact: { ...content.contact, phone: '' },
    }, {
      email: 'account@example.test',
      phone: ' +1111111111 ',
    })

    expect(merged.contact.email).toBe('parsed@example.test')
    expect(merged.contact.phone).toBe('+1111111111')
    expect(persona).toEqual({ phone: true })
  })

  it('does not modify the parsed resume when the profile is empty', () => {
    const { merged, persona } = fillMissingResumeContactFields(content, {
      email: '   ',
      location: null,
    })

    expect(merged).toEqual(content)
    expect(persona).toEqual({})
  })
})
