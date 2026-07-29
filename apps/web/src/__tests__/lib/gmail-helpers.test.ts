/**
 * Gmail helpers tests — classifyEmail and extractPlainText
 */
import { describe, it, expect } from 'vitest'
import { classifyEmail, extractPlainText } from '@/lib/gmail-helpers'

// ── classifyEmail ───────────────────────────────────────────────────────────────

describe('classifyEmail', () => {
  it('detects offer emails', () => {
    expect(classifyEmail('Congratulations on your offer', '')).toBe('offer')
    expect(classifyEmail('Job Offer - We are pleased to extend', '')).toBe('offer')
    expect(classifyEmail('', 'offer letter for the Software Engineer role')).toBe('offer')
  })

  it('detects rejection emails', () => {
    expect(classifyEmail('Unfortunately we are not moving forward', '')).toBe('rejection')
    expect(classifyEmail('', 'regret to inform you')).toBe('rejection')
    expect(classifyEmail('Your application was unsuccessful', '')).toBe('rejection')
    expect(classifyEmail('We have decided not to proceed', 'with other candidates')).toBe('rejection')
  })

  it('detects interview invitations', () => {
    expect(classifyEmail('Interview invitation for Monday', '')).toBe('interview_invitation')
    expect(classifyEmail('', 'Next step: schedule a call')).toBe('interview_invitation')
    expect(classifyEmail('Phone screen with the team', '')).toBe('interview_invitation')
    expect(classifyEmail('We would like to invite you', 'for a video call')).toBe('interview_invitation')
  })

  it('detects application received confirmations', () => {
    expect(classifyEmail('Thank you for applying', '')).toBe('application_received')
    expect(classifyEmail('', 'Application received - we have received your CV')).toBe('application_received')
  })

  it('does not promote profile views to an application state', () => {
    expect(classifyEmail('', 'A recruiter viewed your profile on LinkedIn')).toBe('other')
  })

  it('recognizes job-platform recommendation digests', () => {
    expect(classifyEmail('Weekly job alert', 'new positions this week')).toBe('recommendation_digest')
  })

  it('case-insensitive matching', () => {
    expect(classifyEmail('UNFORTUNATELY', '')).toBe('rejection')
    expect(classifyEmail('OFFER LETTER', '')).toBe('offer')
    expect(classifyEmail('INTERVIEW INVITATION', '')).toBe('interview_invitation')
  })

  it('searches both subject and snippet', () => {
    // Only in snippet
    expect(classifyEmail('Hello', 'we regret to inform you')).toBe('rejection')
    // Only in subject
    expect(classifyEmail('Congratulations!', '')).toBe('other')
  })
})

// ── extractPlainText ────────────────────────────────────────────────────────────

describe('extractPlainText', () => {
  it('extracts base64-encoded body from the root payload', () => {
    const encoded = Buffer.from('Hello from email body').toString('base64')
    const result = extractPlainText({
      body: { data: encoded },
    })
    expect(result).toBe('Hello from email body')
  })

  it('extracts text from a text/plain part in a multipart payload', () => {
    const encoded = Buffer.from('Plain text content').toString('base64')
    const result = extractPlainText({
      parts: [
        { mimeType: 'text/html', body: { data: 'encodedhtml' } },
        { mimeType: 'text/plain', body: { data: encoded } },
      ],
    })
    expect(result).toBe('Plain text content')
  })

  it('recursively extracts from nested parts', () => {
    const encoded = Buffer.from('Deeply nested text').toString('base64')
    const result = extractPlainText({
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: encoded } },
          ],
        },
      ],
    })
    expect(result).toBe('Deeply nested text')
  })

  it('returns empty string for payloads without text/plain', () => {
    const result = extractPlainText({
      parts: [
        { mimeType: 'text/html', body: { data: 'htmlstuff' } },
      ],
    })
    expect(result).toBe('')
  })

  it('returns empty string when body data is missing', () => {
    const result = extractPlainText({})
    expect(result).toBe('')
  })

  it('handles invalid base64 gracefully', () => {
    const result = extractPlainText({
      body: { data: '!!!not-valid-base64!!!' },
    })
    expect(result).toBe('')
  })
})
