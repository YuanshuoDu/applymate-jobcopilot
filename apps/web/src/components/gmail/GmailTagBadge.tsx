import type { GmailMessageKind } from '@/lib/gmail-tracking'
import { GMAIL_TAG_DISPLAY } from './inbox-model'

export function GmailTagBadge({ kind }: { kind: GmailMessageKind }) {
  const display = GMAIL_TAG_DISPLAY[kind]

  return <span style={{
    fontSize: 10,
    fontWeight: 500,
    color: display.color,
    background: display.background,
    borderRadius: 999,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  }}>{display.label}</span>
}
