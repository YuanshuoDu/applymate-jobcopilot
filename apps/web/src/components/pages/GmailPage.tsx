'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { signIn } from 'next-auth/react'
import { TopBar }              from '@/components/layout/TopBar'
import { Btn, Card, useToast } from '@/components/ui'

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
  interview: { label: 'Interview',  color: '#3B6D11', bg: 'rgba(59,109,17,0.12)'   },
  offer:     { label: 'Offer 🎉',  color: '#0E7490', bg: 'rgba(14,116,144,0.12)'  },
  rejected:  { label: 'Rejected',   color: '#A32D2D', bg: 'rgba(163,45,45,0.12)'   },
  review:    { label: 'In Review',  color: '#854F0B', bg: 'rgba(133,79,11,0.12)'   },
  received:  { label: 'Received',   color: '#185FA5', bg: 'rgba(24,95,165,0.12)'   },
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
      <Card style={{ padding: 40, maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
          {status === 'no_google' ? 'Connect your Google Account' : 'Grant Gmail Access'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.75, marginBottom: 24 }}>
          {status === 'no_google'
            ? 'Sign in with Google to enable Gmail tracking. JobCopilot will automatically detect interview invitations, rejections, and offer letters in your inbox.'
            : 'Your Google account is connected but Gmail read-access was not granted. Click below to reconnect and approve Gmail access.'}
        </div>
        <Btn variant="primary" onClick={onConnect}>
          {status === 'no_google' ? '⟳ Sign in with Google' : '⟳ Reconnect with Gmail Access'}
        </Btn>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16 }}>
          We request <strong>read-only</strong> access. JobCopilot never sends emails on your behalf.
        </div>
      </Card>
    </div>
  )
}

// ── EmailBody ─────────────────────────────────────────────────────────────────

function EmailBody({ email, onClose, onStar, onMarkRead }: {
  email:      GmailEmail
  onClose:    () => void
  onStar:     (id: string) => void
  onMarkRead: (id: string) => void
}) {
  const [body,    setBody]    = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const toast = useToast()

  useEffect(() => {
    onMarkRead(email.id)
    fetch(`/api/gmail/message/${email.id}`)
      .then(r => r.json())
      .then(d => setBody(d.body?.trim() || email.preview))
      .catch(() => setBody(email.preview))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id])

  return (
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

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
            <div style={{ width: 14, height: 14, border: '2px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            Loading message…
          </div>
        ) : (
          <pre style={{ fontSize: 12, lineHeight: 1.75, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>
            {body}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 8 }}>
        <Btn variant="ghost" onClick={() => window.open(`https://mail.google.com/mail/#inbox/${email.threadId}`, '_blank')}>
          Open in Gmail ↗
        </Btn>
      </div>
    </div>
  )
}

// ── GmailPage ─────────────────────────────────────────────────────────────────

export function GmailPage() {
  const toast = useToast()

  const [status,     setStatus]     = useState<GmailStatus>('loading')
  const [emails,     setEmails]     = useState<GmailEmail[]>([])
  const [selected,   setSelected]   = useState<GmailEmail | null>(null)
  const [filter,     setFilter]     = useState('all')
  const [search,     setSearch]     = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadEmails = useCallback(async (silent = false) => {
    if (!silent) setStatus('loading')
    else         setRefreshing(true)

    try {
      const res  = await fetch('/api/gmail/threads')
      const body = await res.json()

      if (!res.ok) {
        const code = (body.error ?? '') as string
        if (code === 'NO_GOOGLE_ACCOUNT')  { setStatus('no_google'); return }
        if (code.startsWith('GMAIL'))      { setStatus('no_gmail');  return }
        if (code === 'TOKEN_EXPIRED')      { setStatus('no_gmail');  return }
        setStatus('error')
        return
      }

      setEmails(body.emails ?? [])
      setStatus('ready')
      if (silent) toast.success('Refreshed', `${(body.emails ?? []).length} emails loaded`)
    } catch {
      setStatus('error')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => { loadEmails() }, [loadEmails])

  function connectGoogle() {
    signIn('google', { callbackUrl: window.location.href })
  }

  function toggleStar(id: string) {
    setEmails(prev => prev.map(e => e.id === id ? { ...e, starred: !e.starred } : e))
    if (selected?.id === id) setSelected(s => s ? { ...s, starred: !s.starred } : s)
  }

  function markRead(id: string) {
    setEmails(prev => prev.map(e => e.id === id ? { ...e, read: true } : e))
  }

  // ── Derived lists ─────────────────────────────────────────────────────────

  const filtered = emails.filter(e => {
    const matchesFilter =
      filter === 'all'     ? true :
      filter === 'starred' ? e.starred :
      filter === 'unread'  ? !e.read :
      e.tag === filter
    const matchesSearch = !search ||
      [e.subject, e.name, e.from].some(t => t.toLowerCase().includes(search.toLowerCase()))
    return matchesFilter && matchesSearch
  })

  const unreadCount = emails.filter(e => !e.read).length
  const tagCounts   = emails.reduce<Record<string, number>>((acc, e) => {
    acc[e.tag] = (acc[e.tag] ?? 0) + 1; return acc
  }, {})

  // ── Loading / error / connect states ──────────────────────────────────────

  if (status === 'loading') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <TopBar title="Gmail Tracker" />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 24, height: 24, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Connecting to Gmail…</div>
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
          <div style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>Failed to load Gmail</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <Btn variant="ghost"   onClick={connectGoogle}>Reconnect Google</Btn>
            <Btn variant="primary" onClick={() => loadEmails()}>Retry</Btn>
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
          <span style={{ fontSize: 11, background: '#185FA5', color: '#fff', borderRadius: 999, padding: '2px 8px', fontWeight: 500 }}>
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
            { key: 'starred', label: 'Starred',     count: emails.filter(e => e.starred).length },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', marginBottom: 2,
              background: filter === f.key ? 'rgba(24,95,165,0.12)' : 'transparent',
              color: filter === f.key ? '#185FA5' : 'var(--text)',
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
                background: selected?.id === email.id ? 'rgba(24,95,165,0.06)' : email.read ? 'var(--bg)' : 'rgba(24,95,165,0.03)',
              }}
              onMouseEnter={e => { if (selected?.id !== email.id) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)' }}
              onMouseLeave={e => { if (selected?.id !== email.id) (e.currentTarget as HTMLDivElement).style.background = email.read ? 'var(--bg)' : 'rgba(24,95,165,0.03)' }}>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {!email.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#185FA5', flexShrink: 0 }} />}
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
