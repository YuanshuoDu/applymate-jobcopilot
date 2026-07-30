import { useEffect, useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import { GmailReplyModal } from './GmailReplyModal'
import { GmailTagBadge } from './GmailTagBadge'
import { formatInboxDate, type GmailEmail } from './inbox-model'

interface GmailMessageReaderProps {
  email: GmailEmail
  onClose: () => void
  onStar: (id: string) => void
  onMarkRead: (id: string) => void
}

const URL_SPLIT = /(https?:\/\/[^\s<>"]+)/g
const URL_ONLY = /^https?:\/\//i

export function GmailMessageReader({ email, onClose, onStar, onMarkRead }: GmailMessageReaderProps) {
  const { lang } = useI18n()
  const toast = useToast()
  const [body, setBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [translated, setTranslated] = useState<string | null>(null)
  const [showTranslated, setShowTranslated] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [showReply, setShowReply] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setBody(null); setLoading(true); setTranslated(null); setShowTranslated(false); setShowReply(false)
    onMarkRead(email.id)
    void fetch(`/api/gmail/message/${email.id}`, { signal: controller.signal })
      .then(async response => ({ ok: response.ok, body: (await response.json()) as { body?: string } }))
      .then(result => setBody(result.ok ? result.body.body?.trim() || email.preview : email.preview))
      .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) setBody(email.preview) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [email.id, email.preview, onMarkRead])

  const displayBody = showTranslated && translated ? translated : body
  const canReply = email.tag !== 'other' && email.tag !== 'recommendation_digest'

  async function translateMessage() {
    if (translated) { setShowTranslated(value => !value); return }
    if (!body) return
    setTranslating(true)
    try {
      const response = await fetch('/api/ai/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body.slice(0, 3_500), targetLang: lang === 'zh' ? 'en' : 'zh' }),
      })
      const result = await response.json() as { translated?: string }
      if (!result.translated) throw new Error('Missing translation')
      setTranslated(result.translated); setShowTranslated(true)
    } catch {
      toast.error('Translation failed', 'Please try again')
    } finally {
      setTranslating(false)
    }
  }

  return <>
    <article style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: '0.5px solid var(--border)', background: 'var(--bg)', minWidth: 0 }}>
      <header style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, lineHeight: 1.3 }}>{email.subject}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <GmailTagBadge kind={email.tag} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}><strong>{email.name}</strong> &lt;{email.from}&gt;</span>
            <time style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatInboxDate(email.date)}</time>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
          <button type="button" onClick={() => onStar(email.id)} title="Star" aria-label={email.starred ? 'Unstar email' : 'Star email'} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: email.starred ? '#F59E0B' : 'var(--text-muted)', padding: '0 4px', lineHeight: 1 }}>{email.starred ? '★' : '☆'}</button>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
      </header>
      {showTranslated && <div style={{ padding: '4px 18px', background: 'rgba(79,70,229,0.06)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontSize: 10, color: 'var(--primary)' }}>🌐 {lang === 'zh' ? 'Translated to English' : '已翻译为中文'}</span><button type="button" onClick={() => setShowTranslated(false)} style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>Show original</button></div>}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>{loading ? <LoadingMessage /> : displayBody && <RichEmailBody text={displayBody} />}</div>
      <footer style={{ padding: '10px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn variant="ghost" onClick={() => window.open(`https://mail.google.com/mail/#inbox/${email.threadId}`, '_blank')}>Open in Gmail ↗</Btn>
        {!loading && body && <button type="button" onClick={() => void translateMessage()} disabled={translating} style={translateButton(showTranslated, translating)}>{translating ? '⏳ Translating…' : showTranslated ? (lang === 'zh' ? '显示原文' : 'Show original') : (lang === 'zh' ? '🌐 翻译' : '🌐 Translate')}</button>}
        {!loading && !canReply && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>AI follow-up is available for application emails.</span>}
        {canReply && !loading && <Btn variant="primary" onClick={() => setShowReply(true)} style={{ marginLeft: 'auto' }}>✨ AI follow-up</Btn>}
      </footer>
    </article>
    {showReply && <GmailReplyModal email={email} body={body ?? email.preview} onClose={() => setShowReply(false)} />}
  </>
}

function LoadingMessage() {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}><div style={{ width: 14, height: 14, border: '2px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Loading message…</div>
}

function RichEmailBody({ text }: { text: string }) {
  let inSignature = false
  return <div style={{ fontFamily: 'inherit' }}>{text.split('\n').map((raw, index) => {
    const trimmed = raw.trim()
    if (trimmed === '--' || trimmed === '—') inSignature = true
    if (/^[-=_*]{3,}$/.test(trimmed)) return <hr key={index} style={{ border: 'none', borderTop: '0.5px solid var(--border)', margin: '10px 0' }} />
    const heading = !inSignature && trimmed.length > 0 && trimmed.length <= 60 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)
    return <div key={index} style={{ fontSize: heading ? 11 : 12, fontWeight: heading ? 700 : 400, color: heading ? 'var(--text)' : inSignature ? 'var(--text-muted)' : 'var(--text)', letterSpacing: heading ? 0.4 : 0, marginTop: heading ? 14 : 0, lineHeight: 1.75, opacity: inSignature ? 0.7 : 1 }}>{linkify(raw)}</div>
  })}</div>
}

function linkify(value: string) {
  return value.split(URL_SPLIT).map((part, index) => URL_ONLY.test(part) ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', textDecoration: 'underline', wordBreak: 'break-all' }}>{part.length > 60 ? `${part.slice(0, 57)}…` : part}</a> : part || <span key={index}>&nbsp;</span>)
}

function translateButton(active: boolean, loading: boolean) {
  return { padding: '5px 12px', fontSize: 11, borderRadius: 6, border: `0.5px solid ${active ? 'var(--primary)' : 'var(--border)'}`, background: active ? 'rgba(79,70,229,0.08)' : 'var(--bg-secondary)', color: active ? 'var(--primary)' : 'var(--text-muted)', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }
}
