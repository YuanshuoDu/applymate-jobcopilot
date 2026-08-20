import type { GmailMessageKind } from '@/lib/gmail-tracking'
import { GMAIL_TAG_DISPLAY } from './inbox-model'
import { useI18n } from '@/lib/i18n'

export function GmailTagBadge({ kind }: { kind: GmailMessageKind }) {
  const display = GMAIL_TAG_DISPLAY[kind]
  const { t } = useI18n()
  const labelKey: Record<GmailMessageKind, string> = {
    application_received: 'gmail.tag.applied',
    interview_invitation: 'gmail.tag.interview',
    offer: 'gmail.tag.offer',
    rejection: 'gmail.tag.rejected',
    application_update: 'gmail.tag.applicationUpdate',
    recommendation_digest: 'gmail.tag.recommendations',
    other: 'gmail.tag.other',
  }

  return <span style={{
    fontSize: 10,
    fontWeight: 500,
    color: display.color,
    background: display.background,
    borderRadius: 999,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  }}>{t(labelKey[kind])}</span>
}
