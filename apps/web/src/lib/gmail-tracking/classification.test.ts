import { describe, expect, it } from 'vitest'
import { classifyGmailMessage, inferApplicationMetadata } from './classification'

describe('classifyGmailMessage', () => {
  it.each([
    ['Thank you for applying to Acme', 'We have received your application.', 'application_received'],
    ['Interview invitation', 'Please schedule an interview with the team.', 'interview_invitation'],
    ['Your job offer', 'We are pleased to extend an offer.', 'offer'],
    ['Application update', 'Unfortunately, we are not moving forward.', 'rejection'],
    ['Application status update', 'Your application is under review.', 'application_update'],
    ['Jobs for you this week', 'Recommended roles based on your profile.', 'recommendation_digest'],
    ['LinkedIn notification', 'A recruiter viewed your profile.', 'other'],
  ] as const)('classifies %s as %s', (subject, body, expected) => {
    expect(classifyGmailMessage({ subject, body })).toBe(expected)
  })

  it('does not misclassify a digest whose role title contains interview', () => {
    expect(classifyGmailMessage('Recommended jobs for you', 'Interview Coordinator at Acme')).toBe('recommendation_digest')
  })
})

describe('inferApplicationMetadata', () => {
  it('extracts the role and company from a standard application subject', () => {
    expect(inferApplicationMetadata('Application received: Senior Data Engineer at Acme Labs')).toEqual({
      company: 'Acme Labs',
      role: 'Senior Data Engineer',
    })
  })

  it('supports company-first interview subjects without guessing unknown data', () => {
    expect(inferApplicationMetadata('Northstar — Interview invitation for Product Manager')).toEqual({
      company: 'Northstar',
      role: 'Product Manager',
    })
    expect(inferApplicationMetadata('A message from the hiring team')).toEqual({ company: null, role: null })
  })
})
