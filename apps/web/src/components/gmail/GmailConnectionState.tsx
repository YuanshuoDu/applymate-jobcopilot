import { MailCheck, RefreshCw } from 'lucide-react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'

export type GmailConnectionState = 'loading' | 'no_google' | 'no_gmail' | 'error'

interface GmailConnectionScreenProps {
  state: GmailConnectionState
  onConnect: () => void
  onRetry: () => void
}

export function GmailConnectionScreen({ state, onConnect, onRetry }: GmailConnectionScreenProps) {
  if (state === 'loading') return <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
    <TopBar title="Gmail Tracker" />
    <div style={centered}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}><RefreshCw size={24} className="gmail-spin" /><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading Gmail…</div></div></div>
  </div>

  const missingGoogle = state === 'no_google'
  const reconnect = state === 'no_gmail'
  const title = missingGoogle ? 'Connect your Google Account' : reconnect ? 'Authorize Gmail Access' : 'Failed to load Gmail'
  const description = missingGoogle
    ? 'Sign in with Google to enable job-related email tracking. ApplyMate reads your job emails but never sends or changes your inbox without confirmation.'
    : reconnect
      ? 'Your Google account is connected, but Gmail access needs to be authorized. Google will ask you to approve Gmail read access.'
      : 'Try again, or reconnect Gmail if the problem continues.'

  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
    <TopBar title="Gmail Tracker" />
    <div style={{ ...centered, background: 'var(--bg-tertiary)' }}>
      <Card style={{ padding: 40, maxWidth: 440, textAlign: 'center' }}>
        <span style={{ margin: '0 auto 16px', width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(79,70,229,0.10)', color: 'var(--primary)' }}><MailCheck size={22} /></span>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.75, marginBottom: 24 }}>{description}</div>
        {missingGoogle || reconnect ? <Btn variant="primary" onClick={onConnect}>{missingGoogle ? 'Sign in with Google' : 'Authorize Gmail Access'}</Btn> : <><Btn variant="ghost" onClick={onConnect}>Reconnect Google</Btn><Btn variant="primary" onClick={onRetry} style={{ marginLeft: 8 }}>Retry</Btn></>}
        {(missingGoogle || reconnect) && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16 }}>ApplyMate requests <strong>read</strong> access to scan job-related emails. It never sends or modifies your inbox without confirmation.</div>}
      </Card>
    </div>
  </div>
}

const centered = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }
