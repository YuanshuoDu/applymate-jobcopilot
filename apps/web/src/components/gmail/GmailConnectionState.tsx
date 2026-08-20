import { MailCheck, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, Card } from '@/components/ui'
import { useI18n } from '@/lib/i18n'

export type GmailConnectionState = 'loading' | 'no_google' | 'no_gmail' | 'error'

interface GmailConnectionScreenProps {
  state: GmailConnectionState
  onConnect: () => void
  onRetry: () => void
  pageTitle?: string
  titleAccessory?: ReactNode
}

export function GmailConnectionScreen({ state, onConnect, onRetry, pageTitle, titleAccessory }: GmailConnectionScreenProps) {
  const { t } = useI18n()
  const resolvedPageTitle = pageTitle ?? t('gmail.title')
  if (state === 'loading') return <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
    <TopBar title={resolvedPageTitle} titleAccessory={titleAccessory} />
    <div style={centered}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}><RefreshCw size={24} className="gmail-spin" /><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('gmail.loading')}</div></div></div>
  </div>

  const missingGoogle = state === 'no_google'
  const reconnect = state === 'no_gmail'
  const title = missingGoogle ? t('gmail.connectAccount') : reconnect ? t('gmail.authorizeTitle') : t('gmail.loadFailed')
  const description = missingGoogle
    ? t('gmail.googleDescription')
    : reconnect
      ? t('gmail.reauthorizeDescription')
      : t('gmail.retryDescription')

  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
    <TopBar title={resolvedPageTitle} titleAccessory={titleAccessory} />
    <div style={{ ...centered, background: 'var(--bg-tertiary)' }}>
      <Card style={{ padding: 40, maxWidth: 440, textAlign: 'center' }}>
        <span style={{ margin: '0 auto 16px', width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'rgba(79,70,229,0.10)', color: 'var(--primary)' }}><MailCheck size={22} /></span>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.75, marginBottom: 24 }}>{description}</div>
        {(missingGoogle || reconnect) ? (
          <Btn variant="primary" onClick={onConnect}>{missingGoogle ? t('gmail.connectGoogle') : t('gmail.authorize')}</Btn>
        ) : (
          <><Btn variant="ghost" onClick={onConnect}>{t('gmail.reconnect')}</Btn><Btn variant="primary" onClick={onRetry} style={{ marginLeft: 8 }}>{t('gmail.retry')}</Btn></>
        )}
        {(missingGoogle || reconnect) && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16 }}>{t('gmail.readAccess')}</div>
        )}
      </Card>
    </div>
  </div>
}

const centered = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }
