'use client'

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { TopBar }              from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'
import { useI18n }             from '@/lib/i18n'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GmailEmail {
  id:       string
  threadId: string
  from:     string
  name:     string
  subject:  string
  preview:  string
  date:     string
  tag:      string
  read:     boolean
  starred:  boolean
}

type GmailStatus = 'loading' | 'no_google' | 'no_gmail' | 'ready' | 'error'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAG_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  interview: { label: 'Interview',  color: 'var(--c-success)', bg: 'rgba(5,150,105,0.12)'   },
  offer:     { label: 'Offer 🎉',  color: 'var(--c-info)', bg: 'rgba(2,132,199,0.12)'  },
  rejected:  { label: 'Rejected',   color: 'var(--c-danger)', bg: 'rgba(220,38,38,0.12)'   },
  review:    { label: 'In Review',  color: 'var(--c-warning)', bg: 'rgba(217,119,6,0.12)'   },
  received:  { label: 'Received',   color: 'var(--primary)', bg: 'rgba(79,70,229,0.12)'   },
  viewed:    { label: 'Viewed',     color: '#6B7280', bg: 'rgba(107,114,128,0.12)' },
}

function fmtEmailDate(raw: string): string {
  try {
    const d   = new Date(raw)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 86_400_000 && d.getDate() === now.getDate())
      return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
    if (diff < 7 * 86_400_000)
      return d.toLocaleDateString('en', { weekday: 'short' })
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
  } catch { return raw }
}

// ── TagBadge ──────────────────────────────────────────────────────────────────

function TagBadge({ tag }: { tag: string }) {
  const cfg = TAG_CONFIG[tag] ?? TAG_CONFIG.received
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color: cfg.color, background: cfg.bg, borderRadius: 999, padding: '2px 7px', whiteSpace: 'nowrap', flexShrink: 0 }}>
      {cfg.label}
    </span>
  )
}

// ── ConnectPrompt ─────────────────────────────────────────────────────────────

function ConnectPrompt({ status, onConnect }: { status: GmailStatus; onConnect: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
      <Card style={{ padding: 40, maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
          {status === 'no_google' ? 'Connect your Google Account' : 'Authorize Gmail Access'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.75, marginBottom: 24 }}>
          {status === 'no_google'
            ? 'Sign in with Google to enable AI-powered email tracking. ApplyMate will automatically detect and categorize job applications, interviews, rejections, and offer letters in your inbox.'
            : 'Your Google account is connected, but Gmail access needs to be authorized. Click below — Google will ask you to approve Gmail read access.'}
        </div>
        <Btn variant="primary" onClick={onConnect}>
          {status === 'no_google' ? 'Sign in with Google' : 'Authorize Gmail Access'}
        </Btn>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16 }}>
          ApplyMate requests <strong>read</strong> access to scan your job-related emails. We never send emails or modify your inbox without your confirmation.
        </div>
      </Card>
    </div>
  )
}

// ── ReplyModal ────────────────────────────────────────────────────────────────

interface ReplyModalProps {
  email:    GmailEmail
  body:     string
  onClose:  () => void
}

