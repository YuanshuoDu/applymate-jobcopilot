import { describe, expect, it } from 'vitest'

import {
  countInboxEmails,
  filterInboxEmails,
  formatInboxDate,
  GMAIL_INBOX_FILTER_KINDS,
  GMAIL_TAG_DISPLAY,
  type GmailEmail,
} from './inbox-model'

const emails: GmailEmail[] = [
  {
    id: 'application',
    threadId: 'thread-1',
    from: 'talent@example.com',
    name: 'Example Talent',
    subject: 'We received your application',
    preview: 'Thank you for applying.',
    date: '2026-07-29T08:00:00.000Z',
    tag: 'application_received',
    read: false,
    starred: true,
  },
  {
    id: 'interview',
    threadId: 'thread-2',
    from: 'recruiting@northwind.example',
    name: 'Northwind Recruiting',
    subject: 'Interview invitation',
    preview: 'Choose a time to meet the team.',
    date: '2026-07-28T08:00:00.000Z',
    tag: 'interview_invitation',
    read: true,
    starred: false,
  },
  {
    id: 'update',
    threadId: 'thread-3',
    from: 'jobs@example.com',
    name: 'Example Careers',
    subject: 'Application update',
    preview: 'Your application is being considered.',
    date: '2026-07-27T08:00:00.000Z',
    tag: 'application_update',
    read: false,
    starred: false,
  },
]

describe('Gmail inbox model', () => {
  it('maps only evidence-based lifecycle labels and never review or viewed', () => {
    expect(GMAIL_TAG_DISPLAY.application_received.label).toBe('Applied')
    expect(GMAIL_TAG_DISPLAY.interview_invitation.label).toBe('Interview')
    expect(Object.keys(GMAIL_TAG_DISPLAY)).not.toContain('review')
    expect(Object.keys(GMAIL_TAG_DISPLAY)).not.toContain('viewed')
    expect(GMAIL_INBOX_FILTER_KINDS).not.toContain('other')
  })

  it('formats today, recent, older, and invalid message dates', () => {
    const now = new Date('2026-07-29T12:30:00.000Z')

    expect(formatInboxDate('2026-07-29T08:05:00.000Z', now)).toBe(
      new Date('2026-07-29T08:05:00.000Z').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
    )
    expect(formatInboxDate('2026-07-28T08:00:00.000Z', now)).toBe(
      new Date('2026-07-28T08:00:00.000Z').toLocaleDateString('en', { weekday: 'short' }),
    )
    expect(formatInboxDate('2026-07-01T08:00:00.000Z', now)).toBe(
      new Date('2026-07-01T08:00:00.000Z').toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    )
    expect(formatInboxDate('not-a-date', now)).toBe('not-a-date')
  })

  it('filters legacy inbox messages by standard controls, evidence type, and search', () => {
    expect(filterInboxEmails(emails, 'unread').map((email) => email.id)).toEqual(['application', 'update'])
    expect(filterInboxEmails(emails, 'starred').map((email) => email.id)).toEqual(['application'])
    expect(filterInboxEmails(emails, 'interview_invitation').map((email) => email.id)).toEqual(['interview'])
    expect(filterInboxEmails(emails, 'all', 'northwind').map((email) => email.id)).toEqual(['interview'])
    expect(filterInboxEmails(emails, 'unread', 'interview')).toEqual([])
  })

  it('returns stable counts for the sidebar, including zero-value evidence types', () => {
    expect(countInboxEmails(emails)).toEqual({
      total: 3,
      unread: 2,
      starred: 1,
      byKind: {
        application_received: 1,
        interview_invitation: 1,
        offer: 0,
        rejection: 0,
        application_update: 1,
        recommendation_digest: 0,
        other: 0,
      },
    })
  })
})
