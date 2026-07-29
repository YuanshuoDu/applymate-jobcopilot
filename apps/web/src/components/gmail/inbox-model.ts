import type { GmailMessageKind } from '@/lib/gmail-tracking'

/** The message shape used by the original three-pane Gmail inbox. */
export interface GmailEmail {
  id: string
  threadId: string
  from: string
  name: string
  subject: string
  preview: string
  date: string
  tag: GmailMessageKind
  read: boolean
  starred: boolean
}

export type GmailInboxFilter = 'all' | 'unread' | 'starred' | GmailMessageKind

export interface GmailTagDisplay {
  label: string
  color: string
  background: string
}

export const GMAIL_TAG_DISPLAY: Record<GmailMessageKind, GmailTagDisplay> = {
  application_received: {
    label: 'Applied',
    color: 'var(--primary)',
    background: 'rgba(79,70,229,0.12)',
  },
  interview_invitation: {
    label: 'Interview',
    color: 'var(--c-success)',
    background: 'rgba(5,150,105,0.12)',
  },
  offer: {
    label: 'Offer',
    color: 'var(--c-info)',
    background: 'rgba(2,132,199,0.12)',
  },
  rejection: {
    label: 'Rejected',
    color: 'var(--c-danger)',
    background: 'rgba(220,38,38,0.12)',
  },
  application_update: {
    label: 'Employer update',
    color: 'var(--c-warning)',
    background: 'rgba(217,119,6,0.12)',
  },
  recommendation_digest: {
    label: 'Job recommendations',
    color: 'var(--primary)',
    background: 'rgba(79,70,229,0.12)',
  },
  other: {
    label: 'Other',
    color: 'var(--text-muted)',
    background: 'var(--bg-tertiary)',
  },
}

export const GMAIL_INBOX_FILTER_KINDS: readonly GmailMessageKind[] = [
  'application_received',
  'interview_invitation',
  'offer',
  'rejection',
  'application_update',
  'recommendation_digest',
]

export interface GmailInboxCounts {
  total: number
  unread: number
  starred: number
  byKind: Record<GmailMessageKind, number>
}

export function formatInboxDate(raw: string, now = new Date()): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw

  if (isSameCalendarDay(date, now)) {
    return date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
  }

  const elapsed = now.getTime() - date.getTime()
  if (elapsed >= 0 && elapsed < 7 * 86_400_000) {
    return date.toLocaleDateString('en', { weekday: 'short' })
  }

  return date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

export function filterInboxEmails(
  emails: readonly GmailEmail[],
  filter: GmailInboxFilter,
  search = '',
): GmailEmail[] {
  const query = search.trim().toLocaleLowerCase()

  return emails.filter((email) => {
    const matchesFilter = filter === 'all'
      || (filter === 'unread' && !email.read)
      || (filter === 'starred' && email.starred)
      || email.tag === filter
    if (!matchesFilter) return false

    return !query || [email.subject, email.name, email.from, email.preview]
      .some((value) => value.toLocaleLowerCase().includes(query))
  })
}

export function countInboxEmails(emails: readonly GmailEmail[]): GmailInboxCounts {
  const byKind = createEmptyKindCounts()
  let unread = 0
  let starred = 0

  for (const email of emails) {
    byKind[email.tag] += 1
    if (!email.read) unread += 1
    if (email.starred) starred += 1
  }

  return { total: emails.length, unread, starred, byKind }
}

function createEmptyKindCounts(): Record<GmailMessageKind, number> {
  return {
    application_received: 0,
    interview_invitation: 0,
    offer: 0,
    rejection: 0,
    application_update: 0,
    recommendation_digest: 0,
    other: 0,
  }
}

function isSameCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}
