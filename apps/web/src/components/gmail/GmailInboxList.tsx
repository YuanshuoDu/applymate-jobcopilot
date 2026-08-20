import { GmailTagBadge } from './GmailTagBadge'
import { formatInboxDate, type GmailEmail } from './inbox-model'
import { useI18n } from '@/lib/i18n'

interface GmailInboxListProps {
  emails: GmailEmail[]
  selectedId: string | null
  onSelect: (email: GmailEmail) => void
}

export function GmailInboxList({ emails, selectedId, onSelect }: GmailInboxListProps) {
  const { t } = useI18n()
  const selected = selectedId !== null
  return <section style={{
    width: selected ? 300 : undefined,
    flex: selected ? 'none' : 1,
    borderRight: selected ? '0.5px solid var(--border)' : 'none',
    overflowY: 'auto',
    background: 'var(--bg)',
  }}>
    {emails.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{t('gmail.noEmails')}</div>
      : emails.map(email => <EmailRow key={email.id} email={email} selected={selectedId === email.id} onSelect={onSelect} t={t} />)}
  </section>
}

function EmailRow({ email, selected, onSelect, t }: { email: GmailEmail; selected: boolean; onSelect: (email: GmailEmail) => void; t: (key: string) => string }) {
  const baseBackground = selected ? 'rgba(79,70,229,0.06)' : email.read ? 'var(--bg)' : 'rgba(24,95,165,0.03)'
  return <button type="button" onClick={() => onSelect(email)} style={{
    width: '100%', padding: '11px 14px', border: 'none', borderBottom: '0.5px solid var(--border)', cursor: 'pointer',
    background: baseBackground, textAlign: 'left', color: 'var(--text)', display: 'block',
  }} onMouseEnter={event => { if (!selected) event.currentTarget.style.background = 'var(--bg-secondary)' }} onMouseLeave={event => { if (!selected) event.currentTarget.style.background = baseBackground }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {!email.read && <span aria-label={t('gmail.unreadLabel')} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />}
        <span style={{ fontSize: 12, fontWeight: email.read ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {email.starred && <span aria-label={t('gmail.starredLabel')} style={{ color: '#F59E0B', fontSize: 11 }}>★</span>}
        <time style={{ fontSize: 10, color: 'var(--text-muted)' }}>{formatInboxDate(email.date)}</time>
      </div>
    </div>
    <div style={{ fontSize: 11, fontWeight: email.read ? 400 : 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email.subject}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <GmailTagBadge kind={email.tag} />
      <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email.preview}</span>
    </div>
  </button>
}