function ReplyModal({ email, body, onClose }: ReplyModalProps) {
  const [reply,       setReply]       = useState('')
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [copied,      setCopied]      = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetch('/api/gmail/ai-reply', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        emailBody:   body,
        subject:     email.subject,
        senderName:  email.name,
        senderEmail: email.from,
        tag:         email.tag,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.reply) setReply(d.reply)
        else setError('Could not generate reply.')
      })
      .catch(() => setError('Network error. Please try again.'))
      .finally(() => setLoading(false))
  }, [email, body])

  function copyToClipboard() {
    navigator.clipboard.writeText(reply).then(() => {
      setCopied(true)
      toast.success('Copied!', 'Reply text copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function openGmail() {
    const subject = encodeURIComponent(`Re: ${email.subject}`)
    const bodyEnc = encodeURIComponent(reply)
    const to      = encodeURIComponent(email.from)
    window.open(`https://mail.google.com/mail/?view=cm&to=${to}&su=${subject}&body=${bodyEnc}`, '_blank')
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: 'var(--bg)', borderRadius: 12, width: '100%', maxWidth: 560,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', maxHeight: '80vh',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>AI Reply Draft</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              To: <strong>{email.name}</strong> &lt;{email.from}&gt;
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Re: {email.subject}
            </div>
          </div>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
              <div style={{ width: 14, height: 14, border: '2px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Generating reply with AI…
            </div>
          ) : error ? (
            <div style={{ fontSize: 12, color: 'var(--c-danger)' }}>{error}</div>
          ) : (
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              style={{
                width: '100%', minHeight: 200, fontSize: 12, lineHeight: 1.7,
                color: 'var(--text)', background: 'var(--bg-secondary)',
                border: '0.5px solid var(--border)', borderRadius: 6,
                padding: '10px 12px', resize: 'vertical', outline: 'none',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          {!loading && !error && (
            <>
              <Btn variant="ghost" onClick={copyToClipboard}>
                {copied ? '✓ Copied' : '📋 Copy Text'}
              </Btn>
              <Btn variant="primary" onClick={openGmail}>
                ✉ Open in Gmail
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── RichEmailBody ─────────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s<>"]+)/g

function RichEmailBody({ text }: { text: string }) {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []

  let inSignature = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    // Signature block (-- alone on a line)
    if (trimmed === '--' || trimmed === '—') { inSignature = true }

    // Separator line
    if (/^[-=_*]{3,}$/.test(trimmed)) {
      nodes.push(<hr key={i} style={{ border: 'none', borderTop: '0.5px solid var(--border)', margin: '10px 0' }} />)
      continue
    }

    // Detect heading: short line (≤60 chars), ALL-CAPS with letters, or ends with ':'
    const isHeading = !inSignature && trimmed.length > 0 && trimmed.length <= 60
      && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)

    // Build inline content (linkify URLs)
    const parts = raw.split(URL_RE)
    const inline = parts.map((part, j) =>
      URL_RE.test(part)
        ? <a key={j} href={part} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--primary)', textDecoration: 'underline', wordBreak: 'break-all' }}>
            {part.length > 60 ? part.slice(0, 57) + '…' : part}
          </a>
        : part
    )

    nodes.push(
      <div key={i} style={{
        fontSize: isHeading ? 11 : 12,
        fontWeight: isHeading ? 700 : inSignature ? 400 : 400,
        color: isHeading ? 'var(--text)' : inSignature ? 'var(--text-muted)' : 'var(--text)',
        letterSpacing: isHeading ? 0.4 : 0,
        marginTop: isHeading ? 14 : 0,
        lineHeight: 1.75,
        opacity: inSignature ? 0.7 : 1,
      }}>
        {inline.length === 1 && inline[0] === '' ? <>&nbsp;</> : inline}
      </div>
    )
  }

  return <div style={{ fontFamily: 'inherit' }}>{nodes}</div>
}

// ── EmailBody ─────────────────────────────────────────────────────────────────

function EmailBody({ email, onClose, onStar, onMarkRead }: {
  email:      GmailEmail
  onClose:    () => void
  onStar:     (id: string) => void
  onMarkRead: (id: string) => void
}) {
  const [body,          setBody]          = useState<string | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [showReply,     setShowReply]     = useState(false)
  const [translated,    setTranslated]    = useState<string | null>(null)
  const [translating,   setTranslating]   = useState(false)
  const [showTranslated,setShowTranslated]= useState(false)
  const { lang } = useI18n()
  const toast = useToast()

  useEffect(() => {
    setTranslated(null); setShowTranslated(false)
    onMarkRead(email.id)
    fetch(`/api/gmail/message/${email.id}`)
      .then(r => r.json())
      .then(d => setBody(d.body?.trim() || email.preview))
      .catch(() => setBody(email.preview))
      .finally(() => setLoading(false))
  }, [email.id, email.preview, onMarkRead])

  async function handleTranslate() {
    if (translated) { setShowTranslated(v => !v); return }
    if (!body) return
    setTranslating(true)
    try {
      const targetLang = lang === 'zh' ? 'en' : 'zh'
      const res = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body.slice(0, 3500), targetLang }),
      })
      const data = await res.json()
      if (data.translated) {
        setTranslated(data.translated)
        setShowTranslated(true)
      } else {
        toast.error('Translation failed', 'Please try again')
      }
    } catch {
      toast.error('Network error', 'Could not reach translation service')
    } finally {
      setTranslating(false)
    }
  }

  const canReply   = ['interview', 'offer', 'rejected', 'review', 'received', 'viewed'].includes(email.tag)
  const displayBody = showTranslated && translated ? translated : body

  return (
    <>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: '0.5px solid var(--border)', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6, lineHeight: 1.3 }}>{email.subject}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TagBadge tag={email.tag} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              <strong>{email.name}</strong> &lt;{email.from}&gt;
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtEmailDate(email.date)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
          <button
            onClick={() => { onStar(email.id); toast.info(email.starred ? 'Unstarred' : 'Starred') }}
            title="Star"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: email.starred ? '#F59E0B' : 'var(--text-muted)', padding: '0 4px', lineHeight: 1 }}>
            {email.starred ? '★' : '☆'}
          </button>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
      </div>

      {/* Translate banner */}
      {showTranslated && (
        <div style={{ padding: '4px 18px', background: 'rgba(79,70,229,0.06)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--primary)' }}>🌐 {lang === 'zh' ? 'Translated to English' : '已翻译为中文'}</span>
          <button onClick={() => setShowTranslated(false)}
            style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Show original
          </button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
            <div style={{ width: 14, height: 14, border: '2px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            Loading message…
          </div>
        ) : displayBody ? (
          <RichEmailBody text={displayBody} />
        ) : null}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn variant="ghost" onClick={() => window.open(`https://mail.google.com/mail/#inbox/${email.threadId}`, '_blank')}>
          Open in Gmail ↗
        </Btn>
        {!loading && body && (
          <button onClick={handleTranslate} disabled={translating}
            style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 6,
              border: `0.5px solid ${showTranslated ? 'var(--primary)' : 'var(--border)'}`,
              background: showTranslated ? 'rgba(79,70,229,0.08)' : 'var(--bg-secondary)',
              color: showTranslated ? 'var(--primary)' : 'var(--text-muted)',
              cursor: translating ? 'default' : 'pointer', opacity: translating ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
            {translating ? '⏳' : '🌐'} {translating ? (lang === 'zh' ? '翻译中…' : 'Translating…') : showTranslated ? (lang === 'zh' ? '显示原文' : 'Show original') : (lang === 'zh' ? '翻译' : 'Translate')}
          </button>
        )}
        {canReply && !loading && (
          <Btn variant="primary" onClick={() => setShowReply(true)} style={{ marginLeft: 'auto' }}>
            ✨ AI Reply
          </Btn>
        )}
      </div>
    </div>

    {showReply && (
      <ReplyModal
        email={email}
        body={body ?? email.preview}
        onClose={() => setShowReply(false)}
      />
    )}
    </>
  )
}

// ── GmailPage ─────────────────────────────────────────────────────────────────

export function GmailPage() {
  const toast = useToast()
  const { data: session } = useSession()

  const [status,     setStatus]     = useState<GmailStatus>('loading')
  const [emails,     setEmails]     = useState<GmailEmail[]>([])
  const [selected,   setSelected]   = useState<GmailEmail | null>(null)
  const [filter,     setFilter]     = useState('all')
  const [search,     setSearch]     = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // Prevent double-auth-redirect: track if we already triggered the OAuth flow
  const authTriggeredRef = useRef(false)

  const loadEmails = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!silent) setStatus('loading')
    else         setRefreshing(true)

    try {
      const res  = await fetch('/api/gmail/threads', { signal })
      const body = await res.json()

      if (!res.ok) {
        const code = (body.error ?? '') as string

        if (code === 'NO_GOOGLE_ACCOUNT') {
          setStatus('no_google')
          return
        }

        // Scope missing or token expired/invalid → show connect prompt, do NOT auto-redirect
        if (code === 'GMAIL_REAUTH' || code === 'GMAIL_SCOPE_MISSING' || code === 'GMAIL_PERMISSION' || code === 'TOKEN_EXPIRED') {
          setStatus('no_gmail')
          return
        }

        setStatus('error')
        return
      }

      setEmails(body.emails ?? [])
      setStatus('ready')
      if (silent) toast.success('Refreshed', `${(body.emails ?? []).length} emails loaded`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus('error')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    const controller = new AbortController()
    // Detect if returning from Gmail OAuth — show success toast and force reload
    const params = new URLSearchParams(window.location.search)
    if (params.get('gmailAuth') === '1') {
      const url = new URL(window.location.href)
      url.searchParams.delete('gmailAuth')
      window.history.replaceState({}, '', url)
      toast.success('Google account connected!', 'Loading your Gmail…')
    }
    const gErr = params.get('gmailError')
    if (gErr) {
      const url = new URL(window.location.href)
      url.searchParams.delete('gmailError')
      window.history.replaceState({}, '', url)
      toast.error('Gmail connection failed', gErr)
    }
    void loadEmails(false, controller.signal)
    return () => controller.abort()
  }, [loadEmails, toast])

  function connectGoogle() {
    if (authTriggeredRef.current) return
    authTriggeredRef.current = true
    // Use the dedicated Gmail OAuth flow rather than NextAuth's signIn — that one
    // would change the session identity and refuses to link a Google account whose
    // email differs from the current user's email. Our flow attaches Google tokens
    // to the existing user without touching the session.
    window.location.href = '/api/gmail/oauth/start'
  }

  const toggleStar = useCallback((id: string) => {
    setEmails(prev => prev.map(e => e.id === id ? { ...e, starred: !e.starred } : e))
    if (selected?.id === id) setSelected(s => s ? { ...s, starred: !s.starred } : s)
  }, [selected?.id])

  const markRead = useCallback((id: string) => {
    setEmails(prev => prev.map(e => e.id === id ? { ...e, read: true } : e))
  }, [])

  // ── Derived lists ─────────────────────────────────────────────────────────

  const { filtered, unreadCount, starredCount, tagCounts } = useMemo(() => {
    const nextTagCounts: Record<string, number> = {}
    const normalizedSearch = search.toLowerCase()
    let nextUnreadCount = 0
    let nextStarredCount = 0
    const nextFiltered = emails.filter(email => {
      if (!email.read) nextUnreadCount += 1
      if (email.starred) nextStarredCount += 1
      nextTagCounts[email.tag] = (nextTagCounts[email.tag] ?? 0) + 1

      const matchesFilter = filter === 'all'
        || (filter === 'starred' && email.starred)
        || (filter === 'unread' && !email.read)
        || email.tag === filter
      const matchesSearch = !normalizedSearch
        || [email.subject, email.name, email.from].some(text => text.toLowerCase().includes(normalizedSearch))
      return matchesFilter && matchesSearch
    })
    return { filtered: nextFiltered, unreadCount: nextUnreadCount, starredCount: nextStarredCount, tagCounts: nextTagCounts }
  }, [emails, filter, search])

  // ── Loading / error / connect states ──────────────────────────────────────

  if (status === 'loading') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Gmail Tracker" />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 24, height: 24, border: '2.5px solid rgba(79,70,229,0.15)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading Gmail…</div>
        </div>
      </div>
    </div>
  )

  if (status === 'no_google' || status === 'no_gmail') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Gmail Tracker" />
      <ConnectPrompt status={status} onConnect={connectGoogle} />
    </div>
  )

  if (status === 'error') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Gmail Tracker" />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Card style={{ padding: 32, textAlign: 'center', maxWidth: 360 }}>
          <div style={{ fontSize: 13, color: 'var(--c-danger)', marginBottom: 12 }}>Failed to load Gmail</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <Btn variant="ghost"   onClick={connectGoogle}>Reconnect Google</Btn>
            <Btn variant="primary" onClick={() => { authTriggeredRef.current = false; loadEmails() }}>Retry</Btn>
          </div>
        </Card>
      </div>
    </div>
  )

  // ── Ready ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar title="Gmail Tracker">
        {unreadCount > 0 && (
          <span style={{ fontSize: 11, background: 'var(--primary)', color: '#fff', borderRadius: 999, padding: '2px 8px', fontWeight: 500 }}>
            {unreadCount} unread
          </span>
        )}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search emails…"
          style={{ width: 200, padding: '5px 10px', fontSize: 12, border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
        />
        <Btn variant="ghost" onClick={() => loadEmails(true)} disabled={refreshing}>
          {refreshing ? '…' : '⟳ Refresh'}
        </Btn>
      </TopBar>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Filter sidebar ── */}
        <div style={{ width: 186, flexShrink: 0, borderRight: '0.5px solid var(--border)', background: 'var(--bg-secondary)', padding: '10px 8px', overflowY: 'auto' }}>
          {[
            { key: 'all',     label: 'All Emails', count: emails.length      },
            { key: 'unread',  label: 'Unread',      count: unreadCount         },
            { key: 'starred', label: 'Starred',     count: starredCount },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: 2,
              background: filter === f.key ? 'rgba(79,70,229,0.12)' : 'transparent',
              color: filter === f.key ? 'var(--primary)' : 'var(--text)',
              fontSize: 12, fontWeight: filter === f.key ? 500 : 400,
            }}>
              <span>{f.label}</span>
              <span style={{ fontSize: 10, background: 'var(--bg-tertiary)', borderRadius: 999, padding: '1px 6px', color: 'var(--text-muted)' }}>{f.count}</span>
            </button>
          ))}

          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '12px 10px 4px' }}>By Type</div>

          {Object.entries(TAG_CONFIG).map(([tag, cfg]) => (
            <button key={tag} onClick={() => setFilter(tag)} style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: 2,
              background: filter === tag ? cfg.bg : 'transparent',
              color: filter === tag ? cfg.color : 'var(--text)',
              fontSize: 12,
            }}>
              <span>{cfg.label}</span>
              {tagCounts[tag] != null && (
                <span style={{ fontSize: 10, background: 'var(--bg-tertiary)', borderRadius: 999, padding: '1px 6px', color: 'var(--text-muted)' }}>{tagCounts[tag]}</span>
              )}
            </button>
          ))}

          {/* Account info */}
          {session?.user?.email && (
            <div style={{ marginTop: 16, padding: '8px 10px', borderTop: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>Connected as</div>
              <div style={{ fontSize: 10, color: 'var(--text)', wordBreak: 'break-all' }}>{session.user.email}</div>
            </div>
          )}
        </div>

        {/* ── Email list ── */}
        <div style={{
          width: selected ? 300 : undefined,
          flex:  selected ? 'none' : 1,
          borderRight: selected ? '0.5px solid var(--border)' : 'none',
          overflowY: 'auto', background: 'var(--bg)',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {search ? 'No emails match your search.' : 'No emails in this category.'}
            </div>
          ) : filtered.map(email => (
            <div
              key={email.id}
              onClick={() => setSelected(email)}
              style={{
                padding: '11px 14px', borderBottom: '0.5px solid var(--border)', cursor: 'pointer',
                background: selected?.id === email.id ? 'rgba(79,70,229,0.06)' : email.read ? 'var(--bg)' : 'rgba(24,95,165,0.03)',
              }}
              onMouseEnter={e => { if (selected?.id !== email.id) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)' }}
              onMouseLeave={e => { if (selected?.id !== email.id) (e.currentTarget as HTMLDivElement).style.background = email.read ? 'var(--bg)' : 'rgba(24,95,165,0.03)' }}>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {!email.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />}
                  <span style={{ fontSize: 12, fontWeight: email.read ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {email.name}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {email.starred && <span style={{ color: '#F59E0B', fontSize: 11 }}>★</span>}
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtEmailDate(email.date)}</span>
                </div>
              </div>

              <div style={{ fontSize: 11, fontWeight: email.read ? 400 : 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {email.subject}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <TagBadge tag={email.tag} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {email.preview}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* ── Email body ── */}
        {selected && (
          <EmailBody
            email={selected}
            onClose={() => setSelected(null)}
            onStar={toggleStar}
            onMarkRead={markRead}
          />
        )}
      </div>
    </div>
  )
}
