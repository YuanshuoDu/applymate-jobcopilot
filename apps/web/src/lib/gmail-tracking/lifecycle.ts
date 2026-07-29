import type { JobStatus } from '@prisma/client'
import type { GmailMessageKind } from './classification'

const STATUS_BY_MESSAGE_KIND: Partial<Record<GmailMessageKind, JobStatus>> = {
  application_received: 'applied',
  interview_invitation: 'interview',
  offer: 'offer',
  rejection: 'rejected',
}

/** Returns a lifecycle status only for email evidence that can establish one. */
export function statusForGmailMessage(kind: GmailMessageKind): JobStatus | null {
  return STATUS_BY_MESSAGE_KIND[kind] ?? null
}

/**
 * Email evidence must not move a job backward or replace a terminal outcome.
 * An interview can follow a receipt; an offer or rejection can follow either.
 */
export function canApplyGmailStatus(current: JobStatus, next: JobStatus): boolean {
  if (current === next) return false
  if (current === 'offer' || current === 'rejected') return false
  if (next === 'applied') return current === 'saved'
  if (next === 'interview') return current === 'saved' || current === 'applied'
  if (next === 'offer' || next === 'rejected') return true
  return false
}

export function activityTypeForGmailMessage(kind: GmailMessageKind) {
  if (kind === 'interview_invitation') return 'interview_scheduled' as const
  if (kind === 'offer') return 'offer_received' as const
  if (kind === 'rejection') return 'rejected' as const
  return kind === 'application_update' ? 'note_added' as const : 'status_changed' as const
}

export function gmailEventLabel(kind: GmailMessageKind): string {
  const labels: Record<GmailMessageKind, string> = {
    application_received: 'application receipt',
    interview_invitation: 'interview invitation',
    offer: 'offer',
    rejection: 'rejection',
    application_update: 'employer update',
    recommendation_digest: 'job recommendations',
    other: 'email update',
  }
  return labels[kind]
}
