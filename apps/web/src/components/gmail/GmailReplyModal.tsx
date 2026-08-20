import { useEffect, useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import type { GmailEmail } from './inbox-model'
import { useI18n } from '@/lib/i18n'

interface GmailReplyModalProps {
  email: GmailEmail
  body: string
  onClose: () => void
}

export function GmailReplyModal({ email, body, onClose }: GmailReplyModalProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/gmail/ai-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        emailBody: body,
        subject: email.subject,
        senderName: email.name,
        senderEmail: email.from,
        tag: email.tag,
      }),
    })
      .then(async response => ({ ok: response.ok, body: (await response.json()) as { reply?: string } }))
      .then(result => {
        if (result.ok && result.body.reply) setReply(result.body.reply)
        else setError(t('gmail.replyGenerationFailed'))
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setError(t('gmail.networkRetry'))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [body, email.from, email.name, email.subject, email.tag])

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(reply)
      setCopied(true)
      toast.success(t('gmail.copied'), t('gmail.replyCopied'))
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      toast.error(t('gmail.copyFailed'), t('gmail.copyManually'))
    }
  }

  async function sendFollowUp() {
    setSending(true)
    try {
      const response = await fetch('/api/gmail/send-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email.from, subject: `Re: ${email.subject}`, draft: reply, gmailMessageId: email.id, threadId: email.threadId, messageKind: email.tag }),
      })
      const result = await response.json() as { error?: string; tracked?: boolean }
      if (!response.ok) throw new Error(result.error ?? t('gmail.followUpFailed'))
      window.dispatchEvent(new Event('applymate:jobs-changed'))
      toast.success(t('gmail.followUpSent'), result.tracked ? t('gmail.trackedUpdated') : t('gmail.sentLinkToTrack'))
      onClose()
    } catch (error) {
      toast.error(t('gmail.followUpFailed'), error instanceof Error ? error.message : t('common.tryAgain'))
    } finally {
      setSending(false)
    }
  }

  return <div role="dialog" aria-modal="true" aria-label={t('gmail.aiFollowUpDraft')} style={overlayStyle}>
    <div style={modalStyle}>
      <header style={headerStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{t('gmail.aiFollowUpDraft')}</div>
          <div style={subheaderStyle}>{t('gmail.to')}: <strong>{email.name}</strong> &lt;{email.from}&gt;</div>
          <div style={subheaderStyle}>{t('gmail.re')}: {email.subject}</div>
        </div>
        <Btn small variant="ghost" onClick={onClose}>✕</Btn>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {loading ? <LoadingReply /> : error ? <div style={{ fontSize: 12, color: 'var(--c-danger)' }}>{error}</div> : <textarea value={reply} onChange={event => setReply(event.target.value)} style={textareaStyle} />}
      </div>
      <footer style={footerStyle}>
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        {!loading && !error && <><Btn variant="ghost" onClick={() => void copyToClipboard()}>{copied ? `✓ ${t('gmail.copied')}` : `📋 ${t('gmail.copyText')}`}</Btn><Btn variant="primary" disabled={sending || !reply.trim()} onClick={() => void sendFollowUp()}>{sending ? t('gmail.sending') : `✉ ${t('gmail.sendFollowUp')}`}</Btn></>}
      </footer>
    </div>
  </div>
}

function LoadingReply() {
  const { t } = useI18n()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
    <div style={{ width: 14, height: 14, border: '2px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    {t('gmail.generatingReply')}
  </div>
}

const overlayStyle = { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modalStyle = { background: 'var(--bg)', borderRadius: 12, width: '100%', maxWidth: 560, boxShadow: '0 8px 32px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column' as const, maxHeight: '80vh' }
const headerStyle = { padding: '16px 20px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }
const subheaderStyle = { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }
const footerStyle = { padding: '12px 20px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap' as const, justifyContent: 'flex-end' }
const textareaStyle = { width: '100%', minHeight: 200, fontSize: 12, lineHeight: 1.7, color: 'var(--text)', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 6, padding: '10px 12px', resize: 'vertical' as const, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' as const }
