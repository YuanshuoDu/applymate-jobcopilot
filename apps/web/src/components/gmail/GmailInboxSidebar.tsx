import type { GmailMessageKind } from '@/lib/gmail-tracking'
import { useI18n } from '@/lib/i18n'
import {
  GMAIL_INBOX_FILTER_KINDS,
  GMAIL_TAG_DISPLAY,
  type GmailInboxCounts,
  type GmailInboxFilter,
} from './inbox-model'

interface GmailInboxSidebarProps {
  activeFilter: GmailInboxFilter
  counts: GmailInboxCounts
  email: string | null | undefined
  onFilterChange: (filter: GmailInboxFilter) => void
}

const STANDARD_FILTERS: Array<{ key: GmailInboxFilter; labelKey: string; count: (counts: GmailInboxCounts) => number }> = [
  { key: 'all', labelKey: 'gmail.allEmails', count: counts => counts.total },
  { key: 'unread', labelKey: 'gmail.unreadFilter', count: counts => counts.unread },
  { key: 'starred', labelKey: 'gmail.starred', count: counts => counts.starred },
]

export function GmailInboxSidebar({ activeFilter, counts, email, onFilterChange }: GmailInboxSidebarProps) {
  const { t } = useI18n()
  return <aside style={{
    width: 186,
    flexShrink: 0,
    borderRight: '0.5px solid var(--border)',
    background: 'var(--bg-secondary)',
    padding: '10px 8px',
    overflowY: 'auto',
  }}>
    {STANDARD_FILTERS.map(item => <FilterButton
      key={item.key}
      active={activeFilter === item.key}
      label={t(item.labelKey)}
      count={item.count(counts)}
      onClick={() => onFilterChange(item.key)}
    />)}

    <div style={sectionLabel}>{t('gmail.byType')}</div>
    {GMAIL_INBOX_FILTER_KINDS.map(kind => <EvidenceFilterButton
      key={kind}
      kind={kind}
      active={activeFilter === kind}
      count={counts.byKind[kind]}
      onClick={() => onFilterChange(kind)}
    />)}

    {email && <div style={{ marginTop: 16, padding: '8px 10px', borderTop: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>{t('gmail.connectedAs')}</div>
      <div style={{ fontSize: 10, color: 'var(--text)', wordBreak: 'break-all' }}>{email}</div>
    </div>}
  </aside>
}

function FilterButton({ active, label, count, onClick }: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return <button type="button" onClick={onClick} style={{
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: 2,
    background: active ? 'rgba(79,70,229,0.12)' : 'transparent',
    color: active ? 'var(--primary)' : 'var(--text)', fontSize: 12, fontWeight: active ? 500 : 400,
  }}>
    <span>{label}</span><Count count={count} />
  </button>
}

function EvidenceFilterButton({ active, count, kind, onClick }: {
  active: boolean
  count: number
  kind: GmailMessageKind
  onClick: () => void
}) {
  const display = GMAIL_TAG_DISPLAY[kind]
  return <button type="button" onClick={onClick} style={{
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: 2,
    background: active ? display.background : 'transparent', color: active ? display.color : 'var(--text)', fontSize: 12,
  }}>
    <span>{display.label}</span>{count > 0 && <Count count={count} />}
  </button>
}

function Count({ count }: { count: number }) {
  return <span style={{ fontSize: 10, background: 'var(--bg-tertiary)', borderRadius: 999, padding: '1px 6px', color: 'var(--text-muted)' }}>{count}</span>
}

const sectionLabel = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 1.5,
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  padding: '12px 10px 4px',
}
